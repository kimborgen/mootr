#!/usr/bin/env node
// One activity change settles every 'children' wait above it in one call (S-1739). The waits it writes flip
// ancestors between idle and waiting, and the activity observer calls back in for each; before, every call-back
// recounted every ancestor's subtree, so one flip at a deep leaf cost O(depth²) counts. The settled waits equal
// what the startup rebuild produces, through diamonds, a cycle, duplicate parents and peer links both ways.
// A throwaway STAM_HOME, no daemon: `node --test test/children-waits-cascade.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-children-cascade-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `children-cascade-test-${process.pid}`;
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
  org.watchActivity();
});
after(() => rmSync(home, { recursive: true, force: true }));

function mk(id, parent, activity = 'idle') {
  db.createAgent({ id, name: id.toLowerCase(), role: 'r', machine: 'x', harness: 'claude', model: 'm', effort: null, cwd: '/tmp', parent_id: parent, session_id: null });
  db.updateAgent(id, { activity });
  return id;
}

// Every stam 'children' wait, as agent -> detail.
function waits() {
  const out = {};
  for (const [id, ws] of db.listWaitsByAgent()) {
    const w = ws.find((x) => x.kind === 'children' && x.source === 'stam' && x.target === null);
    if (w) out[id] = w.detail;
  }
  return out;
}

// The waits after a flip equal what the startup rebuild makes of the same agents.
function assertSettled(label) {
  const got = waits();
  org.rebuildWaits();
  assert.deepEqual(got, waits(), label);
}

// Statements and milliseconds one activity change costs, the observer's cascade included.
function flip(id, activity) {
  const s = stmts;
  const t = performance.now();
  db.updateAgent(id, activity === 'idle' ? { activity, activity_detail: 'turn finished' } : { activity });
  return { stmts: stmts - s, ms: performance.now() - t };
}

// A small tree with every shape a count walks: a diamond, a duplicate parent, a cycle, a pending permission
// request, a local agent under a peer agent and a peer agent under a local one.
test('after any flip the waits equal the rebuild, diamonds, a cycle, duplicate parents and peers included', () => {
  const root = mk('S0', null);
  const a = mk('S1', root);
  const b = mk('S2', a);
  const c = mk('S3', b);
  db.addParent(c, a); // a diamond: c under a directly and through b
  db.addParent(b, a); // a duplicate parent: b's spawning parent adopts it as well
  const x = mk('S4', c);
  const cy = mk('S5', x);
  const cz = mk('S6', cy);
  db.addParent(cy, cz); // a cycle: S5 -> S6 -> S5
  const y = mk('S7', root);
  db.rememberPeerAgent({ id: 'SP1', name: 'sp1', machine: 'there', parents: [y, b], activity: 'idle' });
  const u = mk('S8', 'SP1'); // a local agent under a peer agent
  const v = mk('S9', u);
  db.open().prepare("INSERT INTO permission_requests (id, agent_id, action, reason, details, status, created_at) VALUES ('p-cascade', ?, 'x', 'x', '{}', 'pending', ?)").run(x, new Date().toISOString());
  org.rebuildWaits();
  assertSettled('start');
  for (const id of [v, u, c, x, cz, cy, b, y, a, root]) {
    flip(id, 'working');
    assertSettled(`${id} working`);
    flip(id, 'idle');
    assertSettled(`${id} idle`);
  }
  db.rememberPeerAgent({ id: 'SP1', name: 'sp1', machine: 'there', parents: [y, b], activity: 'working' });
  assertSettled('peer busy');
  db.rememberPeerAgent({ id: 'SP1', name: 'sp1', machine: 'there', parents: [y, b], activity: 'idle' });
  assertSettled('peer idle');
  assert.equal(waits()[root], '6 children', 'S1, S2, S3 and S4 wait on the permission request; the cycle keeps S5 and S6 waiting');
});

// The settle announces the agents it turns idle once it ends, rather than the observer per flip: a tree-idle
// parent still hears once when a finished turn's subtree goes quiet.
test('a parent hears once when the settle turns its waiting child idle', () => {
  const g = mk('G0', null);
  const m1 = mk('G1', g);
  const m2 = mk('G2', m1);
  const l = mk('G3', m2);
  db.updateAgent(g, { child_notices: 'tree-idle' });
  db.open().prepare('UPDATE agents SET idle_notified = idle_since').run();
  const told = () => db.listEvents(g, 500).filter((e) => e.type === 'notice:queued' && e.data.includes('g1')).length;
  const base = told(); // G1's first idle, as it was created
  const heard = () => told() - base;
  flip(l, 'working');
  flip(m1, 'working');
  flip(m1, 'idle'); // a finished turn, still waiting on G3
  assert.equal(db.getAgent(m1).activity, 'waiting');
  assert.equal(heard(), 0);
  flip(l, 'idle');
  assert.equal(db.getAgent(m1).activity, 'idle');
  assert.equal(heard(), 1);
  assertSettled('quiet');
  assert.equal(heard(), 1);
});

// Real scale: about 2,000 agents and 2,000 remembered peer rows, with a 40-deep chain through a diamond and a duplicate
// parent, and a peer agent under it with local agents below. A flip at the chain's leaf turns every agent above it waiting, or idle again.
test('one flip at a deep leaf settles the chain in statements linear in its ancestors', (t) => {
  const root = mk('R', null);
  const chain = [root];
  for (let i = 0; i < 40; i++) chain.push(mk(`C${i}`, chain.at(-1)));
  db.addParent('C30', 'C25'); // a diamond
  db.addParent('C10', 'C9'); // a duplicate parent
  db.rememberPeerAgent({ id: 'RPX', name: 'rpx', machine: 'there', parents: ['C15'], activity: 'idle' }); // a peer agent under the chain
  const leaf = chain.at(-1);
  const managers = [...chain.slice(0, 20), mk('CPX', 'RPX')]; // and a local manager under it
  for (let i = 0; i < 2000; i++) {
    const id = mk(`B${i}`, managers[(i * 7) % managers.length], i % 50 ? 'idle' : 'working');
    if (i % 3 === 0) managers.push(id);
  }
  for (let i = 0; i < 2000; i++) db.rememberPeerAgent({ id: `RS${i}`, name: `rs${i}`, machine: 'there', lifecycle: i % 10 ? 'archived' : 'active', parents: [managers[(i * 13) % managers.length]], activity: 'idle' });
  org.rebuildWaits();
  db.open().prepare('UPDATE agents SET idle_notified = idle_since').run(); // no tree-idle notice owed
  const deep = chain.slice(21); // below the busy bulk: nothing waits until the leaf turns busy
  assert.ok(deep.every((id) => waits()[id] === undefined));
  const up = flip(leaf, 'working');
  assert.ok(deep.slice(0, -1).every((id) => waits()[id]), 'every agent above the leaf waits');
  assertSettled('leaf working');
  const down = flip(leaf, 'idle');
  assert.ok(deep.every((id) => waits()[id] === undefined), 'the chain below the bulk is idle again');
  assertSettled('leaf idle');
  const ancestors = chain.length - 1;
  t.diagnostic(`idle→busy at depth ${ancestors}: ${up.stmts} statements, ${up.ms.toFixed(1)} ms`);
  t.diagnostic(`busy→idle at depth ${ancestors}: ${down.stmts} statements, ${down.ms.toFixed(1)} ms`);
  // Each ancestor costs a handful of statements: its wait read, the write, and the write's activity sync.
  for (const [name, f] of [['idle→busy', up], ['busy→idle', down]]) assert.ok(f.stmts < 20 * ancestors, `${name}: ${f.stmts} statements over ${ancestors} ancestors`);
});
