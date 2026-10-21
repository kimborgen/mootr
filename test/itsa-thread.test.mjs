#!/usr/bin/env node
// Unit tests for ITSA mail threads (step 3): the thread made by the first post (subject
// `KEY Title`), recipients (participants minus the sender, the sender joining), update
// health, send_mail with reply_to into the thread as a comment, quiet delivery (the in-turn
// notice skips ITSA mail unless it names the recipient, comes from the human, or comes from
// the owner), and the merged thread of mails and status/owner events. Throwaway STAM_HOME,
// no daemon, no network. Run with `node --test test/itsa-thread.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-itsa-thread-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `itsa-thread-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

let db, itsa, mail, x;
const agent = (id, name) => db.createAgent({ id, name, role: 'dev', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
const unread = (id) => db.inbox(id, true, 50).map((m) => m.id);

before(async () => {
  db = await import('../src/db.ts');
  itsa = await import('../src/itsa.ts');
  mail = await import('../src/mail.ts');
  db.open();
  for (const [id, name] of [['a1', 'alice'], ['a2', 'bob'], ['a3', 'carol'], ['a4', 'dave']]) agent(id, name);
  // alice owns it; bob and carol take part.
  x = await itsa.create({ title: 'Thread test', by: 'human', owner: 'alice', participants: ['bob', 'carol'] });
});
after(() => {
  rmSync(home, { recursive: true, force: true });
});

test('the first post creates the thread, subject KEY Title, and sets itsas.thread_id', async () => {
  assert.equal(x.thread_id, null);
  const m = await itsa.post(x.key, { by: 'bob', body: 'first comment' });
  assert.equal(m.subject, `${x.key} Thread test`);
  assert.equal(itsa.must(x.id).thread_id, m.thread_id);
  assert.equal(m.itsa_id, x.id);
  assert.equal(m.kind, 'comment');
  const row = db.getMail(m.id);
  assert.equal(row.itsa_id, x.id);
  assert.equal(row.kind, 'comment');
  assert.equal(row.health, null);
});

test('recipients are the participants minus the sender, and posting makes the sender a participant', async () => {
  const m = await itsa.post(x.key, { by: 'dave', body: 'drive-by comment' });
  assert.deepEqual(db.threadMail(m.thread_id).at(-1).recipients.map((r) => r.id).sort(), ['a1', 'a2', 'a3']);
  assert.ok(itsa.participants(x.id).includes('a4'));
  const m2 = await itsa.post(x.key, { by: 'bob', body: 'again' });
  assert.deepEqual(db.threadMail(m2.thread_id).at(-1).recipients.map((r) => r.id).sort(), ['a1', 'a3', 'a4']);
  assert.equal(db.threadMail(m2.thread_id).at(-1).subject, `Re: ${x.key} Thread test`);
});

test('the human is a recipient of an agent’s comment only when named, and a human post makes them a participant', async () => {
  const last = (await itsa.post(x.key, { by: 'bob', body: 'no human yet' }));
  assert.ok(!db.threadMail(last.thread_id).at(-1).recipients.some((r) => r.id === 'human'));
  await itsa.post(x.key, { by: 'human', body: 'human here' });
  assert.ok(itsa.participants(x.id).includes('human'));
  // An agent's comment doesn't mail the human, even a participant; a `to` naming them does.
  const m = await itsa.post(x.key, { by: 'bob', body: 'not for the human' });
  assert.ok(!db.threadMail(m.thread_id).at(-1).recipients.some((r) => r.id === 'human'));
  const n = await itsa.post(x.key, { by: 'bob', body: 'now the human is told', to: ['human'] });
  assert.ok(db.threadMail(n.thread_id).at(-1).recipients.some((r) => r.id === 'human'));
});

test('an update needs a health; a comment cannot have one; kind is validated', async () => {
  await assert.rejects(itsa.post(x.key, { by: 'alice', kind: 'update', body: 'status' }), /health/);
  await assert.rejects(itsa.post(x.key, { by: 'alice', kind: 'update', health: 'fine', body: 'status' }), /health/);
  await assert.rejects(itsa.post(x.key, { by: 'alice', health: 'on_track', body: 'status' }), /only an update/);
  await assert.rejects(itsa.post(x.key, { by: 'alice', kind: 'poem', body: 'x' }), /unknown kind/);
  await assert.rejects(itsa.post(x.key, { by: 'alice', body: '  ' }), /body/);
  const m = await itsa.post(x.key, { by: 'alice', kind: 'update', health: 'at_risk', body: 'slipping' });
  const row = db.getMail(m.id);
  assert.equal(row.kind, 'update');
  assert.equal(row.health, 'at_risk');
});

test('send_mail with reply_to into the thread is a comment: participants get it; only one the ITSA lets post may (S-480)', async () => {
  const t = itsa.must(x.id).thread_id;
  const parent = db.threadMail(t).at(-1);
  agent('a5', 'erin');
  // erin has the thread's mail in her mailbox (named in a post); she isn't in the ITSA, so her reply is refused.
  db.createMail({ id: 'seed-erin', from_id: 'a2', from_name: 'bob', subject: parent.subject, body: 'seed', thread_id: t, reply_to: null, itsa_id: x.id, kind: 'comment' }, ['a5']);
  await assert.rejects(mail.sendMail({ from: 'a5', to: ['bob'], body: 'let me in', reply_to: 'seed-erin' }), /erin can't post to S-1: .*add you with itsa_set participants/);
  assert.ok(!itsa.participants(x.id).includes('a5'));
  // Added as a participant, her reply goes to everyone else.
  await itsa.addParticipant(x.id, 'a5');
  const m = await mail.sendMail({ from: 'a5', to: ['bob'], body: 'via send_mail', reply_to: 'seed-erin' });
  assert.equal(m.thread_id, t);
  assert.equal(m.kind, 'comment');
  assert.equal(m.itsa_id, x.id);
  assert.ok(itsa.participants(x.id).includes('a5'));
  const got = db.threadMail(t).at(-1);
  assert.equal(got.body, 'via send_mail');
  assert.ok(['a1', 'a2', 'a3', 'a4'].every((id) => got.recipients.some((r) => r.id === id)), 'participants beyond the named `to` are included');
});

test('quiet delivery: no in-turn notice for ITSA comments; they wait for the idle batch', async () => {
  const y = await itsa.create({ title: 'Quiet', by: 'human', owner: 'alice', participants: ['bob', 'carol'] });
  for (const id of ['a1', 'a2', 'a3']) db.open().prepare("UPDATE mail_recipients SET read_at = datetime('now') WHERE agent_id = ? AND read_at IS NULL").run(id);
  const m = await itsa.post(y.key, { by: 'dave', body: 'plain comment' });
  assert.equal(mail.inTurnNotice('a2'), undefined, 'bob is not interrupted');
  assert.equal(mail.inTurnNotice('a3'), undefined);
  // The mail is unread and unpushed, so the idle push still delivers it.
  assert.ok(unread('a2').includes(db.threadMail(m.thread_id).at(-1).id));
  assert.equal(db.unpushedCount('a2'), 1);
});

test('exceptions interrupt: an @name mention, the human, and the ITSA owner', async () => {
  const y = await itsa.create({ title: 'Loud', by: 'human', owner: 'alice', participants: ['bob', 'carol'] });
  const clear = () => db.open().prepare("UPDATE mail_recipients SET read_at = datetime('now') WHERE read_at IS NULL").run();
  clear();
  // A mention interrupts the one named, and only them.
  await itsa.post(y.key, { by: 'dave', body: 'need you @bob, not the others' });
  assert.match(mail.inTurnNotice('a2') ?? '', /unread mail/);
  assert.equal(mail.inTurnNotice('a3'), undefined);
  assert.equal(mail.inTurnNotice('a1'), undefined);
  // A name that only starts like the recipient's doesn't count.
  clear();
  await itsa.post(y.key, { by: 'dave', body: 'ping @bobby and bob@example.com' });
  assert.equal(mail.inTurnNotice('a2'), undefined);
  // The owner's post interrupts every recipient.
  clear();
  await itsa.post(y.key, { by: 'alice', body: 'from the owner' });
  assert.match(mail.inTurnNotice('a2') ?? '', /unread mail/);
  assert.match(mail.inTurnNotice('a3') ?? '', /unread mail/);
  // So does the human's.
  clear();
  await itsa.post(y.key, { by: 'human', body: 'from the human' });
  assert.match(mail.inTurnNotice('a1') ?? '', /unread mail/);
  // A normal mail still interrupts, even with quiet ITSA mail waiting.
  clear();
  await itsa.post(y.key, { by: 'dave', body: 'quiet one' });
  await mail.sendMail({ from: 'a4', to: ['bob'], subject: 'Plain', body: 'hello', new_thread: true });
  const n = mail.inTurnNotice('a2') ?? '';
  assert.match(n, /1 unread mail/);
  assert.match(n, /Plain/);
  assert.doesNotMatch(n, /Loud/);
});

test('the merged thread has mails and status/owner events by time, not as mail', async () => {
  const y = await itsa.create({ title: 'Events', by: 'human', owner: 'alice', participants: ['bob'] });
  await itsa.post(y.key, { by: 'bob', body: 'before' });
  await new Promise((r) => setTimeout(r, 10));
  await itsa.set(y.key, { status: 'in_progress' }, 'alice');
  await itsa.set(y.key, { owner: 'bob' }, 'human');
  await itsa.set(y.key, { title: 'Events renamed' }, 'human');
  await new Promise((r) => setTimeout(r, 10));
  await itsa.post(y.key, { by: 'alice', body: 'after' });
  const t = db.threadMail(itsa.must(y.id).thread_id);
  const items = itsa.mergeThread(t, itsa.threadEvents(y.key));
  assert.deepEqual(items.map((i) => (i.type === 'mail' ? i.mail.body : i.event)), ['before', 'status', 'owner', 'after']);
  const ev = items.filter((i) => i.type === 'event').map((i) => i.text);
  assert.equal(ev[0], 'alice changed status from backlog to in_progress');
  assert.equal(ev[1], 'the human changed owner from alice to bob');
  assert.equal(t.length, 2, 'events are not mail');
});

test('mergeThread folds copies by id only: same id joins recipients, same body with another id stays', () => {
  const mk = (id, to, over = {}) => ({ id, from_id: 'a1', subject: 's', body: 'same', created_at: '2026-01-01T00:00:00.000Z', recipients: [{ id: to, read_at: null }], ...over });
  const folded = itsa.mergeThread([mk('m1', 'a2'), mk('m1', 'a3')], []);
  assert.equal(folded.length, 1);
  assert.deepEqual(folded[0].mail.recipients.map((r) => r.id).sort(), ['a2', 'a3']);
  // Two identical comments, and two updates with different health, are different mails.
  assert.equal(itsa.mergeThread([mk('m1', 'a2'), mk('m2', 'a2')], []).length, 2);
  assert.equal(itsa.mergeThread([mk('m1', 'a2', { kind: 'update', health: 'on_track' }), mk('m2', 'a2', { kind: 'update', health: 'at_risk' })], []).length, 2);
});

test('a post with a ghost participant lands, and the next post joins its thread (S-281)', async () => {
  const y = await itsa.create({ title: 'Ghost', by: 'human', owner: 'alice', participants: ['bob'] });
  db.open().prepare("INSERT INTO itsa_participants (itsa_id, agent_id) VALUES (?, 'ghost')").run(y.id);
  const first = await itsa.post(y.key, { by: 'alice', body: 'first try' });
  const tid = itsa.must(y.id).thread_id;
  assert.equal(first.thread_id, tid);
  db.open().prepare("DELETE FROM itsa_participants WHERE itsa_id = ? AND agent_id = 'ghost'").run(y.id);
  const m = await itsa.post(y.key, { by: 'alice', body: 'second try' });
  assert.equal(m.thread_id, tid);
  assert.equal(itsa.must(y.id).thread_id, tid);
});

test('a forwarded mail stored under its original id is idempotent and adds recipients', async () => {
  const send = (to) => mail.sendMail({ from: 'a9', to, subject: 'Fwd', body: 'once', thread_id: 'tfwd', mail_id: 'mfwd1', forwarded: { from_name: 'remote' } });
  await send(['a2']);
  await send(['a3']);
  assert.equal(db.threadMail('tfwd').length, 1);
  assert.equal(db.threadMail('tfwd')[0].id, 'mfwd1');
  assert.deepEqual(db.threadMail('tfwd')[0].recipients.map((r) => r.id).sort(), ['a2', 'a3']);
});

test('a reply that joins the ITSA thread by inference is a comment for all participants', async () => {
  const y = await itsa.create({ title: 'Guessed', by: 'human', owner: 'alice', participants: ['bob', 'carol'] });
  const m = await itsa.post(y.key, { by: 'bob', body: 'question for alice' });
  const mine = db.threadMail(m.thread_id).at(-1);
  db.open().prepare("UPDATE mail_recipients SET read_at = datetime('now') WHERE mail_id = ? AND agent_id = 'a1'").run(mine.id);
  // alice answers bob without reply_to: the daemon guesses the thread.
  const r = await mail.sendMail({ from: 'a1', to: ['bob'], body: 'answer' , subject: '' });
  assert.equal(r.thread_id, m.thread_id);
  assert.equal(r.itsa_id, y.id);
  assert.equal(r.kind, 'comment');
  const got = db.threadMail(m.thread_id).at(-1);
  assert.deepEqual(got.recipients.map((x) => x.id).sort(), ['a2', 'a3']);
  // alice owns the ITSA, so it interrupts; and carol, a plain participant, was told.
  assert.match(mail.inTurnNotice('a3') ?? '', /unread mail/);
});

test('a repeat forward notifies only the recipients that are new', async () => {
  const fwd = (to) => mail.sendMail({ from: 'a9', to, subject: 'Repeat', body: 'x', thread_id: 'trep', mail_id: 'mrep1', forwarded: { from_name: 'remote' } });
  await fwd(['a2']);
  const got = (id) => db.listEvents(id, 100).filter((e) => e.type === 'mail:received' && e.data?.includes('mrep1')).length;
  assert.equal(got('a2'), 1);
  assert.equal(got('a3'), 0);
  await fwd(['a2', 'a3']);
  assert.equal(got('a2'), 1, 'the repeat does not notify a2 again');
  assert.equal(got('a3'), 1, 'the new recipient is notified, so its idle push is scheduled');
  assert.equal(db.unpushedCount('a3') >= 1, true);
});

test('foldMails joins recipients of same-id copies and keeps read state and attachments', () => {
  const copy = (recipients, extra = {}) => ({ id: 'mf1', from_id: 'a1', subject: 's', body: 'b', created_at: '2026-01-01T00:00:00.000Z', recipients, attachments: [], ...extra });
  const [m] = db.foldMails([
    copy([{ id: 'human', read_at: null }, { id: 'a2', read_at: '2026-01-01T01:00:00.000Z' }]),
    copy([{ id: 'a3', read_at: null }, { id: 'a2', read_at: null }], { attachments: [{ name: 'f.txt', path: '/p', size: 1 }] }),
  ]);
  assert.deepEqual(m.recipients.map((r) => r.id).sort(), ['a2', 'a3', 'human']);
  assert.equal(m.recipients.find((r) => r.id === 'a2').read_at, '2026-01-01T01:00:00.000Z');
  assert.equal(m.recipients.find((r) => r.id === 'human').read_at, null);
  assert.equal(m.attachments[0].name, 'f.txt');
});

test('a post skips an archived or forgotten participant and still reaches the rest (S-281)', async () => {
  agent('b5', 'erin-s281');
  agent('b6', 'frank-s281');
  agent('b7', 'gus-s281');
  const y = await itsa.create({ title: 'Gone participants', by: 'human', owner: 'a1', participants: ['erin-s281', 'frank-s281', 'gus-s281'] });
  db.updateAgent('b5', { lifecycle: 'archived' });
  db.forgetAgent('b6');
  const m = await itsa.post(y.key, { by: 'bob', body: 'still lands' });
  assert.equal(m.itsa_id, y.id);
  assert.equal(itsa.must(y.id).thread_id, m.thread_id);
  assert.equal(unread('b7').includes(m.id), true, 'the live participant still gets the post');
  assert.equal(unread('b5').includes(m.id), false, 'the archived participant is skipped');
  assert.equal(itsa.participants(y.id).includes('b5'), true, 'the participant row stays');
});

test('a participant on a peer that is down is kept, so its post is queued for it (S-281)', async () => {
  // A peer on a closed port refuses at once: the participant there can't be looked up.
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [{ name: 'far', url: 'http://127.0.0.1:9', token: 't' }] }));
  agent('c1', 'hank');
  const z = await itsa.create({ title: 'Down peer', by: 'human', owner: 'a1', participants: ['hank'] });
  db.open().prepare("INSERT INTO itsa_participants (itsa_id, agent_id) VALUES (?, 'far-s281')").run(z.id);
  // Seen on the peer before it went down, so the mail for it can wait in the outbox.
  db.rememberPeerAgent({ id: 'far-s281', name: 'far-s281', machine: 'far' });
  const m = await itsa.post(z.key, { by: 'bob', body: 'waits for the peer' });
  assert.ok(itsa.must(z.id).thread_id, 'the post joined the ITSA thread');
  assert.equal(unread('c1').includes(m.id), true, 'the local participant gets the post');
  assert.equal(db.outboxRows().some((r) => r.peer === 'far' && r.body.includes('far-s281')), true, 'the post for the down peer waits in its outbox');
});

// S-542 (it was S-308): in a thread the user started, mail reaches the user only when it is addressed to them.
test('an agent’s reply to the human’s mail in the ITSA thread reaches the human only when addressed to them', async () => {
  const q = await itsa.post(x.key, { by: 'human', body: 'Dana asks something' });
  await mail.sendMail({ from: 'bob', to: ['alice'], body: 'bob to alice', reply_to: q.id });
  await mail.sendMail({ from: 'bob', to: ['human'], body: 'answer for Dana', reply_to: q.id });
  const sent = (body) => db.threadMail(q.thread_id).findLast((m) => m.body === body);
  assert.ok(!sent('bob to alice').recipients.some((r) => r.id === 'human'), 'mail between agents stays out of the human\'s inbox');
  assert.ok(sent('answer for Dana').recipients.some((r) => r.id === 'human'), 'an answer addressed to the human reaches them');
});

test('a from_stam reply into an ITSA thread stays a notice, so it does not undefer the thread for bob (S-2033)', async () => {
  const y = await itsa.create({ title: 'Stam reply', by: 'human', owner: 'alice', participants: ['bob', 'carol'] });
  const m = await itsa.post(y.key, { by: 'bob', body: 'first' });
  const parent = db.threadMail(m.thread_id).at(-1);
  db.deferThread('a2', m.thread_id, [parent.id]);
  const sent = await mail.sendMail({ from: 'a1', from_stam: true, to: ['bob'], body: 'stam notice', reply_to: parent.id });
  assert.equal(sent.thread_id, m.thread_id);
  assert.equal(sent.itsa_id, y.id);
  assert.ok(db.getMail(sent.id).notice, 'the reply keeps its notice flag through the ITSA comment path');
  assert.equal(db.deferredCount('a2'), 1, 'a notice leaves the deferred thread deferred');
});
