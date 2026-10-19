#!/usr/bin/env node
// A busy agent on the peer machine holds its local parents' 'children' wait and tree-idle notice (S-1652):
// db.rememberPeerAgent stores the busy flag and calls org.peerBusyChanged however it is reached, the flag
// goes stale after PEER_BUSY_FRESH_MS, and a local grandparent above a peer agent is reached.
// Run with `node --test test/peer-busy.test.mjs`.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-peer-busy-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `peer-busy-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
const db = await import('../src/db.ts');
const org = await import('../src/org.ts');
org.watchActivity();

const mk = (id, parent, extra = {}) => {
  db.createAgent({ id, name: id, role: 'manager', machine: 'here', harness: 'claude', model: 'm', effort: null, cwd: '/tmp', parent_id: parent ?? null, session_id: null });
  db.updateAgent(id, extra);
};
const childrenWait = (id) => db.listWaits(id).find((w) => w.kind === 'children')?.detail;
const notices = (id) => db.listEvents(id, 500).filter((e) => e.type === 'notice:queued' && e.data.includes('finished'));
const expired = (id) => db.expiredPeerBusy().filter((x) => x === id);
const peer = (activity, extra = {}) => ({ id: 'pk', name: 'pk', machine: 'there', lifecycle: 'active', parents: ['pm'], activity, ...extra });

test('a spawn reply with a busy peer child gives its parent a children wait, which clears when it goes idle', () => {
  mk('pg', null, { child_notices: 'tree-idle', activity: 'idle' });
  mk('pm', 'pg', { activity: 'idle' });
  assert.equal(childrenWait('pm'), undefined);
  // The spawnOnPeer path remembers the reply, which carries parent_id only.
  db.rememberPeerAgent({ id: 'pk', name: 'pk', machine: 'there', parent_id: 'pm', activity: 'starting' });
  assert.equal(childrenWait('pm'), '1 child');
  assert.equal(childrenWait('pg'), '2 children', 'the grandparent follows: pm is waiting on its child, and pk');
  db.rememberPeerAgent(peer('idle'));
  assert.equal(childrenWait('pm'), undefined);
  assert.equal(childrenWait('pg'), undefined);
});

test('a tree-idle notice waits for the busy peer child, then queues exactly once', () => {
  const base = notices('pg').length;
  db.rememberPeerAgent(peer('working'));
  db.updateAgent('pm', { activity: 'working' });
  db.updateAgent('pm', { activity: 'idle', activity_detail: 'turn finished', idle_since: new Date().toISOString() });
  assert.equal(notices('pg').length, base, 'held back by the busy peer child');
  db.rememberPeerAgent(peer('idle'));
  assert.equal(notices('pg').length, base + 1);
  db.rememberPeerAgent(peer('working', { lifecycle: 'active' }));
  db.rememberPeerAgent(peer('idle'));
  assert.equal(notices('pg').length, base + 1, 'not repeated');
});

test('the busy re-sync reaches a local agent through a chain of peer agents; org.ancestors stays local', () => {
  mk('qr', null, { activity: 'idle' });
  db.rememberPeerAgent({ id: 'qp', name: 'qp', machine: 'there', parents: ['qr'], activity: 'idle' });
  db.rememberPeerAgent({ id: 'qq', name: 'qq', machine: 'there', parents: ['qp'], activity: 'working' });
  assert.equal(childrenWait('qr'), '1 child');
  mk('ql', 'qp', { activity: 'idle' });
  assert.ok(!org.ancestors(db.getAgent('ql')).has('qr'), 'unchanged for other callers');
});

test('a peer busy flag nobody refreshed stops counting after the freshness bound', () => {
  mk('sm', null, { activity: 'idle' });
  db.rememberPeerAgent({ id: 'sk', name: 'sk', machine: 'there', parents: ['sm'], activity: 'working' });
  assert.equal(db.busyDescendantCount('sm'), 1);
  const old = new Date(Date.now() - db.PEER_BUSY_FRESH_MS - 1000).toISOString();
  db.open().prepare("UPDATE peer_agents SET busy_at = ? WHERE id = 'sk'").run(old);
  assert.equal(db.busyDescendantCount('sm'), 0);
  // Still listed as busy later: the next window's write refreshes it.
  db.open().prepare("UPDATE peer_agents SET busy_at = ? WHERE id = 'sk'").run(new Date().toISOString());
  assert.equal(db.busyDescendantCount('sm'), 1);
});

test('a flag that expires with no other event clears the parent wait, and queues the notice once', () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    mk('xg', null, { child_notices: 'tree-idle', activity: 'idle' });
    mk('xm', 'xg', { activity: 'idle' });
    db.rememberPeerAgent({ id: 'xk', name: 'xk', machine: 'there', parents: ['xm'], activity: 'working' });
    assert.equal(childrenWait('xm'), '1 child');
    const base = notices('xg').length;
    mock.timers.tick(1000);
    db.updateAgent('xm', { activity: 'working' });
    db.updateAgent('xm', { activity: 'idle', activity_detail: 'turn finished', idle_since: new Date().toISOString() });
    assert.equal(notices('xg').length, base, 'held back while the flag is fresh');
    assert.deepEqual(expired('xk'), []);
    mock.timers.tick(db.PEER_BUSY_FRESH_MS + 1000);
    assert.deepEqual(db.expiredPeerBusy().filter((x) => x === 'xk'), ['xk']);
    assert.deepEqual(expired('xk'), [], 'once');
    org.peerBusyChanged('xk');
    assert.equal(childrenWait('xm'), undefined);
    assert.equal(notices('xg').length, base + 1);
    org.peerBusyChanged('xk');
    assert.equal(notices('xg').length, base + 1, 'exactly once');
  } finally {
    mock.timers.reset();
  }
});

test('a refreshed busy flag stays counted past the bound, and a stale one that is listed busy again is fresh again', () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    mk('rm', null, { activity: 'idle' });
    const busy = { id: 'rk', name: 'rk', machine: 'there', parents: ['rm'], activity: 'working' };
    db.rememberPeerAgent(busy);
    // The daemon's sweep lists the peer every 2 minutes, with no UI open.
    for (let i = 0; i < 10; i++) {
      mock.timers.tick(2 * 60_000);
      db.rememberPeerAgent(busy);
    }
    assert.equal(db.busyDescendantCount('rm'), 1, 'still busy after 20 minutes');
    mock.timers.tick(db.PEER_BUSY_FRESH_MS + 1000);
    assert.equal(db.busyDescendantCount('rm'), 0);
    assert.deepEqual(expired('rk'), ['rk']);
    const seen = [];
    db.onPeerBusyChange((id) => seen.push(id));
    db.rememberPeerAgent(busy);
    assert.deepEqual(seen, ['rk'], 'stale to fresh calls the observer though busy stays 1');
    assert.equal(db.busyDescendantCount('rm'), 1);
    db.onPeerBusyChange(org.peerBusyChanged);
  } finally {
    mock.timers.reset();
  }
});
