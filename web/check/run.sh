#!/bin/sh
# Runs one Chromium check against its own throwaway daemon (daemon.sh), then stops it:
#   web/check/run.sh CHECK [ARGS...]                  CHECK: phone, shots, or interactions
#   web/check/run.sh --remote storage CHECK [ARGS...] the same on storage (test/remote.sh)
# ARGS go to web/check/CHECK.mjs after its BASE_URL and OUT_DIR. Screenshots go to $OUT
# (default: a folder named in the output), copied back here from a remote run. daemon.sh's
# variables (NO_HELLO, SKIP_BUILD) pass through. Exits with the check's status.
cd "$(dirname "$(readlink -f "$0")")/../.." || exit 1
. test/tmpdir.sh
if [ "$1" = --remote ]; then
  [ -n "$2" ] && [ -n "$3" ] || { echo "usage: web/check/run.sh --remote SERVER CHECK [ARGS...]"; exit 2; }
  server=$2; shift 2
  exec sh test/remote.sh "$server" web/check/run.sh "$@"
fi
# One of the machine's test slots (scripts/test-slot.sh, S-692); the Chromium lock nests inside it.
[ -n "$STAM_TEST_NOSLOT" ] || sh scripts/test-slot.sh --held || exec sh scripts/test-slot.sh sh web/check/run.sh "$@"
CHECK=$1
[ -f "web/check/$CHECK.mjs" ] || { echo "usage: web/check/run.sh [--remote SERVER] phone|shots|interactions [ARGS...]"; exit 2; }
shift
# Screenshots are deleted on a pass unless OUT names a folder. KEEP=1 instead keeps the daemon running (S-1225).
AUTO=; [ -n "$OUT" ] || { AUTO=1; OUT="$(mktemp -d "$STAM_TEST_TMPDIR/stam-check-shots.XXXXXX")"; }
LOG="$(mktemp "$STAM_TEST_TMPDIR/stam-check-daemon.XXXXXX")"
# What the daemon starts and its home, recorded by daemon.sh for stop below (S-965).
PIDS="$(mktemp "$STAM_TEST_TMPDIR/stam-check-pids.XXXXXX")"
export CHECK_PIDS="$PIDS"
(cd web && [ -d node_modules ] || npm install >&2)
sh web/check/daemon.sh >"$LOG" 2>&1 &
DAEMON=$!
# Kills what daemon.sh recorded, by PID (never by name): the stub, registry, tmux server, and fake
# agents' panes (TERM, then KILL for any still alive), then removes this run's home. daemon.sh's own
# cleanup normally does this first; this catches what it missed (S-965).
# True when process $1's command line or environment names $2, this run's home. A PID recorded
# long ago can belong to another process by now; only one that names this home is ours to kill.
names_home() { { tr '\0' '\n' <"/proc/$1/cmdline"; tr '\0' '\n' <"/proc/$1/environ"; } 2>/dev/null | grep -qF "$2"; }
# A pane's shell may not name the home itself; its session's processes (the fake agent) do.
group_names_home() { names_home "$1" "$2" && return 0; for c in $(ps -o pid= -g "$1" 2>/dev/null); do names_home "$c" "$2" && return 0; done; return 1; }
stop_recorded() {
  [ -s "$PIDS" ] || return 0
  pids=$(sed -n 's/^\(pid\|tmux\) \([0-9][0-9]*\)$/\2/p' "$PIDS" | sort -u)
  panes=$(sed -n 's/^pane \([0-9][0-9]*\)$/\1/p' "$PIDS" | sort -u)
  home=$(sed -n 's/^home //p' "$PIDS")
  # No home recorded, or nothing to check against: kill nothing (an empty grep pattern matches all).
  [ -n "$home" ] || return 0
  keep= ; for p in $pids; do [ "$p" -gt 1 ] && names_home "$p" "$home" && keep="$keep $p"; done; pids=$keep
  keep= ; for p in $panes; do [ "$p" -gt 1 ] && group_names_home "$p" "$home" && keep="$keep $p"; done; panes=$keep
  # KEEP leaves this run's daemon, home, tmux server and fake agents running for debugging (S-965), and
  # prints the command that stops them (S-1225): TERM to the recorded PIDs and pane groups, wait, KILL
  # what's left, then remove the home and the tmux socket. The same guards as below. Kills nothing.
  if [ -n "$KEEP" ]; then
    socket=$(sed -n 's/^socket //p' "$PIDS")
    groups=$(printf '%s\n' $panes | sort -u | tr '\n' ' ')
    allp=$(printf '%s\n' $pids $panes | sort -u | tr '\n' ' ')
    stop='for p in '"$allp"'; do kill -s TERM $p 2>/dev/null; done; for g in '"$groups"'; do kill -s TERM -- -$g 2>/dev/null; done; for _i in 1 2 3 4 5 6 7 8 9 10; do alive=; for p in '"$allp"'; do kill -0 $p 2>/dev/null && alive=1; done; [ -z "$alive" ] && break; sleep 0.2; done; for g in '"$groups"'; do kill -s KILL -- -$g 2>/dev/null; done; for p in '"$allp"'; do kill -s KILL $p 2>/dev/null; done; case '"$home"' in */stam-test.*) [ -f '"$home"'/owner ] && rm -rf '"$home"' ;; esac'
    [ -z "$socket" ] || stop="$stop; rm -f ${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$socket"
    echo "kept $home running; stop it with: sh -c '$stop'"
    return 0
  fi
  for p in $panes; do [ "$p" -gt 1 ] && kill -s TERM -- "-$p" 2>/dev/null; done
  for p in $pids $panes; do [ "$p" -gt 1 ] && kill -s TERM "$p" 2>/dev/null; done
  for _i in 1 2 3 4 5 6 7 8 9 10; do
    alive=
    for p in $pids $panes; do [ "$p" -gt 1 ] && kill -0 "$p" 2>/dev/null && alive=1; done
    [ -z "$alive" ] && break
    sleep 0.2
  done
  for p in $panes; do [ "$p" -gt 1 ] && kill -s KILL -- "-$p" 2>/dev/null; done
  for p in $pids $panes; do [ "$p" -gt 1 ] && kill -s KILL "$p" 2>/dev/null; done
  # Only the home daemon.sh created (it has lib.sh's owner file), by its recorded path, never a glob.
  case $home in "$STAM_TEST_TMPDIR"/stam-test.*) [ -f "$home/owner" ] && rm -rf "$home" ;; esac
}
stop() { kill $DAEMON 2>/dev/null; wait $DAEMON 2>/dev/null || true; stop_recorded; rm -f "$LOG" "$PIDS"; }
trap stop EXIT
trap 'exit 130' INT TERM HUP
for _i in $(seq 1 180); do grep -q '^URL=' "$LOG" && break; kill -0 $DAEMON 2>/dev/null || break; sleep 1; done
# A failed web build (daemon.sh's BUILD_FAILED=1) reads as a build failure, with its output last (S-2162).
grep -q '^URL=' "$LOG" || { sed '/^BUILD_FAILED=1$/d' "$LOG"; grep -q '^BUILD_FAILED=1$' "$LOG" && echo "FAIL: the web build failed (see the error above)" || echo "FAIL: the check daemon didn't start"; exit 1; }
echo "screenshots: $OUT"
rc=0
node "web/check/$CHECK.mjs" "$(sed -n 's/^URL=//p' "$LOG")" "$OUT" "$@" || rc=$?
[ "$rc" = 0 ] && [ -n "$AUTO" ] && [ -z "$KEEP" ] && rm -rf "$OUT" || echo "screenshots kept: $OUT"
exit $rc
