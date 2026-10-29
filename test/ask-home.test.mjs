#!/usr/bin/env node
// An ask to the human goes in its home thread (S-3827, src/ask-home.ts): the thread it names (`thread`), else its ITSA's
// thread (`itsa`, else the one active ITSA it owns), else a new thread, which for now is sent with a "No home thread"
// line, a `permission:no-home` event and a hint (refusal is staged), or with the agent's `override` reason. A thread
// or ITSA the agent can't read is refused, storing nothing. An origin-thread ask of an agent with an ITSA adds a link
// line in the ITSA thread. Only placement changes: the recipients are as before, and the placed ask, its link line,
// and the home thread's earlier mail are visible to exactly those who saw them before. A plain human reply in the
// thread neither settles nor withdraws the ask, and settling the ask leaves the thread open and its other decisions listed.
// Throwaway STAM_HOME, no daemon. Run with `node --test test/ask-home.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-ask-home-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `ask-home-${process.pid}`;
process.env.STAM_EMBEDDER = 'stub';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), '{}');

let db, itsa, mail, permissions, visibility, search, waits;
const agent = (id, name, parent = null) => {
  db.createAgent({ id, name, role: 'dev', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: '/tmp', parent_id: parent, session_id: null });
  db.updateAgent(id, { lifecycle: 'active', activity: 'idle' });
  return db.getAgent(id);
};
const count = (table) => db.open().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const askMail = (id) => db.getMail(db.permissionMailIds(id)[0]);
const recipients = (m) => db.threadMail(m.thread_id).find((y) => y.id === m.id).recipients.map((r) => r.id).sort();
const events = (agentId, type) => db.open().prepare('SELECT COUNT(*) AS n FROM events WHERE agent_id = ? AND type = ?').get(agentId, type).n;
const send = (from, to, subject, extra = {}) => mail.sendMail({ from, to, subject, body: `${subject} body`, ...extra });
const owned = async (owner, title) => {
  const x = await itsa.create({ title, by: 'human', owner, kind: 'issue' });
  await itsa.set(x.id, { status: 'in_progress' }, 'human');
  return x;
};

let dev, peer, other, kid, mgr, child, solo;
before(async () => {
  db = await import('../src/db.ts');
  itsa = await import('../src/itsa.ts');
  mail = await import('../src/mail.ts');
  permissions = await import('../src/permissions.ts');
  visibility = await import('../src/mail-visibility.ts');
  search = await import('../src/mail-search.ts');
  waits = await import('../src/waits.ts');
  await import('../src/settings.ts');
  db.open();
  dev = agent('dev1', 'dev-one');
  peer = agent('peer1', 'peer-one');
  other = agent('oth1', 'other-one');
  kid = agent('kid1', 'peer-kid', 'peer1');
  mgr = agent('mgr1', 'manager-one');
  child = agent('chd1', 'child-one', 'mgr1');
  solo = agent('solo1', 'solo-one');
});
after(() => rmSync(home, { recursive: true, force: true }));

test('an ask with `thread` joins that thread, to exactly the human, carrying its permission id', async () => {
  const m = await send('peer1', ['dev1'], 'Plan the release', { new_thread: true });
  const r = await permissions.requestPermission(dev, 'git push', 'auto mode blocks it', '', false, { home: { thread: m.id } }, 'human');
  const x = askMail(r.id);
  assert.equal(x.thread_id, m.thread_id);
  assert.equal(x.permission_id, r.id);
  assert.deepEqual(recipients(x), ['human']);
  assert.equal(db.getPermissionRequest(r.id).home_thread, m.thread_id);
  assert.equal(r.hint, undefined);
  // dev-one owns no active ITSA, so no link line anywhere.
  assert.equal(db.open().prepare("SELECT COUNT(*) AS n FROM mail WHERE kind = 'ask-link'").get().n, 0);
});

test('a placed ask is hidden from the thread\'s other readers; its requester sees it; the thread\'s mail is not opened up', async () => {
  // peer-one starts a thread with other-one (no human), then writes dev-one in it: dev-one reads only that mail.
  const y1 = await send('peer1', ['oth1'], 'Private plan', { new_thread: true });
  const y2 = await send('peer1', ['dev1'], 'Re: Private plan', { reply_to: y1.id });
  assert.equal(visibility.mayReadMail('dev1', db.getMail(y1.id)), false, 'dev-one reads only its own part before');
  assert.equal(visibility.mayReadMail('kid1', db.getMail(y1.id)), false, "peer-one's child reads no part of a thread without the human");
  const r = await permissions.requestPermission(dev, 'deploy', 'needs consent', '', false, { home: { thread: y2.id } }, 'human');
  const x = askMail(r.id);
  assert.equal(x.thread_id, y1.thread_id);
  assert.equal(visibility.mayReadMail('dev1', x), true, 'the requester sees its ask');
  for (const id of ['peer1', 'oth1', 'kid1']) {
    assert.equal(visibility.mayReadMail(id, x), false, `${id} doesn't see the ask placed in its thread`);
    const reader = visibility.threadReader(id, x.thread_id);
    assert.ok(reader === true ? false : !reader(x), `${id}'s thread reader hides the ask`);
    assert.ok(!visibility.withoutHiddenAsks(id, db.threadMail(x.thread_id)).some((y) => y.id === x.id), `${id}'s thread read hides the ask`);
  }
  // The requester doesn't gain the thread's earlier mail, nor does a child of its people.
  assert.equal(visibility.mayReadMail('dev1', db.getMail(y1.id)), false, 'the ask hands the requester no read of the thread');
  assert.equal(visibility.mayReadMail('kid1', db.getMail(y1.id)), false, 'the ask opens the thread to no child');
  assert.ok(!search.sharedThreads('kid1').includes(y1.thread_id));
});

test("the human's free-text reply to a placed ask goes to its requester only and opens the thread to nobody", async () => {
  const y1 = await send('peer1', ['oth1'], 'Quiet plan', { new_thread: true });
  const y2 = await send('peer1', ['dev1'], 'Re: Quiet plan', { reply_to: y1.id });
  const r = await permissions.requestPermission(dev, 'tag a release', 'needs consent', '', false, { home: { thread: y2.id } }, 'human');
  const x = askMail(r.id);
  // The web UI's reply names the thread's people as inferred recipients, as it did before (S-603).
  const to = ['peer1', 'oth1', 'dev1'];
  const reply = await mail.sendMail({ from: 'human', to, inferred: to, reply_to: x.id, subject: 'Re: ask', body: 'Which tag?' });
  const m = db.getMail(reply.id);
  assert.equal(m.thread_id, y1.thread_id, 'the reply stays in the thread');
  assert.deepEqual(recipients(m), ['dev1'], 'only the requester gets it');
  assert.equal(m.kind, 'ask-reply');
  for (const id of ['peer1', 'oth1', 'kid1']) assert.equal(visibility.mayReadMail(id, m), false, `${id} doesn't read the reply`);
  assert.equal(visibility.mayReadMail('dev1', m), true);
  assert.ok(!db.humanThreadIds(true).includes(y1.thread_id), 'the reply makes it no thread with the human');
  assert.ok(!search.sharedThreads('kid1').includes(y1.thread_id), "so peer-one's child gains no read of it");
  assert.equal(visibility.mayReadMail('kid1', db.getMail(y1.id)), false);
  // A second reply, under the first, still goes to the requester only.
  const again = await mail.sendMail({ from: 'human', to, inferred: to, reply_to: m.id, subject: 'Re: ask', body: 'Also: which branch?' });
  assert.deepEqual(recipients(db.getMail(again.id)), ['dev1']);
  assert.equal(db.getPermissionRequest(r.id).status, 'pending', "a reply doesn't settle the ask");
});

test("the asker's answer under the human's reply is sealed too, so its children gain no read of the thread", async () => {
  const y1 = await send('peer1', ['oth1'], 'Budget plan', { new_thread: true });
  const y2 = await send('peer1', ['mgr1'], 'Re: Budget plan', { reply_to: y1.id });
  const r = await permissions.requestPermission(mgr, 'raise the cap', 'needs consent', '', false, { home: { thread: y2.id } }, 'human');
  const h = await mail.sendMail({ from: 'human', to: ['mgr1'], reply_to: askMail(r.id).id, subject: 'Re: ask', body: 'By how much?' });
  const back = await mail.sendMail({ from: 'mgr1', to: ['human'], reply_to: h.id, subject: 'Re: ask', body: 'Ten dollars.' });
  const m = db.getMail(back.id);
  assert.equal(m.thread_id, y1.thread_id);
  assert.equal(m.kind, 'ask-reply');
  for (const id of ['peer1', 'oth1']) assert.equal(visibility.mayReadMail(id, m), false, `${id} doesn't read the asker's answer`);
  assert.ok(!db.humanThreadIds(true).includes(y1.thread_id));
  assert.ok(!search.sharedThreads('chd1').includes(y1.thread_id), "manager-one's child gains no read of the thread");
  assert.equal(visibility.mayReadMail('chd1', db.getMail(y1.id)), false);
});

test("stam's note on a placed ask (an approved input that expired) is sealed like the ask", async () => {
  const y1 = await send('peer1', ['oth1'], 'Deploy plan', { new_thread: true });
  const y2 = await send('peer1', ['mgr1'], 'Re: Deploy plan', { reply_to: y1.id });
  const r = await permissions.suggestInput({ ...mgr, harness: 'claude' }, '! git push', 'blocked', { thread: y2.id });
  assert.equal(askMail(r.id).thread_id, y1.thread_id);
  db.open().prepare("UPDATE permission_requests SET status = 'held', expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(r.id);
  permissions.expireInputs();
  let note;
  for (let i = 0; i < 50 && !note; i++) {
    await new Promise((res) => setTimeout(res, 20));
    note = db.threadMail(y1.thread_id).find((y) => /expired untyped/.test(y.subject));
  }
  assert.ok(note, 'the human is told in the home thread');
  const m = db.getMail(note.id);
  assert.equal(m.kind, 'ask-note');
  assert.deepEqual(recipients(m), ['human']);
  for (const id of ['peer1', 'oth1']) assert.equal(visibility.mayReadMail(id, m), false, `${id} doesn't read the note`);
  assert.ok(!db.humanThreadIds(true).includes(y1.thread_id));
  assert.ok(!search.sharedThreads('chd1').includes(y1.thread_id));
});

test('ordinary mail still makes its holders part of a thread (the placed-ask filter skips only placed asks)', async () => {
  // Every mail but the root is a reply (thread_id != id), where a NULL kind once made the filter drop the row.
  const root = await send('peer1', ['oth1'], 'Plain thread', { new_thread: true });
  const m = await send('peer1', ['human', 'dev1'], 'Re: Plain thread', { reply_to: root.id });
  assert.equal(m.thread_id, root.thread_id);
  assert.ok(db.threadIdsOf('dev1', true).includes(m.thread_id), 'dev-one is in the thread by a reply');
  assert.ok(db.humanThreadIds(true).includes(m.thread_id), 'so is the human');
  assert.ok(db.threads('dev1', 50).some((t) => t.thread_id === m.thread_id), "dev-one's thread list has it");
  assert.ok(search.sharedThreads('kid1').includes(m.thread_id), "peer-one's child reads the thread with the human, as before");
  assert.ok(db.mailScope('kid1', search.sharedThreads('kid1')).some((x) => x.id === m.id && !x.placed));
});

test("a requester in a thread only by its ask lists only the thread's mail it may read", async () => {
  // manager-one reads w1 as child-one's parent, not w0; its ask in that thread makes it no reader of w0.
  const w0 = await send('peer1', ['oth1'], 'Side plan', { new_thread: true });
  const w1 = await send('peer1', ['chd1'], 'Re: Side plan', { reply_to: w0.id });
  const r = await permissions.requestPermission(mgr, 'merge side plan', 'needs consent', '', false, { home: { thread: w1.id } }, 'human');
  const listed = db.threads('mgr1', 100).find((t) => t.thread_id === w0.thread_id);
  assert.ok(listed, 'the raw list has the thread, by the ask');
  const shown = visibility.listedThread('mgr1', listed).mails.map((m) => m.id);
  assert.ok(shown.includes(w1.id) && shown.includes(askMail(r.id).id), shown);
  assert.ok(!shown.includes(w0.id), 'not the mail it could not read');
});

test('an ask with no thread goes in the one active ITSA it owns, creating that thread', async () => {
  const x = await owned('solo1', 'Solo work');
  assert.equal(itsa.must(x.id).thread_id, null);
  const r = await permissions.requestPermission(solo, 'npm publish', 'outward action', '', false, {}, 'human');
  const tid = itsa.must(x.id).thread_id;
  assert.ok(tid, 'the ITSA thread was created');
  assert.equal(askMail(r.id).thread_id, tid);
  assert.equal(db.getPermissionRequest(r.id).home_itsa, x.id);
  // A later post joins the same thread.
  const p = await itsa.post(x.id, { by: 'solo1', body: 'progress' });
  assert.equal(p.thread_id, tid);
});

test('an ITSA participant that reads the ITSA thread whole still does not see the ask', async () => {
  const x = await itsa.create({ title: 'Shared work', by: 'human', owner: 'oth1', kind: 'issue', participants: ['peer-one'] });
  await itsa.set(x.id, { status: 'in_progress' }, 'human');
  const r = await permissions.requestPermission(other, 'rm -rf build', 'outside the worktree', '', false, {}, 'human');
  const m = askMail(r.id);
  assert.equal(m.thread_id, itsa.must(x.id).thread_id);
  assert.equal(visibility.mayReadWholeThread('peer1', m.thread_id), true);
  assert.equal(visibility.mayReadMail('peer1', m), false);
  assert.equal(visibility.mayReadMail('oth1', m), true);
});

test('with several active ITSAs and none named, a new thread with the no-home line, an event and a hint', async () => {
  await owned('mgr1', 'First');
  await owned('mgr1', 'Second');
  const before = events('mgr1', 'permission:no-home');
  const r = await permissions.requestPermission(mgr, 'merge it', 'needs approval', '', false, {}, 'human');
  const m = askMail(r.id);
  assert.equal(m.thread_id, m.id, 'a new thread');
  assert.match(m.body, /^_No home thread_/);
  assert.match(r.hint, /pass `thread`/);
  assert.equal(events('mgr1', 'permission:no-home'), before + 1);
});

test('a named ITSA takes the ask; one the agent cannot read is refused and stores nothing', async () => {
  const [mine] = await itsa.list({ owner: 'mgr1' });
  const r = await permissions.requestPermission(mgr, 'tag it', 'release', '', false, { home: { itsa: mine.key } }, 'human');
  assert.equal(askMail(r.id).thread_id, itsa.must(mine.id).thread_id);
  const theirs = await itsa.create({ title: 'Not mine', by: 'human', owner: 'oth1', kind: 'issue' });
  const n = [count('permission_requests'), count('mail'), count('waits')];
  await assert.rejects(permissions.requestPermission(mgr, 'tag it', 'release', '', false, { home: { itsa: theirs.key } }, 'human'), /can't ask in the thread of/);
  assert.deepEqual([count('permission_requests'), count('mail'), count('waits')], n);
});

test('an override sends it to a new thread and shows the reason', async () => {
  const r = await permissions.requestPermission(mgr, 'rotate keys', 'expired', '', false, { home: { override: 'about the whole fleet, no one ITSA' } }, 'human');
  const m = askMail(r.id);
  assert.equal(m.thread_id, m.id);
  assert.match(m.body, /^_Asked in a new thread: about the whole fleet, no one ITSA_/);
  assert.equal(db.getPermissionRequest(r.id).home_override, 'about the whole fleet, no one ITSA');
  assert.equal(r.hint, undefined);
});

test('a thread the agent cannot read, or no such mail, is refused and stores no row, mail or wait', async () => {
  const hidden = await send('peer1', ['oth1'], 'Not for dev', { new_thread: true });
  const n = [count('permission_requests'), count('mail'), count('waits')];
  await assert.rejects(permissions.requestPermission(dev, 'git push', 'blocked', '', false, { home: { thread: hidden.id } }, 'human'), /isn't visible to you/);
  await assert.rejects(permissions.requestPermission(dev, 'git push', 'blocked', '', false, { home: { thread: 'm0000000' } }, 'human'), /no mail m0000000/);
  await assert.rejects(permissions.suggestInput({ ...dev, harness: 'claude' }, '! git push', 'blocked', { thread: hidden.id }), /isn't visible to you/);
  assert.deepEqual([count('permission_requests'), count('mail'), count('waits')], n);
});

test('an escalated delegate ask goes in the thread it named, to the human only', async () => {
  const m = await send('mgr1', ['chd1'], 'Do the migration', { new_thread: true });
  const r = await permissions.requestPermission(child, 'drop the old table', 'irreversible', '', false, { home: { thread: m.id } }, 'delegate');
  assert.equal(r.audience, 'delegate');
  const first = askMail(r.id);
  assert.equal(first.thread_id, first.id, 'a delegate ask keeps its own thread with the reviewers');
  assert.deepEqual(recipients(first), ['mgr1']);
  await permissions.escalatePermission(r.id, 'mgr1', 'only the human can say yes');
  const sent = db.permissionMailIds(r.id).map((id) => db.getMail(id)).find((x) => x.id !== first.id);
  assert.equal(sent.thread_id, m.thread_id);
  assert.deepEqual(recipients(sent), ['human']);
});

test('an escalated delegate ask with no thread goes in the requester\'s ITSA thread', async () => {
  const x = await owned('chd1', 'Child work');
  const r = await permissions.requestPermission(child, 'force push', 'history rewrite', '', false, {}, 'delegate');
  await permissions.escalatePermission(r.id, 'mgr1', 'needs the human');
  const sent = db.permissionMailIds(r.id).map((id) => db.getMail(id)).find((y) => recipients(y).includes('human'));
  assert.equal(sent.thread_id, itsa.must(x.id).thread_id);
});

test("an escalated delegate ask keeps a home in another ITSA's thread, whose id is no mail's", async () => {
  // child-one owns an active ITSA of its own (Child work), so a lost home would land there instead.
  const x = await itsa.create({ title: 'Peer work', by: 'human', owner: 'peer1', kind: 'issue', participants: ['child-one'] });
  await itsa.set(x.id, { status: 'in_progress' }, 'human');
  const p = await itsa.post(x.id, { by: 'peer1', body: 'child-one, take the schema part' });
  const tid = itsa.must(x.id).thread_id;
  assert.equal(db.getMail(tid), undefined, "the ITSA thread's id is no mail's");
  const r = await permissions.requestPermission(child, 'alter the schema', 'irreversible', '', false, { home: { thread: p.mail_id ?? p.id } }, 'delegate');
  assert.equal(db.getPermissionRequest(r.id).home_thread, tid);
  await permissions.escalatePermission(r.id, 'mgr1', 'needs the human');
  const sent = db.permissionMailIds(r.id).map((id) => db.getMail(id)).find((y) => recipients(y).includes('human'));
  assert.equal(sent.thread_id, tid, 'the ask went in the thread it named');
});

test('a wait on the human naming an ask ties to that ask, not to an older one in its home thread', async () => {
  // solo-one's ITSA thread already holds its first ask (an earlier test); two more join it.
  const r1 = await permissions.requestPermission(solo, 'npm deprecate', 'outward', '', false, {}, 'human');
  const r2 = await permissions.requestPermission(solo, 'npm unpublish', 'outward', '', false, {}, 'human');
  assert.equal(askMail(r1.id).thread_id, askMail(r2.id).thread_id);
  assert.equal(waits.requestWaitedOn('solo1', '', askMail(r2.id).id)?.id, r2.id);
  assert.equal(waits.requestWaitedOn('solo1', '', askMail(r1.id).id)?.id, r1.id);
  // A wait naming the thread's own mail ties to no ask placed in it.
  const post = await itsa.post((await itsa.list({ owner: 'solo1' }))[0].id, { by: 'solo1', body: 'more progress' });
  assert.equal(waits.requestWaitedOn('solo1', '', post.mail_id ?? post.id), undefined);
});

test('an ask in its origin thread from an agent with an ITSA posts a sealed link line in the ITSA thread', async () => {
  const x = itsa.must((await itsa.list({ owner: 'chd1' }))[0].id);
  await itsa.set(x.id, { participants: ['peer-one'] }, 'human');
  const m = await send('mgr1', ['chd1'], 'Second task', { new_thread: true });
  const r = await permissions.requestPermission(child, 'publish the image', 'outward', '', false, { home: { thread: m.id } }, 'human');
  const ask = askMail(r.id);
  assert.equal(ask.thread_id, m.thread_id);
  const link = db.threadMail(x.thread_id).find((y) => y.kind === 'ask-link' && y.body.includes(ask.id));
  assert.ok(link, 'a link line in the ITSA thread');
  assert.equal(link.body, `Ask in ${ask.id}: publish the image`);
  assert.deepEqual(link.recipients.map((y) => y.id), ['human']);
  assert.equal(visibility.mayReadMail('peer1', db.getMail(link.id)), false, 'the ITSA participant does not see the link');
  assert.equal(visibility.mayReadMail('mgr1', db.getMail(link.id)), true, "the requester's parent does");
});

test('a human reply in the thread neither settles nor withdraws the ask; settling it keeps the thread and its decisions', async () => {
  const m = await send('peer1', ['dev1', 'human'], 'Open question', { new_thread: true });
  const r = await permissions.requestPermission(dev, 'restart prod', 'outage', '', false, { home: { thread: m.id } }, 'human');
  const d = await mail.sendMail({ from: 'dev1', to: ['human'], subject: 'Re: Open question', body: '```decision\nWhich first?\n- A: x\n- B: y\n```', reply_to: m.id });
  assert.equal(db.decisionMailOpen(d.id), true);
  await mail.sendMail({ from: 'human', to: ['peer1'], subject: 'Re: Open question', body: 'Thanks, noted.', reply_to: m.id });
  assert.equal(db.getPermissionRequest(r.id).status, 'pending', 'the human reply did not settle it');
  const human = () => db.open().prepare("SELECT withdrawn_at FROM mail_recipients WHERE mail_id = ? AND agent_id = 'human'").get(askMail(r.id).id);
  assert.equal(human().withdrawn_at, null, 'nor withdraw it');
  assert.ok(db.threadMail(m.thread_id).some((y) => y.permission?.status === 'pending'), 'the thread still shows it pending');
  // A new decision after the reply, then the ask settles: the decision stays listed and the thread open.
  const d2 = await mail.sendMail({ from: 'dev1', to: ['human'], subject: 'Re: Open question', body: '```decision\nShip?\n- Yes: x\n- No: y\n```', reply_to: m.id });
  await permissions.answerPermission(r.id, false, 'human', 'not now');
  assert.equal(db.getPermissionRequest(r.id).status, 'denied');
  assert.equal(db.decisionMailOpen(d2.id), true, "settling the ask doesn't clear the requester's other decision in its home thread");
  assert.equal(db.open().prepare("SELECT COUNT(*) AS n FROM thread_archive WHERE mailbox_id = 'human' AND thread_id = ?").get(m.thread_id).n, 0);
});

test("a plain reply in an ask's own thread neither settles nor withdraws it; only an answer on the ask does (S-3829)", async () => {
  const r = await permissions.requestPermission(dev, 'clear the build cache', 'disk is full', '', false, {}, 'human');
  const ask = askMail(r.id);
  await mail.sendMail({ from: 'human', to: [ask.from_id], subject: `Re: ${ask.subject}`, body: 'Not yet, I want to look first.', reply_to: ask.id });
  assert.equal(db.getPermissionRequest(r.id).status, 'pending', 'the reply did not settle it');
  const human = db.open().prepare("SELECT withdrawn_at FROM mail_recipients WHERE mail_id = ? AND agent_id = 'human'").get(ask.id);
  assert.equal(human.withdrawn_at, null, 'nor withdraw the ask from the human');
  await permissions.answerPermission(r.id, false, 'human', 'Not yet; look first.');
  assert.equal(db.getPermissionRequest(r.id).status, 'denied', 'the answer on the ask settles it');
});

test("a reviewer's answer withdraws the placed ask but keeps its home thread open", async () => {
  const m = await send('mgr1', ['chd1'], 'Third task', { new_thread: true });
  const r = await permissions.requestPermission(child, 'sudo apt install', 'system change', '', false, { home: { thread: m.id } }, 'human');
  await permissions.answerPermission(r.id, false, 'mgr1', 'use the container');
  await new Promise((res) => setTimeout(res, 50));
  const row = db.open().prepare("SELECT withdrawn_at FROM mail_recipients WHERE mail_id = ? AND agent_id = 'human'").get(askMail(r.id).id);
  assert.ok(row.withdrawn_at, 'the ask mail is withdrawn from the human');
  assert.equal(db.open().prepare("SELECT COUNT(*) AS n FROM thread_archive WHERE mailbox_id = 'human' AND thread_id = ?").get(m.thread_id).n, 0, 'the home thread is not archived');
});
