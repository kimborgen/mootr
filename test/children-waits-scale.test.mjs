#!/usr/bin/env node
// The 'children' wait recompute (S-1025): one activity change costs a fixed number of SQL statements,
// however many agents sit in the tree, and the count equals the old per-agent walk's.
// A throwaway STAM_HOME, no daemon: `node --test test/children-waits-scale.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-children-scale-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `children-scale-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

// Counts every statement run, by wrapping prepare before db.ts opens its handle.
let stmts = 0;
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql) {
  const st = prepare.call(this, sql);
  for (const m of ['run', 'get', 'all']) {
    const f = st[m];
    st[m] = (...a) => {
      stmts++;
      return f.apply(st, a);
    };
  }
  return st;
};

let db, org;
before(async () => {
  db = await import('../src/db.ts');
  org = await import('../src/org.ts');
});
after(() => rmSync(home, { recursive: true, force: true }));

let n = 0;
function mk(parent, activity = 'idle', extra = {}) {
  const id = `T${n++}`;
  db.createAgent({ id, name: id.toLowerCase(), role: 'r', machine: 'x', harness: 'claude', model: 'm', effort: null, cwd: '/tmp', parent_id: parent, session_id: null });
  db.updateAgent(id, { activity, ...extra });
  return id;
}

// The old walk, kept as the reference: descendants through getAgent, busy per agent.
function reference(id) {
  let c = 0;
  for (const d of org.descendants(id)) {
    const a = db.getAgent(d);
    if (a && (['working', 'blocked', 'waiting', 'starting'].includes(a.activity) || db.hasPendingPermission(a.id))) c++;
  }
  return c;
}

test('the busy count matches the per-agent walk, adoptions and pending requests included', () => {
  const root = mk(null);
  const a = mk(root, 'working');
  const b = mk(a, 'idle');
  const c = mk(b, 'starting');
  const d = mk(root, 'errored');
  const adopter = mk(null);
  db.addParent(c, adopter);
  const e = mk(d, 'idle');
  db.open().prepare("INSERT INTO permission_requests (id, agent_id, action, reason, details, status, created_at) VALUES ('p1', ?, 'x', 'x', '{}', 'pending', ?)").run(e, new Date().toISOString());
  for (const id of [root, a, b, c, d, e, adopter]) assert.equal(db.busyDescendantCount(id), reference(id), id);
  assert.equal(db.busyDescendantCount(root), 3); // a, c, e
  assert.equal(db.busyDescendantCount(adopter), 1); // c, by adoption
});

test('peer agents are counted in the same query: a busy one under root, and a local one under a peer one', () => {
  const root = mk(null);
  db.rememberPeerAgent({ id: 'PP', name: 'pp', machine: 'there', parents: [root], activity: 'idle' });
  db.rememberPeerAgent({ id: 'PQ', name: 'pq', machine: 'there', parents: [root], activity: 'working' });
  const l = mk('PP', 'working');
  assert.equal(db.busyDescendantCount(root), 2); // PQ, and l below PP
  const before = stmts;
  db.busyDescendantCount(root);
  assert.equal(stmts - before, 1);
  assert.ok(l);
});

function costOfOneChange(width, depth) {
  const root = mk(null);
  let level = [root];
  let leaf = root;
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const p of level) for (let i = 0; i < width; i++) next.push(mk(p, i % 3 ? 'idle' : 'working'));
    level = next;
  }
  leaf = level[0];
  db.updateAgent(leaf, { activity: 'idle' });
  org.rebuildWaits();
  const before = stmts;
  org.syncChildrenWaits(leaf);
  const cost = stmts - before;
  const total = db.listAgents().length;
  const want = reference(root);
  assert.equal(db.listWaits(root).find((w) => w.kind === 'children')?.detail, want === 1 ? '1 child' : `${want} children`);
  return { cost, total };
}

test('one activity change costs the same statements in a small tree and a large one', () => {
  const small = costOfOneChange(2, 3);
  const large = costOfOneChange(6, 3);
  assert.ok(large.total > small.total * 10, `${small.total} vs ${large.total} agents`);
  assert.equal(large.cost, small.cost);
});

test('hundreds of archived peer rows keep the count one statement and cheap', () => {
  const root = mk(null);
  let p = root;
  for (let i = 0; i < 30; i++) p = mk(p, 'idle');
  for (let i = 0; i < 400; i++) db.rememberPeerAgent({ id: `AR${i}`, name: `ar${i}`, machine: 'there', lifecycle: 'archived', parents: [i % 2 ? root : p, `T${i}`], activity: 'idle' });
  const before = stmts;
  const t = performance.now();
  db.busyDescendantCount(root);
  const ms = performance.now() - t;
  assert.equal(stmts - before, 1);
  assert.ok(ms < 200, `${ms.toFixed(1)} ms over 400 peer rows and a 30-deep chain`);
});

// Real scale (S-1725): about the live tree's size, with as many remembered peer rows. Joining peer_agents' JSON in
// every recursion step made one root count 0.1-0.7 s and each activity change pay it once per ancestor, which
// stalled the daemon's event loop and rolled back aa181742; unpacked once per call it is a few ms.
test('a real-scale tree with thousands of peer rows keeps one activity change fast', (t) => {
  const root = mk(null, 'working');
  const managers = [root];
  for (let i = 0; i < 2000; i++) {
    const id = mk(managers[(i * 7) % managers.length], i % 50 ? 'idle' : 'working');
    if (i % 3 === 0) managers.push(id);
  }
  for (let i = 0; i < 2000; i++) db.rememberPeerAgent({ id: `RS${i}`, name: `rs${i}`, machine: 'there', lifecycle: i % 10 ? 'archived' : 'active', parents: [managers[(i * 13) % managers.length]], activity: i % 20 ? 'idle' : 'working' });
  const leaf = db.listAgents().at(-1).id;
  org.syncChildrenWaits(leaf);
  const runs = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    org.syncChildrenWaits(leaf);
    runs.push(performance.now() - t);
  }
  const ms = runs.sort((a, b) => a - b)[2];
  t.diagnostic(`one activity change: median ${ms.toFixed(1)} ms`);
  assert.ok(ms < 300, `one activity change took ${ms.toFixed(1)} ms over ${org.ancestors(db.getAgent(leaf)).size} ancestors`);
  assert.equal(db.busyDescendantCount(root), reference(root) + peerBusyUnder(root));
});

// The busy peer agents below `id`, walked in JS: the reference for the peer half of the count.
function peerBusyUnder(id) {
  const rows = db.open().prepare('SELECT id, parents, busy FROM peer_agents').all();
  const below = new Set(org.descendants(id));
  below.add(id);
  return rows.filter((r) => r.busy && JSON.parse(r.parents ?? '[]').some((p) => below.has(p))).length;
}

// The startup rebuild reads every count in one pass (S-1725): tree.busyDescendantCounts agrees with the query for
// every agent, through adoptions that make diamonds and cycles, duplicate parents, and peer links both ways.
test('the one-pass counts equal the per-agent query, diamonds, cycles and peers included', async () => {
  const tree = await import('../src/tree.ts');
  const root = mk(null, 'idle');
  const a = mk(root, 'working');
  const b = mk(a, 'idle');
  const c = mk(b, 'working');
  db.addParent(c, a); // a diamond: c under a directly and through b
  db.addParent(c, root); // and a duplicate path from root
  const x = mk(c, 'idle');
  db.addParent(a, x); // a cycle: a -> b -> c -> x -> a
  const y = mk(root, 'idle');
  db.open().prepare("INSERT INTO permission_requests (id, agent_id, action, reason, details, status, created_at) VALUES ('p-one-pass', ?, 'x', 'x', '{}', 'pending', ?)").run(y, new Date().toISOString());
  db.rememberPeerAgent({ id: 'OPa', name: 'opa', machine: 'there', parents: [b, x], activity: 'working' });
  db.rememberPeerAgent({ id: 'OPb', name: 'opb', machine: 'there', parents: [y], activity: 'idle' });
  db.rememberPeerAgent({ id: 'OPc', name: 'opc', machine: 'there', parents: [y], activity: 'working' });
  db.open().prepare("UPDATE peer_agents SET busy_at = '2000-01-01T00:00:00.000Z' WHERE id = 'OPc'").run(); // a stale flag
  mk('OPb', 'starting'); // a local agent under a peer one
  const counts = tree.busyDescendantCounts();
  for (const ag of db.listAgents()) assert.equal(counts.get(ag.id) ?? 0, db.busyDescendantCount(ag.id), ag.id);
  assert.equal(counts.get(root), db.busyDescendantCount(root));
  assert.ok(db.busyDescendantCount(root) >= 5, 'a, c, y, OPa and the agent under OPb');
});

// Runs after the real-scale case above, on its agents and peer rows in this file's shared home.
test('the startup rebuild at real scale settles every wait and is cheap on a restart', (t) => {
  org.rebuildWaits();
  // Settled: every agent's wait names its busy count as the query reads it now.
  for (const ag of db.listAgents()) {
    const n = db.busyDescendantCount(ag.id);
    const w = db.listWaits(ag.id).find((x) => x.kind === 'children' && x.source === 'stam');
    assert.equal(w?.detail, n ? (n === 1 ? '1 child' : `${n} children`) : undefined, ag.id);
  }
  // A restart finds the waits in place: one pass over the counts, with nothing to change.
  const before = stmts;
  const t0 = performance.now();
  org.rebuildWaits();
  const ms = performance.now() - t0;
  t.diagnostic(`rebuildWaits on a restart over ${db.listAgents().length} agents: ${ms.toFixed(1)} ms, ${stmts - before} statements`);
  assert.ok(ms < 300, `${ms.toFixed(1)} ms`);
});
