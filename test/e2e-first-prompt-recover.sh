#!/bin/sh
# S-759, free: a spawn a daemon restart cut off before its first prompt was delivered leaves
# the agent 'starting' with the prompt stored (first_prompt) and no delivery marker. The
# daemon's first reconcile pass re-delivers it with a fresh launch instead of waiting for the
# starting timeout, and the prompt reaches the harness. An agent whose launch already got its
# prompt in, and one from before the markers, are left alone. Runs against its own daemon
# (test/lib.sh); nothing waits on a timer beyond reconcile's own tick.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home rec
WORK="$TEST_TMP/work"
mkdir -p "$WORK"
cat >"$TEST_TMP/rec.json" <<'EOF'
{ "turns": [
  { "match": "recover the lost prompt", "steps": [
    { "shell": "printf recovered > recovered.txt" },
    { "reply": "DONE" } ] } ] }
EOF
fake_claude "$TEST_TMP/rec.json"
SEED="$TEST_TMP/seed-first-prompt.mjs"
cat >"$SEED" <<'EOF'
const db = await import(process.env.ROOT + '/src/db.ts');
db.open();
const work = process.env.WORK;
const ws = JSON.stringify({ spec: { kind: 'dir', path: work }, cwd: work });
const seed = (id, events) => {
  db.createAgent({ id, name: id, role: 'dev', machine: 'rec', harness: 'claude', model: null, effort: null, cwd: work, parent_id: id === 'sup' ? null : 'sup', session_id: '11111111-1111-4111-8111-111111111111' });
  db.updateAgent(id, { lifecycle: 'active', activity: 'starting', activity_detail: 'with prompt', workspace: ws, first_prompt: 'recover the lost prompt' });
  for (const e of events) db.addEvent(id, e);
};
seed('sup', []);
// The daemon restarted mid-spawn: the prompt is stored and pending, nothing delivered it.
seed('lost', ['first-prompt:pending']);
// The launch got its prompt in before the restart: marked delivered, so it is left alone.
seed('delivered', ['first-prompt:pending', 'first-prompt:delivered']);
// Spawned before the markers existed: no pending marker, so it is left to the starting timeout.
seed('unmarked', []);
EOF
# A timeout long enough that the starting-dead path can never be what recovers 'lost'.
printf '{ "peers": [], "startingTimeoutMinutes": 600 }\n' >"$TEST_TMP/rec/settings.json"
ROOT="$ROOT" WORK="$WORK" STAM_HOME="$TEST_TMP/rec" node "$SEED"
use rec
daemon_up rec
fail() { echo "FAIL: $1"; exit 1; }
field() { "$STAM" show "$1" | python3 -c 'import json,sys; print(json.load(sys.stdin).get(sys.argv[1]))' "$2"; }
events_has() { "$STAM" events "$1" | grep -q "$2"; }
# The turn the re-delivery starts writes the file: proof the stored prompt reached the harness.
recovered() { [ -f "$WORK/recovered.txt" ]; }
wait_until recovered
events_has lost 'first-prompt:recover' || fail "lost was not recovered"
events_has lost 'first-prompt:delivered' || fail "the re-delivered prompt was not recorded as delivered"
[ "$(field lost activity)" != starting ] || fail "lost is still starting after the recovery"
# The agent that already got its prompt, and one from before the markers, are left alone.
if events_has delivered 'first-prompt:recover'; then fail "delivered was recovered again"; fi
if events_has unmarked 'first-prompt:recover'; then fail "unmarked (no pending marker) was recovered"; fi
[ "$(field delivered activity)" = starting ] || fail "delivered is $(field delivered activity), not starting"
[ "$(field unmarked activity)" = starting ] || fail "unmarked is $(field unmarked activity), not starting"
echo "PASS e2e-first-prompt-recover"
