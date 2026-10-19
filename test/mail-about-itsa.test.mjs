#!/usr/bin/env node
// Unit tests for S-91: a mail is about an ITSA when the sender names it (`itsa`, a key or an
// id, stored as `about_itsa`), or when it is in the ITSA's own thread; naming an unknown ITSA
// is refused, and a reply to a mail that is only about an ITSA stays plain mail (it isn't a
// comment on the ITSA). Throwaway STAM_HOME, no daemon.
// Run with `node --test test/mail-about-itsa.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-mail-about-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `mail-about-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

let db, itsa, mail;
const agent = (id, name) => db.createAgent({ id, name, role: 'dev', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });

before(async () => {
  db = await import('../src/db.ts');
  itsa = await import('../src/itsa.ts');
  mail = await import('../src/mail.ts');
  db.open();
  agent('a1', 'alice');
  agent('a2', 'bob');
});
after(() => rmSync(home, { recursive: true, force: true }));

test('a mail naming an ITSA by key or id is about it, and the row says so', async () => {
  const x = await itsa.create({ title: 'Ship it', by: 'human', owner: 'alice' });
  const byKey = await mail.sendMail({ from: 'a1', to: ['bob'], subject: 'Question', body: 'Is it ready?', itsa: x.key });
  assert.equal(db.getMail(byKey.id).about_itsa, x.id);
  const byId = await mail.sendMail({ from: 'a1', to: ['bob'], subject: 'Another', body: 'Hmm', itsa: x.id, new_thread: true });
  assert.equal(db.getMail(byId.id).about_itsa, x.id);
  const plain = await mail.sendMail({ from: 'a1', to: ['bob'], subject: 'Plain', body: 'No ITSA', new_thread: true });
  assert.equal(db.getMail(plain.id).about_itsa, null);
  assert.equal(db.getMail(plain.id).itsa_id, null);
});

test('naming an ITSA that does not exist is refused', async () => {
  await assert.rejects(mail.sendMail({ from: 'a1', to: ['bob'], subject: 'x', body: 'y', itsa: 'S-999' }), /no ITSA S-999/);
});

test('mail in an ITSA’s own thread is about that ITSA without naming it', async () => {
  const x = await itsa.create({ title: 'Thread', by: 'human', owner: 'alice', participants: ['bob'] });
  const m = await itsa.post(x.key, { by: 'alice', body: 'An update for the thread.' });
  assert.equal(db.getMail(m.id).about_itsa, x.id);
  assert.equal(db.getMail(m.id).itsa_id, x.id);
});

test('a reply to a mail that is only about an ITSA is plain mail, not a comment on it', async () => {
  const x = await itsa.create({ title: 'Plain reply', by: 'human', owner: 'alice', participants: ['bob'] });
  const q = await mail.sendMail({ from: 'a1', to: ['bob'], subject: 'About it', body: 'Look at this.', itsa: x.key });
  const r = await mail.sendMail({ from: 'a2', to: ['alice'], body: 'Looked.', reply_to: q.id });
  const row = db.getMail(r.id);
  assert.equal(row.itsa_id, null);
  assert.equal(row.thread_id, q.thread_id ?? q.id);
  assert.equal(itsa.must(x.id).thread_id, null);
});

test('the migration backfills existing ITSA thread mail', async () => {
  const x = await itsa.create({ title: 'Old', by: 'human', owner: 'alice' });
  const m = await itsa.post(x.key, { by: 'alice', body: 'old comment' });
  db.open().prepare('UPDATE mail SET about_itsa = NULL WHERE id = ?').run(m.id);
  db.open().prepare('UPDATE mail SET about_itsa = itsa_id WHERE itsa_id IS NOT NULL AND about_itsa IS NULL').run();
  assert.equal(db.getMail(m.id).about_itsa, x.id);
});

test('an ITSA’s related threads: mail about it, minus its own thread, one row each (S-92)', async () => {
  const x = await itsa.create({ title: 'Related', by: 'human', owner: 'alice', participants: ['bob'] });
  const own = await itsa.post(x.key, { by: 'alice', body: 'own thread' });
  const a = await mail.sendMail({ from: 'a1', to: ['bob'], subject: 'About it', body: 'first', itsa: x.key });
  await mail.sendMail({ from: 'a2', to: ['alice'], body: 'reply', reply_to: a.id });
  const other = await mail.sendMail({ from: 'a2', to: ['human'], subject: 'Elsewhere', body: 'not about it', new_thread: true });
  const groups = db.aboutItsaThreads(x.id);
  const rows = itsa.aboutThreads(groups, itsa.must(x.id).thread_id);
  assert.deepEqual(rows.map((r) => r.thread_id), [a.thread_id ?? a.id]);
  assert.equal(rows[0].subject, 'About it');
  assert.deepEqual(rows[0].participants.sort(), ['a1', 'a2'].sort().map((id) => id));
  assert.equal(rows[0].unread, 0);
  // Mail the human hasn't read counts as unread; the ITSA's own thread never shows.
  const unreadMail = await mail.sendMail({ from: 'a1', to: ['human'], subject: 'Ping', body: 'hi', itsa: x.key, new_thread: true });
  const again = itsa.aboutThreads(db.aboutItsaThreads(x.id), itsa.must(x.id).thread_id);
  assert.equal(again.length, 2);
  assert.equal(again[0].thread_id, unreadMail.thread_id ?? unreadMail.id);
  assert.equal(again[0].unread, 1);
  assert.ok(!again.some((r) => r.thread_id === own.thread_id));
  assert.equal(db.getMail(other.id).about_itsa, null);
});
