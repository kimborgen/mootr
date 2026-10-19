#!/bin/sh
# Waits Codex and OpenCode create, with a live agent: a background `sleep` and a sub-agent
# that sleeps longer make the agent 'waiting' with two job waits (source 'hook'); the
# command's wait clears when it ends, the sub-agent's when it finishes, and the agent is
# idle with no waits after. HARNESS=opencode (the default, DeepSeek V4 Flash, well under
# a cent) or HARNESS=codex (gpt-6.1-sol at effort low; Codex usage is scarce, so only by
# hand). Runs against its own daemon (test/lib.sh). Takes about three minutes.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
# Calls OpenRouter with a real model (lib.sh): the live test gets the real key.
STAM_TEST_REAL_KEY=1
isolate
H="${HARNESS:-opencode}"
T=$(date +%s); N="e2e-waits-$H-$T"; DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
waits() { "$STAM" show "$N" 2>/dev/null | python3 -c "
import json,sys
a=json.load(sys.stdin)
print(a['activity'], ' '.join(sorted(w['kind']+':'+w['source'] for w in a.get('waits') or [])))"; }
# Polls up to $2 seconds until the agent's activity and waits read exactly $1.
until_waits() {
  for i in $(seq 1 "$2"); do [ "$(waits)" = "$1" ] && return 0; sleep 1; done
  echo "FAIL: expected '$1', got '$(waits)'"; "$STAM" events "$N" | tail -20; exit 1
}

if [ "$H" = codex ]; then
  "$STAM" spawn "$N" --harness codex --model "${MODEL:-gpt-6.1-sol}" --effort low --cwd "$DIR" --role "Waits test agent." \
    "Do exactly these two things, then end your turn at once without waiting for either: 1) Start the shell command \`sleep 50; echo done\` so that it keeps running in the background after your turn (use a short yield so you get control back while it still runs; do not poll it). 2) Spawn one sub-agent whose task is: run \`sleep 90\` and then reply ok. Do not wait for the sub-agent. Then reply 'started' and end your turn."
else
  "$STAM" spawn "$N" --harness opencode --model "${MODEL:-openrouter/~deepseek/deepseek-v4-flash-latest}" --cwd "$DIR" --role "Waits test agent." \
    "Do exactly these two things, then end your turn at once without waiting: 1) Run the shell command \`sleep 40\` with background set to true. 2) Start a subagent with the subagent tool, background true, description 'sleeper', whose prompt is: Run the shell command \`sleep 80\` (not in the background), then reply ok. When a completion notice arrives later, reply with one short line."
fi
"$STAM" wait "$N" --until working --timeout 60

echo "-- the turn ends with a background command and a sub-agent running: waiting, two hook job waits"
until_waits "waiting job:hook job:hook" 120

echo "-- the command ends: its wait clears, the sub-agent's remains"
until_waits "waiting job:hook" 90

echo "-- the sub-agent finishes: idle, no waits"
until_waits "idle " 150

echo "PASS e2e-waits-harness ($H)"
