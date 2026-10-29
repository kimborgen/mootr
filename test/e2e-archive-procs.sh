#!/bin/sh
# Archive and shutdown stop what an agent started (S-323), free: scripted Claude Code agents
# (test/fake-claude, no model) leave processes that ignore SIGTERM and SIGHUP behind, as a
# Codex sandbox's test run did. One is an orphan in a session of its own that carries the
# agent's STAM_AGENT_ID, left by an agent that then goes idle and is archived; the other is
# still in the agent's tree, in a session of its own with the id scrubbed from its env (bwrap
# --new-session's shape), when the agent is shut down mid-turn. Both must be gone after.
# What they started that isn't theirs stays: a stam daemon from `stam daemon start` (which
# drops the agent's id), one run by hand with the id inherited (spared as a daemon), and a
# process of another agent in the tree, with everything under it.
# Runs against its own daemon (test/lib.sh).
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
# loop.sh PIDFILE: ignores SIGTERM and SIGHUP, writes its pid, and runs until killed.
printf '%s\n' 'trap "" TERM HUP; echo $$ >"$1"; while :; do sleep 1; done' >"$DIR/loop.sh"
cat >"$TEST_TMP/procs.json" <<EOF2
{ "turns": [
  { "match": "orphan", "steps": [
    { "shell": "(. $TEST_TMP/second/test.env && $STAM daemon start >/dev/null 2>&1)" },
    { "shell": "(. $TEST_TMP/third/test.env && setsid $STAM daemon run </dev/null >>$TEST_TMP/third/daemon.log 2>&1 & echo \$! >$DIR/third.pid)" },
    { "shell": "(setsid sh $DIR/loop.sh $DIR/orphan.pid </dev/null >/dev/null 2>&1 &)" },
    { "reply": "DONE" } ] },
  { "match": "tree", "steps": [
    { "shell": "MOOTR_AGENT_ID=another STAM_AGENT_ID=another sh -c 'sh $DIR/loop.sh $DIR/under-other.pid & sh $DIR/loop.sh $DIR/other.pid' </dev/null >/dev/null 2>&1 & env -u STAM_AGENT_ID -u MOOTR_AGENT_ID setsid sh $DIR/loop.sh $DIR/tree.pid </dev/null >/dev/null 2>&1" },
    { "reply": "DONE" } ] }
] }
EOF2
fake_claude "$TEST_TMP/procs.json"
isolate
daemon_home second
daemon_home third
fail() { echo "FAIL: $1"; exit 1; }
# Kills only the pids this test's agents wrote, if the daemon left them.
leftovers() { for f in "$DIR"/*.pid; do [ -s "$f" ] && kill -KILL "$(cat "$f")" 2>/dev/null || true; done; }
trap 'leftovers; stam_test_cleanup' EXIT
# Waits for the pid file $1, then prints its pid.
pid_of() {
  i=0
  while [ ! -s "$1" ]; do
    i=$((i + 1)); [ "$i" -gt 300 ] && fail "no $1"
    sleep 0.1
  done
  cat "$1"
}
# Waits until process $1 is gone (or a zombie): the daemon sends a SIGKILL 5 s after the SIGTERM.
gone() {
  i=0
  while kill -0 "$1" 2>/dev/null && [ "$(ps -o stat= -p "$1" | cut -c1)" != Z ]; do
    i=$((i + 1)); [ "$i" -gt 300 ] && fail "$2"
    sleep 0.1
  done
}

echo "== archive stops an orphan that carries the agent's id"
A="e2e-procs-a-$(date +%s)"
"$STAM" spawn "$A" --model claude-haiku-5-5 --cwd "$DIR" "Start an orphan."
"$STAM" wait "$A" --until idle --timeout 60
orphan=$(pid_of "$DIR/orphan.pid")
kill -0 "$orphan" || fail "the orphan $orphan didn't start"
[ "$(ps -o sid= -p "$orphan" | tr -d ' ')" = "$orphan" ] || fail "the orphan isn't in a session of its own"
# The hand-run daemon starts async, so wait for it to answer before the archive.
third_up() { on third "$STAM" daemon status 2>/dev/null | grep -q "machine: 'third'"; }
wait_until third_up
"$STAM" archive "$A" --force >/dev/null
"$STAM" wait "$A" --until archived --timeout 30
gone "$orphan" "the orphan $orphan outlived the archive of $A"
# The orphan needed the SIGKILL, so the sweep is over: the daemons it spared still answer.
on second "$STAM" daemon status 2>/dev/null | grep -q "machine: 'second'" || fail "the daemon $A started with stam daemon start was stopped"
on third "$STAM" daemon status 2>/dev/null | grep -q "machine: 'third'" || fail "the daemon $A ran by hand was stopped"
tr '\0' '\n' <"/proc/$(cat "$TEST_TMP/second/daemon.pid")/environ" | grep -q '^STAM_AGENT_ID=' && fail "stam daemon start kept the agent's STAM_AGENT_ID"
tr '\0' '\n' <"/proc/$(cat "$DIR/third.pid")/environ" | grep -q '^STAM_AGENT_ID=' || fail "the hand-run daemon lost the id, so it proves nothing"

echo "== shutdown stops a child in the agent's tree, in a session of its own, without the id"
B="e2e-procs-b-$(date +%s)"
"$STAM" spawn "$B" --model claude-haiku-5-5 --cwd "$DIR" "Start a tree child."
tree=$(pid_of "$DIR/tree.pid")
other=$(pid_of "$DIR/other.pid")
under=$(pid_of "$DIR/under-other.pid")
tr '\0' '\n' <"/proc/$tree/environ" | grep -q '^\(MOOTR\|STAM\)_AGENT_ID=' && fail "the tree child still has an agent id"
"$STAM" kill "$B" >/dev/null
"$STAM" wait "$B" --until shut_down --timeout 20
gone "$tree" "the tree child $tree outlived the shutdown of $B"
# The tree child needed the SIGKILL, so the sweep is over.
kill -0 "$other" || fail "another agent's process $other in $B's tree was stopped"
kill -0 "$under" || fail "a process under another agent's ($under) in $B's tree was stopped"
echo "PASS e2e-archive-procs"
