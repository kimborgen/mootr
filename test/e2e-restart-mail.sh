#!/bin/sh
# Mail across a daemon restart: each mail to an idle agent is pushed once and starts exactly
# one turn, before and after the daemon restarts, and the reply reaches the human. A Claude
# Code agent on the scripted fake (test/fake-claude): no model, no network, free. The Codex
# half is test/e2e-restart-mail-codex.sh (smoke).
# Runs against its own daemon (test/lib.sh). Waits on state (`stam wait --until idle`) and on
# the reply's arrival in the human inbox, bounded; nothing waits on a timer.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/restart-mail.json" <<'EOF'
{ "turns": [
  { "match": "/Check (\\d)/", "steps": [
    { "mcp": "read_mail", "expect": "PONG" },
    { "mcp": "send_mail", "expect": "Sent", "args": { "to": ["human"], "subject": "Re: Check ${1}", "body": "PONG" } },
    { "reply": "PONG" } ] } ] }
EOF
fake_claude "$TEST_TMP/restart-mail.json"
isolate
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
fail() { echo "FAIL: $1"; exit 1; }
human_has() { "$STAM" mail inbox human | grep -q "$1"; }

"$STAM" spawn cl --harness claude --model claude-sonnet-5-5 --cwd "$DIR" --role "Test agent." >/dev/null
"$STAM" wait cl --until idle --timeout 60 >/dev/null

# Sends a mail and waits for its reply. The reply is sent during the turn; the turn ends
# with Stop, so the idle state comes after the reply.
round() {
  "$STAM" mail send --to cl --subject "Check $1" "Reply to this mail with exactly: PONG. Nothing else." >/dev/null
  for i in $(seq 1 60); do human_has "Re: Check $1" && break; sleep 0.5; done
  human_has "Re: Check $1" || fail "no reply to Check $1"
  "$STAM" wait cl --until idle --timeout 60 >/dev/null
}
round 1
"$STAM" daemon stop >/dev/null
daemon_up main
"$STAM" wait cl --until idle --timeout 60 >/dev/null
round 2

pushes=$("$STAM" events cl | grep -c 'pushed {"mail":true' || true)
turns=$("$STAM" events cl | grep -c 'hook:UserPromptSubmit' || true)
[ "$pushes" = 2 ] || fail "$pushes mail pushes for 2 mails"
[ "$turns" = 2 ] || fail "$turns turns for 2 mails"
echo "PASS e2e-restart-mail"
