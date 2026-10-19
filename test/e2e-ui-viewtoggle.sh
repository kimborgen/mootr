#!/bin/sh
# The switch between an agent's terminal and stam's view of its conversation (S-82, S-125) in
# headless Chromium: web/check/viewtoggle.mjs on a throwaway daemon with the fake OpenCode,
# Codex, and Claude Code. Desktop and 360 px light; no model runs, nothing is spent.
# Screenshots go to $OUT.
set -e
cd "$(dirname "$(readlink -f "$0")")/.."
rc=0
OWN_VIEW=1 VIEW_TOGGLE=1 NO_HELLO=1 sh web/check/run.sh viewtoggle || rc=$?
[ "$rc" = 0 ] && echo "PASS: view switch" || echo "FAIL: view switch"
exit $rc
