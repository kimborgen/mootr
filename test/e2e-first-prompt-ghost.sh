#!/bin/sh
# S-2123, free: Claude Code's input box can show a placeholder or a prompt suggestion, drawn
# faint, before anything is typed, and a Claude Code still resuming can drop a paste. The fake
# draws a placeholder in its empty box and drops the first paste of each launch (`placeholder`,
# `dropPastes`). A spawn's first prompt and a resume's prompt still go in: the faint text counts
# as an empty box, and the lost paste goes in again. Each is submitted once, exactly as written.
# A UserPromptSubmit hook that comes late (a stalled daemon) is waited for once the box took the
# prompt, with no second Enter. A paste a stalled Claude Code holds back and lands only after the
# retry pasted again would show two copies: nothing is pressed, and the launch fails instead.
# A long prompt Claude Code doesn't fold, taller than the box's window (`boxRows`), still goes in.
# A launch a restart supersedes while its Enter goes unanswered (`holdEnter`) steps aside: it
# presses nothing more into the new session and doesn't fail the new launch.
# Runs against its own daemons (test/lib.sh).
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
HOLD="$TEST_TMP/hold-hook"
ENTER="$TEST_TMP/hold-enter"
LONG=$(python3 -c "print(('alpha bravo charlie delta echo foxtrot golf hotel india juliet ' * 12)[:700].strip())")
cat >"$TEST_TMP/ghost.json" <<EOF
{ "placeholder": "Try \"fix the failing test\"", "dropPastes": 1, "holdPromptHook": "$HOLD", "holdEnter": "$ENTER", "boxRows": 3,
  "turns": [
  { "match": "stale second", "steps": [ { "reply": "STALE-DONE" } ] },
  { "match": "alpha bravo", "steps": [ { "reply": "LONG-DONE" } ] },
  { "match": "ghost first", "steps": [ { "reply": "FIRST-DONE" } ] },
  { "match": "ghost resume", "steps": [ { "reply": "RESUME-DONE" } ] },
  { "match": "ghost hold", "steps": [ { "reply": "HOLD-DONE" } ] } ] }
EOF
fake_claude "$TEST_TMP/ghost.json"
isolate
fail() { echo "FAIL: $1"; "$STAM" ls; exit 1; }
# A lost paste goes in again after a 10 s wait and a settle, past wait_until's 20 s: up to 60 s.
wait_long() { for _i in $(seq 1 300); do "$@" >/dev/null 2>&1 && return 0; sleep 0.2; done; echo "FAIL: timed out waiting for: $*"; [ -z "${ON_TIMEOUT:-}" ] || $ON_TIMEOUT; exit 1; }
field() { "$STAM" show "$1" | python3 -c 'import json,sys; print(json.load(sys.stdin).get(sys.argv[1]))' "$2"; }
NAME="ghost-$(date +%s)"
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
"$STAM" spawn "$NAME" --model claude-haiku-5-5 --cwd "$DIR" "ghost first: reply FIRST-DONE" >/dev/null
"$STAM" wait "$NAME" --until idle --timeout 90 || fail "the first prompt was not taken: $(field "$NAME" activity_detail)"
said "$NAME" FIRST-DONE || fail "the first turn didn't run"
TYPED="$STAM_HOME/agents/$(field "$NAME" id)/typed.jsonl"
# The resume relaunches the fake, which shows its placeholder and drops a paste again.
"$STAM" kill "$NAME" >/dev/null
"$STAM" wait "$NAME" --until shut_down --timeout 10
"$STAM" resume "$NAME" "ghost resume: reply RESUME-DONE" >/dev/null
resumed() { said "$NAME" RESUME-DONE; }
wait_long resumed
"$STAM" wait "$NAME" --until idle --timeout 60
# Every submitted input, in order: each prompt once, exactly as written; nothing else (no placeholder, no double paste).
python3 - "$TYPED" <<'EOF' || fail "typed inputs: $(cat "$TYPED")"
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]).read().splitlines()]
assert len(rows) == 2, rows
assert rows[0] == "ghost first: reply FIRST-DONE", rows
assert "ghost resume: reply RESUME-DONE" in rows[1], rows
assert rows[1].count("ghost resume") == 1, rows
EOF
"$STAM" kill "$NAME" >/dev/null
"$STAM" wait "$NAME" --until shut_down --timeout 10

# A late hook: the box took the prompt, so stam waits for UserPromptSubmit instead of failing or pressing Enter again.
: >"$HOLD"
H="hold-$(date +%s)"
"$STAM" spawn "$H" --model claude-haiku-5-5 --cwd "$DIR" "ghost hold: reply HOLD-DONE" >/dev/null
awaiting() { "$STAM" events "$H" | grep -q 'first-prompt:awaiting-hook'; }
wait_until awaiting
[ "$(field "$H" activity)" = starting ] || fail "the late hook left $H $(field "$H" activity): $(field "$H" activity_detail)"
rm "$HOLD"
"$STAM" wait "$H" --until idle --timeout 60
said "$H" HOLD-DONE || fail "the held turn didn't run"
HTYPED="$STAM_HOME/agents/$(field "$H" id)/typed.jsonl"
[ "$(wc -l <"$HTYPED")" -eq 1 ] || fail "late hook: typed $(cat "$HTYPED")"
"$STAM" kill "$H" >/dev/null
"$STAM" wait "$H" --until shut_down --timeout 10

# A long prompt under 800 characters isn't folded; its box outgrows the window of three rows.
L="long-$(date +%s)"
"$STAM" spawn "$L" --model claude-haiku-5-5 --cwd "$DIR" "$LONG" >/dev/null
"$STAM" wait "$L" --until idle --timeout 90 || fail "the long prompt was not taken: $(field "$L" activity_detail)"
said "$L" LONG-DONE || fail "the long turn didn't run"
LTYPED="$STAM_HOME/agents/$(field "$L" id)/typed.jsonl"
python3 -c 'import json,sys; rows=[json.loads(l) for l in open(sys.argv[1]).read().splitlines()]; assert rows == [sys.argv[2]], rows' "$LTYPED" "$LONG" || fail "long typed: $(cat "$LTYPED")"
"$STAM" kill "$L" >/dev/null
"$STAM" wait "$L" --until shut_down --timeout 10

# A restart supersedes a launch whose Enter goes unanswered: the old launch steps aside.
: >"$ENTER"
S="stale-$(date +%s)"
"$STAM" spawn "$S" --model claude-haiku-5-5 --cwd "$DIR" "stale first: reply NEVER" >/dev/null
dropped() { [ -s "$ENTER.dropped" ]; }
wait_long dropped
"$STAM" restart "$S" "stale second" >/dev/null
superseded() { "$STAM" events "$S" | grep -q 'first-prompt:superseded'; }
# S-3454: on a timeout, the stale agent's events and its session's screen go to the kept log.
dump_stale() {
  echo "events of $S, latest 200:"
  "$STAM" events "$S" --limit 200 || true
  echo "screen of $S:"
  tmux -L "$STAM_TMUX_SOCKET" capture-pane -p -t "=$(field "$S" id):" 2>&1 || true
}
ON_TIMEOUT=dump_stale wait_long superseded
[ "$(field "$S" activity)" != errored ] || fail "the stale launch failed the new one: $(field "$S" activity_detail)"
if "$STAM" events "$S" | grep -q 'first-prompt:screen'; then fail "the stale launch recorded a failure"; fi
rm "$ENTER"
stale_done() { said "$S" STALE-DONE; }
wait_long stale_done
"$STAM" wait "$S" --until idle --timeout 60
STYPED="$STAM_HOME/agents/$(field "$S" id)/typed.jsonl"
python3 -c 'import json,sys; rows=[json.loads(l) for l in open(sys.argv[1]).read().splitlines()]; assert len(rows) == 1 and "stale second" in rows[0], rows' "$STYPED" || fail "stale typed: $(cat "$STYPED")"
"$STAM" kill "$S" >/dev/null
"$STAM" wait "$S" --until shut_down --timeout 10

# A held paste that lands after the retry: two copies in the box, so nothing is pressed and the launch fails.
cat >"$TEST_TMP/held.json" <<'EOF'
{ "placeholder": "Try something", "holdPastes": 1, "turns": [ { "match": "ghost held", "steps": [ { "reply": "NEVER" } ] } ] }
EOF
fake_claude "$TEST_TMP/held.json"
isolate held
D="held-$(date +%s)"
"$STAM" spawn "$D" --model claude-haiku-5-5 --cwd "$DIR" "ghost held: reply NEVER" >/dev/null
errored() { [ "$(field "$D" activity)" = errored ]; }
wait_long errored
field "$D" activity_detail | grep -q 'exactly once' || fail "wrong failure: $(field "$D" activity_detail)"
DTYPED="$STAM_HOME/agents/$(field "$D" id)/typed.jsonl"
[ ! -s "$DTYPED" ] || fail "a doubled prompt was submitted: $(cat "$DTYPED")"
"$STAM" kill "$D" >/dev/null
echo "PASS e2e-first-prompt-ghost"
