#!/usr/bin/env node
// send_mail `supersedes` (S-1304, src/mail.ts): the old mail stays in its thread but leaves the unread
// counts of every recipient, and the human's copy is withdrawn with its decision; only the sender, only
// an exact id, once. Throwaway STAM_HOME, no daemon, no models: `node --test test/supersede.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-supersede-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `supersede-test-${process.pid}`;
process.env.STAM_EMBEDDER = 'stub';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let db, mail;
const agent = (id) => db.createAgent({ id, name: id, role: 'test', machine: 'x', harness: 'claude', model: 'claude-opus-5-5', effort: null, cwd: '/tmp', parent_id: null, session_id: null });
before(async () => {
  db = await import('../src/db.ts');
  mail = await import('../src/mail.ts');
  agent('s-a');
  agent('s-b');
});
after(() => rmSync(home, { recursive: true, force: true }));

const copy = (id, who) => db.threadMail(db.mailThreadId(id)).find((m) => m.id === id).recipients.find((r) => r.id === who);

test('a superseded mail leaves the recipient unread count and stays in its thread', async () => {
  const old = await mail.sendMail({ from: 's-a', to: ['s-b'], subject: 'Plan', body: 'first', new_thread: true });
  assert.equal(db.unreadCount('s-b'), 1);
  const next = await mail.sendMail({ from: 's-a', to: ['s-b'], subject: 'Plan', body: 'second', reply_to: old.id, supersedes: old.id });
  assert.equal(db.unreadCount('s-b'), 1, 'only the newest mail is unread');
  assert.deepEqual(db.inbox('s-b', true, 10).map((m) => m.id), [next.id]);
  assert.equal(db.getMail(old.id).superseded_by, next.id);
  assert.ok(db.threadMail(old.thread_id).some((m) => m.id === old.id), 'still in the thread');
});

test('a superseded decision mail leaves the human attention and the decision list, and the thread stays open', async () => {
  const body = '```decision\nPick?\n- A: x\n- B: y\n```';
  const old = await mail.sendMail({ from: 's-a', to: ['human'], subject: 'Pick', body, new_thread: true, override: 'test' });
  const next = await mail.sendMail({ from: 's-a', to: ['human'], subject: 'Pick', body: 'Pick again?\n\n' + body, reply_to: old.id, supersedes: old.id, override: 'test' });
  assert.ok(!db.decisionMails().some((m) => m.mail_id === old.id));
  assert.ok(db.decisionMails().some((m) => m.mail_id === next.id));
  const r = copy(old.id, 'human');
  assert.ok(r.read_at && r.withdrawn_at);
  assert.equal(r.withdrawn_note, `Superseded by ${next.id}`);
  assert.ok(!copy(next.id, 'human').read_at, 'the new mail is unread');
  assert.equal(db.splitArchived('human', [{ thread_id: next.thread_id, mails: db.threadMail(next.thread_id) }]).archived.length, 0);
});

test('only the sender, an existing exact id, and a mail not yet superseded', async () => {
  const m1 = await mail.sendMail({ from: 's-a', to: ['s-b'], subject: 'X', body: 'x', new_thread: true });
  await assert.rejects(mail.sendMail({ from: 's-b', to: ['s-a'], subject: 'Y', body: 'y', new_thread: true, supersedes: m1.id }), /only its sender/);
  await assert.rejects(mail.sendMail({ from: 's-a', to: ['s-b'], subject: 'Y', body: 'y', new_thread: true, supersedes: 'mdeadbeef' }), /no mail/);
  const m2 = await mail.sendMail({ from: 's-a', to: ['s-b'], subject: 'Y', body: 'y', reply_to: m1.id, supersedes: m1.id });
  await assert.rejects(mail.sendMail({ from: 's-a', to: ['s-b'], subject: 'Z', body: 'z', reply_to: m2.id, supersedes: m1.id }), /already superseded/);
});

test('a recipient daemon applies a forwarded supersedes to the copy it holds, and ignores one it does not', async () => {
  const old = await mail.sendMail({ from: 's-a', to: ['s-b'], subject: 'F', body: 'old', new_thread: true });
  assert.equal(db.getMail(old.id).superseded_by ?? null, null);
  const before = db.unreadCount('s-b');
  const next = await mail.sendMail({ from: 's-a', to: ['s-b'], subject: 'F', body: 'new', thread_id: old.thread_id, reply_to: old.id, forwarded: { from_name: 's-a' }, supersedes: old.id });
  assert.equal(db.getMail(old.id).superseded_by, next.id);
  assert.equal(db.unreadCount('s-b'), before, 'old read, new unread');
  // A copy this daemon doesn't hold, or another sender's, is left alone.
  const other = await mail.sendMail({ from: 's-b', to: ['s-a'], subject: 'G', body: 'x', new_thread: true });
  await mail.sendMail({ from: 's-a', to: ['s-b'], subject: 'G', body: 'y', new_thread: true, forwarded: { from_name: 's-a' }, supersedes: other.id });
  await mail.sendMail({ from: 's-a', to: ['s-b'], subject: 'G', body: 'y', new_thread: true, forwarded: { from_name: 's-a' }, supersedes: 'mnothere' });
  assert.equal(db.getMail(other.id).superseded_by ?? null, null);
});
