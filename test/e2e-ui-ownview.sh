#!/bin/sh
# stam's own view of an agent (S-79) in headless Chromium: web/check/ownview.mjs on a
# throwaway daemon with the fake OpenCode (test/fake-opencode) and a seeded conversation.
# Desktop and 360 px light; no model runs, nothing is spent. Screenshots go to $OUT.
set -e
cd "$(dirname "$(readlink -f "$0")")/.."
rc=0
OWN_VIEW=1 NO_HELLO=1 sh web/check/run.sh ownview || rc=$?
[ "$rc" = 0 ] && echo "PASS: own view" || echo "FAIL: own view"
exit $rc
