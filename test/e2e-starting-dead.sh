#!/bin/sh
# S-578, free: reconcile ends an agent stuck in 'starting' with no harness process. Past
# settings.startingTimeoutMinutes it is marked stopped, its parent is told, and its pending
# archive runs at once — no kill needed. A still-starting agent past the old fixed 60 s grace but
# under the deadline is left alone, and is not archived early. Runs against its own daemon
# (test/lib.sh); nothing waits on a timer beyond reconcile's own tick.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home sd
SEED="$TEST_TMP/seed-starting.mjs"
cat >"$SEED" <<'EOF'
const db = await import(process.env.ROOT + '/src/db.ts');
db.open();
const ws = JSON.stringify({ spec: { kind: 'dir', path: '/tmp' }, cwd: '/tmp' });
const agent = (id, name, activity, created, pending) => {
  db.createAgent({ id, name, role: 'dev', machine: 'sd', harness: 'claude', model: null, effort: null, cwd: '/tmp', parent_id: id === 'sup' ? null : 'sup', session_id: null });
  db.updateAgent(id, { lifecycle: 'active', activity, activity_detail: 'with prompt', workspace: ws, created_at: created, ...(pending ? { pending_action: JSON.stringify(pending) } : {}) });
};
agent('sup', 'sup', 'idle', new Date().toISOString(), null);
// 20 minutes old: past the 10-minute deadline, so reconcile marks it dead and archives it.
agent('stuck-old', 'stuck-old', 'starting', new Date(Date.now() - 20 * 60_000).toISOString(), { type: 'archive', force: false });
// 90 seconds old: past the old 60 s grace but under the 10-minute deadline; it must stay starting.
agent('stuck-recent', 'stuck-recent', 'starting', new Date(Date.now() - 90_000).toISOString(), { type: 'archive', force: false });
// An active agent with no session: the first reconcile tick marks it, so the test can wait on a tick.
agent('marker', 'marker', 'idle', new Date().toISOString(), null);
EOF
printf '{ "peers": [], "startingTimeoutMinutes": 10 }\n' >"$TEST_TMP/sd/settings.json"
ROOT="$ROOT" STAM_HOME="$TEST_TMP/sd" node "$SEED"
use sd
daemon_up sd
fail() { echo "FAIL: $1"; exit 1; }
field() { "$STAM" show "$1" | python3 -c 'import json,sys; print(json.load(sys.stdin).get(sys.argv[1]))' "$2"; }
events_has() { "$STAM" events "$1" | grep -q "$2"; }
# The first reconcile tick marks the session-less active agent, so the tick has happened.
ticked() { "$STAM" events marker | grep -Eq 'exited|tmux-lost'; }
wait_until ticked
# The stuck agent is archived without a kill, and its parent heard.
archived() { [ "$(field stuck-old lifecycle)" = archived ]; }
wait_until archived
[ "$(field stuck-old pending_action)" = "None" ] || fail "stuck-old still has a pending action: $(field stuck-old pending_action)"
events_has stuck-old 'starting:dead' || fail "stuck-old has no starting:dead event"
events_has stuck-old 'archive' || fail "stuck-old was not archived"
events_has sup 'notice:queued' || fail "stuck-old's parent got no notice"
# The younger one is under the deadline: not archived, and not marked dead.
[ "$(field stuck-recent lifecycle)" = active ] || fail "stuck-recent is $(field stuck-recent lifecycle), not active"
[ "$(field stuck-recent activity)" = starting ] || fail "stuck-recent is $(field stuck-recent activity), not starting"
if events_has stuck-recent 'starting:dead'; then fail "stuck-recent was marked dead before its deadline"; fi
echo "PASS e2e-starting-dead"
