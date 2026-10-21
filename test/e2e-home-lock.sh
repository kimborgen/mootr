#!/bin/sh
# One daemon per STAM_HOME (S-346): a second daemon on a home refuses to start before it touches the
# DB or tmux, whatever started the first (the daemon's own command, or a script that calls
# runDaemon). It exits non-zero, names the holder's pid, and leaves the rows and tmux sessions of
# the running one alone. Of two starts at once exactly one runs. A holder killed with SIGKILL
# releases the home, and another home isn't blocked. A Claude Code agent on the scripted fake
# (test/fake-claude): no model, no network, free. Waits on state (processes, health), bounded.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/home-lock.json" <<'EOF2'
{ "turns": [ { "match": "/.*/", "steps": [ { "reply": "OK" } ] } ] }
EOF2
fake_claude "$TEST_TMP/home-lock.json"
isolate
pids=""
fail() { echo "FAIL: $1"; exit 1; }
# Direct starts (no daemon.pid) are tracked in $pids. Any exit, a failed wait_until included, kills and
# reaps them, then runs the cleanup that lib.sh's trap would have run.
reap() { for p in $pids; do kill "$p" 2>/dev/null || true; wait "$p" 2>/dev/null || true; done; stam_test_cleanup; }
trap reap EXIT
# Row counts of what a boot writes: unchanged means the second daemon wrote nothing. The agent's own
# hook events (hook:*) are left out: its harness reports them on its own clock, after `wait --until idle`
# has returned, so counting them made the snapshot race the agent under load (S-882).
rows() { curl -sf -m 5 -H "authorization: Bearer $(cat "$STAM_HOME/token")" "$STAM_URL/api/test/counts"; }
sessions() { tmux -L "$STAM_TMUX_SOCKET" list-sessions -F '#{session_name}' 2>/dev/null | sort; }
# A process that has exited, or is a zombie waiting to be reaped.
exited() { ! kill -0 "$1" 2>/dev/null || grep -q '^State:[[:space:]]*Z' "/proc/$1/status" 2>/dev/null; }
# Waits up to 20 s for PID to exit; it returns whether it did, so the caller can clean up.
await_exit() {
  for _i in $(seq 1 100); do exited "$1" && return 0; sleep 0.2; done
  exited "$1"
}
# Whether HOME's daemon answers as itself.
up() { on "$1" "$STAM" daemon status 2>/dev/null | grep -q "machine: '$1'"; }
# A daemon run in the background from HOME's settings: its pid is $!.
run_bg() { (use "$1" && exec "$STAM" daemon run) >"$TEST_TMP/$1.$2.log" 2>&1 & }

DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
"$STAM" spawn cl --harness claude --model claude-sonnet-5-5 --cwd "$DIR" --role "Test agent." >/dev/null
# The agent is idle at SessionStart, before its first prompt is delivered: wait for the delivery
# event, then for the turn to end, so the row snapshot below isn't taken mid-boot (S-882).
event_seen() { [ "$(curl -sf -m 5 -H "authorization: Bearer $(cat "$STAM_HOME/token")" "$STAM_URL/api/test/events?type=first-prompt:delivered" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')" -ge 1 ]; }
wait_until event_seen
"$STAM" wait cl --until idle --timeout 60 >/dev/null
main_pid=$(cat "$TEST_TMP/main/daemon.pid")
before_rows=$(rows)
[ -n "$before_rows" ] || fail "can't count rows"
before_sessions=$(sessions)
[ -n "$before_sessions" ] || fail "no agent session to compare"

# 1. A second daemon on the running home.
run_bg main second
second=$!
pids="$pids $second"
await_exit "$second" || fail "a second daemon on the same home is still running"
rc=0
wait "$second" || rc=$?
pids=""
[ "$rc" != 0 ] || fail "the second daemon exited 0"
grep -q "another stam daemon (pid $main_pid)" "$TEST_TMP/main.second.log" || fail "no refusal naming pid $main_pid: $(cat "$TEST_TMP/main.second.log")"
[ "$(rows)" = "$before_rows" ] || fail "the second daemon changed rows: $before_rows -> $(rows)"
[ "$(sessions)" = "$before_sessions" ] || fail "the second daemon changed tmux sessions"
up main || fail "the running daemon stopped answering"

# 2. A holder that is not the CLI's own child (daemon_up starts it detached), as in the S-346 incident: a second daemon
# on its home is refused, naming the holder's pid.
daemon_home wrapped
daemon_up wrapped
wrapper=$(cat "$TEST_TMP/wrapped/daemon.pid")
run_bg wrapped second
w2=$!
pids="$pids $w2"
await_exit "$w2" || fail "a second daemon on a wrapper's home is still running"
rc=0
wait "$w2" || rc=$?
pids=""
[ "$rc" != 0 ] || fail "a second daemon started beside a wrapper's holder"
grep -q "another stam daemon (pid $wrapper)" "$TEST_TMP/wrapped.second.log" || fail "no refusal naming the wrapper's pid $wrapper: $(cat "$TEST_TMP/wrapped.second.log")"
# SIGKILL: no exit handler runs, and the home is still free for the next start.
kill -9 "$wrapper"
await_exit "$wrapper" || fail "the killed holder didn't exit"
wait "$wrapper" 2>/dev/null || true
pids=""
run_bg wrapped third
w3=$!
pids="$w3"
wait_until up wrapped
kill "$w3"
await_exit "$w3" || fail "the restarted daemon didn't exit"
wait "$w3" 2>/dev/null || true
pids=""

# 3. Two starts at once: exactly one runs.
daemon_home race
run_bg race a
a=$!
run_bg race b
b=$!
pids="$a $b"
for _i in $(seq 1 100); do { exited "$a" || exited "$b"; } && break; sleep 0.2; done
if exited "$a" && exited "$b"; then fail "both simultaneous starts exited"; fi
if exited "$a"; then loser=$a; winner=$b; else loser=$b; winner=$a; fi
rc=0
wait "$loser" || rc=$?
[ "$rc" != 0 ] || fail "the losing start exited 0"
grep -q "another stam daemon" "$TEST_TMP/race.$([ "$loser" = "$a" ] && echo a || echo b).log" || fail "the losing start didn't say another daemon runs"
wait_until up race
kill "$winner"
await_exit "$winner" || fail "the winner didn't exit"
wait "$winner" 2>/dev/null || true
pids=""

# 4. Leftovers that name no live stam daemon don't block a start: a dead pid, and a live pid that
# is some other process (a reused pid). Another home, so main keeps running alongside.
daemon_home stale
sleep 0 &
dead=$!
wait "$dead"
printf '%s\n' "$dead" >"$TEST_TMP/stale/daemon.lock"
daemon_up stale

daemon_home reused
sleep 300 &
other=$!
pids="$other"
printf '%s\n' "$other" >"$TEST_TMP/reused/daemon.lock"
daemon_up reused
kill "$other" 2>/dev/null || true
wait "$other" 2>/dev/null || true
other=""
pids=""

# 5. A stopped daemon releases its home: a start after the stop is not refused.
daemon_stop main
daemon_up main
echo "PASS home-lock"
