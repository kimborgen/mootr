#!/usr/bin/env node
// Unit tests for the human's attention (step 8): entering a human status mails the human once
// in the ITSA's thread (kind `ask`, with the owner's latest comment), a second set to the same
// status sends nothing, a move to a different human status sends again, the actions (defaults
// and settings overrides) move the status and post the text as a comment that interrupts the
// owner, and the attention list is the ITSAs in human statuses, oldest first. Throwaway
// STAM_HOME, no daemon. Run with `node --test test/itsa-human.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-itsa-human-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `itsa-human-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

let db, itsa, human;
const agent = (id, name) => db.createAgent({ id, name, role: 'dev', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
const thread = (x) => db.threadMail(itsa.must(x.id).thread_id);
const asks = (x) => thread(x).filter((m) => m.kind === 'ask');
const tick = () => new Promise((r) => setTimeout(r, 50));
// Waits until the ITSA's thread holds `n` asks: the ask is posted asynchronously after the status change.
const askedBy = async (x, n) => { for (let i = 0; i < 400 && asks(x).length < n; i++) await tick(); return asks(x); };

before(async () => {
  db = await import('../src/db.ts');
  itsa = await import('../src/itsa.ts');
  human = await import('../src/itsa-human.ts');
  db.open();
  agent('a1', 'alice');
  agent('a2', 'bob');
  human.watchHumanStatuses();
});
after(() => rmSync(home, { recursive: true, force: true }));

test('entering a human status by an agent mails the human once, with the owner’s latest comment', async () => {
  const x = await itsa.create({ title: 'Review me', by: 'human', owner: 'alice', status: 'in_progress' });
  await itsa.post(x.key, { by: 'alice', body: 'Done, tests pass.' });
  await itsa.set(x.key, { status: 'needs_review' }, 'alice');
  await tick();
  const a = asks(x);
  assert.equal(a.length, 1);
  assert.deepEqual(a[0].recipients.map((r) => r.id), ['human']);
  assert.equal(a[0].from_id, 'a1');
  // The ask replies to the owner's comment it repeats, so the thread view can fold that comment.
  assert.equal(a[0].reply_to, thread(x).find((m) => m.body === 'Done, tests pass.').id);
  assert.match(a[0].body, /^\*\*alice needs you:\*\* \S+ Review me · needs review · Approve, Request changes$/m);
  // The owner's comment is the body, unquoted, so its blocks render as the owner wrote them.
  assert.match(a[0].body, /^Done, tests pass\.$/m);
  assert.doesNotMatch(a[0].body, /^> /m);
  assert.ok(itsa.participants(x.id).includes('human'));
  // The same status again changes nothing; nothing is sent.
  await itsa.set(x.key, { status: 'needs_review' }, 'alice');
  await tick();
  assert.equal(asks(x).length, 1);
  // A different human status asks again, after the owner comments again.
  await itsa.post(x.key, { by: 'alice', body: 'Ready to try.' });
  await itsa.set(x.key, { status: 'needs_test' }, 'alice');
  await tick();
  assert.equal(asks(x).length, 2);
  assert.match(asks(x)[1].body, /try/);
});

test('an agent’s comment in an ITSA thread doesn’t mail the human; the move to a human status does, once', async () => {
  const x = await itsa.create({ title: 'Quiet comment', by: 'human', owner: 'alice', status: 'in_progress' });
  await itsa.post(x.key, { by: 'alice', body: 'Done, need your call.' });
  await itsa.post(x.key, { by: 'bob', body: 'Looks fine to me.' });
  await tick();
  assert.equal(asks(x).length, 0);
  assert.ok(thread(x).every((m) => !m.recipients.some((r) => r.id === 'human')));
  await itsa.set(x.key, { status: 'needs_input' }, 'alice');
  assert.equal((await askedBy(x, 1)).length, 1);
  assert.equal(thread(x).filter((m) => m.recipients.some((r) => r.id === 'human')).length, 1);
  assert.match(asks(x)[0].body, /^Done, need your call\.$/m);
});

test('an agent’s comment that names the human as a recipient still mails the human', async () => {
  const x = await itsa.create({ title: 'Named', by: 'human', owner: 'alice', status: 'in_progress' });
  await itsa.post(x.key, { by: 'alice', body: 'Which way?', to: ['human'] });
  await tick();
  const m = thread(x).find((k) => k.body === 'Which way?');
  assert.deepEqual(m.recipients.map((r) => r.id), ['human']);
});

test('a status that does not wait on the human sends nothing, and neither does the human’s own change', async () => {
  const x = await itsa.create({ title: 'Quiet', by: 'human', owner: 'alice' });
  await itsa.set(x.key, { status: 'in_review' }, 'alice');
  await itsa.set(x.key, { status: 'needs_approval' }, 'human');
  await tick();
  assert.equal(x.thread_id, null);
  assert.equal(itsa.must(x.id).thread_id, null);
});

test('the actions are the settings’ defaults, and none unless the ITSA waits on the human', () => {
  assert.deepEqual(itsa.actionsOf('in_progress'), []);
  const to = (s) => Object.fromEntries(itsa.actionsOf(s).map((a) => [a.id, a.to]));
  assert.deepEqual(to('needs_review'), { approve: 'ready_to_merge', changes: 'in_progress' });
  assert.deepEqual(to('needs_approval'), { approve: 'in_progress', changes: 'in_progress' });
  assert.deepEqual(to('needs_test'), { approve: 'done', changes: 'in_progress' });
  // With no itsa.statuses in settings.json, the defaults apply: merging is release's job.
  assert.deepEqual(['ready_to_merge', 'merging', 'deploying'].map((n) => itsa.statusOf(n).human), [false, false, false]);
  // ready_to_merge isn't a human status by default (release merges), so it has no human buttons.
  assert.deepEqual(itsa.actionsOf('ready_to_merge'), []);
  assert.deepEqual(to('needs_input'), { answer: 'in_progress' });
});

test('Approve moves needs_review to ready_to_merge, which does not notify the human', async () => {
  const x = await itsa.create({ title: 'Approve me', by: 'human', owner: 'alice', status: 'needs_review' });
  const r = await human.act(x.key, 'approve', 'Looks good');
  assert.equal(r.itsa.status, 'ready_to_merge');
  await tick();
  const t = thread(x);
  assert.ok(t.some((m) => m.from_id === 'human' && m.body === 'Looks good'));
  assert.equal(t.filter((m) => m.kind === 'ask').length, 0);
  assert.equal(human.attention().some((a) => a.id === x.id), false);
  await assert.rejects(human.act(x.key, 'approve', ''), /no action approve/);
});

test('Request changes needs text, moves to in_progress, and the comment interrupts the owner', async () => {
  const x = await itsa.create({ title: 'Change me', by: 'human', owner: 'alice', participants: ['bob'], status: 'needs_review' });
  await assert.rejects(human.act(x.key, 'changes', '  '), /needs a comment/);
  assert.equal(itsa.must(x.id).status, 'needs_review');
  const r = await human.act(x.key, 'changes', 'Please rename the flag');
  assert.equal(r.itsa.status, 'in_progress');
  const m = thread(x).find((k) => k.body === 'Please rename the flag');
  assert.equal(m.from_id, 'human');
  // From the human, it interrupts: the owner's in-turn notice lists it.
  const loud = db.inbox('a1', true, 10, true).map((k) => k.id);
  assert.ok(loud.includes(m.id));
  await assert.rejects(human.act(x.key, 'approve', ''), /no action approve/);
});

test('Answer on needs_input needs text; the settings override the actions of a status', async () => {
  const x = await itsa.create({ title: 'Ask me', by: 'human', owner: 'alice', status: 'needs_input' });
  await assert.rejects(human.act(x.key, 'answer', ''), /needs a comment/);
  assert.equal((await human.act(x.key, 'answer', 'Use option B')).itsa.status, 'in_progress');
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ itsa: { actions: { needs_test: [{ id: 'approve', label: 'Ship it', to: 'deploying', text: 'none' }] } } }));

  const y = await itsa.create({ title: 'Ship me', by: 'human', owner: 'alice', status: 'needs_test' });
  assert.deepEqual(itsa.actionsOf('needs_test').map((a) => [a.label, a.to]), [['Ship it', 'deploying']]);
  await assert.rejects(human.act(y.key, 'approve', 'hm'), /takes no comment/);
  assert.equal((await human.act(y.key, 'approve', '')).itsa.status, 'deploying');
});

test('the attention list is the ITSAs in human statuses, oldest first', async () => {
  const a = await itsa.create({ title: 'First', by: 'human', owner: 'alice', status: 'in_progress' });
  const b = await itsa.create({ title: 'Second', by: 'human', owner: 'alice', status: 'in_progress' });
  await itsa.post(b.key, { by: 'alice', body: 'Which option?' });
  await itsa.set(b.key, { status: 'needs_input' }, 'alice');
  await new Promise((r) => setTimeout(r, 5));
  await itsa.post(a.key, { by: 'alice', body: 'Ready for review.' });
  await itsa.set(a.key, { status: 'needs_review' }, 'alice');
  const list = human.attention().filter((x) => [a.id, b.id].includes(x.id));
  assert.deepEqual(list.map((x) => x.key), [b.key, a.key]);
  assert.ok(list.every((x) => x.actions.length && x.since));
  // Each row carries its ask mail, which the mail list shows as the ITSA's row.
  await tick();
  const ask = asks(a).at(-1);
  const row = human.attention().find((x) => x.id === a.id);
  assert.deepEqual([row.ask_thread_id, row.ask_mail_id], [ask.thread_id, ask.id]);
});

test('an agent creating an ITSA straight into a human status mails the human; the human creating one does not', async () => {
  const x = await itsa.create({ title: 'Born waiting', by: 'alice', owner: 'alice', status: 'needs_input' });
  await tick();
  assert.equal(asks(x).length, 1);
  assert.equal(asks(x)[0].from_id, 'a1');
  const y = await itsa.create({ title: 'Mine', by: 'human', owner: 'alice', status: 'needs_input' });
  await tick();
  assert.equal(itsa.must(y.id).thread_id, null);
});

test('an action is a compare-and-set on the status and never mails the human about their own move', async () => {
  const x = await itsa.create({ title: 'Stale', by: 'human', owner: 'alice', status: 'needs_review' });
  await assert.rejects(itsa.set(x.key, { status: 'done', ifStatus: 'needs_test' }, 'human'), /^Error: status changed: .* is needs_review now, not needs_test/);
  assert.equal(itsa.must(x.id).status, 'needs_review');
  const z = await itsa.create({ title: 'Moved by the human', by: 'human', owner: 'alice', status: 'needs_review' });
  const r = await human.act(z.key, 'changes', 'again');
  assert.equal(r.itsa.status, 'in_progress');
  await tick();
  assert.equal(asks(z).length, 0);
});

test('a participant no daemon knows does not block the human answer: it lands and the status moves (S-281)', async () => {
  const x = await itsa.create({ title: 'Ghost answer', by: 'human', owner: 'alice', status: 'needs_input' });
  // A participant that no daemon knows: it is skipped, the answer still goes to the rest.
  db.open().prepare('INSERT INTO itsa_participants (itsa_id, agent_id) VALUES (?, ?)').run(x.id, 'ghost1');
  const r = await human.act(x.key, 'answer', 'Use the second option');
  assert.equal(r.itsa.status, 'in_progress');
  assert.equal(itsa.must(x.id).status, 'in_progress');
});

test('an agent cannot move an ITSA into a human status without a comment since its last status change', async () => {
  const x = await itsa.create({ title: 'Silent', by: 'human', owner: 'alice', status: 'in_progress' });
  await assert.rejects(itsa.set(x.key, { status: 'needs_review' }, 'alice'), /post a comment first with itsa_post/);
  assert.equal(itsa.must(x.id).status, 'in_progress');
  assert.equal(asks(x).length, 0);
  // A comment from another agent doesn't count.
  await itsa.post(x.key, { by: 'bob', body: 'Looks fine to me.' });
  await assert.rejects(itsa.set(x.key, { status: 'needs_review' }, 'alice'), /post a comment first/);
  // The owner's comment does, and it covers only the move that follows it.
  await itsa.post(x.key, { by: 'alice', body: 'Done.' });
  await tick();
  await itsa.set(x.key, { status: 'in_review' }, 'alice');
  await assert.rejects(itsa.set(x.key, { status: 'needs_review' }, 'alice'), /post a comment first/);
  await itsa.post(x.key, { by: 'alice', body: 'Done, again.' });
  await itsa.set(x.key, { status: 'needs_review' }, 'alice');
  assert.equal(itsa.must(x.id).status, 'needs_review');
});

test('the human moves an ITSA into a human status without a comment', async () => {
  const x = await itsa.create({ title: 'Human moves', by: 'human', owner: 'alice', status: 'in_progress' });
  const r = await itsa.set(x.key, { status: 'needs_approval' }, 'human');
  assert.equal(r.itsa.status, 'needs_approval');
});

test('the ask lands in the ITSA’s thread even when the owner mailed the human about it earlier in another thread', async () => {
  const x = await itsa.create({ title: 'Ask in place', by: 'human', owner: 'alice', status: 'in_progress' });
  await itsa.post(x.key, { by: 'alice', body: 'Done, need your call.' });
  await itsa.set(x.key, { status: 'blocked' }, 'alice');
  const { sendMail } = await import('../src/mail.ts');
  const mail = await sendMail({ from: 'a1', to: ['human'], subject: 'Question', body: 'Which way?', itsa: x.key });
  await itsa.post(x.key, { by: 'alice', body: 'Here is the plan.' });
  await itsa.set(x.key, { status: 'needs_input' }, 'alice');
  const [last] = await askedBy(x, 1);
  // The ask is in the ITSA's thread, not in the mail's thread, and it still replies to the owner's comment it repeats.
  assert.equal(last.thread_id, itsa.must(x.id).thread_id);
  assert.notEqual(last.thread_id, mail.thread_id);
  assert.equal(last.reply_to, thread(x).find((m) => m.body === 'Here is the plan.').id);
  assert.equal(db.threadMail(mail.thread_id).filter((m) => m.kind === 'ask').length, 0);
});

test('the ask opens in the ITSA’s thread when the owner’s mail about the ITSA predates the status change before it', async () => {
  const x = await itsa.create({ title: 'Old mail', by: 'human', owner: 'alice', status: 'in_progress' });
  const { sendMail } = await import('../src/mail.ts');
  await sendMail({ from: 'a1', to: ['human'], subject: 'Old question', body: 'Earlier?', itsa: x.key });
  // The status change must land in a later millisecond than the mail: the notice compares their timestamps.
  await tick();
  await itsa.set(x.key, { status: 'blocked' }, 'alice');
  await itsa.post(x.key, { by: 'alice', body: 'Still stuck.' });
  await itsa.set(x.key, { status: 'needs_input' }, 'alice');
  const last = (await askedBy(x, 1)).at(-1);
  assert.equal(last.reply_to, thread(x).find((m) => m.body === 'Still stuck.').id);
  assert.equal(last.thread_id, itsa.must(x.id).thread_id);
});

test('ready_to_merge, merging and deploying never wait on the human by default, and the move sends nothing', async () => {
  // No itsa.statuses in settings.json: the defaults apply, and release merges these three.
  writeFileSync(join(home, 'settings.json'), JSON.stringify({}));
  assert.deepEqual(['ready_to_merge', 'merging', 'deploying'].map((n) => itsa.statusOf(n).human), [false, false, false]);
  const x = await itsa.create({ title: 'Ship it', by: 'human', owner: 'alice', status: 'in_progress' });
  // An agent moves it to ready_to_merge with no comment: no comment-first refusal, no mail to the human.
  await itsa.set(x.key, { status: 'ready_to_merge' }, 'alice');
  await tick();
  assert.equal(asks(x).length, 0);
  assert.equal(human.attention().some((a) => a.id === x.id), false);
  assert.deepEqual(itsa.actionsOf('ready_to_merge'), []);
});

test('an ask from an earlier status is stale: the attention row and askThreadIds drop it (S-311)', async () => {
  const x = await itsa.create({ title: 'Stale ask', by: 'human', owner: 'alice', status: 'in_progress' });
  await itsa.post(x.key, { by: 'alice', body: 'Ready.' });
  await itsa.set(x.key, { status: 'needs_review' }, 'alice');
  await tick();
  const ask = asks(x).at(-1);
  assert.equal(human.attention().find((a) => a.id === x.id).ask_thread_id, ask.thread_id);
  assert.ok(human.askThreadIds().has(ask.thread_id));
  // The human's own move into another human status sends no fresh ask.
  await itsa.set(x.key, { status: 'needs_input' }, 'human');
  await tick();
  assert.equal(asks(x).length, 1);
  const row = human.attention().find((a) => a.id === x.id);
  assert.deepEqual([row.ask_thread_id, row.ask_mail_id], [null, null]);
  assert.equal(human.askThreadIds().has(ask.thread_id), false);
});

test("archive can't hide a waiting ITSA's ask thread: splitArchived keeps the threads it is given (S-311)", async () => {
  const x = await itsa.create({ title: 'Keep me', by: 'human', owner: 'alice', status: 'in_progress' });
  await itsa.post(x.key, { by: 'alice', body: 'Which one?' });
  await itsa.set(x.key, { status: 'needs_input' }, 'alice');
  await tick();
  const tid = asks(x).at(-1).thread_id;
  const t = { thread_id: tid, mails: db.threadMail(tid) };
  db.archiveThread('human', tid, t.mails.map((m) => m.id));
  assert.deepEqual(db.splitArchived('human', [t]).archived.map((a) => a.thread_id), [tid]);
  const kept = db.splitArchived('human', [t], human.askThreadIds());
  assert.deepEqual([kept.active.map((a) => a.thread_id), kept.archived.length], [[tid], 0]);
});

test('the ask carries the owner’s whole comment, however long', async () => {
  const x = await itsa.create({ title: 'Long one', by: 'human', owner: 'alice', status: 'in_progress' });
  const long = 'Long option text. '.repeat(200) + 'THE END';
  await itsa.post(x.key, { by: 'alice', body: long });
  await itsa.set(x.key, { status: 'needs_review' }, 'alice');
  const [a] = await askedBy(x, 1);
  assert.ok(a.body.includes(long), 'the ask body holds the whole comment');
});
