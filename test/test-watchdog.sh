#!/bin/sh
# Reaps a test run's daemons when the run is killed hard (S-1294). Usage: test-watchdog.sh TEST_TMP OWNER_PID
# lib.sh starts it detached (setsid), so it outlives a SIGKILL of the run's process group, which skips the
# run's EXIT trap (the gate kills a group 3 s after its TERM, mid-cleanup). It waits for OWNER_PID to
# end, then, if TEST_TMP is still there (a clean exit removed it), stops each daemon by the pid in its
# home, kills its tmux server and the panes' groups, and removes TEST_TMP. Nothing is matched by name.
T=$1
O=$2
OS=$3
# Start time of PID (field 22 of /proc/PID/stat), empty when it is gone: with the pid it names the owner run, so a
# pid the kernel has reused never matches.
stt() { sed 's/^.*) //' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f20; }
# isdaemon PID: PID's environment names this home, so a pid the kernel reused for another process never matches, and a
# daemon restarted by the test (a new pid in daemon.pid) still does.
isdaemon() { tr '\0' '\n' <"/proc/$1/environ" 2>/dev/null | grep -qx "STAM_HOME=$STAM_HOME"; }
# sig SIG PID: signals PID only while it is this home's daemon.
sig() { isdaemon "$2" && kill -s "$1" "$2" 2>/dev/null; }
case "$O" in '' | *[!0-9]*) exit 2 ;; esac
[ -n "$OS" ] || exit 2
[ -d "$T" ] && [ -f "$T/owner" ] || exit 2
echo $$ >"$T/watchdog.pid" # lib.sh stops it on a clean exit
while [ "$(stt "$O")" = "$OS" ] && [ -d "$T" ]; do sleep 1; done
[ -d "$T" ] || exit 0
# A later run with the same pid number would have written its own owner file elsewhere; this one still names $O.
grep -qx "pid=$O" "$T/owner" 2>/dev/null || exit 0
for env in "$T"/*/test.env; do
  [ -f "$env" ] || continue
  (
    . "$env"
    dpid=$(cat "$STAM_HOME/daemon.pid" 2>/dev/null)
    case "$dpid" in '' | *[!0-9]*) dpid= ;; esac
    panes=
    for p in $(tmux -L "$STAM_TMUX_SOCKET" list-panes -a -F '#{pane_pid}' 2>/dev/null); do
      case $p in '' | *[!0-9]* | 0 | 1) continue ;; esac
      panes="$panes $p"
    done
    [ -n "$dpid" ] && sig TERM "$dpid"
    tmux -L "$STAM_TMUX_SOCKET" kill-server 2>/dev/null
    for p in $panes; do kill -s TERM -- "-$p" 2>/dev/null; done
    for _i in 1 2 3 4 5 6 7 8 9 10; do
      alive=
      [ -n "$dpid" ] && isdaemon "$dpid" && alive=1
      for p in $panes; do kill -0 "$p" 2>/dev/null && alive=1; done
      [ -z "$alive" ] && break
      sleep 0.2
    done
    for p in $panes; do kill -s KILL -- "-$p" 2>/dev/null; done
    [ -n "$dpid" ] && sig KILL "$dpid"
    rm -f "${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$STAM_TMUX_SOCKET"
  )
done
# Anything still naming the folder (a stub, a Codex app-server), then the folder.
pkill -KILL -f "$T/" 2>/dev/null
rm -rf "$T"
