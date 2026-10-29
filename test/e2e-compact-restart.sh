#!/bin/sh
# S-358, free: an idle compaction of a Claude Code agent that a daemon restart cuts short isn't read as an exit:
# the restarted daemon stops the compactor the old one left running, confirms it gone, compacts again (never two
# compactors on a session at once), and resumes the agent, which ends active and idle and answers mail. The same
# holds when the tmux server went down too. Claude Code agents on the scripted fake (test/fake-claude, no model).
# The compaction is held open with a flag file while the daemon restarts; the fake logs each compactor's session
# in fake-compact-runs, and an OVERLAP line when two run on one session.
# Runs against its own daemon (test/lib.sh). Nothing waits on a timer: the checks poll state.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/compact-restart.json" <<'EOF2'
{ "turns": [
  { "match": "Reply with exactly: ready", "steps": [
    { "status": { "context_tokens": 50000, "context_window": 200000 } }, { "reply": "ready" } ] },
  { "match": "from the human: ping", "steps": [
    { "mcp": "read_mail" },
    { "mcp": "send_mail", "expect": "Sent", "args": { "to": ["human"], "subject": "pong", "new_thread": true, "body": "pong" } },
    { "reply": "Mailed the human." } ] }
] }
EOF2
fake_claude "$TEST_TMP/compact-restart.json"
isolate
set_settings() { printf '%s\n' "$1" >"$STAM_HOME/settings.json"; }
field() { "$STAM" show "$1" | grep "\"$2\"" | head -1 | sed 's/.*: //; s/^"//; s/",*$//; s/,$//'; }
events_has() { "$STAM" events "$1" | grep -q "$2"; }
human_has() { "$STAM" mail inbox human | grep -q "$1"; }
compacting() { "$STAM" show "$1" | grep -q '"activity_detail": "compacting'; }
recovers() { "$STAM" events "$1" | grep -c ' recover ' || true; }
resumed_idle() { test "$(field "$1" lifecycle)" = active && test "$(field "$1" activity)" = idle && test "$(recovers "$1")" -ge "$2"; }
runs() { grep -c . "$STAM_HOME/fake-compact-runs" 2>/dev/null || echo 0; }
# Every transcript line parses: the row a killed compactor cut short was trimmed (the fake's
# compaction writes its row in two parts).
whole_transcript() {
  tp=$(field "$N" transcript_path)
  node -e 'for (const l of require("fs").readFileSync(process.argv[1], "utf8").split("\n")) if (l) JSON.parse(l)' "$tp" || { echo "FAIL: $tp has a half-written row"; exit 1; }
}
half_written() { tail -c 20 "$(field "$N" transcript_path)" | grep -q 'compacting$'; }
no_overlap() { ! grep -q OVERLAP "$STAM_HOME/fake-compact-runs" || { echo "FAIL: two compactors ran on one session"; exit 1; }; }
no_exit() { test "$("$STAM" events "$1" | grep -c ' exited' || true)" = 0 || { echo "FAIL: $1 read as exited $2"; exit 1; }; }

set_settings '{"idleCompaction":{"enabled":false}}'
N="e2e-cr-$(date +%s)"; DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
"$STAM" spawn "$N" --model claude-sonnet-5-5 --cwd "$DIR" --role "Compact restart test agent." "Reply with exactly: ready"
"$STAM" wait "$N" --until idle --timeout 90

echo "-- an idle compaction held open across a daemon restart"
touch "$STAM_HOME/fake-compact-hold"
set_settings '{"idleCompaction":{"enabled":true,"idleMinutes":0.01,"growthTokens":-1000000,"minTokens":1000}}'
poll 400 events_has "$N" 'context:idle-compaction' || { echo "FAIL: no idle compaction"; exit 1; }
poll 60 compacting "$N" || { echo "FAIL: $N never showed compacting"; exit 1; }
poll 60 half_written || { echo "FAIL: the held compaction didn't start its transcript row"; exit 1; }
# No second idle compaction after the restart: this one is enough.
set_settings '{"idleCompaction":{"enabled":false}}'
daemon_stop main
daemon_up main
# The restarted daemon's first reconcile finds the harness down mid-compaction.
poll 60 events_has "$N" 'exit:compaction' || { echo "FAIL: restart didn't see the compaction; events: $("$STAM" events "$N" | tail -5)"; exit 1; }
no_exit "$N" "after the restart"
# The old daemon's compactor still runs (held): the new one stops it before compacting again.
poll 60 events_has "$N" 'compact:killed' || { echo "FAIL: the running compactor wasn't stopped"; exit 1; }
poll 60 events_has "$N" '"headless":true' || { echo "FAIL: no compaction after the stop"; exit 1; }
rm -f "$STAM_HOME/fake-compact-hold"
poll 1100 resumed_idle "$N" 1 || { echo "FAIL: $N not resumed: $(field "$N" lifecycle) $(field "$N" activity) $(field "$N" activity_detail)"; exit 1; }
events_has "$N" '"compacted":true' || { echo "FAIL: resumed without compacting"; exit 1; }
# The stopped compactor and the new one, one after the other.
test "$(runs)" = 2 || { echo "FAIL: $(runs) compactor runs, expected 2"; exit 1; }
no_overlap
whole_transcript
no_exit "$N" "after the resume"

echo "-- it answers mail afterwards"
"$STAM" mail send --to "$N" --subject ping "ping" >/dev/null
poll 400 human_has "pong" || { echo "FAIL: $N didn't answer mail after the resume"; exit 1; }

echo "-- a compaction cut short by a restart that also lost the tmux server"
# A clean restart first: it clears the in-memory dedupe left by round one's recovery compaction (S-273),
# so the compact below runs rather than being dropped. The agent's harness stays up across it.
daemon_stop main
daemon_up main
# `stam events` shows the last 50 events, so round two counts only those since its own compact.
since() { "$STAM" events "$N" | sed -n '/ compact {"type":"compact","reason":"requested"/,$p'; }
since_has() { since | grep -q "$1"; }
touch "$STAM_HOME/fake-compact-hold"
"$STAM" compact "$N" >"$TEST_TMP/compact.out" 2>&1 &
CPID=$!
# A reconcile tick that ran during this compaction, not round one's.
poll 400 since_has 'reconcile:held' || { echo "FAIL: no reconcile tick during the second compaction: $(cat "$TEST_TMP/compact.out")"; exit 1; }
daemon_stop main
wait "$CPID" || true
# The test's own tmux server: the restarted daemon finds no server at all.
tmux -L "$STAM_TMUX_SOCKET" kill-server 2>/dev/null || true
daemon_up main
poll 400 since_has 'exit:compaction' || { echo "FAIL: lost-server restart didn't see the compaction; events: $(since | tail -5)"; exit 1; }
poll 400 since_has 'compact:killed' || { echo "FAIL: the second compactor wasn't stopped"; exit 1; }
rm -f "$STAM_HOME/fake-compact-hold"
resumed_again() { test "$(field "$N" lifecycle)" = active && test "$(field "$N" activity)" = idle && since_has ' recover '; }
poll 1100 resumed_again || { echo "FAIL: $N not resumed after the lost server: $(field "$N" lifecycle) $(field "$N" activity) $(field "$N" activity_detail)"; exit 1; }
test "$(runs)" = 4 || { echo "FAIL: $(runs) compactor runs, expected 4"; exit 1; }
no_overlap
whole_transcript
! since_has ' exited' || { echo "FAIL: $N read as exited after the lost-server restart"; exit 1; }
echo "PASS"
