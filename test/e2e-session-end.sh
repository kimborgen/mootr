#!/bin/sh
# A harness that ends its session but leaves its pane live (S-384), free: Claude Code agents on the scripted fake
# (test/fake-claude, no model). The fake's `{ "exit": "hang" }` runs SessionEnd and stops its MCP server without
# exiting, so the tmux check sees a live pane. The agent shows "session ended" instead of idle, and once
# STAM_SESSION_END_MS passes with no new session and no MCP stream, the daemon shuts it down and tells its parent.
# Mail sent to it then tells the sender (in send_mail's result) and the parent (one notice for a burst), whoever sent it, and is
# delivered once it is resumed. A /clear SessionEnd and a stam restart don't count as the session ending.
# Runs against its own daemon (test/lib.sh). Nothing waits on a timer: the checks poll state.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/session-end.json" <<'EOF'
{ "turns": [
  { "match": "Reply with exactly: ready", "steps": [ { "reply": "ready" } ] },
  { "match": "from the human: hang", "steps": [ { "mcp": "read_mail" }, { "exit": "hang" } ] },
  { "match": "from the human: tell-b", "steps": [
    { "mcp": "read_mail" },
    { "mcp": "send_mail", "expect": "Not running: e2e-se-b", "args": { "to": ["e2e-se-b"], "subject": "are you there", "new_thread": true, "body": "Ping." } },
    { "reply": "told" } ] },
  { "match": "from the human: clear", "steps": [ { "mcp": "read_mail" }, { "hook": "SessionEnd", "payload": { "reason": "clear" } }, { "reply": "cleared" } ] },
  { "match": "from e2e-se-a: are you there", "steps": [ { "mcp": "read_mail", "expect": "Ping." }, { "reply": "got it" } ] }
] }
EOF
fake_claude "$TEST_TMP/session-end.json"
export STAM_SESSION_END_MS=3000
isolate
field() { "$STAM" show "$1" | grep "\"$2\"" | head -1 | sed 's/.*: //; s/^"//; s/",*$//; s/,$//'; }
is() { test "$(field "$1" "$2")" = "$3"; }

P=e2e-se-p; A=e2e-se-a; B=e2e-se-b; DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
"$STAM" spawn "$P" --model claude-sonnet-5-5 --cwd "$DIR" --role "Session end test parent." "Reply with exactly: ready"
"$STAM" spawn "$A" --model claude-sonnet-5-5 --cwd "$DIR" --role "Session end test sender." "Reply with exactly: ready"
"$STAM" spawn "$B" --model claude-sonnet-5-5 --cwd "$DIR" --parent "$P" --role "Session end test agent." "Reply with exactly: ready"
for n in "$P" "$A" "$B"; do "$STAM" wait "$n" --until idle --timeout 90; done

told() { "$STAM" events "$P" | grep -q "$1"; }

echo "-- a /clear SessionEnd keeps the agent as it was"
"$STAM" mail send --to "$A" --subject "clear" "Clear."
poll 30 is "$A" last_message cleared || { echo "FAIL: $A: $(field "$A" last_message)"; exit 1; }
"$STAM" wait "$A" --until idle --timeout 90
is "$A" lifecycle active || { echo "FAIL: $A is $(field "$A" lifecycle) after /clear"; exit 1; }
! "$STAM" events "$A" | grep -q 'session ended' || { echo "FAIL: /clear counted as the session ending"; exit 1; }

echo "-- a stam restart doesn't count as the session ending"
"$STAM" restart "$A" "test"
poll 70 sh -c '"$0" events "$1" | grep -q " resume "' "$STAM" "$A" || { echo "FAIL: $A not relaunched"; exit 1; }
"$STAM" wait "$A" --until idle --timeout 90
is "$A" lifecycle active || { echo "FAIL: $A is $(field "$A" lifecycle) after a restart"; exit 1; }
! "$STAM" events "$A" | grep -q 'session ended' || { echo "FAIL: the restart counted as the session ending"; exit 1; }

echo "-- a SessionEnd with the pane still live leaves idle"
"$STAM" mail send --to "$B" --subject "hang" "End your session."
poll 70 is "$B" activity_detail "session ended" || is "$B" lifecycle shut_down || { echo "FAIL: $B is $(field "$B" activity) $(field "$B" activity_detail) after SessionEnd"; exit 1; }
"$STAM" events "$B" | grep -q 'hook:SessionEnd' || { echo "FAIL: no SessionEnd from $B"; exit 1; }

echo "-- with no new session and no stream, the daemon shuts it down"
poll 130 is "$B" lifecycle shut_down || { echo "FAIL: $B is $(field "$B" lifecycle) $(field "$B" activity_detail)"; exit 1; }
is "$B" activity_detail "harness ended its session" || { echo "FAIL: $B: $(field "$B" activity_detail)"; exit 1; }
"$STAM" events "$B" | grep -q 'exited.*session ended' || { echo "FAIL: no exited event for $B"; exit 1; }
! tmux -L "$STAM_TMUX_SOCKET" has-session -t "=$(field "$B" id)" 2>/dev/null || { echo "FAIL: $B's pane was left running"; exit 1; }
poll 30 told "$B's harness ended its session" || { echo "FAIL: $P not told $B shut down"; exit 1; }

echo "-- mail from the human (the CLI) to it tells the parent"
"$STAM" mail send --to "$B" --subject "from the cli" "Are you there?"
poll 30 told "from the human to $B" || { echo "FAIL: $P not told of the human's mail to $B"; "$STAM" events "$P" | tail -5; exit 1; }

echo "-- more mail to it tells the sender; the parent, told already, isn't told again"
"$STAM" mail send --to "$A" --subject "tell-b" "Mail e2e-se-b."
"$STAM" wait "$A" --until idle --timeout 90
poll 30 is "$A" last_message told || { echo "FAIL: $A: $(field "$A" last_message)"; exit 1; }
test "$("$STAM" events "$P" | grep -c 'waits unread' || true)" = 1 || { echo "FAIL: $P told more than once of mail to $B"; exit 1; }

echo "-- resumed, it gets the mail that waited"
"$STAM" resume "$B"
poll 70 is "$B" last_message "got it" || { echo "FAIL: $B didn't read its waiting mail: $(field "$B" last_message)"; exit 1; }
echo PASS
