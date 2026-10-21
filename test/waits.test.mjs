#!/usr/bin/env node
// Unit tests for waiting states change 5 (src/waits.ts, src/mail.ts): the cron parser where a
// daylight-saving gap removes an hour, and stam's own mail never clearing a declared wait.
// Free; a throwaway STAM_HOME, no daemon, no network, no models:
// `TZ=Europe/Helsinki node --test test/waits.test.mjs` (the test sets TZ itself).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempHome } from './tmphome.mjs';

// nextCron works in local time, and the DST case needs a zone with the gap.
process.env.TZ = 'Europe/Helsinki';
const here = dirname(fileURLToPath(import.meta.url));
const home = tempHome('stam-waits-');
process.env.STAM_HOME = home;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
// A peer nothing listens on: a send to its agent is refused at once and queued (S-2663 copies).
writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [{ name: 'far', url: 'http://127.0.0.1:1', token: 't' }] }));

let db, waits, mail;
before(async () => {
  db = await import('../src/db.ts');
  waits = await import('../src/waits.ts');
  mail = await import('../src/mail.ts');
});
after(() => rmSync(home, { recursive: true, force: true }));

function agent(id, name) {
  db.createAgent({ id, name, role: 'test', machine: 'x', harness: 'external', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  db.updateAgent(id, { activity: 'idle' });
  return db.getAgent(id);
}

test('nextCron skips the hour a daylight-saving gap removes', () => {
  // Finland springs forward on 2027-03-28: 03:00-03:59 local doesn't exist, so `* 3 * * *`
  // must fire at 03:00 the next day (00:00 UTC), not every minute of 04:00-04:59 that day.
  const next = waits.nextCron('* 3 * * *', new Date('2027-03-28T00:30:00Z'));
  assert.equal(next.toISOString(), '2027-03-29T00:00:00.000Z');
});

test('nextCron still finds a real fire time on the gap day', () => {
  // 09:00 local exists on the gap day (it is EEST by then): 09:00 EEST = 06:00 UTC.
  const next = waits.nextCron('*/15 9 * * *', new Date('2027-03-28T00:30:00Z'));
  assert.equal(next.toISOString(), '2027-03-28T06:00:00.000Z');
});

test("mail stam sends never clears a declared wait", async () => {
  const a = agent('wa-standin', 'standin');
  const b = agent('wa-waiter', 'waiter');
  // The stand-in for stam's own mail is the first active agent, here `a`.
  assert.equal(mail.stamSender().id, a.id);
  const w = await waits.declare(b.id, { on: 'agent', target: a.id, note: 'the real reply' });
  assert.ok(db.listWaits(b.id).some((x) => x.id === w.id));
  assert.equal(await mail.sendFromStam([b.id], 'Subject', 'Body'), true);
  assert.ok(db.listWaits(b.id).some((x) => x.id === w.id), "stam's own mail cleared the declared wait");
  // A real mail from the awaited agent does clear it.
  await mail.sendMail({ from: a.id, to: [b.id], subject: 'the real reply', body: 'here', new_thread: true });
  assert.ok(!db.listWaits(b.id).some((x) => x.id === w.id), 'a real mail did not clear the wait');
});
test("an agent wait without a detail is summed up by the agent's name", () => {
  agent('ws1', 'summed');
  agent('ws2', 'awaited');
  db.addWait({ agent_id: 'ws1', kind: 'agent', source: 'declared', target: 'ws2' });
  assert.equal(db.waitSummary(db.listWaits('ws1')), "waiting for awaited's reply");
});

test('a re-declared reply wait nudges only for an ask the awaited agent has not answered (S-2574)', async () => {
  const a = agent('wn-awaited', 'nudged');
  const b = agent('wn-waiter', 'nudger');
  const root = await mail.sendMail({ from: b.id, to: [a.id], subject: 'merge ask', body: 'tell me when it merges', new_thread: true });
  const nudges = () => db.listEvents(a.id, 200, 'wait:nudged').length;
  const declare = () => waits.declare(b.id, { on: 'agent', target: a.id, thread: root.thread_id, note: 'the merge' });
  const openWaits = () => db.listWaits(b.id).filter((w) => w.kind === 'agent' && w.target === a.id).length;
  const reply = (body) => mail.sendMail({ from: a.id, to: [b.id], subject: 'Re: merge ask', body, reply_to: root.id });

  await declare();
  assert.equal(nudges(), 1);
  // Idle ticks with the wait open send nothing more.
  await waits.tick();
  await waits.tick();
  assert.equal(nudges(), 1);
  // Re-declared before any answer: no second nudge for the same ask.
  await declare();
  assert.equal(nudges(), 1);
  // A reply in another thread does not clear the thread-scoped waits (the first and the re-declared one).
  await mail.sendMail({ from: a.id, to: [b.id], subject: 'unrelated', body: 'not this one', new_thread: true });
  assert.equal(openWaits(), 2);
  // The awaited agent's reply in the thread clears the waits.
  await reply('not yet');
  assert.equal(openWaits(), 0);
  await waits.tick();
  // The reported sequence: a reply, a re-declare with no new ask from the waiter, a reply, a re-declare. No nudge.
  await declare();
  assert.equal(nudges(), 1);
  await reply('still not yet');
  await declare();
  assert.equal(nudges(), 1);
  // A new question from the waiter, then a re-declare: one nudge for it, and none on a further re-declare.
  await mail.sendMail({ from: b.id, to: [a.id], subject: 'Re: merge ask', body: 'any news?', reply_to: root.id });
  await declare();
  assert.equal(nudges(), 2);
  await declare();
  assert.equal(nudges(), 2);
});

test('a sender copy with no recipient rows counts as an ask, and a mail id names its thread (S-2574)', async () => {
  // A mail to a peer's agent is stored here as the sender's copy: no recipient rows. The awaited agent's replies come in as local mail.
  const a = agent('sc-awaited', 'copied');
  const b = agent('sc-waiter', 'copy-waiter');
  const copy = (id, body) => db.createMail({ id, from_id: b.id, from_name: 'copy-waiter', subject: 'Re: copy ask', body, thread_id: 'sc-root', reply_to: null }, [], []);
  copy('sc-root', 'tell me when it merges');
  const nudges = () => db.listEvents(a.id, 200, 'wait:nudged').length;
  const declare = (thread = 'sc-root') => waits.declare(b.id, { on: 'agent', target: a.id, thread, note: 'the merge' });

  await declare();
  assert.equal(nudges(), 1);
  // The awaited agent's reply arrives here as mail with a recipient row for the waiter.
  db.createMail({ id: 'sc-reply', from_id: a.id, from_name: 'copied', subject: 'Re: copy ask', body: 'not yet', thread_id: 'sc-root', reply_to: 'sc-root' }, [b.id]);
  await declare();
  assert.equal(nudges(), 1);
  // A new question from the waiter, stored as a sender's copy, then a re-declare: one nudge for it.
  copy('sc-q2', 'any news?');
  await declare();
  assert.equal(nudges(), 2);
  // A re-declare naming another mail id in the same thread is the same thread, so the same ask: no nudge.
  await declare('sc-q2');
  assert.equal(nudges(), 2);
});

test('a threadless wait nudges for a sender copy, and once per reply with no visible ask (S-2574)', async () => {
  const a = agent('tl-awaited', 'threadless');
  const b = agent('tl-waiter', 'threadless-waiter');
  const nudges = (id) => db.listEvents(id, 200, 'wait:nudged').length;
  // A reply from the awaited agent, then the waiter's question as a sender's copy with no recipient rows.
  db.createMail({ id: 'tl-old', from_id: a.id, from_name: 'threadless', subject: 'old', body: 'not yet', thread_id: 'tl-old', reply_to: null }, [b.id]);
  db.createMail({ id: 'tl-copy', from_id: b.id, from_name: 'threadless-waiter', subject: 'ask', body: 'any news?', thread_id: 'tl-copy', reply_to: null }, []);
  await waits.declare(b.id, { on: 'agent', target: a.id, note: 'the merge' });
  assert.equal(nudges(a.id), 1);
  await waits.declare(b.id, { on: 'agent', target: a.id, note: 'the merge' });
  assert.equal(nudges(a.id), 1);

  // No visible ask at all, only the awaited agent's reply: one nudge for that reply, none on a re-declare.
  const c = agent('tl-c', 'replier');
  const d = agent('tl-d', 'asker');
  db.createMail({ id: 'tl-reply', from_id: c.id, from_name: 'replier', subject: 'reply', body: 'here', thread_id: 'tl-reply', reply_to: null }, [d.id]);
  await waits.declare(d.id, { on: 'agent', target: c.id, note: 'the merge' });
  assert.equal(nudges(c.id), 1);
  await waits.declare(d.id, { on: 'agent', target: c.id, note: 'the merge' });
  assert.equal(nudges(c.id), 1);
});

test('a mail from the waiter to someone else in the thread does not nudge the awaited agent (S-2574)', async () => {
  const a = agent('tn-awaited', 'scoped');
  const b = agent('tn-waiter', 'scoped-waiter');
  const c = agent('tn-other', 'other');
  const root = await mail.sendMail({ from: b.id, to: [a.id], subject: 'merge ask', body: 'tell me when it merges', new_thread: true });
  const nudges = () => db.listEvents(a.id, 200, 'wait:nudged').length;
  const declare = () => waits.declare(b.id, { on: 'agent', target: a.id, thread: root.thread_id, note: 'the merge' });
  await declare();
  assert.equal(nudges(), 1);
  // The waiter writes to another agent in the same thread: that is not an ask of the awaited agent.
  await mail.sendMail({ from: b.id, to: [c.id], subject: 'Re: merge ask', body: 'a side note', reply_to: root.id });
  await declare();
  assert.equal(nudges(), 1);
});

test('a restart keeps an answered wait from nudging again (S-2574)', async () => {
  const a = agent('wr-awaited', 'restarted');
  const b = agent('wr-waiter', 'restart-waiter');
  const root = await mail.sendMail({ from: b.id, to: [a.id], subject: 'merge ask', body: 'tell me when it merges', new_thread: true });
  await waits.declare(b.id, { on: 'agent', target: a.id, thread: root.thread_id, note: 'the merge' });
  await mail.sendMail({ from: a.id, to: [b.id], subject: 'Re: merge ask', body: 'not yet', reply_to: root.id });
  // A fresh process with the same STAM_HOME: nothing in memory, only the db.
  const script = `
    const db = await import(${JSON.stringify(pathToFileURL(join(here, '../src/db.ts')).href)});
    const waits = await import(${JSON.stringify(pathToFileURL(join(here, '../src/waits.ts')).href)});
    await waits.declare(${JSON.stringify(b.id)}, { on: 'agent', target: ${JSON.stringify(a.id)}, thread: ${JSON.stringify(root.thread_id)}, note: 'the merge' });
    console.log(db.listEvents(${JSON.stringify(a.id)}, 200, 'wait:nudged').length);`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, STAM_HOME: home, TZ: 'Europe/Helsinki' }, encoding: 'utf8' });
  assert.equal(out.trim(), '1', 'a restarted daemon nudged for an answered ask');
});

test('a thread with no ask nudges once, however many replies the awaited agent sends (S-2663)', async () => {
  // The awaited agent opened the thread: the waiter never mailed it there.
  const a = agent('nn-awaited', 'noask');
  const b = agent('nn-waiter', 'noask-waiter');
  const root = await mail.sendMail({ from: a.id, to: [b.id], subject: 'opened', body: 'hello', new_thread: true });
  const nudges = () => db.listEvents(a.id, 200, 'wait:nudged').length;
  const declare = () => waits.declare(b.id, { on: 'agent', target: a.id, thread: root.thread_id, note: 'the merge' });
  const reply = (body) => mail.sendMail({ from: a.id, to: [b.id], subject: 'Re: opened', body, reply_to: root.id });

  await declare();
  assert.equal(nudges(), 1);
  await reply('first reply');
  await declare();
  assert.equal(nudges(), 1, 'the first reply nudged again');
  // A second reply, then a re-declare: still no nudge.
  await reply('second reply');
  await declare();
  assert.equal(nudges(), 1, 'the second reply nudged again');
  await waits.tick();
  assert.equal(nudges(), 1);
});

test('a thread with no ask and no answer sends no nudge, even when the awaited agent mailed a third agent (S-2663)', async () => {
  const a = agent('na-awaited', 'narrow');
  const b = agent('na-waiter', 'narrow-waiter');
  const c = agent('na-third', 'narrow-third');
  const root = await mail.sendMail({ from: a.id, to: [c.id], subject: 'side', body: 'for the third agent', new_thread: true });
  await waits.declare(b.id, { on: 'agent', target: a.id, thread: root.thread_id, note: 'the merge' });
  assert.equal(db.listEvents(a.id, 200, 'wait:nudged').length, 0, 'a mail to a third agent nudged the awaited agent');
});

test('a nudged key stays nudged after 200 newer wait:nudged events (S-2663)', async () => {
  const a = agent('nd-awaited', 'deduped');
  const b = agent('nd-waiter', 'deduped-waiter');
  const root = await mail.sendMail({ from: b.id, to: [a.id], subject: 'ask', body: 'tell me when it merges', new_thread: true });
  const nudgeEvents = () => db.open().prepare("SELECT COUNT(*) AS n FROM events WHERE agent_id = ? AND type = 'wait:nudged'").get(a.id).n;
  const declare = () => waits.declare(b.id, { on: 'agent', target: a.id, thread: root.thread_id, note: 'the merge' });

  await declare();
  assert.equal(nudgeEvents(), 1);
  // 250 newer nudges of other keys push the first one out of the newest 200 events.
  for (let i = 0; i < 250; i++) db.addEvent(a.id, 'wait:nudged', { waiter: 'someone-else', thread: null, mail: `filler-${i}` });
  await declare();
  assert.equal(nudgeEvents(), 251, 'the key nudged again once it left the newest 200 events');
});

test('nudges sent before the wait_nudges table are backfilled so they never repeat, and never block a new nudge (S-2663)', async () => {
  const a = agent('mg-awaited', 'migrated');
  const b = agent('mg-waiter', 'migrated-waiter');
  const threaded = await mail.sendMail({ from: a.id, to: [b.id], subject: 'opened', body: 'hello', new_thread: true });
  const threadless = await mail.sendMail({ from: a.id, to: [b.id], subject: 'opened again', body: 'hello again', new_thread: true });
  // A thread the awaited agent opened with a third agent, so b has no answer there yet.
  const c = agent('mg-third', 'migrated-third');
  const later = await mail.sendMail({ from: a.id, to: [c.id], subject: 'side', body: 'for the third agent', new_thread: true });
  // An older database: the table and its migration record are gone; the nudges sent before are only in events.
  // A thread-scoped no-ask nudge with the old answer id, a threadless one (with the answer id it was keyed on), and a
  // thread-scoped bare 'declare:' sent when there was no answer yet.
  db.open().exec('DROP TABLE wait_nudges');
  db.open().exec("DELETE FROM migrations WHERE name = 'wait-nudges-from-events'");
  db.addEvent(a.id, 'wait:nudged', { waiter: b.id, thread: threaded.thread_id, mail: 'declare:old-answer' });
  db.addEvent(a.id, 'wait:nudged', { waiter: b.id, thread: null, mail: `declare:${threadless.id}` });
  db.addEvent(a.id, 'wait:nudged', { waiter: b.id, thread: later.thread_id, mail: 'declare:' });
  const before = db.listEvents(a.id, 200, 'wait:nudged').length;
  const script = `
    const db = await import(${JSON.stringify(pathToFileURL(join(here, '../src/db.ts')).href)});
    const mail = await import(${JSON.stringify(pathToFileURL(join(here, '../src/mail.ts')).href)});
    const waits = await import(${JSON.stringify(pathToFileURL(join(here, '../src/waits.ts')).href)});
    db.open();
    const a = ${JSON.stringify(a.id)}, b = ${JSON.stringify(b.id)};
    // The thread-scoped key was sent before: no nudge.
    await waits.declare(b, { on: 'agent', target: a, thread: ${JSON.stringify(threaded.thread_id)}, note: 'the merge' });
    // The threadless key was sent for this answer: no nudge.
    await waits.declare(b, { on: 'agent', target: a, note: 'the merge' });
    // A new answer from the awaited agent is a new key: one nudge.
    await mail.sendMail({ from: a, to: [b], subject: 'Re: opened again', body: 'news', reply_to: ${JSON.stringify(threadless.id)} });
    await waits.declare(b, { on: 'agent', target: a, note: 'the merge' });
    // The bare 'declare:' of a thread with no answer then: the awaited agent answers there, and the re-declare nudges exactly once.
    await mail.sendMail({ from: a, to: [b], subject: 'Re: side', body: 'answer', reply_to: ${JSON.stringify(later.id)} });
    await waits.declare(b, { on: 'agent', target: a, thread: ${JSON.stringify(later.thread_id)}, note: 'the merge' });
    await waits.declare(b, { on: 'agent', target: a, thread: ${JSON.stringify(later.thread_id)}, note: 'the merge' });
    console.log(db.listEvents(a, 200, 'wait:nudged').length);`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, STAM_HOME: home, TZ: 'Europe/Helsinki' }, encoding: 'utf8' });
  assert.equal(out.trim(), String(before + 2), 'a backfilled key nudged again, or a new answer or answer in the thread did not nudge exactly once');
});

test('a mixed send to a local and a peer agent asks the peer agent, and its copy records the peer (S-2663)', async () => {
  const a = agent('mx-awaited', 'mixed');
  const c = agent('mx-local', 'mixed-local');
  db.rememberPeerAgent({ id: 'mx-remote', name: 'far-agent', machine: 'far' });
  const sent = await mail.sendMail({ from: a.id, to: [c.id, 'mx-remote'], subject: 'mixed ask', body: 'tell me when it merges', new_thread: true });
  assert.deepEqual(JSON.parse(db.getMail(sent.id).copy_to), ['mx-remote']);
  await waits.declare(a.id, { on: 'agent', target: 'mx-remote', thread: sent.thread_id, note: 'the merge' });
  assert.equal(db.listEvents('mx-remote', 200, 'wait:nudged').length, 1, 'the remote recipient of a mixed send was not asked');
});

test('a threadless wait with no ask nudges again only after the awaited agent mails (S-2663)', async () => {
  const a = agent('tu-awaited', 'threadless-noask');
  const b = agent('tu-waiter', 'threadless-noask-waiter');
  const root = await mail.sendMail({ from: a.id, to: [b.id], subject: 'opened', body: 'hello', new_thread: true });
  const nudges = () => db.listEvents(a.id, 200, 'wait:nudged').length;
  const declare = () => waits.declare(b.id, { on: 'agent', target: a.id, note: 'the merge' });

  await declare();
  assert.equal(nudges(), 1);
  await declare();
  assert.equal(nudges(), 1, 'a re-declare nudged again before the awaited agent mailed');
  await mail.sendMail({ from: a.id, to: [b.id], subject: 'Re: opened', body: 'not yet', reply_to: root.id });
  await declare();
  assert.equal(nudges(), 2, 'a new mail from the awaited agent did not nudge');
  await declare();
  assert.equal(nudges(), 2);
});

test('a sender copy counts as an ask only of the agents it was sent to (S-2663)', async () => {
  const a = agent('cp-awaited', 'copy-to');
  const b = agent('cp-waiter', 'copy-to-waiter');
  const c = agent('cp-other', 'copy-other');
  const nudges = () => db.listEvents(a.id, 200, 'wait:nudged').length;
  const declare = () => waits.declare(b.id, { on: 'agent', target: a.id, thread: 'cp-root', note: 'the merge' });
  // A copy sent to another agent, and one sent to the awaited agent later on, in the same thread.
  db.createMail({ id: 'cp-root', from_id: b.id, from_name: 'copy-to-waiter', subject: 'ask', body: 'for the other agent', thread_id: 'cp-root', reply_to: null, copy_to: [c.id] }, [], []);
  await declare();
  assert.equal(nudges(), 0, 'a copy sent to another agent counted as an ask of the awaited agent');
  // Recording another recipient on the copy makes it an ask of that agent too.
  db.addCopyRecipients('cp-root', [a.id]);
  await declare();
  assert.equal(nudges(), 1);
});
