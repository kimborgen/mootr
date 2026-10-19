#!/usr/bin/env node
// Unit tests for the external-event service (src/watch.ts): subject glob matching, subject
// keys from link urls, dedupe by dedupe_key, folding a burst into one delivery, expiry,
// delivery to an agent, an ITSA, and the human, an ITSA's link subscriptions (subscribe,
// unsubscribe, close and reopen), event waits cleared by a matching event, and the subjects
// the pollers watch. Throwaway STAM_HOME, no daemon, no network. Run with
// `node --test test/watch.test.mjs`.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-watch-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `watch-test-${process.pid}`;
// A long fold window: the tests deliver by calling flush() instead of waiting.
process.env.STAM_EVENT_FOLD_MS = '60000';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

let db, watch, mail, itsa, waits;

const agent = (id, name, fields = {}) =>
  db.createAgent({ id, name, role: 'dev', machine: 'x', harness: 'claude', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null, ...fields });

before(async () => {
  db = await import('../src/db.ts');
  watch = await import('../src/watch.ts');
  mail = await import('../src/mail.ts');
  itsa = await import('../src/itsa.ts');
  waits = await import('../src/waits.ts');
  db.open();
  // As the daemon does at start: reconcile an ITSA's link subscriptions on any change.
  watch.watchItsa();
});
after(() => rmSync(home, { recursive: true, force: true }));

beforeEach(() => {
  const d = db.open();
  for (const t of ['ext_events', 'event_subscriptions', 'mail_recipients', 'mail', 'waits', 'itsa_participants', 'itsa_events', 'itsa_links', 'itsas', 'agents']) d.exec(`DELETE FROM ${t}`);
});

// A running stand-in for mail stam sends on its own behalf (mail.stamSender).
const standIn = () => agent('stand', 'standin');

test('globMatch: * stays within one segment; an exact pattern matches only itself', () => {
  assert.ok(watch.globMatch('github:example/*', 'github:example/stam'));
  assert.ok(watch.globMatch('github:example/*', 'github:example/stam#12'));
  assert.ok(!watch.globMatch('github:example/*', 'github:other/stam2'));
  assert.ok(watch.globMatch('github:example/stam#12', 'github:example/stam#12'));
  assert.ok(!watch.globMatch('github:example/stam#12', 'github:example/stam#13'));
  assert.ok(watch.globMatch('pull_request.*', 'pull_request.synchronize'));
  assert.ok(!watch.globMatch('pull_request.*', 'push'));
  assert.ok(watch.globMatch('*', 'anything:at/all'));
});

test('ingest stores an event once and drops a repeat of its dedupe_key', () => {
  const first = watch.ingest({ source: 'github', type: 'x', subjects: ['github:o/r#1'], dedupe_key: 'k1' });
  assert.equal(first.stored, true);
  const again = watch.ingest({ source: 'github', type: 'x', subjects: ['github:o/r#1'], dedupe_key: 'k1' });
  assert.equal(again.stored, false);
  assert.equal(watch.events().length, 1);
  assert.ok(watch.events({ subject: 'github:o/r#1' }).length === 1);
  assert.equal(watch.events({ subject: 'github:o/r#2' }).length, 0);
  assert.throws(() => watch.ingest({ type: 'x', dedupe_key: 'k2' }), /source/);
  assert.throws(() => watch.ingest({ source: 'github', dedupe_key: 'k3' }), /type/);
  assert.throws(() => watch.ingest({ source: 'github', type: 'x' }), /dedupe_key/);
});

test('events(subject=) filters in SQL, so an old match survives the limit', () => {
  // The two matches are the oldest of 60; a LIMIT applied before the filter would drop them.
  watch.ingest({ source: 'github', type: 'x', subjects: ['github:o/r#12'], summary: 'target one', dedupe_key: 't1' });
  watch.ingest({ source: 'github', type: 'x', subjects: ['github:o/r#12'], summary: 'target two', dedupe_key: 't2' });
  for (let i = 0; i < 58; i++) watch.ingest({ source: 'github', type: 'x', subjects: [`github:o/r#${100 + i}`], summary: `noise ${i}`, dedupe_key: `n${i}` });
  assert.equal(watch.events().length, 50, 'the plain listing is limited to 50');
  const got = watch.events({ subject: 'github:o/r#12', limit: 50 });
  assert.equal(got.length, 2, 'both old matches are returned');
  assert.deepEqual(got.map((e) => e.summary).sort(), ['target one', 'target two']);
});

test('a subscription matches, folds a burst, and notifies a working agent in its turn', async () => {
  standIn();
  agent('a1', 'alice');
  db.updateAgent('a1', { activity: 'working' });
  watch.createSubscription({ subscriber_kind: 'agent', subscriber_id: 'a1', filter: { source: 'github', subjects: ['github:o/*'], types: ['pull_request.*'] }, by: 'a1' });
  watch.ingest({ source: 'github', type: 'pull_request.opened', subjects: ['github:o/r#1'], actor: 'kim', url: 'https://x/1', summary: 'opened 1', dedupe_key: 'e1' });
  watch.ingest({ source: 'github', type: 'pull_request.synchronize', subjects: ['github:o/r#1'], actor: 'kim', url: 'https://x/1b', summary: 'synced 1', dedupe_key: 'e2' });
  watch.ingest({ source: 'github', type: 'push', subjects: ['github:o/r'], summary: 'a push', dedupe_key: 'e3' });
  assert.equal(mail.inTurnNotice('a1'), undefined, 'nothing arrives before the fold window closes');
  await watch.flush();
  const notice = mail.inTurnNotice('a1') ?? '';
  assert.match(notice, /opened 1/);
  assert.match(notice, /synced 1/);
  assert.match(notice, /https:\/\/x\/1/, 'the url is listed');
  assert.doesNotMatch(notice, /a push/, 'a type outside the filter is not delivered');
});

test('an idle agent gets mail from stam', async () => {
  standIn();
  agent('a1', 'alice');
  db.updateAgent('a1', { activity: 'idle' });
  watch.createSubscription({ subscriber_kind: 'agent', subscriber_id: 'a1', filter: { source: 'github' }, by: 'a1' });
  watch.ingest({ source: 'github', type: 'x', subjects: ['github:o/r'], summary: 'a thing happened', dedupe_key: 'e1' });
  await watch.flush();
  const inbox = db.inbox('a1', false, 10);
  assert.equal(inbox.length, 1);
  assert.match(inbox[0].subject, /github event/);
  assert.match(db.readMail('a1', [inbox[0].id])[0].body, /a thing happened/);
});

test('an expired subscription is deleted and never delivers', async () => {
  standIn();
  agent('a1', 'alice');
  db.updateAgent('a1', { activity: 'idle' });
  watch.createSubscription({ subscriber_kind: 'agent', subscriber_id: 'a1', filter: { source: 'github' }, by: 'a1', expires_at: Date.now() - 1000 });
  watch.ingest({ source: 'github', type: 'x', summary: 'too late', dedupe_key: 'e1' });
  await watch.flush();
  assert.equal(watch.listSubscriptions('a1').length, 0, 'the expired one was deleted');
  assert.equal(db.inbox('a1', false, 10).length, 0);
});

test('an agent may subscribe itself or an agent in its tree, not an unrelated one', () => {
  agent('boss', 'boss');
  agent('kid', 'kid', { parent_id: 'boss' });
  agent('other', 'other');
  assert.ok(watch.createSubscription({ subscriber_kind: 'agent', subscriber_id: 'kid', by: 'boss' }), 'a parent subscribes its child');
  assert.ok(watch.createSubscription({ subscriber_kind: 'agent', subscriber_id: 'boss', by: 'boss' }), 'an agent subscribes itself');
  assert.throws(() => watch.createSubscription({ subscriber_kind: 'agent', subscriber_id: 'other', by: 'kid' }), /may not/);
  assert.throws(() => watch.createSubscription({ subscriber_kind: 'agent', subscriber_id: 'kid', by: 'other' }), /may not/);
});

test('an ITSA subscription posts into its thread as stam, without joining as a participant', async () => {
  standIn();
  const x = await itsa.create({ title: 'Watch it', by: 'human', owner: 'human' });
  watch.createSubscription({ subscriber_kind: 'itsa', subscriber_id: x.id, filter: { source: 'github' }, by: 'human' });
  watch.ingest({ source: 'github', type: 'x', subjects: ['github:o/r'], summary: 'happened', dedupe_key: 'e1' });
  await watch.flush();
  const t = itsa.must(x.id).thread_id;
  assert.ok(t, 'the thread was created');
  const mails = db.threadMail(t);
  assert.equal(mails.length, 1);
  assert.match(mails[0].body, /happened/);
  assert.ok(!itsa.participants(x.id).includes('stand'), 'stam did not join the ITSA');
});

test('an ITSA event notice reaches its agents but not the human participant (S-511)', async () => {
  standIn();
  agent('a1', 'alice');
  const x = await itsa.create({ title: 'Event it', by: 'human', owner: 'human' });
  // The human joins as a participant (a post by them), and so does an agent.
  await itsa.post(x.id, { by: 'human', body: 'hello' });
  await itsa.post(x.id, { by: 'a1', body: 'hi' });
  assert.ok(itsa.participants(x.id).includes('human') && itsa.participants(x.id).includes('a1'));
  watch.createSubscription({ subscriber_kind: 'itsa', subscriber_id: x.id, filter: { source: 'github' }, by: 'human' });
  watch.ingest({ source: 'github', type: 'x', subjects: ['github:o/r'], summary: 'agents only', dedupe_key: 'e1' });
  await watch.flush();
  const t = itsa.must(x.id).thread_id;
  const notice = db.threadMail(t).find((m) => m.from_id === 'stand');
  assert.ok(notice, 'the event notice was posted');
  assert.match(notice.body, /agents only/);
  const to = notice.recipients.map((r) => r.id);
  assert.ok(to.includes('a1'), 'the agent participant gets it');
  assert.ok(!to.includes('human'), 'the human participant does not');
  // The same post without the flag still reaches the human: the flag is what keeps them out.
  await itsa.post(x.id, { from_stam: true, body: 'plain stam post' });
  const plain = db.threadMail(t).find((m) => m.body === 'plain stam post');
  assert.ok(plain.recipients.map((r) => r.id).includes('human'), 'a stam post without agents_only still reaches the human');
});

test('human deliveries share one thread per subscription', async () => {
  standIn();
  watch.createSubscription({ subscriber_kind: 'human', subscriber_id: 'human', filter: { source: 'github' }, by: 'human' });
  watch.ingest({ source: 'github', type: 'x', summary: 'first', dedupe_key: 'e1' });
  await watch.flush();
  watch.ingest({ source: 'github', type: 'x', summary: 'second', dedupe_key: 'e2' });
  await watch.flush();
  const inbox = db.inbox('human', false, 10);
  assert.equal(inbox.length, 2);
  assert.equal(inbox[0].thread_id, inbox[1].thread_id, 'both messages are in one thread');
});

test('removeSubscription deletes it and refuses an unrelated agent', () => {
  agent('a1', 'alice');
  agent('other', 'other');
  const s = watch.createSubscription({ subscriber_kind: 'agent', subscriber_id: 'a1', filter: {}, by: 'a1' });
  assert.throws(() => watch.removeSubscription(s.id, 'other'), /may not/);
  assert.equal(watch.removeSubscription(s.id, 'a1').id, s.id);
  assert.equal(watch.find(s.id), undefined);
});

test('subjectsForUrl maps a GitHub PR or issue and a Linear issue, and nothing else', () => {
  assert.equal(watch.subjectsForUrl('https://github.com/example/stam/pull/12'), 'github:example/stam#12');
  assert.equal(watch.subjectsForUrl('https://github.com/example/stam/issues/7'), 'github:example/stam#7');
  assert.equal(watch.subjectsForUrl('https://linear.app/kim/issue/TEAM-123/a-title'), 'linear:TEAM-123');
  assert.equal(watch.subjectsForUrl('https://github.com/example/stam'), null, 'a bare repo is not a PR or issue');
  assert.equal(watch.subjectsForUrl('https://example.com/x'), null);
  assert.equal(watch.subjectsForUrl(''), null);
});

test('an ITSA linked at create hears on that subject as stam, and closing or unlinking drops it', async () => {
  const x = await itsa.create({ title: 'PR 12', by: 'human', owner: 'human', links: [{ url: 'https://github.com/o/r/pull/12' }] });
  const subs = watch.listSubscriptions('human');
  assert.equal(subs.length, 1, 'a link makes exactly one subscription');
  assert.equal(subs[0].subscriber_kind, 'itsa');
  assert.equal(subs[0].subscriber_id, x.id);
  assert.equal(subs[0].created_by, 'stam');
  assert.deepEqual(subs[0].filter.subjects, ['github:o/r#12']);
  assert.equal(subs[0].note, 'linked github:o/r#12');

  // Idempotent: a second reconcile makes no second one.
  watch.syncItsaSubscriptions();
  assert.equal(watch.listSubscriptions('human').length, 1);

  // Closing the ITSA drops it; reopening recreates it.
  await itsa.set(x.id, { status: 'done' }, 'human');
  assert.equal(watch.listSubscriptions('human').length, 0, 'a closed ITSA keeps no link subscription');
  await itsa.set(x.id, { status: 'in_progress' }, 'human');
  assert.equal(watch.listSubscriptions('human').length, 1, 'reopening recreates the link subscription');
});

test('adding a link subscribes and removing it unsubscribes, idempotently', async () => {
  const x = await itsa.create({ title: 'Add a link', by: 'human', owner: 'human' });
  assert.equal(watch.listSubscriptions('human').length, 0);
  const { link } = await itsa.addLink(x.id, { url: 'https://github.com/o/r/issues/3' }, 'human');
  const subs = watch.listSubscriptions('human');
  assert.equal(subs.length, 1);
  assert.equal(subs[0].created_by, 'stam');
  assert.deepEqual(subs[0].filter.subjects, ['github:o/r#3']);
  await itsa.removeLink(x.id, link.n, 'human');
  assert.equal(watch.listSubscriptions('human').length, 0, 'removing the link drops its subscription');
});

test('an event wait clears on the first matching event, and not on others', async () => {
  standIn();
  agent('a1', 'alice');
  const w = await waits.declare('a1', { on: 'event', filter: { source: 'github', subjects: ['github:o/r#12'] }, note: 'CI on PR 12' });
  assert.equal(w.kind, 'event');
  assert.equal(w.source, 'declared');
  assert.equal(db.waitSummary(db.listWaits('a1')), 'waiting for CI on PR 12');

  watch.ingest({ source: 'github', type: 'check_run', subjects: ['github:o/r#13'], summary: 'another PR', dedupe_key: 'x1' });
  assert.ok(db.getWait(w.id), 'an event outside the filter cleared the wait');

  watch.ingest({ source: 'github', type: 'check_run.completed', subjects: ['github:o/r#12'], url: 'https://gh/12', summary: 'CI passed', dedupe_key: 'x2' });
  assert.equal(db.getWait(w.id), undefined, 'the matching event cleared the wait');
  assert.equal(db.listWaits('a1').length, 0);
  const notice = mail.inTurnNotice('a1') ?? '';
  assert.match(notice, /CI passed/, 'the notice carries the event summary');
  assert.match(notice, /https:\/\/gh\/12/, 'the notice carries the event url');
});

test('an event wait clears nothing for a duplicate event, and honors a timeout row', async () => {
  agent('a1', 'alice');
  const w = await waits.declare('a1', { on: 'event', filter: { subjects: ['github:o/r#1'] }, timeout_minutes: 30 });
  assert.ok(w.until, 'a timeout sets until');
  watch.ingest({ source: 'github', type: 'x', subjects: ['github:o/r#1'], summary: 'first', dedupe_key: 'd1' });
  assert.equal(db.getWait(w.id), undefined);
  const w2 = await waits.declare('a1', { on: 'event', filter: { subjects: ['github:o/r#2'] } });
  watch.ingest({ source: 'github', type: 'x', subjects: ['github:o/r#2'], summary: 'again', dedupe_key: 'd1' });
  assert.ok(db.getWait(w2.id), 'a duplicate dedupe_key was not stored and must not clear a wait');
});

test('a subscription with ends_on ends after its ending event is delivered, and not before', async () => {
  // watch_pr: a merge or close ends the watch. The row goes at once; the queued copy still delivers.
  standIn();
  agent('a1', 'alice');
  db.updateAgent('a1', { activity: 'working' });
  assert.deepEqual(watch.sanitizeFilter({ ends_on: ['pull_request.merged'] }).ends_on, ['pull_request.merged']);
  const sub = watch.createSubscription({ subscriber_kind: 'agent', subscriber_id: 'a1', filter: { source: 'github', subjects: ['github:o/r#1'], types: ['checks.completed', 'pull_request.merged'], ends_on: ['pull_request.merged'] }, note: 'PR #1 watch', by: 'a1' });
  watch.ingest({ source: 'github', type: 'checks.completed', subjects: ['github:o/r#1'], summary: 'checks ok', dedupe_key: 'c1' });
  assert.ok(watch.find(sub.id), 'a checks event does not end the watch');
  watch.ingest({ source: 'github', type: 'pull_request.merged', subjects: ['github:o/r#1'], summary: 'merged 1', dedupe_key: 'm1' });
  assert.equal(watch.find(sub.id), undefined, 'the merge ends it');
  assert.deepEqual(watch.watchedSubjects().filter((x) => x === 'github:o/r#1'), [], 'so the poller stops watching the PR');
  assert.equal(watch.ingest({ source: 'github', type: 'checks.completed', subjects: ['github:o/r#1'], summary: 'later', dedupe_key: 'c2' }).matched, 0, 'nothing after it matches');
  await watch.flush();
  const notice = mail.inTurnNotice('a1') ?? '';
  assert.match(notice, /merged 1/, 'the ending event is delivered');
  assert.match(notice, /checks ok/, 'and the event before it');
  assert.doesNotMatch(notice, /later/);
  assert.doesNotMatch(notice, /Manage it with/, 'the subscription already ended, so the notice doesn\'t ask the agent to manage it');
  assert.match(notice, /nothing to unsubscribe/);
});

test('a watch relays only events after it began, and never the watcher\'s own review (S-795, S-803)', async () => {
  standIn();
  agent('a1', 'alice');
  db.updateAgent('a1', { activity: 'working' });
  const since = '2026-10-14T16:41:00Z';
  assert.equal(watch.sanitizeFilter({ since }).since, since, 'since survives sanitizing');
  watch.createSubscription({
    subscriber_kind: 'agent',
    subscriber_id: 'a1',
    filter: { source: 'github', subjects: ['github:o/r#1'], types: ['comment.created', 'checks.completed', 'pull_request.merged'], ends_on: ['pull_request.merged'], since },
    note: 'PR #1 watch',
    by: 'a1',
  });

  // A comment older than the watch (the replay in S-795) is stored but not delivered.
  const old = watch.ingest({ source: 'github', type: 'comment.created', subjects: ['github:o/r#1'], payload: { at: '2026-10-14T16:22:00Z' }, summary: 'old comment', dedupe_key: 'c-old' });
  assert.equal(old.matched, 0, 'a change older than the watch does not reach the subscriber');
  assert.equal(watch.events({ subject: 'github:o/r#1' }).length, 1, 'but it is still stored');

  // The watcher's own review comment and the status it set are dropped (S-803).
  assert.equal(watch.ingest({ source: 'github', type: 'comment.created', subjects: ['github:o/r#1'], payload: { at: '2026-10-14T16:42:00Z', review_agent: 'a1' }, summary: 'Review (a1): approve. ok', dedupe_key: 'c-own' }).matched, 0, 'the watcher\'s own review comment');
  assert.equal(watch.ingest({ source: 'github', type: 'checks.completed', subjects: ['github:o/r#1'], payload: { at: '2026-10-14T16:42:30Z', review_agent: 'a1' }, summary: 'checks passed', dedupe_key: 'k-own' }).matched, 0, 'the status the watcher set');

  // Another agent's review, and a new comment, do reach it.
  assert.equal(watch.ingest({ source: 'github', type: 'comment.created', subjects: ['github:o/r#1'], payload: { at: '2026-10-14T16:43:00Z', review_agent: 'a2' }, summary: 'Review (a2): request_changes. rebase', dedupe_key: 'c-other' }).matched, 1, 'another agent\'s review');
  assert.equal(watch.ingest({ source: 'github', type: 'comment.created', subjects: ['github:o/r#1'], payload: { at: '2026-10-14T16:44:00Z' }, summary: 'a new comment', dedupe_key: 'c-new' }).matched, 1, 'a new comment');

  // A merge is always delivered even when it happened before the watch, and it ends the watch.
  assert.equal(watch.ingest({ source: 'github', type: 'pull_request.merged', subjects: ['github:o/r#1'], payload: { at: '2026-10-14T16:20:00Z' }, summary: 'merged 1', dedupe_key: 'm1' }).matched, 1, 'an ending event is always delivered');

  await watch.flush();
  const notice = mail.inTurnNotice('a1') ?? '';
  assert.doesNotMatch(notice, /old comment/, 'the older comment was not replayed');
  assert.doesNotMatch(notice, /Review \(a1\)/, 'the watcher\'s own review comment was not delivered');
  assert.doesNotMatch(notice, /checks passed/, 'the status the watcher set was not delivered');
  assert.match(notice, /Review \(a2\): request_changes/, 'another agent\'s review was delivered');
  assert.match(notice, /a new comment/, 'the new comment was delivered');
  assert.match(notice, /merged 1/, 'the merge was delivered');
});

test('watchedSubjects lists live subscription and event-wait subjects, distinct', async () => {
  standIn();
  agent('a1', 'alice');
  watch.createSubscription({ subscriber_kind: 'agent', subscriber_id: 'a1', filter: { source: 'github', subjects: ['github:o/r'] }, by: 'a1' });
  await waits.declare('a1', { on: 'event', filter: { subjects: ['github:o/r#12', 'github:o/r'] } });
  await itsa.create({ title: 'linked', by: 'human', owner: 'human', links: [{ url: 'https://github.com/o/r/issues/9' }] });
  assert.deepEqual(watch.watchedSubjects().sort(), ['github:o/r', 'github:o/r#12', 'github:o/r#9']);
});
