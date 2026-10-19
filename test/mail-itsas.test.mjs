#!/usr/bin/env node
// Unit tests for S-986: a mail is linked to the ITSAs it is about (named by the sender, keys in its
// text outside code, the ITSA whose thread it is in) in mail_itsas, without becoming mail: no
// recipient, no unread count. Thread and inbox reads carry the links, the reverse lookup lists an ITSA's
// linked mail newest first and bounded, and the migration fills older mail. Throwaway STAM_HOME, no daemon.
// Run with `node --test test/mail-itsas.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-mail-itsas-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `mail-itsas-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

let db, itsa, mail, keys, readable, vis;
const agent = (id, name) => db.createAgent({ id, name, role: 'dev', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
const send = (o) => mail.sendMail({ from: 'a1', to: ['bob'], new_thread: true, ...o });
const sources = (id) => (db.mailItsaLinks([id]).get(id) ?? []).map((l) => `${l.key}:${l.source}`);

before(async () => {
  db = await import('../src/db.ts');
  itsa = await import('../src/itsa.ts');
  mail = await import('../src/mail.ts');
  keys = await import('../src/itsa-keys.ts');
  readable = await import('../src/mail-itsas.ts');
  vis = await import('../src/mail-visibility.ts');
  db.open();
  agent('a1', 'alice');
  agent('a2', 'bob');
});
after(() => rmSync(home, { recursive: true, force: true }));

test('namedKeys reads keys outside code only', () => {
  const text = 'See S-12 and TEAM-S-7, not S-99 in `S-98` or\n```\nS-97\n```\nbut S-12 again. Also x-5y and S-1a.';
  assert.deepEqual(keys.namedKeys(text), ['S-12', 'TEAM-S-7', 'S-99']);
  assert.deepEqual(keys.namedKeys('```\nS-5 never closed'), []);
});

test('a mail is linked by the ITSA the sender named, and by keys in its subject or body, once each', async () => {
  const a = await itsa.create({ title: 'First', by: 'human', owner: 'alice' });
  const b = await itsa.create({ title: 'Second', by: 'human', owner: 'alice' });
  const m = await send({ subject: `Re ${b.key}`, body: `Cc ${a.key} and ${b.key}; unknown S-9999; code \`${a.key}\``, itsa: a.key });
  assert.deepEqual(sources(m.id), [`${a.key}:itsa`, `${b.key}:named`]);
  const plain = await send({ subject: 'Plain', body: 'Nothing here' });
  assert.deepEqual(sources(plain.id), []);
});

test('a key inside code or an unknown key links nothing', async () => {
  const a = await itsa.create({ title: 'Quoted', by: 'human', owner: 'alice' });
  const m = await send({ subject: 'Code', body: `Run \`${a.key}\`.\n\`\`\`\n${a.key}\n\`\`\`\nAnd S-9999.` });
  assert.deepEqual(sources(m.id), []);
});

test('mail in an ITSA’s thread is linked as thread, and a link makes no mail or unread', async () => {
  const x = await itsa.create({ title: 'Threaded', by: 'human', owner: 'alice', participants: ['bob'] });
  const before = db.inbox('human', true, 100).length;
  const m = await itsa.post(x.key, { by: 'alice', body: 'An update.' });
  assert.deepEqual(sources(m.id), [`${x.key}:thread`]);
  const named = await send({ subject: 'Mentions', body: `About ${x.key}` });
  assert.deepEqual(sources(named.id), [`${x.key}:named`]);
  assert.equal(db.getMail(named.id) && db.threadMail(named.thread_id ?? named.id)[0].recipients.map((r) => r.id).join(), 'a2');
  assert.equal(db.inbox('human', true, 100).length, before);
});

test('a comment in an ITSA’s own thread links it as thread, even when it names its own key', async () => {
  const x = await itsa.create({ title: 'Own thread', by: 'human', owner: 'alice', participants: ['bob'] });
  const y = await itsa.create({ title: 'Other', by: 'human', owner: 'alice' });
  const a = await itsa.post(x.key, { by: 'alice', body: 'Plain comment.' });
  const b = await itsa.post(x.key, { by: 'alice', body: `Names ${x.key} and ${y.key}.` });
  assert.deepEqual(sources(a.id), [`${x.key}:thread`]);
  assert.deepEqual(sources(b.id).sort(), [`${y.key}:named`, `${x.key}:thread`].sort());
});

test('threads and the inbox carry each mail’s linked ITSAs; mail without links has none', async () => {
  const x = await itsa.create({ title: 'Carried', by: 'human', owner: 'alice' });
  const m = await send({ subject: 'Carry', body: `For ${x.key}` });
  const [t] = db.threadMail(m.thread_id ?? m.id);
  assert.deepEqual(t.itsas.map((l) => [l.key, l.title, l.status, l.source]), [[x.key, 'Carried', x.status, 'named']]);
  const inbox = db.inbox('a2', false, 100).find((i) => i.id === m.id);
  assert.equal(inbox.itsas[0].key, x.key);
  const plain = await send({ subject: 'Bare', body: 'none' });
  assert.equal(db.threadMail(plain.thread_id ?? plain.id)[0].itsas, undefined);
});

test('the reverse lookup lists linked threads newest first, bounded by threads, without the ITSA’s own thread', async () => {
  const x = await itsa.create({ title: 'Reverse', by: 'human', owner: 'alice', participants: ['bob'] });
  const first = await send({ subject: 'One', body: x.key });
  const second = await send({ subject: 'Two', body: x.key });
  const reply = await mail.sendMail({ from: 'a2', to: ['alice'], body: `Also ${x.key}`, reply_to: second.id });
  await itsa.post(x.key, { by: 'alice', body: 'In its own thread.' });
  const own = itsa.must(x.key).thread_id;
  const rows = db.linkedThreads(x.id, itsa.must(x.key).thread_id, 10);
  assert.deepEqual(rows.map((r) => [r.subject, r.mails, r.mail_id]), [['Two', 2, reply.id], ['One', 1, first.id]]);
  assert.ok(!rows.some((r) => r.thread_id === own));
  assert.equal(rows[0].from_id, 'a2');
  assert.equal(db.linkedThreads(x.id, itsa.must(x.key).thread_id, 1).length, 1);
  assert.equal(itsa.mergeLinkedThreads([...rows, { ...rows[1], mails: 3 }], 10).find((r) => r.subject === 'One').mails, 3);
});

test('a busy ITSA thread does not crowd out other linked threads, and visibility is checked once per thread', async () => {
  const x = await itsa.create({ title: 'Busy', by: 'human', owner: 'alice', participants: ['bob'] });
  const other = await send({ subject: 'Other thread', body: `About ${x.key}` });
  for (let i = 0; i < 60; i++) await itsa.post(x.key, { by: 'alice', body: `update ${i}` });
  let asked = 0;
  const rows = readable.readableLinkedThreads(x.id, itsa.must(x.key).thread_id, 5, () => (asked++, true));
  assert.deepEqual(rows.map((r) => r.thread_id), [other.thread_id ?? other.id]);
  assert.equal(asked, 1);
});

test('the linked list holds back threads the viewer may not read', async () => {
  const x = await itsa.create({ title: 'Private', by: 'human', owner: 'alice', participants: ['bob'] });
  agent('a3', 'carol');
  const m = await send({ subject: 'Between a1 and a2', body: `Re ${x.key}` });
  const mayRead = (box) => (tid) => vis.threadReader(box, tid, box);
  assert.equal(readable.readableLinkedThreads(x.id, null, 5, mayRead('a2')).some((r) => r.mail_id === m.id), true);
  assert.equal(readable.readableLinkedThreads(x.id, null, 5, mayRead('a3')).some((r) => r.mail_id === m.id), false);
});

test('a linked row shows only the subject, count and newest mail the viewer may read', async () => {
  const x = await itsa.create({ title: 'Partial', by: 'human', owner: 'alice', participants: ['bob'] });
  agent('a4', 'dave');
  const root = await mail.sendMail({ from: 'a1', to: ['bob'], new_thread: true, subject: 'Secret root', body: 'Nothing linked here' });
  const a = await mail.sendMail({ from: 'a1', to: ['a4'], subject: 'Re: shared one', body: `Note on ${x.key}`, reply_to: root.id });
  const b = await mail.sendMail({ from: 'a1', to: ['bob'], subject: 'Re: private two', body: `Later on ${x.key}`, reply_to: a.id });
  const mayRead = (box, ids) => (tid) => { const r = vis.threadReader(box, tid, box); return r === true ? r : (mm) => ids.includes(mm.id) && r(mm); };
  const rows = readable.readableLinkedThreads(x.id, null, 5, mayRead('a4', [a.id]));
  assert.deepEqual(rows.map((r) => [r.subject, r.mails, r.mail_id]), [['Re: shared one', 1, a.id]]);
  assert.ok(rows.every((r) => r.subject !== 'Secret root'));
  // A viewer who reads the whole thread sees its title, the root subject.
  const all = readable.readableLinkedThreads(x.id, null, 5, () => true);
  assert.deepEqual(all.map((r) => [r.subject, r.mails, r.mail_id]), [['Secret root', 2, b.id]]);
});

test('the ITSA’s own thread is left out where the ITSA is not known, by its thread source', async () => {
  const x = await itsa.create({ title: 'Own thread', by: 'human', owner: 'alice', participants: ['bob'] });
  await itsa.post(x.key, { by: 'alice', body: 'In its own thread.' });
  const other = await send({ subject: 'Elsewhere', body: x.key });
  // A peer that does not hold the ITSA passes no own thread.
  assert.deepEqual(db.linkedThreads(x.id, null, 10).map((r) => r.thread_id), [other.thread_id ?? other.id]);
});

test('the linked route’s local part: an outsider sees nothing, a participant their threads, never the own thread', async () => {
  const x = await itsa.create({ title: 'Route', by: 'human', owner: 'alice', participants: ['bob'] });
  agent('a5', 'erin');
  await itsa.post(x.key, { by: 'alice', body: 'In its own thread.' });
  const m = await send({ subject: 'About route', body: `Re ${x.key}` });
  const as = (box) => readable.linkedThreadsFor(x.key, 10, { all: false, box, reader: box });
  assert.deepEqual(as('a5'), []);
  assert.deepEqual(as('a2').map((r) => r.mail_id), [m.id]);
  assert.deepEqual(readable.linkedThreadsFor(x.key, 10, { all: true, box: '', reader: '' }).map((r) => r.mail_id), [m.id]);
});

test('a forwarded comment on an unknown ITSA keeps its thread out, as on a peer', async () => {
  const x = await itsa.create({ title: 'Peer', by: 'human', owner: 'alice', participants: ['bob'] });
  await itsa.post(x.key, { by: 'alice', body: 'A comment.' });
  const own = itsa.must(x.key).thread_id;
  const other = await send({ subject: 'Elsewhere too', body: x.key });
  // The comment's links are stored as `itsa` here, as a peer holding only a forwarded comment would have them.
  db.open().prepare("UPDATE mail_itsas SET source = 'itsa' WHERE itsa_id = ?").run(x.id);
  assert.deepEqual(db.linkedThreads(x.id, null, 10).map((r) => r.thread_id), [other.thread_id ?? other.id]);
});

test('many threads of many mails: a participant and an outsider are answered quickly, one thread load per thread', async () => {
  const x = await itsa.create({ title: 'Flood', by: 'human', owner: 'alice', participants: ['bob'] });
  agent('a6', 'frank');
  for (let t = 0; t < 12; t++) {
    let prev = await send({ subject: `Flood ${t}`, body: `Re ${x.key}` });
    for (let i = 1; i < 40; i++) prev = await mail.sendMail({ from: 'a1', to: ['bob'], body: `Re ${x.key} ${i}`, reply_to: prev.id });
  }
  const t0 = Date.now();
  const as = (box) => readable.linkedThreadsFor(x.key, 20, { all: false, box, reader: box });
  assert.equal(as('a2').length, 12);
  assert.equal(as('a2')[0].mails, 40);
  assert.deepEqual(as('a6'), []);
  // 12 threads x 40 mails: a thread load per mail took seconds; one per thread is a few hundred ms at most.
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
});

test('the migration fills links for older mail and runs once', async () => {
  const x = await itsa.create({ title: 'Old', by: 'human', owner: 'alice' });
  const m = await send({ subject: 'Old news', body: `About ${x.key}`, itsa: x.key });
  const d = db.open();
  d.exec('DELETE FROM mail_itsas');
  d.exec("DELETE FROM migrations WHERE name = 'mail-itsas-backfill'");
  db.backfillMailItsas(d);
  assert.ok(sources(m.id).includes(`${x.key}:itsa`));
  const n = d.prepare('SELECT COUNT(*) AS n FROM mail_itsas').get().n;
  db.backfillMailItsas(d);
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM mail_itsas').get().n, n);
});

test('attachToMail links ITSAs and agents silently, for a recipient or a boss only (S-1305)', async () => {
  const x = await itsa.create({ title: 'Attached', by: 'human', owner: 'alice' });
  const m = await send({ subject: 'Request', body: 'Please build it.' });
  const unread = () => db.inbox('bob', true, 100).length;
  const before = unread();
  const r = readable.attachToMail(m.id, 'a2', { itsas: [x.key], agents: ['alice'] }, false);
  assert.deepEqual(r, { itsas: [x.id], agents: ['a1'] });
  assert.deepEqual(sources(m.id), [`${x.key}:attached`]);
  assert.deepEqual(db.threadMail(m.thread_id).find((t) => t.id === m.id).agents, ['a1']);
  assert.equal(unread(), before);
  assert.deepEqual(readable.attachToMail(m.id, 'a2', { agents: ['a1'] }, false).agents, []);
  assert.throws(() => readable.attachToMail(m.id, 'a1', { itsas: [x.key] }, false), /recipient/);
  assert.equal(readable.attachToMail(m.id, 'a1', { itsas: [x.key] }, true).itsas.length, 1);
  assert.throws(() => readable.attachToMail(m.id, 'a2', { itsas: ['S-99999'] }, false), /no ITSA/);
  assert.throws(() => readable.attachToMail('nope', 'a2', { itsas: [x.key] }, true), /no mail/);
});

test('attachToMail takes a known peer agent by name or id and stores its canonical id (S-1305)', async () => {
  db.rememberPeerAgent({ id: 'peer-dev', name: 'remote-dev', machine: 'other' });
  const m = await send({ subject: 'Peer', body: 'Route it.' });
  assert.deepEqual(readable.attachToMail(m.id, 'boss', { agents: ['remote-dev'] }, true).agents, ['peer-dev']);
  assert.deepEqual(readable.attachToMail(m.id, 'boss', { agents: ['peer-dev'] }, true).agents, []);
  assert.deepEqual(db.threadMail(m.thread_id).find((t) => t.id === m.id).agents, ['peer-dev']);
});
