#!/bin/sh
# Mail across a daemon restart for a Codex agent (smoke: a real Codex on a cheap model, run by
# hand, never a merge gate). Each mail to an idle agent is pushed once and starts one turn,
# before and after the daemon restarts, and the reply reaches the human. Costs about $0.02.
# The Claude Code half runs on the fake: test/e2e-restart-mail.sh (free).
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
isolate
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
fail() { echo "FAIL: $1"; exit 1; }
human_has() { "$STAM" mail inbox human | grep -q "$1"; }

"$STAM" spawn cx --harness codex --model gpt-6-luna --effort low --cwd "$DIR" --role "Test agent." >/dev/null
"$STAM" wait cx --until idle --timeout 90 >/dev/null

round() {
  "$STAM" mail send --to cx --subject "Check $1" "Reply to this mail with exactly: PONG. Nothing else." >/dev/null
  for i in $(seq 1 120); do human_has "Re: Check $1" && break; sleep 0.5; done
  human_has "Re: Check $1" || fail "no reply to Check $1"
  "$STAM" wait cx --until idle --timeout 120 >/dev/null
}
round 1
"$STAM" daemon stop >/dev/null
daemon_up main
"$STAM" wait cx --until idle --timeout 90 >/dev/null
round 2

pushes=$("$STAM" events cx | grep -c 'pushed {"mail":true' || true)
turns=$("$STAM" events cx | grep -c 'hook:UserPromptSubmit' || true)
[ "$pushes" = 2 ] || fail "cx: $pushes mail pushes for 2 mails"
[ "$turns" = 2 ] || fail "cx: $turns turns for 2 mails"
echo "PASS e2e-restart-mail-codex"
