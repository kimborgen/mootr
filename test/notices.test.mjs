#!/usr/bin/env node
// Unit tests for the auto-read sweep (src/notices.ts, S-717): a watch_pr relay whose watch
// ended, an automatic notice in or about a closed ITSA, and a pushed notice from an agent
// archived a day ago all count as read; a colleague's mail, a deploy-hold alert, and anything
// the agent still waits on stay unread, and the human's own mail is never touched. Throwaway
// STAM_HOME, no daemon: `node --test test/notices.test.mjs`.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-notices-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `notices-test-${process.pid}`;
// Deliver by calling flush() instead of waiting on the fold window.
process.env.STAM_EVENT_FOLD_MS = '60000';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

const DAY = 24 * 60 * 60_000;
let db, watch, mail, itsa, notices, waits;

const agent = (id, name, fields = {}) =>
  db.createAgent({ id, name, role: 'dev', machine: 'x', harness: 'claude', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null, ...fields });

// A mail written straight into the store, so its sender, subject, and ITSA link are exact.
let seq = 0;
const send = (from, to, subject, extra = {}) => {
  const id = `m-notice-${++seq}`;
  db.createMail({ id, from_id: from, from_name: null, subject, body: extra.body ?? 'body', thread_id: extra.thread ?? id, reply_to: null, ...extra }, to);
  return id;
};

const unread = (a) => db.inbox(a, true, 50).map((m) => m.id).sort();

before(async () => {
  db = await import('../src/db.ts');
  watch = await import('../src/watch.ts');
  mail = await import('../src/mail.ts');
  itsa = await import('../src/itsa.ts');
  notices = await import('../src/notices.ts');
  waits = await import('../src/waits.ts');
  db.open();
  watch.watchItsa();
});
after(() => rmSync(home, { recursive: true, force: true }));

beforeEach(() => {
  const d = db.open();
  for (const t of ['ext_events', 'event_subscriptions', 'mail_recipients', 'mail', 'waits', 'itsa_participants', 'itsa_events', 'itsa_links', 'itsas', 'agents']) d.exec(`DELETE FROM ${t}`);
});

test('a watch_pr relay counts as read once the watch ends, and not before', async () => {
  agent('stand', 'standin');
  agent('a1', 'alice');
  db.updateAgent('a1', { activity: 'idle' });
  watch.createSubscription({
    subscriber_kind: 'agent',
    subscriber_id: 'a1',
    filter: { source: 'github', subjects: ['github:o/r#12'], types: ['checks.completed', 'pull_request.merged'], ends_on: ['pull_request.merged'] },
    note: 'PR #12 watch',
    by: 'a1',
  });
  watch.ingest({ source: 'github', type: 'checks.completed', subjects: ['github:o/r#12'], summary: 'checks ok', dedupe_key: 'c1' });
  await watch.flush();
  assert.equal(unread('a1').length, 1, 'the relay arrived');
  assert.equal(notices.sweep(), 0, 'the watch is live, so the relay stays unread');
  assert.equal(unread('a1').length, 1);

  // The merge ends the watch; the ending relay is delivered from the queued copy.
  watch.ingest({ source: 'github', type: 'pull_request.merged', subjects: ['github:o/r#12'], summary: 'merged 12', dedupe_key: 'm1' });
  await watch.flush();
  assert.equal(unread('a1').length, 2, 'both relays arrived');
  assert.equal(notices.sweep(), 0, 'a fresh relay waits until it is pushed or a day passes');
  assert.equal(notices.sweep({ now: Date.now() + 2 * DAY }), 2, 'a day later, both relays count as read');
  assert.equal(unread('a1').length, 0);
});

test('mail in a closed ITSA thread counts as read, and stays unread while it is open', async () => {
  agent('stand', 'standin');
  agent('a2', 'bob');
  db.updateAgent('a2', { activity: 'idle' });
  const x = await itsa.create({ title: 'Watch it', by: 'human', owner: 'human' });
  await itsa.post(x.id, { by: 'a2', body: 'hi' });
  watch.createSubscription({ subscriber_kind: 'itsa', subscriber_id: x.id, filter: { source: 'github' }, by: 'human' });
  watch.ingest({ source: 'github', type: 'x', subjects: ['github:o/r'], summary: 'happened', dedupe_key: 'e1' });
  await watch.flush();
  assert.equal(unread('a2').length, 1, 'the ITSA relay reached the participant');
  assert.equal(notices.sweep(), 0, 'the ITSA is open');
  await itsa.set(x.id, { status: 'done' }, 'human');
  assert.equal(notices.sweep(), 1, 'closing the ITSA reads its mail');
  assert.equal(unread('a2').length, 0);
});

test('mail linked to a closed ITSA counts as read', async () => {
  agent('a1', 'alice');
  const x = await itsa.create({ title: 'Linked', by: 'human', owner: 'human' });
  send('system:deploy-watch', ['a1'], 'deploy staged', { about_itsa: x.id, notice: true });
  assert.equal(notices.sweep(), 0, 'the ITSA is open');
  await itsa.set(x.id, { status: 'done' }, 'human');
  assert.equal(notices.sweep(), 1);
  assert.equal(unread('a1').length, 0);
});

test('a legacy deploy notice naming a closed ITSA counts as read, a hold alert does not', async () => {
  agent('a1', 'alice');
  const x = await itsa.create({ title: 'Deployed', by: 'human', owner: 'human' });
  // The "not marked done" failure names the key in its text; it has no ITSA link (legacy).
  send('system:deploy-watch', ['a1'], `${x.key} is not marked done after deploy of abc`, { body: 'The set command failed.' });
  // A hold alert names the same key, but waits on the human until the hold is removed (S-717 review).
  send('system:deploy-watch', ['a1'], `deploy of abc stopped: origin is down`, {
    about_itsa: x.id,
    notice: true,
    body: `PR #7.\n${x.key} was not closed: the merge is held, so it stays open.\n\nThe watcher holds until /home/user/.local/share/stam/deploy-hold is removed.`,
  });
  assert.equal(notices.sweep(), 0, 'the ITSA it names is open');
  await itsa.set(x.id, { status: 'done' }, 'human');
  assert.equal(notices.sweep(), 1, 'the legacy notice is read, never the hold alert');
  assert.equal(unread('a1').length, 1, 'the hold alert stays unread');
});

test('a colleague\'s own mail in a closed ITSA stays unread', async () => {
  agent('a1', 'alice');
  agent('a2', 'bob');
  const x = await itsa.create({ title: 'Closed', by: 'human', owner: 'human' });
  await itsa.set(x.id, { status: 'done' }, 'human');
  const ask = send('a2', ['a1'], 'Can you review this?', { about_itsa: x.id, body: 'A real question, still needs an answer.' });
  assert.equal(notices.sweep(), 0, "a colleague's question is not an automatic notice");
  assert.deepEqual(unread('a1'), [ask]);
  // An automatic notice about the same closed ITSA still counts as read.
  send('system:deploy-watch', ['a1'], 'deploy done', { about_itsa: x.id, notice: true });
  assert.equal(notices.sweep(), 1, 'only the automatic notice is read');
  assert.deepEqual(unread('a1'), [ask]);
});

test('a notice the agent has a wait_for on stays unread', async () => {
  agent('a1', 'alice');
  agent('a2', 'bob');
  const x = await itsa.create({ title: 'Relay', by: 'human', owner: 'human' });
  await itsa.set(x.id, { status: 'done' }, 'human');
  send('a2', ['a1'], '[stam] 1 linked github:o/r#1 events', { about_itsa: x.id, notice: true, body: 'something changed' });
  const w = await waits.declare('a1', { on: 'agent', target: 'a2' });
  assert.equal(notices.sweep(), 0, 'the recipient waits on this sender, so it stays unread');
  assert.equal(unread('a1').length, 1);
  db.clearWait(w.id);
  assert.equal(notices.sweep(), 1, 'with the wait gone, the notice is settled');
  assert.equal(unread('a1').length, 0);
});

test('a pushed notice from an agent archived over a day ago counts as read; its other mail does not', () => {
  agent('a1', 'alice');
  agent('a2', 'gone');
  send('a2', ['a1'], 'all done', { notice: true });
  const ask = send('a2', ['a1'], 'can you check?', { notice: false });
  db.addEvent('a2', 'archive', { result: 'archived' });
  db.updateAgent('a2', { lifecycle: 'archived' });
  assert.equal(notices.sweep({ now: Date.now() + 2 * DAY }), 0, 'not pushed yet, so nothing is read');
  db.markPushed('a1');
  assert.equal(notices.sweep(), 0, 'pushed, but the archive was under a day ago');
  assert.equal(notices.sweep({ now: Date.now() + 2 * DAY }), 1, 'only the notice is read');
  assert.deepEqual(unread('a1'), [ask]);
});

test('a resumed agent\'s fresh notice stays unread, though its old archive event is a day old', () => {
  agent('a1', 'alice');
  agent('a2', 'back');
  db.addEvent('a2', 'archive', { result: 'archived' });
  db.updateAgent('a2', { lifecycle: 'archived' });
  db.updateAgent('a2', { lifecycle: 'active' });
  send('a2', ['a1'], 'fresh news', { notice: true });
  db.markPushed('a1');
  assert.equal(notices.sweep({ now: Date.now() + 2 * DAY }), 0, 'the sender is active again, so its notice stays');
  assert.equal(unread('a1').length, 1);
});

test('ordinary mail from a live agent stays unread, and the human is never touched', () => {
  agent('a1', 'alice');
  agent('a2', 'bob');
  agent('a3', 'gone');
  db.updateAgent('a3', { lifecycle: 'archived' });
  send('a2', ['a1'], 'a real question?');
  send('a3', ['human'], 'news for the human');
  assert.equal(notices.sweep({ now: Date.now() + 2 * DAY }), 0, 'the live agent mail stays; the human is skipped');
  assert.equal(unread('a1').length, 1);
  assert.equal(unread('human').length, 1);
});