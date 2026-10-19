#!/bin/sh
# Harness exit near the context limit (S-220, S-257), free: Claude Code agents on the scripted fake (test/fake-claude,
# no model). A harness that exits at 320k context (over the default 297.5k: 85% of 350k) is compacted headless on its
# session, then resumed once with a note, and its parent hears a line. A second exit within the repeat window isn't
# resumed, and the parent is told so; `stam compact` on that shut-down agent compacts and resumes it. A low-context
# exit keeps today's behaviour and tells no one.
# Runs against its own daemon (test/lib.sh). Nothing waits on a timer: the checks poll state.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/exit-context.json" <<'EOF'
{ "turns": [
  { "match": "Reply with exactly: ready", "steps": [ { "reply": "ready" } ] },
  { "match": "from the human: exit-high", "steps": [
    { "mcp": "read_mail" }, { "status": { "context_tokens": 320000 } }, { "exit": true } ] },
  { "match": "from the human: exit-again", "steps": [
    { "mcp": "read_mail" }, { "status": { "context_tokens": 320000 } }, { "exit": true } ] },
  { "match": "from the human: exit-fail", "steps": [
    { "mcp": "read_mail" }, { "status": { "context_tokens": 320000 } }, { "exit": true } ] },
  { "match": "from the human: exit-low", "steps": [
    { "mcp": "read_mail" }, { "status": { "context_tokens": 1000 } }, { "exit": true } ] },
  { "match": "stam compacted your conversation", "steps": [
    { "mcp": "send_mail", "expect": "Sent", "args": { "to": ["human"], "subject": "resumed", "new_thread": true, "body": "Resumed after compaction." } },
    { "reply": "resumed" } ] }
] }
EOF
fake_claude "$TEST_TMP/exit-context.json"
isolate
field() { "$STAM" show "$1" | grep "\"$2\"" | head -1 | sed 's/.*: //; s/^"//; s/",*$//; s/,$//'; }
# An agent's mail to the human goes to its parent unless it is a manager (S-548), so the resumed agent's mail lands in the parent's inbox.
mail_has() { "$STAM" mail inbox "$1" | grep -q "$2"; }
events_has() { "$STAM" events "$1" | grep -q "$2"; }
# Bounded: each try is a state check on the daemon, so a state is seen as soon as it is reached.
poll() { n=$1; shift; while [ "$n" -gt 0 ]; do "$@" && return 0; n=$((n - 1)); done; return 1; }

P="e2e-xc-p-$(date +%s)"; H="e2e-xc-h-$(date +%s)"; L="e2e-xc-l-$(date +%s)"; F="e2e-xc-f-$(date +%s)"; DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
"$STAM" spawn "$P" --model claude-sonnet-5-5 --cwd "$DIR" --role "Exit test parent." "Reply with exactly: ready"
"$STAM" spawn "$H" --model claude-sonnet-5-5 --cwd "$DIR" --parent "$P" --role "Exit test agent." "Reply with exactly: ready"
"$STAM" spawn "$L" --model claude-sonnet-5-5 --cwd "$DIR" --parent "$P" --role "Exit test agent." "Reply with exactly: ready"
"$STAM" spawn "$F" --model claude-sonnet-5-5 --cwd "$DIR" --parent "$P" --role "Exit test agent." "Reply with exactly: ready"
for n in "$P" "$H" "$L" "$F"; do "$STAM" wait "$n" --until idle --timeout 90; done

echo "-- exit near the limit is resumed once, with the parent told"
"$STAM" mail send --to "$H" --subject "exit-high" "Stop now."
poll 300 mail_has "$P" "resumed" || { echo "FAIL: $H not resumed with the compact note"; exit 1; }
poll 200 events_has "$P" "$H exited at 320k context; compacted and resumed" || { echo "FAIL: parent not told of the resume"; exit 1; }
test "$(field "$H" lifecycle)" = active || { echo "FAIL: $H is $(field "$H" lifecycle) after the resume"; exit 1; }
test "$("$STAM" events "$H" | grep -c ' recover ' || true)" = 1 || { echo "FAIL: $H resumed more than once"; exit 1; }
events_has "$H" '"headless":true' || { echo "FAIL: $H was resumed without a headless compaction"; exit 1; }
"$STAM" wait "$H" --until idle --timeout 90

echo "-- a second exit within the repeat window isn't resumed"
"$STAM" mail send --to "$H" --subject "exit-again" "Stop again."
poll 200 events_has "$P" "$H exited at 320k context again; not resumed" || { echo "FAIL: parent not told of the second exit"; exit 1; }
test "$(field "$H" lifecycle)" = shut_down || { echo "FAIL: $H is $(field "$H" lifecycle) after a second exit"; exit 1; }
test "$(field "$H" activity_detail)" = "harness exited" || { echo "FAIL: $H: $(field "$H" activity_detail)"; exit 1; }
test "$("$STAM" events "$H" | grep -c ' recover ' || true)" = 1 || { echo "FAIL: $H resumed a second time"; exit 1; }

echo "-- stam compact on the shut-down agent compacts headless and resumes it"
"$STAM" compact "$H"
poll 300 events_has "$H" '"headless":true' || { echo "FAIL: $H not compacted"; exit 1; }
"$STAM" wait "$H" --until idle --timeout 90
test "$(field "$H" lifecycle)" = active || { echo "FAIL: $H is $(field "$H" lifecycle) after stam compact"; exit 1; }
test "$("$STAM" events "$H" | grep -c '"headless":true' || true)" = 2 || { echo "FAIL: $H compacted $("$STAM" events "$H" | grep -c '"headless":true' || true) times"; exit 1; }

echo "-- a failed compaction is told to the parent, and stam compact retries it"
touch "$STAM_HOME/fake-compact-fail"
"$STAM" mail send --to "$F" --subject "exit-fail" "Stop now."
poll 200 events_has "$P" "$F exited at 320k context; compaction failed" || { echo "FAIL: parent not told of the failed compaction"; exit 1; }
test "$(field "$F" lifecycle)" = shut_down || { echo "FAIL: $F is $(field "$F" lifecycle) after a failed compaction"; exit 1; }
test "$("$STAM" events "$F" | grep -c ' recover ' || true)" = 0 || { echo "FAIL: $F resumed after a failed compaction"; exit 1; }
rm -f "$STAM_HOME/fake-compact-fail"
"$STAM" compact "$F"
"$STAM" wait "$F" --until idle --timeout 90
test "$(field "$F" lifecycle)" = active || { echo "FAIL: $F is $(field "$F" lifecycle) after the retry"; exit 1; }
test "$("$STAM" events "$F" | grep -c '"headless":true' || true)" = 2 || { echo "FAIL: $F not compacted on the retry"; exit 1; }

echo "-- a low-context exit is unchanged"
"$STAM" mail send --to "$L" --subject "exit-low" "Stop now."
"$STAM" wait "$L" --until shut_down --timeout 60
test "$(field "$L" activity_detail)" = "harness exited" || { echo "FAIL: $L: $(field "$L" activity_detail)"; exit 1; }
test "$("$STAM" events "$L" | grep -c ' recover ' || true)" = 0 || { echo "FAIL: $L resumed"; exit 1; }
test "$("$STAM" events "$P" | grep -c "$L exited" || true)" = 0 || { echo "FAIL: parent told of a low-context exit"; exit 1; }
echo "PASS"
