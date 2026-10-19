#!/bin/sh
# Sending to the executive assistant from the web UI in headless Chromium: the prompt input's
# assistant button and the Alt+A overlay, on a throwaway daemon whose agents run the fake
# Claude Code (web/check/daemon.sh), so no model runs and nothing is spent. Checks the
# assistant starts, gets both messages, and answers. Screenshots go to $OUT.
set -e
HERE="$(dirname "$(readlink -f "$0")")"
ROOT="$HERE/.."
. "$ROOT/test/tmpdir.sh"
# Screenshots are deleted on a pass unless KEEP=1 or OUT names a folder.
AUTO=; [ -n "$OUT" ] || { AUTO=1; OUT="$(mktemp -d "$STAM_TEST_TMPDIR/stam-ui-shots.XXXXXX")"; }
LOG="$(mktemp "$STAM_TEST_TMPDIR/stam-ui-daemon.XXXXXX")"
(cd "$ROOT/web" && [ -d node_modules ] || npm install >&2)
sh "$ROOT/web/check/daemon.sh" >"$LOG" 2>&1 &
DAEMON=$!
stop() { kill $DAEMON 2>/dev/null; wait $DAEMON 2>/dev/null || true; rm -f "$LOG"; }
# kill_tree PID: the check's process and its children (a flock waiting on the Chromium lock),
# by PID, leaves nothing behind when the wrapper is signalled.
kill_tree() { for _c in $(ps -o pid= --ppid "$1" 2>/dev/null); do kill_tree "$_c"; done; kill "$1" 2>/dev/null; }
trap stop EXIT
# A signal with no trap ends the shell without running the EXIT trap, and the daemon outlives it.
trap 'exit 130' INT TERM HUP
for _i in $(seq 1 120); do grep -q '^URL=' "$LOG" && break; kill -0 $DAEMON 2>/dev/null || { cat "$LOG"; echo "FAIL: the check daemon didn't start"; exit 1; }; sleep 1; done
grep -q '^URL=' "$LOG" || { cat "$LOG"; echo "FAIL: the check daemon didn't start"; exit 1; }
URL="$(sed -n 's/^URL=//p' "$LOG")"
echo "screenshots: $OUT"
rc=0
# In the background, so a signal's trap runs at once rather than after the check ends.
node "$ROOT/web/check/interactions.mjs" "$URL" "$OUT" assistant &
CHECK=$!
trap 'kill_tree $CHECK; exit 130' INT TERM HUP
wait $CHECK || rc=$?
trap - EXIT
stop
[ "$rc" = 0 ] && [ -n "$AUTO" ] && [ -z "$KEEP" ] && rm -rf "$OUT" || echo "screenshots kept: $OUT"
[ "$rc" = 0 ] && echo "PASS: ui assistant" || echo "FAIL: ui checks"
exit $rc
