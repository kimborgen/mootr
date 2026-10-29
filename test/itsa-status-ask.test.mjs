#!/usr/bin/env node
// S-4178: a remote agent's move to a human status asks the human the way a relayed original is routed (the S-548 rule with the
// routing facts its daemon attached, relay_route): the owner and an exempt sender go direct, anyone else reroutes to the parent
// that daemon named, and a move with no facts keeps main's delivery. The move is checked before it is written, so an ask that
// would be refused leaves the status. A stub peer on loopback answers the lookups of the remote agents, so the move's actor
// resolves as a peer's agent. Throwaway STAM_HOME, no daemon. Run with `node --test test/itsa-status-ask.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-itsa-status-ask-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `itsa-status-ask-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

// The remote agents the stub peer knows: GET /api/agents/:ref answers them, and anything else is absent.
const REMOTE = {
  rother: { id: 'rother', name: 'rother', machine: 'far', lifecycle: 'active' },
  rowner: { id: 'rowner', name: 'rowner', machine: 'far', lifecycle: 'active' },
  rparent: { id: 'rparent', name: 'rparent', machine: 'far', lifecycle: 'active' },
};
// The mail the peer takes: a relayed POST /api/mail (the outbox's delivery) is recorded and accepted, so a test can see where an ask went.
const posted = [];
// A test can run a step while the stub answers a lookup: onLookup = { at, run } runs `run` on the `at`-th lookup since reset.
let onLookup = null;
let lookups = 0;
const stub = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/mail') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const mail = JSON.parse(raw);
      posted.push(mail);
      // A peer that takes the mail answers with the mail it stored, as the daemon does.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: mail.mail_id, thread_id: mail.thread_id, to: mail.to, kind: mail.kind, subject: mail.subject }));
    });
    return;
  }
  const ref = decodeURIComponent(req.url.replace(/^\/api\/agents\//, ''));
  if (req.method === 'GET') lookups++;
  if (req.method === 'GET' && onLookup && lookups === onLookup.at) {
    const run = onLookup.run;
    onLookup = null;
    run();
  }
  if (req.method === 'GET' && REMOTE[ref]) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(REMOTE[ref]));
  } else {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"no agent"}');
  }
});
await new Promise((done) => stub.listen(0, '127.0.0.1', done));
writeFileSync(join(home, 'token'), 'status-ask-shared\n');
writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [{ name: 'far', url: `http://127.0.0.1:${stub.address().port}`, token: 'far-shared', peerToken: 'far-peer' }] }));

let db, itsa, mail;
const agent = (id, name, parent_id, type = null) => {
  db.createAgent({ id, name, role: 'x', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: '/tmp', parent_id, session_id: null });
  if (type) db.updateAgent(id, { type });
};
const inbox = (id) => db.inbox(id, false, 50).map((m) => m.id);
// Whether the human is a recipient of the mail (the inbox is only the newest 50, so it can't show an older mail).
const toHuman = (id) => db.open().prepare('SELECT COUNT(*) AS n FROM mail_recipients WHERE mail_id = ? AND agent_id = ?').get(id, 'human').n;

before(async () => {
  db = await import('../src/db.ts');
  itsa = await import('../src/itsa.ts');
  mail = await import('../src/mail.ts');
  // The daemon registers the human's ask on a status change (itsa-human.ts watchHumanStatuses); the test does too.
  (await import('../src/itsa-human.ts')).watchHumanStatuses();
  db.open();
  agent('c1', 'cos', null);
  agent('m1', 'mgr', 'c1', 'manager');
  agent('o1', 'owner', 'm1', 'developer');
});
after(() => {
  stub.close();
  rmSync(home, { recursive: true, force: true });
});

const mgrRoute = { exempt: false, parent: 'mgr' };
// An ITSA owned by `owner` (a local agent, or a peer's), with the human in it.
const makeItsa = async (title, owner) => {
  const x = await itsa.create({ title, by: 'human', owner: 'o1', participants: ['human'] });
  db.open().prepare('UPDATE itsas SET owner = ? WHERE id = ?').run(owner, x.id);
  return itsa.find(x.id);
};
// A peer's agent comments in the ITSA's thread first: an agent hands an ITSA to the human only after saying what it did.
const commentAs = (from, x) =>
  mail.sendMail({ from, to: ['human'], subject: 'Done', body: 'Result', itsa_id: x.id, thread_id: itsa.ensureThread(x.id), kind: 'comment', forwarded: { from_name: from }, relay: true, relay_route: { exempt: true, parent: 'mgr' } });
// The ask a move sends goes out after the move (itsa-human.ts onStatus is not awaited), so the test waits for its mail to land.
const lastAsk = async (x) => {
  for (let i = 0; i < 300; i++) {
    const row = db.open().prepare("SELECT id FROM mail WHERE itsa_id = ? AND kind = 'ask' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(x.id);
    if (row) return row.id;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error(`no ask for ${x.key}`);
};
// The ask a remote sender's move sends, as the peer it went to recorded it: the ask is sent after the move, so the test waits for it.
const relayedAsk = async (x) => {
  for (let i = 0; i < 300; i++) {
    const got = posted.find((p) => p.subject?.startsWith(`${x.key} `));
    if (got) return got;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error(`no relayed ask for ${x.key}`);
};
const moveAsk = async (title, owner, actor, extra) => {
  const x = await makeItsa(title, owner);
  await commentAs(actor, x);
  await itsa.set(x.key, { status: 'needs_input', ...extra }, actor);
  return { x, ask: await lastAsk(x) };
};

test('a remote non-owner’s move to a human status asks the human through its parent', async () => {
  const { ask } = await moveAsk('Remote ask', 'o1', 'rother', { relay_route: mgrRoute });
  assert.ok(inbox('m1').includes(ask));
  assert.ok(!inbox('human').includes(ask));
});

test('a remote exempt agent’s move to a human status asks the human directly, as on main', async () => {
  const { ask } = await moveAsk('Remote exempt ask', 'o1', 'rother', { relay_route: { exempt: true, parent: 'mgr' } });
  assert.ok(inbox('human').includes(ask));
});

test('a remote owner’s move to a human status asks the human directly', async () => {
  const { ask } = await moveAsk('Remote owner ask', 'rowner', 'rowner', { relay_route: mgrRoute });
  assert.ok(inbox('human').includes(ask));
});

test('a remote move with no routing facts (an older peer) asks the human directly, as on main', async () => {
  const { ask } = await moveAsk('Remote old ask', 'o1', 'rother', {});
  assert.ok(inbox('human').includes(ask));
});

test('a remote non-owner whose parent can’t be named is refused before the move, and the status stays', async () => {
  const x = await makeItsa('Remote refused ask', 'o1');
  await commentAs('rother', x);
  const before = itsa.find(x.id).status;
  await assert.rejects(itsa.set(x.key, { status: 'needs_input', relay_route: { exempt: false } }, 'rother'), /parent can't be reached/);
  assert.equal(itsa.find(x.id).status, before);
});

test('a reassignment while the route check looks up the peer aborts the move: nothing is written', async () => {
  const x = await makeItsa('Raced ask', 'rowner');
  await commentAs('rother', x);
  const before = itsa.find(x.id).status;
  // The third lookup is the route check's peer lookup: the reassignment lands there, after the check assumed rowner as the owner.
  lookups = 0;
  onLookup = { at: 3, run: () => db.open().prepare('UPDATE itsas SET owner = ? WHERE id = ?').run('o1', x.id) };
  await assert.rejects(itsa.set(x.key, { status: 'needs_input', relay_route: mgrRoute }, 'rother'), /the owner changed/);
  onLookup = null;
  assert.equal(itsa.find(x.id).status, before);
  assert.equal(itsa.find(x.id).owner, 'o1');
});

test('an ask whose thread holds an ITSA the sender doesn’t own is refused before the move when its send would refuse', async () => {
  // The sender owns the moved ITSA, so only the other ITSA in the thread makes it a reroute, and its parent can't be named.
  const x = await makeItsa('Shared thread ask', 'rother');
  await commentAs('rother', x);
  // Another ITSA in the same thread, owned by someone else: the send checks every ITSA the thread holds, not only this one.
  const y = await makeItsa('Shared thread other', 'o1');
  db.open().prepare('UPDATE itsas SET thread_id = ? WHERE id = ?').run(itsa.find(x.id).thread_id, y.id);
  const before = itsa.find(x.id).status;
  await assert.rejects(itsa.set(x.key, { status: 'needs_input', relay_route: { exempt: false } }, 'rother'), /parent can't be reached/);
  assert.equal(itsa.find(x.id).status, before);
});

test('a partly owned thread’s ask reroutes to a reachable remote parent, and the move goes ahead', async () => {
  const x = await makeItsa('Reachable parent ask', 'rother');
  await commentAs('rother', x);
  const y = await makeItsa('Reachable parent other', 'rowner');
  db.open().prepare('UPDATE itsas SET thread_id = ? WHERE id = ?').run(itsa.find(x.id).thread_id, y.id);
  await itsa.set(x.key, { status: 'needs_input', relay_route: { exempt: false, parent: 'rparent' } }, 'rother');
  assert.equal(itsa.find(x.id).status, 'needs_input');
  // A remote sender's ask is kept by the peer it goes to, not here, so the peer's record shows where it went: wait for it (the ask
  // is sent after the move), then check it is addressed to the parent and to no human.
  const relayed = await relayedAsk(x);
  assert.ok(relayed.to.includes('rparent'), `the ask is addressed to the parent: ${relayed.to}`);
  assert.ok(!relayed.to.includes('human'), `the ask is not addressed to the human: ${relayed.to}`);
});

test('an exempt sender’s ask with an unresolvable parent id goes direct, with no refusal', async () => {
  const x = await makeItsa('Exempt ambiguous parent', 'o1');
  await commentAs('rother', x);
  await itsa.set(x.key, { status: 'needs_input', relay_route: { exempt: true, parent: 'nobody-here' } }, 'rother');
  assert.equal(toHuman(await lastAsk(x)), 1);
});

test('an owner’s ask with an unresolvable parent id goes direct, with no refusal', async () => {
  const x = await makeItsa('Owner ambiguous parent', 'rowner');
  await commentAs('rowner', x);
  await itsa.set(x.key, { status: 'needs_input', relay_route: { exempt: false, parent: 'nobody-here' } }, 'rowner');
  assert.equal(toHuman(await lastAsk(x)), 1);
});
