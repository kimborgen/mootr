#!/bin/sh
# An agent's end of turn isn't lost (S-188). A: a Stop hook that fires while the daemon is
# down retries until the daemon is back, so the agent ends idle. B: an agent whose Stop never
# arrived stays 'working' with mail queued, until stam sees it at an empty prompt with no
# hook for settings.staleWorkingMinutes, marks it idle, and delivers the mail.
# Fake Claude Code (test/fake-claude): no model, no network, free. Waits on state, bounded.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/stale.json" <<'EOF'
{ "turns": [
  { "match": "Hold", "steps": [
    { "shell": "touch held; while [ ! -e release ]; do sleep 0.1; done" },
    { "reply": "HELD" } ] },
  { "match": "Lose", "steps": [
    { "reply": "LOST" },
    { "lost_stop": true } ] },
  { "match": "Ping", "source": "channel", "steps": [
    { "mcp": "read_mail", "expect": "PING-BODY" },
    { "reply": "PONG" } ] } ] }
EOF
fake_claude "$TEST_TMP/stale.json"
daemon_home main
printf '{ "peers": [], "staleWorkingMinutes": 60 }\n' >"$TEST_TMP/main/settings.json"
use main
daemon_up main
fail() { echo "FAIL: $1"; exit 1; }
activity() { "$STAM" show "$1" | grep -o '"activity": *"[a-z]*"' | sed 's/.*"\([a-z]*\)"$/\1/'; }

# A: the turn holds until the daemon is down, so its Stop hook meets a refused connection.
A="$(mktemp -d "$TEST_TMP/a.XXXX")"
"$STAM" spawn a --cwd "$A" "Hold" >/dev/null
held() { [ -e "$A/held" ]; }
wait_until held
daemon_stop main
touch "$A/release"
daemon_up main
"$STAM" wait a --until idle --timeout 60 >/dev/null || fail "a not idle after the daemon came back"
"$STAM" events a | grep -q 'hook:Stop' || fail "a's Stop hook was lost across the restart"
"$STAM" events a | grep -q 'activity:reconciled' && fail "a was reconciled; the hook should have retried"

# B: the turn ends without Stop; mail sent now waits, since stam thinks b is working.
B="$(mktemp -d "$TEST_TMP/b.XXXX")"
"$STAM" spawn b --cwd "$B" "Lose" >/dev/null
lost() { "$STAM" events b | grep -q 'hook:UserPromptSubmit'; }
wait_until lost
"$STAM" mail send --to b --subject "Ping" "PING-BODY" >/dev/null
[ "$(activity b)" = working ] || fail "b is $(activity b), not stuck working"
"$STAM" events b | grep -q 'pushed' && fail "mail pushed to a working agent"
# A short limit: the next sweep finds b at its prompt with no recent hook.
printf '{ "peers": [], "staleWorkingMinutes": 0.01 }\n' >"$STAM_HOME/settings.json"
reconciled() { "$STAM" events b | grep -q 'activity:reconciled'; }
pushed() { "$STAM" events b | grep -q 'pushed {"mail":true'; }
wait_until reconciled
wait_until pushed
"$STAM" wait b --until idle --timeout 60 >/dev/null
"$STAM" show b | grep -q 'PONG' || fail "b didn't answer the queued mail"
echo "PASS e2e-stale-working"
