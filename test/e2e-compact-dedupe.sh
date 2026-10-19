#!/bin/sh
# S-273, free: an ordinary compaction of a Claude Code agent (stam compact on an idle agent) is not read as an
# exit while it runs, and a compact right after it is dropped. Claude Code agents on the scripted fake
# (test/fake-claude, no model). The compaction is held open with a flag file so the daemon's reconcile runs
# while the harness is down on purpose.
# Runs against its own daemon (test/lib.sh).
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/compact-dedupe.json" <<'EOF2'
{ "turns": [
  { "match": "Reply with exactly: ready", "steps": [ { "reply": "ready" } ] }
] }
EOF2
fake_claude "$TEST_TMP/compact-dedupe.json"
isolate
field() { "$STAM" show "$1" | grep "\"$2\"" | head -1 | sed 's/.*: //; s/^"//; s/",*$//; s/,$//'; }
events_has() { "$STAM" events "$1" | grep -q "$2"; }
# Bounded: each try is a state check on the daemon, so a state is seen as soon as it is reached.
poll() { n=$1; shift; while [ "$n" -gt 0 ]; do "$@" && return 0; n=$((n - 1)); done; return 1; }
compacting() { "$STAM" show "$1" | grep -q '"activity_detail": "compacting'; }

N="e2e-cd-n-$(date +%s)"; DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
"$STAM" spawn "$N" --model claude-sonnet-5-5 --cwd "$DIR" --role "Compact test agent." "Reply with exactly: ready"
"$STAM" wait "$N" --until idle --timeout 90

echo "-- an ordinary compaction held open is not read as an exit"
touch "$STAM_HOME/fake-compact-hold"
"$STAM" compact "$N" >"$TEST_TMP/compact.out" 2>&1 &
CPID=$!
poll 200 compacting "$N" || { echo "FAIL: $N never showed compacting"; exit 1; }
# Wait for a reconcile tick that ran while the compaction is held open.
poll 200 events_has "$N" 'reconcile:held' || { echo "FAIL: no reconcile tick during the compaction"; exit 1; }
# One held event per compaction, however many ticks ran while it was held (S-273).
test "$("$STAM" events "$N" | grep -c 'reconcile:held' || true)" = 1 || { echo "FAIL: reconcile:held more than once for one compaction"; exit 1; }
test "$(field "$N" lifecycle)" = active || { echo "FAIL: $N is $(field "$N" lifecycle) during the compaction"; exit 1; }
test "$("$STAM" events "$N" | grep -c 'exited' || true)" = 0 || { echo "FAIL: $N read as exited during the compaction"; exit 1; }
rm -f "$STAM_HOME/fake-compact-hold"
# The CLI call may give up while the compaction is held; the agent's state is what counts.
wait "$CPID" || true
"$STAM" wait "$N" --until idle --timeout 90
test "$(field "$N" lifecycle)" = active || { echo "FAIL: $N is $(field "$N" lifecycle) after the compaction"; exit 1; }
test "$("$STAM" events "$N" | grep -c 'exited' || true)" = 0 || { echo "FAIL: $N read as exited after the compaction"; exit 1; }

echo "-- a compact right after the compaction and its resume is dropped"
"$STAM" compact "$N" >"$TEST_TMP/dropped.out" 2>&1 || true
grep -q "dropped" "$TEST_TMP/dropped.out" || { echo "FAIL: second compact not dropped: $(cat "$TEST_TMP/dropped.out")"; exit 1; }
events_has "$N" 'compact:dropped' || { echo "FAIL: no compact:dropped event"; exit 1; }
echo "PASS"
