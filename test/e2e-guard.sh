#!/bin/sh
# The broad-kill guard end to end, on the scripted fake (test/fake-claude, no model, free): a
# Bash call that kills by pgrep is refused by the PreToolUse hook (`stam guard`) before it runs,
# so the process it names survives and the agent gets the refusal as its tool result. A kill by
# PID still goes through. The process is a throwaway this test starts, found by a marker in its
# command line, so even a broken guard could only reach this test's own process.
# Runs against its own daemon (test/lib.sh). Nothing sleeps for a state: the checks poll, bounded.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
MARK="GUARD-E2E-$(date +%s)-$$"
PIDF="$TEST_TMP/guard-sleeper.pid"
cat >"$TEST_TMP/guard.json" <<EOF2
{ "turns": [
  { "match": "guard test", "steps": [
    { "shell": "kill \$(pgrep -f $MARK)", "save": "refusal" },
    { "shell": "kill -0 \$(cat $PIDF) && echo SURVIVED" },
    { "shell": "kill \$(cat $PIDF)" },
    { "reply": "killed by pid" } ] } ] }
EOF2
fake_claude "$TEST_TMP/guard.json"
isolate
N="e2e-guard-$(date +%s)"; DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"

# The throwaway process the agent must not reach by a broad kill.
python3 -c 'import time; time.sleep(300)' "$MARK" &
echo $! >"$PIDF"
SLEEPER=$(cat "$PIDF")
alive() { kill -0 "$SLEEPER" 2>/dev/null; }
alive || { echo "FAIL: the throwaway process did not start"; exit 1; }

"$STAM" spawn "$N" --harness claude --model claude-haiku-5-5 --cwd "$DIR" --role "Guard test agent." "Begin the guard test."
"$STAM" wait "$N" --until idle --timeout 60 >/dev/null

echo "-- the pgrep kill is refused before it runs: the refusal is the tool result, and the process survives it"
TR=$(grep -rl "Refused: broad process kill" "$STAM_HOME" 2>/dev/null | head -1)
[ -n "$TR" ] || { echo "FAIL: no refusal in the agent's transcript"; "$STAM" show "$N" | tail -30; exit 1; }
grep -q SURVIVED "$TR" || { echo "FAIL: the process did not survive the refused kill"; exit 1; }

echo "-- the kill by PID that followed went through"
for i in $(seq 1 40); do alive || break; sleep 0.5; done
alive && { echo "FAIL: the kill by PID did not stop the process"; exit 1; }
wait "$SLEEPER" 2>/dev/null || true

echo "PASS e2e-guard"
