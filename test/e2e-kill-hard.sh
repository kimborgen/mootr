#!/bin/sh
# A test run killed hard (SIGKILL to its whole process group, so no EXIT trap runs; or TERM, then KILL while its
# cleanup is still running, as the gate does) leaves no daemon, tmux server, or folder: test/test-watchdog.sh reaps them (S-1294). Free.
set -e
if [ "$1" = --child ]; then
  . "$(dirname "$(readlink -f "$0")")/lib.sh"
  isolate
  daemon_home twin
  daemon_up twin
  # Restarted through the CLI, not daemon_up: the new pid must still be recognised as this home's daemon.
  on twin "$STAM" daemon stop >/dev/null
  on twin "$STAM" daemon start >/dev/null
  for _i in $(seq 1 40); do on twin "$STAM" daemon status 2>/dev/null | grep -q "machine: 'twin'" && break; sleep 0.5; done
  printf '%s\n%s\n%s\n%s\n' "$TEST_TMP" "$STAM_PORT" "$STAM_TMUX_SOCKET" "$(cat "$STAM_HOME/daemon.pid")" >"$2"
  sleep 600
  exit 0
fi
OUT="$(mktemp "${TMPDIR:-/tmp}/stam-killhard-out.XXXXXX")"
trap 'rm -f "$OUT" "$OUT.hold"' EXIT
trap 'exit 130' INT TERM HUP
fail() { echo "FAIL: $1"; exit 1; }
# MODE kill: KILL at once. MODE term: TERM, then KILL once its cleanup holds at the last step (STAM_TEST_SWEEP_HOLD) (S-1294).
for MODE in kill term; do
  : >"$OUT"
  HOLD="$OUT.hold"
  rm -f "$HOLD"
  [ "$MODE" = term ] && export STAM_TEST_SWEEP_HOLD="$HOLD"
  setsid sh "$(readlink -f "$0")" --child "$OUT" </dev/null >/dev/null 2>&1 &
  unset STAM_TEST_SWEEP_HOLD
  RUN=$!
  for _i in $(seq 1 120); do [ -s "$OUT" ] && [ "$(wc -l <"$OUT")" -ge 4 ] && break; sleep 0.5; done
  [ "$(wc -l <"$OUT")" -ge 4 ] || { kill -s KILL -- "-$RUN" 2>/dev/null; fail "$MODE: the child run never started its daemons"; }
  { read -r tmp; read -r port; read -r sock; read -r dpid; } <"$OUT"
  kill -0 "$dpid" 2>/dev/null || fail "$MODE: daemon $dpid not running before the kill"
  # The run's own group only: the daemon is setsid'd out of it, which is the case under test.
  if [ "$MODE" = term ]; then kill -s TERM -- "-$RUN"; for _i in $(seq 1 600); do [ -e "$HOLD" ] && break; sleep 0.1; done; [ -e "$HOLD" ] || fail "term: cleanup never reached its final sweep"; fi
  kill -s KILL -- "-$RUN" 2>/dev/null || true
  for _i in $(seq 1 60); do [ ! -e "$tmp" ] && break; sleep 0.5; done
  [ ! -e "$tmp" ] || fail "$MODE: temp folder $tmp left behind"
  kill -0 "$dpid" 2>/dev/null && fail "$MODE: daemon $dpid still running"
  curl -s -m 2 "http://127.0.0.1:$port/api/health" >/dev/null && fail "$MODE: daemon still answering on $port"
  tmux -L "$sock" ls >/dev/null 2>&1 && fail "$MODE: tmux server $sock still running"
  pgrep -f "$tmp" >/dev/null && fail "$MODE: processes left: $(pgrep -af "$tmp")"
done
echo "PASS e2e-kill-hard"
