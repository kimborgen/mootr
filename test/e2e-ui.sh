#!/bin/sh
# The web UI's drag interactions in headless Chromium, on a throwaway daemon with a seeded
# agent and mail (web/check/daemon.sh, with no agent turns, so no spend): tabs dragged
# between panes, to split edges, and reordered; agents dragged in from the tree; ranks
# dragged and moved with arrows and sent; notes written on decisions and sent; agents added from the + menu and its panel; agent types added by name and edited in Settings; decision steps listed, turned on and off, added, tested on recent examples, and their logs read in Settings; writing to a chief of staff from the overlay and the prompt input; a prompt sent as mail from the prompt input's Direct/Mail toggle; ITSAs opened, edited, and added from the Issues section and an ITSA's world; ITSA cards dragged across and within board columns; a terminal keeping its size while the prompt input grows and while the window is dragged; an agent arranging the layout and every open page, the phone too, following it live; requirements turned on, seeded with verdicts through the decide stub, and their tree, world, waiver, preview, ITSA panel, compliance matrix (cards on a phone), and Settings › Requirements with Import checked at 360 px and on the desktop. Screenshots go to $OUT (default: a folder named in
# the output).
set -e
HERE="$(dirname "$(readlink -f "$0")")"
ROOT="$HERE/.."
. "$ROOT/test/tmpdir.sh"
# Screenshots are deleted on a pass unless KEEP=1 or OUT names a folder.
AUTO=; [ -n "$OUT" ] || { AUTO=1; OUT="$(mktemp -d "$STAM_TEST_TMPDIR/stam-ui-shots.XXXXXX")"; }
LOG="$(mktemp "$STAM_TEST_TMPDIR/stam-ui-daemon.XXXXXX")"
(cd "$ROOT/web" && [ -d node_modules ] || npm install >&2)
NO_HELLO=1 sh "$ROOT/web/check/daemon.sh" >"$LOG" 2>&1 &
DAEMON=$!
stop() { kill $DAEMON 2>/dev/null; wait $DAEMON 2>/dev/null || true; rm -f "$LOG"; }
# kill_tree PID: the check's process and its children (a flock waiting on the Chromium lock),
# by PID, leaves nothing behind when the wrapper is signalled.
kill_tree() { for _c in $(ps -o pid= --ppid "$1" 2>/dev/null); do kill_tree "$_c"; done; kill "$1" 2>/dev/null; }
trap stop EXIT
# A signal with no trap ends the shell without running the EXIT trap, and the daemon outlives it.
trap 'exit 130' INT TERM HUP
# A failed web build (daemon.sh's BUILD_FAILED=1) reads as a build failure, with its output last (S-2162).
daemon_down() { sed '/^BUILD_FAILED=1$/d' "$LOG"; grep -q '^BUILD_FAILED=1$' "$LOG" && echo "FAIL: the web build failed (see the error above)" || echo "FAIL: the check daemon didn't start"; exit 1; }
for _i in $(seq 1 120); do grep -q '^URL=' "$LOG" && break; kill -0 $DAEMON 2>/dev/null || daemon_down; sleep 1; done
grep -q '^URL=' "$LOG" || daemon_down
URL="$(sed -n 's/^URL=//p' "$LOG")"
echo "screenshots: $OUT"
rc=0
# In the background, so a signal's trap runs at once rather than after the check ends.
node "$ROOT/web/check/interactions.mjs" "$URL" "$OUT" ${UI_FLOWS:-tabs rank notes spawn types tools steps archive cos mail maillink search itsa board work term machines rules back layout requirements permissions} &
CHECK=$!
trap 'kill_tree $CHECK; exit 130' INT TERM HUP
wait $CHECK || rc=$?
trap - EXIT
stop
[ "$rc" = 0 ] && [ -n "$AUTO" ] && [ -z "$KEEP" ] && rm -rf "$OUT" || echo "screenshots kept: $OUT"
[ "$rc" = 0 ] && echo "PASS: ui interactions" || echo "FAIL: ui checks"
exit $rc
