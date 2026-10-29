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

let db, itsa, human, waits, org;
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
  waits = await import('../src/waits.ts');
  org = await import('../src/org.ts');
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
  const r = await human.act(x.key, 'approve', 'Looks good', itsa.get(x.key).rev);
  assert.equal(r.itsa.status, 'ready_to_merge');
  await tick();
  const t = thread(x);
  assert.ok(t.some((m) => m.from_id === 'human' && m.body === 'Looks good'));
  assert.equal(t.filter((m) => m.kind === 'ask').length, 0);
  assert.equal(human.attention().some((a) => a.id === x.id), false);
  await assert.rejects(human.act(x.key, 'approve', '', itsa.get(x.key).rev), /no action approve/);
});

test('Approve carries the text it showed (S-2998): a body changed since, or no revision at all, is refused and nothing moves', async () => {
  const x = await itsa.create({ title: 'Approve the diff', body: 'diff one', by: 'human', owner: 'alice', status: 'needs_approval' });
  const shown = itsa.get(x.key).rev;
  // The owner swaps the diff while the ask is open; the human's page still shows the first one.
  await itsa.set(x.key, { body: 'diff two' }, 'a1');
  await assert.rejects(human.act(x.key, 'approve', 'ok', shown), /the text changed, review again/);
  // A page from before Approve sent a revision (no if_rev) fails closed too.
  await assert.rejects(human.act(x.key, 'approve', ''), /the text changed, review again/);
  await assert.rejects(human.act(x.key, 'approve', '', ''), /the text changed, review again/);
  assert.equal(itsa.must(x.id).status, 'needs_approval');
  assert.ok(!thread(x).some((m) => m.from_id === 'human' && m.body === 'ok'), 'a refused Approve posts nothing');
  // Approving the text shown now works.
  assert.equal((await human.act(x.key, 'approve', '', itsa.get(x.key).rev)).itsa.status, 'in_progress');
});

test('Approve re-checks the text in the transaction that moves the status (S-2998): a change after the first check is refused', async () => {
  const x = await itsa.create({ title: 'Race the move', body: 'diff one', by: 'human', owner: 'alice', status: 'needs_approval' });
  const shown = itsa.get(x.key).rev;
  // act checks the revision, then awaits before the move's transaction: the owner swaps the diff in between.
  const p = human.act(x.key, 'approve', '', shown);
  db.open().prepare('UPDATE itsas SET body = ? WHERE id = ?').run('diff two', x.id);
  await assert.rejects(p, /the text changed, review again: \S+ changed since it was shown/);
  assert.equal(itsa.must(x.id).status, 'needs_approval');
});

test('a mail thread approves what its newest mail showed (S-2998): a body swapped after the ask is refused', async () => {
  const x = await itsa.create({ title: 'Approve from the thread', body: 'diff one', by: 'human', owner: 'alice', status: 'in_progress' });
  await itsa.post(x.key, { by: 'alice', body: 'Please approve diff one.' });
  await itsa.set(x.key, { status: 'needs_approval' }, 'alice');
  const [ask] = await askedBy(x, 1);
  // The owner swaps the body after the ask went out; the thread still shows the ask.
  await itsa.set(x.key, { body: 'diff two' }, 'alice');
  await assert.rejects(human.act(x.key, 'approve', '', undefined, ask.id), /the text changed, review again/);
  // A mail of another thread, or none recorded, names no revision.
  const other = await itsa.create({ title: 'Elsewhere', by: 'human', owner: 'alice', status: 'in_progress' });
  const elsewhere = await itsa.post(other.key, { by: 'alice', body: 'hi' });
  await assert.rejects(human.act(x.key, 'approve', '', undefined, elsewhere.id), /the text changed, review again/);
  assert.equal(itsa.must(x.id).status, 'needs_approval');
  // A mail that shows the new text records its revision; a thread showing it approves.
  const shown = human.shownText(itsa.must(x.id));
  const again = await itsa.post(x.key, { by: 'alice', body: `Now diff two.\n\n${shown.text}` }, { shown });
  // Approve from a thread that shows only the ask still fails; one that shows the new mail works.
  await assert.rejects(human.act(x.key, 'approve', '', undefined, ask.id), /the text changed, review again/);
  assert.equal((await human.act(x.key, 'approve', '', undefined, again.id)).itsa.status, 'in_progress');
});

test('the ask shows the text it asks about and records the revision of that snapshot (S-2998)', async () => {
  const x = await itsa.create({ title: 'Show me', summary: 'One line.', body: 'diff B', by: 'human', owner: 'alice', status: 'in_progress' });
  // The owner comments on diff A, then sets the body to B, then asks: the ask renders B, so B is what a thread approves.
  await itsa.post(x.key, { by: 'alice', body: 'Here is diff A.' });
  await itsa.set(x.key, { status: 'needs_approval' }, 'alice');
  const [ask] = await askedBy(x, 1);
  // It comes first, so nothing the owner wrote can hide it.
  assert.match(ask.body, /^<details><summary>What you approve: \S+ Show me<\/summary>\n\nOne line\.\n\ndiff B\n\n<\/details>\n\n/);
  assert.equal(itsa.shownRev(x.id, ask.id), itsa.get(x.key).rev);
  // The thread serves where the snapshot sits in the body, in UTF-16 units, for the web to draw it above the rest.
  const served = (itsaId, id) => db.threadMail(itsa.must(itsaId).thread_id).find((m) => m.id === id);
  // A comment that renders no ITSA text records nothing: a thread whose newest mail is one, with no ask before it, is refused.
  const plain = await itsa.create({ title: 'Plain', by: 'human', owner: 'alice', status: 'in_progress' });
  const c = await itsa.post(plain.key, { by: 'alice', body: 'just a comment' });
  assert.equal(itsa.shownRev(plain.id, c.id), undefined);
  assert.deepEqual(served(x.id, ask.id).shown, { at: 0, len: human.shownText(itsa.must(x.id)).text.length });
  assert.equal(served(plain.id, c.id).shown, undefined);
});

test('markup in the title or summary is escaped, so it can\'t hide the snapshot (S-2998)', () => {
  for (const title of ['<!-- hide', '<span hidden>x</span>', '<span style="display:none">x</span>']) {
    const { text } = human.shownText({ key: 'S-1', title, summary: `${title} & more`, body: 'diff' });
    assert.doesNotMatch(text, /<!--|<span/, `raw markup from ${title}`);
    assert.match(text, /&lt;/);
    assert.match(text, /&amp; more/);
    assert.match(text, /\n\ndiff\n\n<\/details>$/, 'the body follows, whole');
  }
  assert.match(human.shownText({ key: 'S-1', title: 'a "b"', summary: null, body: null }).text, /a &quot;b&quot;/);
});

test('an ask whose snapshot was cut off by the mail cap records no revision (S-2998)', async () => {
  const x = await itsa.create({ title: 'Near the cap', body: 'diff', by: 'human', owner: 'alice', status: 'in_progress' });
  // The owner's comment, which the ask repeats, nearly fills the mail: the appended snapshot is cut off.
  await itsa.post(x.key, { by: 'alice', body: 'y'.repeat(19_900) });
  await itsa.set(x.key, { status: 'needs_approval' }, 'alice');
  const [ask] = await askedBy(x, 1);
  assert.match(ask.body, /body truncated/);
  assert.equal(itsa.shownRev(x.id, ask.id), undefined);
  await assert.rejects(human.act(x.key, 'approve', '', undefined, ask.id), /the text changed, review again/);
});

test('a title or comment with markup can\'t hide the ask\'s snapshot, and a hidden copy in a cut mail records nothing (S-2998)', async () => {
  const x = await itsa.create({ title: 'x <div hidden>', body: 'real diff', by: 'human', owner: 'alice', status: 'in_progress' });
  // The owner's comment carries CSS that would hide or cover the snapshot (the web strips it: mailblocks.test.ts),
  // opens a hidden block and an HTML comment, and carries a copy of the snapshot, then pads past the cap.
  const copy = human.shownText(itsa.must(x.id)).text;
  const css = '<style>details{display:none!important}</style>\n\n<div style="position:fixed;inset:0">cover</div>\n\n';
  await itsa.post(x.key, { by: 'alice', body: `${css}<div hidden>\n\n${copy}\n\n<!-- hide\n\n${'y'.repeat(19_900)}` });
  await itsa.set(x.key, { status: 'needs_approval' }, 'alice');
  const [ask] = await askedBy(x, 1);
  // The real snapshot comes first and the title is escaped everywhere in the ask.
  assert.ok(ask.body.startsWith(copy), 'the snapshot leads the ask');
  assert.ok(ask.body.indexOf('<style>') > copy.length, 'the comment\'s CSS comes after the snapshot');
  assert.doesNotMatch(ask.body.split('\n').slice(0, 4).join('\n'), /<div hidden>/);
  assert.match(ask.body, /x &lt;div hidden&gt;/);
  // Cut by the cap: no revision, though a whole copy of the snapshot is in the body.
  assert.match(ask.body, /body truncated/);
  assert.equal(itsa.shownRev(x.id, ask.id), undefined);
  await assert.rejects(human.act(x.key, 'approve', '', undefined, ask.id), /the text changed, review again/);
});

test('a body too long for the mail is cut, records no revision, and the thread fails closed (S-2998)', async () => {
  const long = 'x'.repeat(human.ASK_TEXT_MAX + 10);
  const x = await itsa.create({ title: 'Too long', body: long, by: 'human', owner: 'alice', status: 'in_progress' });
  await itsa.post(x.key, { by: 'alice', body: 'Please look.' });
  await itsa.set(x.key, { status: 'needs_approval' }, 'alice');
  const [ask] = await askedBy(x, 1);
  assert.match(ask.body, /… Cut here: open \S+ to review all of it\./);
  assert.equal(itsa.shownRev(x.id, ask.id), undefined);
  await assert.rejects(human.act(x.key, 'approve', '', undefined, ask.id), /the text changed, review again/);
  // The ITSA view, which shows it all, approves.
  assert.equal((await human.act(x.key, 'approve', '', itsa.get(x.key).rev)).itsa.status, 'in_progress');
});

test('a refused Approve with a comment posts nothing and records nothing (S-2998)', async () => {
  const x = await itsa.create({ title: 'Comment race', body: 'diff one', by: 'human', owner: 'alice', status: 'needs_approval' });
  const shown = itsa.get(x.key).rev;
  const mails = () => db.open().prepare('SELECT COUNT(*) AS n FROM mail').get().n;
  const evts = () => itsa.events(x.id, 1000).length;
  const [m0, e0] = [mails(), evts()];
  const p = human.act(x.key, 'approve', 'Looks good', shown);
  db.open().prepare('UPDATE itsas SET body = ? WHERE id = ?').run('diff two', x.id);
  await assert.rejects(p, /the text changed, review again/);
  await tick();
  assert.equal(mails(), m0, 'no comment was posted');
  assert.equal(evts(), e0, 'no event was recorded');
  // An Approve that goes through posts its comment after the move.
  const r = await human.act(x.key, 'approve', 'Looks good', itsa.get(x.key).rev);
  assert.equal(r.itsa.status, 'in_progress');
  assert.ok(thread(x).some((m) => m.from_id === 'human' && m.body === 'Looks good'));
});

test('the revision covers each field apart (S-2998): text moved between fields changes it, and Go builds the same', () => {
  assert.equal(itsa.revOf({ title: 'Gamma', summary: null, body: null }), 'f767a69f7540656b', 'the value go/internal/server TestItsaRevOf expects');
  assert.notEqual(itsa.revOf({ title: 'ab', summary: 'c', body: null }), itsa.revOf({ title: 'a', summary: 'bc', body: null }));
  assert.notEqual(itsa.revOf({ title: 'a', summary: null, body: 'b' }), itsa.revOf({ title: 'a', summary: 'b', body: null }));
  assert.notEqual(itsa.revOf({ title: 'é', summary: null, body: null }), itsa.revOf({ title: 'e', summary: null, body: null }));
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
  await assert.rejects(human.act(x.key, 'approve', '', itsa.get(x.key).rev), /no action approve/);
});

test('Answer on needs_input needs text; the settings override the actions of a status', async () => {
  const x = await itsa.create({ title: 'Ask me', by: 'human', owner: 'alice', status: 'needs_input' });
  await assert.rejects(human.act(x.key, 'answer', ''), /needs a comment/);
  assert.equal((await human.act(x.key, 'answer', 'Use option B')).itsa.status, 'in_progress');
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ itsa: { actions: { needs_test: [{ id: 'approve', label: 'Ship it', to: 'deploying', text: 'none' }] } } }));

  const y = await itsa.create({ title: 'Ship me', by: 'human', owner: 'alice', status: 'needs_test' });
  assert.deepEqual(itsa.actionsOf('needs_test').map((a) => [a.label, a.to]), [['Ship it', 'deploying']]);
  await assert.rejects(human.act(y.key, 'approve', 'hm', itsa.get(y.key).rev), /takes no comment/);
  assert.equal((await human.act(y.key, 'approve', '', itsa.get(y.key).rev)).itsa.status, 'deploying');
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

// S-3080: an agent's wait_for on the human in an ITSA's thread is tied to the ITSA while it waits on the human,
// and clears when the ITSA leaves that status, by the agent or by the human.
const waitingOn = (agentId, itsaId) => db.listWaits(agentId).filter((w) => w.kind === 'human' && w.target === itsaId);
const future = () => new Date(Date.now() + 3_600_000).toISOString();
// An ITSA asking the human, as an agent makes it: its thread starts with the owner's comment, then the move.
const openAsk = async (title, owner) => {
  const x = await itsa.create({ title, by: 'human', owner, status: 'in_progress' });
  await itsa.post(x.key, { by: owner, body: 'Need a call.' });
  await itsa.set(x.key, { status: 'needs_input' }, owner);
  return x;
};
test('S-3080: an agent’s wait on the human is tied to its ITSA, and leaving the status clears it; other waits stay', async () => {
  const x = await openAsk('Tied ask', 'alice');
  const y = await openAsk('Other ask', 'alice');
  const tied = await waits.declare('a1', { on: 'human', thread: itsa.must(x.id).thread_id, note: 'the call' });
  const other = await waits.declare('a1', { on: 'human', thread: itsa.must(y.id).thread_id, note: 'the other call' });
  const timer = db.addWait({ agent_id: 'a1', kind: 'timer', source: 'stam', detail: 'a timer', until: future() });
  assert.equal(tied.target, x.id);
  assert.equal(other.target, y.id);
  await itsa.set(x.key, { status: 'in_progress' }, 'alice');
  await tick();
  assert.equal(db.getWait(tied.id), undefined, 'the wait on the ITSA that left its human status is gone');
  assert.ok(db.getWait(other.id), 'a wait for a different ask stays');
  assert.ok(db.getWait(timer.id), 'a timer stays');
  // Once the ITSA is out of its human status, a new wait in its thread is not tied to it.
  assert.equal((await waits.declare('a1', { on: 'human', thread: itsa.must(x.id).thread_id, note: 'later' })).target, null);
});

test('S-3080: the human answering an ITSA ask through its action clears the agent’s wait on it', async () => {
  const x = await openAsk('Answered ask', 'alice');
  const w = await waits.declare('a1', { on: 'human', thread: itsa.must(x.id).thread_id, note: 'the answer' });
  assert.equal(w.target, x.id);
  assert.equal((await human.act(x.key, 'answer', 'Use option B')).itsa.status, 'in_progress');
  assert.equal(db.getWait(w.id), undefined);
});

test('S-3080: a move between human statuses keeps the agent’s wait on the ITSA, which still waits on the human', async () => {
  const x = await openAsk('Moved ask', 'alice');
  const w = await waits.declare('a1', { on: 'human', thread: itsa.must(x.id).thread_id, note: 'the call' });
  // Every move to a human status is a new ask, so it needs its own comment first.
  await itsa.post(x.key, { by: 'alice', body: 'Done, please review.' });
  await itsa.set(x.key, { status: 'needs_review' }, 'alice');
  await tick();
  assert.equal(itsa.must(x.id).status, 'needs_review');
  assert.equal(db.getWait(w.id)?.target, x.id, 'the wait stays tied to the ITSA');
});

test('S-3080: a restart settles a tied wait whose ITSA left its human status, and keeps one whose ask is open', async () => {
  const gone = await openAsk('Withdrawn ask', 'alice');
  const open = await openAsk('Open ask', 'alice');
  const goneWait = await waits.declare('a2', { on: 'human', thread: itsa.must(gone.id).thread_id, note: 'gone' });
  const openWait = await waits.declare('a2', { on: 'human', thread: itsa.must(open.id).thread_id, note: 'open' });
  // The daemon stopped after the ITSA left its status and before the wait cleared: only the row moved.
  db.open().prepare("UPDATE itsas SET status = 'in_progress' WHERE id = ?").run(gone.id);
  org.rebuildWaits();
  assert.equal(db.getWait(goneWait.id), undefined, 'the withdrawn ask leaves no wait behind');
  assert.ok(db.getWait(openWait.id), 'an open ask keeps its wait');
});

test('S-3080: a tied wait is kept when its ITSA cannot be read, and settled only by a row that says so', async () => {
  const x = await itsa.create({ title: 'Unreadable ask', by: 'human', owner: 'alice', status: 'needs_input' });
  assert.equal(human.itsaAskSettled(x.id), false, 'a live ask');
  assert.equal(human.itsaAskSettled('inotfound'), true, 'an ITSA that is not there settles its wait');
  // Any other read error keeps the wait: the table is renamed away for this read only.
  db.open().exec('ALTER TABLE itsas RENAME TO itsas_hold');
  try {
    assert.equal(human.itsaAskSettled(x.id), false, 'a failing read keeps the wait');
  } finally {
    db.open().exec('ALTER TABLE itsas_hold RENAME TO itsas');
  }
  assert.equal(human.itsaAskSettled(x.id), false, 'the ITSA is still in its human status');
});
