#!/usr/bin/env node
// Unit tests for S-4163: an agent that owns an ITSA mails the human directly, not through its parent (S-548), when the
// human takes part in that ITSA. Every other case stays rerouted: a non-owner participant, an owner the human isn't in
// the ITSA with, a forged `itsa` field or a thread of an ITSA the agent doesn't own, an archived owner, and a reassigned
// ITSA. The human's reply in the thread reaches the owner and no parent or chief of staff. Throwaway STAM_HOME, no daemon,
// no network. Run with `node --test test/mail-itsa-human.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-mail-itsa-human-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `mail-itsa-human-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

let db, itsa, mail, owned, others, noHuman, archived, remoteOwned, remoteOther, remoteGone;
const agent = (id, name, parent_id, type = null) => {
  db.createAgent({ id, name, role: 'x', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: '/tmp', parent_id, session_id: null });
  if (type) db.updateAgent(id, { type });
};
const inbox = (id) => db.inbox(id, false, 50).map((m) => m.id);
const recipientIds = (m) => db.threadMail(m.thread_id).at(-1).recipients.map((r) => r.id);

before(async () => {
  db = await import('../src/db.ts');
  itsa = await import('../src/itsa.ts');
  mail = await import('../src/mail.ts');
  db.open();
  agent('c1', 'cos', null);
  agent('m1', 'mgr', 'c1', 'manager');
  agent('o1', 'owner', 'm1', 'developer');
  agent('o2', 'other', 'm1', 'developer');
  agent('d1', 'dev', 'm1', 'developer');
  agent('oa', 'archived', 'm1', 'developer');
  // o1 owns `owned`, and the human takes part in it.
  owned = await itsa.create({ title: 'Owned work', by: 'human', owner: 'o1', participants: ['human', 'd1'] });
  // o2 owns `others`, with the human in it; o1 doesn't own it.
  others = await itsa.create({ title: 'Other work', by: 'human', owner: 'o2', participants: ['human'] });
  // o1 owns `noHuman`, which the human isn't in.
  noHuman = await itsa.create({ title: 'No human', by: 'human', owner: 'o1', participants: ['d1'] });
  // An archived agent owns `archived`, with the human in it.
  archived = await itsa.create({ title: 'Archived owner', by: 'human', owner: 'oa', participants: ['human'] });
  db.updateAgent('oa', { lifecycle: 'archived' });
  // Agents on a peer, as a home daemon knows them: their posts are relayed here, and they have no row here.
  for (const [id, name, lifecycle] of [['rowner', 'rowner', 'active'], ['rother', 'rother', 'active'], ['rgone', 'rgone', 'archived']]) {
    db.rememberPeerAgent({ id, name, machine: 'far', lifecycle });
  }
  // A peer agent can't be named at create (it isn't local), so the ITSAs are made with a local owner and then given the peer's.
  const onPeer = async (title, owner, people) => {
    const x = await itsa.create({ title, by: 'human', owner: 'o1', participants: ['human'] });
    db.open().prepare('UPDATE itsas SET owner = ? WHERE id = ?').run(owner, x.id);
    for (const p of people) db.open().prepare('INSERT OR IGNORE INTO itsa_participants (itsa_id, agent_id) VALUES (?, ?)').run(x.id, p);
    return itsa.find(x.id);
  };
  remoteOwned = await onPeer('Remote owned', 'rowner', ['human']);
  remoteOther = await onPeer('Remote other', 'o1', ['human', 'rother']);
  remoteGone = await onPeer('Remote gone', 'rgone', ['human']);
});
after(() => {
  rmSync(home, { recursive: true, force: true });
});

test('the owner of an ITSA mails the human directly when the human takes part in it', async () => {
  const sent = await itsa.post(owned.key, { by: 'o1', body: 'Result', to: ['human'] });
  assert.equal(sent.rerouted, undefined);
  assert.equal(db.getMail(sent.id).body, 'Result');
  assert.ok(inbox('human').includes(sent.id));
  assert.ok(!inbox('m1').includes(sent.id));
});

test('a non-owner participant of an ITSA still mails the human through its parent', async () => {
  const sent = await itsa.post(owned.key, { by: 'd1', body: 'Not mine to send', to: ['human'] });
  assert.equal(sent.rerouted, 'mgr');
  assert.ok(inbox('m1').includes(sent.id));
  assert.match(db.getMail(sent.id).body, /^Meant for your user\./);
});

test('the owner of an ITSA the human is not in still mails the human through its parent', async () => {
  const sent = await itsa.post(noHuman.key, { by: 'o1', body: 'Result', to: ['human'] });
  assert.equal(sent.rerouted, 'mgr');
});

test('a forged itsa field naming an ITSA the agent does not own reroutes the mail', async () => {
  // o1 owns `owned`, but names `others` (owned by o2, with the human in it) in its `itsa` field.
  const sent = await mail.sendMail({ from: 'o1', to: ['human'], subject: 'Forged', body: 'Result', new_thread: true, itsa: others.key });
  assert.equal(sent.rerouted, 'mgr');
  assert.ok(inbox('m1').includes(sent.id));
});

test('mail in the thread of an ITSA the agent does not own reroutes the mail', async () => {
  // o1 joins the thread as a participant, so it can read and reply to o2's comment there; it still doesn't own the ITSA.
  await itsa.post(others.key, { by: 'o1', body: 'Joining' });
  const theirs = await itsa.post(others.key, { by: 'o2', body: 'Their thread' });
  const sent = await mail.sendMail({ from: 'o1', to: ['human'], subject: 'Re: theirs', body: 'Result', reply_to: theirs.id });
  assert.equal(sent.rerouted, 'mgr');
});

test('an archived owner of an ITSA reroutes its mail', async () => {
  const sent = await mail.sendMail({ from: 'oa', to: ['human'], subject: 'Stale', body: 'Result', new_thread: true, itsa: archived.key });
  assert.equal(sent.rerouted, 'mgr');
});

test('an ITSA reassigned to someone else reroutes its former owner’s mail', async () => {
  const moved = await itsa.create({ title: 'Moving work', by: 'human', owner: 'o1', participants: ['human'] });
  await itsa.set(moved.key, { owner: 'd1' }, 'human');
  const sent = await itsa.post(moved.key, { by: 'o1', body: 'Result', to: ['human'] });
  assert.equal(sent.rerouted, 'mgr');
});

test('the human’s reply in an ITSA thread reaches the owner, and no parent or chief of staff', async () => {
  const sent = await itsa.post(owned.key, { by: 'o1', body: 'Question for you', to: ['human'] });
  const reply = await mail.sendMail({ from: 'human', to: ['o1'], subject: sent.subject, body: 'Answer', reply_to: sent.id });
  const ids = recipientIds(reply);
  assert.ok(ids.includes('o1'));
  assert.ok(!ids.includes('c1'));
  assert.ok(!ids.includes('m1'));
});

// S-4163: a relayed original (an ITSA post by an agent on a peer, relayed here by its home) follows the S-548 rule with the
// routing facts its sending daemon attached (relay_route): the ITSA's owner goes direct, an exempt sender goes direct as
// before, and anyone else reroutes to the parent that daemon named. Facts missing (an older peer) keep main's delivery.
const relayed = (from, row, extra = {}) => mail.sendMail({ from, to: ['human'], subject: 'Relayed', body: 'Result', itsa_id: row.id, thread_id: itsa.ensureThread(row.id), kind: 'comment', forwarded: { from_name: from }, relay: true, ...extra });
const mgrRoute = { exempt: false, parent: 'mgr' };

test('a relayed ITSA post by its owner on a peer goes to the human directly', async () => {
  const sent = await relayed('rowner', remoteOwned, { relay_route: mgrRoute });
  assert.equal(sent.rerouted, undefined);
  assert.ok(inbox('human').includes(sent.id));
});

test('a relayed ITSA post by a non-owner on a peer reroutes to the parent its daemon named', async () => {
  const sent = await relayed('rother', remoteOther, { relay_route: mgrRoute });
  assert.equal(sent.rerouted, 'mgr');
  assert.ok(inbox('m1').includes(sent.id));
  assert.ok(!inbox('human').includes(sent.id));
  assert.match(db.getMail(sent.id).body, /^Meant for your user\./);
});

test('a relayed post by an exempt sender on a peer goes to the human directly, as on main', async () => {
  const sent = await relayed('rother', remoteOther, { relay_route: { exempt: true, parent: 'mgr' } });
  assert.equal(sent.rerouted, undefined);
  assert.ok(inbox('human').includes(sent.id));
});

test('a relayed post with no routing facts (an older peer) goes to the human directly, as on main', async () => {
  const sent = await relayed('rother', remoteOther);
  assert.equal(sent.rerouted, undefined);
  assert.ok(inbox('human').includes(sent.id));
});

test('a relayed non-owner whose parent can’t be named is refused, not delivered to the human', async () => {
  const before = inbox('human').length;
  await assert.rejects(relayed('rother', remoteOther, { relay_route: { exempt: false } }), /parent can't be reached/);
  assert.equal(inbox('human').length, before);
});

test('a relayed post by a former owner, once the ITSA is reassigned, reroutes', async () => {
  await itsa.set(remoteOwned.key, { owner: 'o1' }, 'human');
  const sent = await relayed('rowner', remoteOwned, { relay_route: mgrRoute });
  assert.equal(sent.rerouted, 'mgr');
});

test('a relayed post by an archived peer agent reroutes', async () => {
  const sent = await relayed('rgone', remoteGone, { relay_route: mgrRoute });
  assert.equal(sent.rerouted, 'mgr');
});

test('a delivery copy of a mail is not checked again here', async () => {
  const sent = await mail.sendMail({ from: 'rother', to: ['human'], subject: 'Copy', body: 'Result', itsa_id: remoteOther.id, thread_id: itsa.ensureThread(remoteOther.id), kind: 'comment', forwarded: { from_name: 'rother' } });
  assert.equal(sent.rerouted, undefined);
});

test('a relayed original from a local agent that isn’t the owner reroutes as its own mail does', async () => {
  const sent = await relayed('d1', remoteOther);
  assert.equal(sent.rerouted, 'mgr');
});

// S-4163: a reply that names an ITSA is a comment on the reply's own ITSA; a different one named is refused, not dropped.
test('a reply with the ITSA the reply is in is a comment there', async () => {
  const base = await itsa.post(owned.key, { by: 'o1', body: 'Base' });
  const sent = await mail.sendMail({ from: 'd1', to: ['o1'], subject: 'Re: Base', body: 'Ok', reply_to: base.id, itsa: owned.key });
  assert.equal(sent.itsa_id, owned.id);
});

test('a reply that names a different ITSA than the one it is in is refused', async () => {
  const base = await itsa.post(owned.key, { by: 'o1', body: 'Base again' });
  await assert.rejects(mail.sendMail({ from: 'd1', to: ['o1'], subject: 'Re: Base', body: 'Ok', reply_to: base.id, itsa: others.key }), /another ITSA/);
});
