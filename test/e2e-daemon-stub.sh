#!/bin/sh
# S-668: web/check/daemon.sh takes the decide stub (and the fake registry) with it. Start it, wait for
# its URL line (and, for a DAEMON_MAX_LIFE=3 run, its own end), check the stub runs, kill the script by PID with TERM, then with KILL on a second run
# (no trap runs; the stub exits on its own when its parent is gone), and assert the stub is gone.
set -e
HERE="$(dirname "$(readlink -f "$0")")"
ROOT="$HERE/.."
. "$ROOT/test/tmpdir.sh"
WORK="$(mktemp -d "$STAM_TEST_TMPDIR/stam-daemonstub.XXXXXX")"
PID=
trap '[ -z "$PID" ] || kill "$PID" 2>/dev/null; rm -rf "$WORK"' EXIT
trap 'exit 130' INT TERM HUP

# stub_pids PID: the decide stubs that are children of PID (the script's own).
stub_pids() { for c in $(ps -o pid= --ppid "$1" 2>/dev/null); do
  case "$(tr '\0' ' ' <"/proc/$c/cmdline" 2>/dev/null)" in *decide-stub.mjs*) echo "$c" ;; esac
done; }
gone() { for _i in $(seq 1 100); do kill -0 "$1" 2>/dev/null || return 0; sleep 0.1; done; return 1; }

for SIG in TERM KILL LIFE; do
  LOG="$WORK/$SIG.log"
  LIFE=; [ "$SIG" != LIFE ] || LIFE=1
  DAEMON_MAX_LIFE=$([ -n "$LIFE" ] && echo 3 || echo 7200) SKIP_BUILD=1 NO_HELLO=1 sh "$ROOT/web/check/daemon.sh" >"$LOG" 2>&1 &
  PID=$!
  for _i in $(seq 1 300); do grep -q '^URL=' "$LOG" && break; kill -0 "$PID" 2>/dev/null || { cat "$LOG"; echo "FAIL: daemon.sh exited early"; exit 1; }; sleep 0.5; done
  grep -q '^URL=' "$LOG" || { cat "$LOG"; echo "FAIL: daemon.sh never printed its URL"; exit 1; }
  STUB=$(stub_pids "$PID" | head -1)
  [ -n "$STUB" ] || { echo "FAIL: no decide stub under daemon.sh ($SIG run)"; exit 1; }
  FOLDER=$(tr '\0' '\n' <"/proc/$STUB/cmdline" | tail -1); FOLDER=${FOLDER%/stub}
  # LIFE: DAEMON_MAX_LIFE=3 ends the script on its own, with its children already dead or not; the
  # cleanup must still run (a failing kill under set -e once aborted it), and the exit code is 0.
  if [ "$SIG" = LIFE ]; then
    gone "$PID" || { echo "FAIL: daemon.sh outlived DAEMON_MAX_LIFE=3"; exit 1; }
    wait "$PID" || { echo "FAIL: daemon.sh exited with $? at the end of its life"; exit 1; }
    PID=
    [ ! -e "$FOLDER" ] || { echo "FAIL: $FOLDER left behind after the script's life ended"; exit 1; }
  else
    kill -s "$SIG" "$PID"
  fi
  gone "$STUB" || { kill "$STUB" 2>/dev/null; echo "FAIL: the stub $STUB outlived daemon.sh after $SIG"; exit 1; }
  [ -z "$PID" ] || wait "$PID" 2>/dev/null || true
  PID=
  # A script killed hard leaves its daemon, tmux server and folder (no trap ran): stop them here,
  # by the pid file and the socket named in the folder, and assert nothing is left.
  if [ -d "$FOLDER" ]; then
    ( . "$FOLDER/ui/test.env" 2>/dev/null
      dpid=$(cat "$STAM_HOME/daemon.pid" 2>/dev/null)
      case "$dpid" in '' | *[!0-9]*) ;; *) kill "$dpid" 2>/dev/null ;; esac
      pids=$(tmux -L "$STAM_TMUX_SOCKET" list-panes -a -F '#{pane_pid}' 2>/dev/null)
      tmux -L "$STAM_TMUX_SOCKET" kill-server 2>/dev/null
      for p in $pids; do kill -s TERM -- "-$p" 2>/dev/null; done
      echo "$pids" >"$WORK/panes"
      rm -f "${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$STAM_TMUX_SOCKET" ) || true
    rm -rf "$FOLDER"
  fi
  [ ! -e "$FOLDER" ] || { echo "FAIL: $FOLDER left behind after the $SIG run"; exit 1; }
  # No pane process group of that run is left (the fake agents' command lines name the worktree, not
  # the folder, so check by pane pid).
  for p in $(cat "$WORK/panes" 2>/dev/null); do
    for _i in $(seq 1 30); do kill -0 "$p" 2>/dev/null || break; sleep 0.1; done
    # The fake agent can take longer than the wait to leave on TERM: end its group hard (our own pane).
    ! kill -0 "$p" 2>/dev/null || { kill -s KILL -- "-$p" 2>/dev/null || true; sleep 0.2; }
    ! kill -0 "$p" 2>/dev/null || { echo "FAIL: pane process $p left after the $SIG run"; exit 1; }
  done
  echo "ok: the stub is gone after $SIG"
done
