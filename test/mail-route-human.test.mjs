#!/usr/bin/env node
// Unit tests for S-548: mail to the human from an agent other than the chief of staff, the
// assistant, or a manager goes to its first parent instead; permission requests still reach the human.
// Throwaway STAM_HOME, no daemon. Run with `node --test test/mail-route-human.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-mail-route-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `mail-route-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];
// A stub peer ("far") that records the mail forwarded to it and accepts it.
const got = [];
const peer = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const j = body ? JSON.parse(body) : {};
    if (req.method === 'POST' && req.url === '/api/mail') {
      got.push(j);
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ id: j.mail_id, thread_id: j.thread_id, to: j.to }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
});
await new Promise((r) => peer.listen(0, '127.0.0.1', r));
writeFileSync(join(home, 'settings.json'), JSON.stringify({ chiefOfStaff: 'cos', peers: [{ name: 'far', url: `http://127.0.0.1:${peer.address().port}`, token: 'test-peer-token' }] }));

let db, mail;
const agent = (id, name, parent_id, type = null) => {
  db.createAgent({ id, name, role: 'x', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: '/tmp', parent_id, session_id: null });
  if (type) db.updateAgent(id, { type });
};
const toHuman = (from, extra = {}) => mail.sendMail({ from, to: ['human'], subject: 'Result', body: 'Done.', new_thread: true, ...extra });

before(async () => {
  db = await import('../src/db.ts');
  mail = await import('../src/mail.ts');
  db.open();
  agent('c1', 'cos', null);
  agent('m1', 'mgr', 'c1', 'manager');
  agent('d1', 'dev', 'm1', 'developer');
  agent('r1', 'rev', 'm1', 'reviewer');
  agent('k1', 'coord', 'c1', 'coordinator');
  agent('orph', 'orphan', null, 'developer');
  agent('h1', 'haiku', 'm1', 'developer');
  db.updateAgent('h1', { model: 'claude-haiku-5-5' });
  db.rememberPeerAgent({ id: 'far-mgr', name: 'far-mgr', machine: 'far', lifecycle: 'active' });
  agent('p1', 'peerkid', 'far-mgr', 'developer');
});
after(() => {
  peer.close();
  rmSync(home, { recursive: true, force: true });
});

test('a developer’s mail to the human goes to its parent, with a line saying so', async () => {
  const sent = await toHuman('d1');
  assert.ok(db.inbox('m1', false, 50).some((m) => m.id === sent.id));
  assert.ok(!db.inbox('human', false, 50).some((m) => m.id === sent.id));
  const row = db.getMail(sent.id);
  assert.match(row.body, /^Meant for your user\./);
  assert.match(row.body, /Subject: Result/);
  assert.equal(sent.rerouted, 'mgr');
});

test('a reviewer’s mail to the human goes to its parent', async () => {
  const sent = await toHuman('r1');
  assert.equal(sent.rerouted, 'mgr');
});

test('a manager and the chief of staff mail the human directly', async () => {
  for (const from of ['m1', 'c1']) {
    const sent = await toHuman(from);
    assert.equal(sent.rerouted, undefined);
    assert.equal(db.getMail(sent.id).body, 'Done.');
    assert.ok(db.inbox('human', false, 50).some((m) => m.id === sent.id));
  }
});

test('a permission request from a developer still reaches the human', async () => {
  const sent = await toHuman('d1', { permission_id: 'p1' });
  assert.equal(sent.rerouted, undefined);
  assert.equal(db.getMail(sent.id).body, 'Done.');
});

test('a coordinator mails the human directly', async () => {
  const sent = await toHuman('k1');
  assert.equal(sent.rerouted, undefined);
  assert.ok(db.inbox('human', false, 50).some((m) => m.id === sent.id));
});

test('an agent with no parent is rerouted to the chief of staff', async () => {
  const sent = await toHuman('orph');
  assert.equal(sent.rerouted, 'cos');
  assert.ok(db.inbox('c1', false, 50).some((m) => m.id === sent.id));
});

test('a developer on a model barred from mailing the human is rerouted, not refused', async () => {
  const sent = await toHuman('h1');
  assert.equal(sent.rerouted, 'mgr');
});

test('a parent on a peer gets the rerouted mail forwarded to it, and the human does not', async () => {
  const sent = await toHuman('p1');
  assert.equal(sent.rerouted, 'far-mgr');
  assert.equal(got.length, 1);
  assert.deepEqual(got[0].to, ['far-mgr']);
  assert.match(got[0].body, /^Meant for your user\./);
  assert.ok(!db.inbox('human', false, 50).some((m) => m.id === sent.id));
});
