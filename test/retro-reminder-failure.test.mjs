#!/usr/bin/env node
// Retro reminders at the failure (S-726): the notices an agent gets right after something failed
// carry a one-line retro reminder when settings.retro.reminders.enabled, and not when it is off.
// Covers a denied permission and a PR failure (a red gate, a request_changes review, or a deploy
// that stopped) delivered to the agent watching the PR, but not the ITSA's copy of it. An
// agent-errored notice is left unchanged: its recipient is the parent, not the failing agent.
// Throwaway STAM_HOME, no daemon, no network: `node --test test/retro-reminder-failure.test.mjs`.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-retro-failure-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `retro-reminder-failure-${process.pid}`;
// Deliver by calling watch.flush() instead of waiting for the fold window.
process.env.STAM_EVENT_FOLD_MS = '60000';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

let db, mail, settings, templates, permissions, org, watch, itsa;

const agent = (id, fields = {}) =>
  db.createAgent({ id, name: id, role: 'dev', machine: 'x', harness: 'claude', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null, ...fields });
const save = (obj) => { writeFileSync(join(home, 'settings.json'), JSON.stringify(obj)); settings.settingsChanged(); };
const activity = (id, activity, detail) => db.updateAgent(id, { activity, ...(detail ? { activity_detail: detail } : {}) });
const REMINDER = /record what went wrong and at which step/;

before(async () => {
  db = await import('../src/db.ts');
  mail = await import('../src/mail.ts');
  settings = await import('../src/settings.ts');
  templates = await import('../src/templates.ts');
  permissions = await import('../src/permissions.ts');
  org = await import('../src/org.ts');
  watch = await import('../src/watch.ts');
  itsa = await import('../src/itsa.ts');
  db.open();
  // As the daemon does at start: activity observers, and an ITSA's link subscriptions.
  org.watchActivity();
  watch.watchItsa();
});
after(() => rmSync(home, { recursive: true, force: true }));

beforeEach(() => {
  const d = db.open();
  for (const t of ['permission_requests', 'agent_parents', 'agents', 'itsas', 'itsa_links', 'itsa_participants', 'itsa_events', 'ext_events', 'event_subscriptions', 'mail', 'mail_recipients', 'decision_mails', 'waits'])
    d.exec(`DELETE FROM ${t}`);
  save({});
});

test('the reminder follows retro.reminders.enabled', () => {
  assert.equal(settings.settings().retro.reminders.enabled, true);
  assert.match(templates.withFailureRetro('boom'), REMINDER);
  save({ retro: { reminders: { enabled: false } } });
  assert.equal(settings.settings().retro.reminders.enabled, false);
  assert.equal(templates.withFailureRetro('boom'), 'boom', 'off: the text is unchanged');
});

test('a denied permission notice carries the reminder; an approval does not', async () => {
  agent('perm-a');
  activity('perm-a', 'working');
  const denied = await permissions.requestPermission(db.getAgent('perm-a'), 'Run npm test', 'needed', 'details');
  await permissions.answerPermission(denied.id, false, 'human', 'Denied');
  assert.match(mail.inTurnNotice('perm-a') ?? '', REMINDER);

  const approved = await permissions.requestPermission(db.getAgent('perm-a'), 'Run npm test', 'needed', 'details');
  await permissions.answerPermission(approved.id, true, 'human', 'I authorize');
  const notice = mail.inTurnNotice('perm-a') ?? '';
  assert.match(notice, /was approved/);
  assert.doesNotMatch(notice, REMINDER, 'an approval is not a failure');
});

test('an agent-errored notice is unchanged: its recipient is the parent, which did not fail', () => {
  agent('err-p');
  activity('err-p', 'working');
  agent('err-k', { parent_id: 'err-p' });
  activity('err-k', 'errored', 'exit 1');
  const notice = mail.inTurnNotice('err-p') ?? '';
  assert.match(notice, /stopped with an error/, 'the parent still hears the error');
  assert.doesNotMatch(notice, REMINDER, 'no reminder: the notice is not the failing agent\'s');
});

test('isFailureEvent: a red gate, a changes-requested review, a stopped deploy, not a pass', () => {
  const ev = (type, summary) => ({ source: 'github', type, summary });
  assert.ok(watch.isFailureEvent(ev('checks.completed', 'PR #1 checks failed: stam/gates')));
  assert.ok(watch.isFailureEvent(ev('review.submitted', 'PR #1 reviewed (changes requested) by rev')));
  assert.ok(watch.isFailureEvent(ev('comment.created', 'PR #1 comment by stam: Deploy of 4823608 stopped: rolled back.')));
  assert.ok(!watch.isFailureEvent(ev('checks.completed', 'PR #1 checks passed')));
  assert.ok(!watch.isFailureEvent(ev('review.submitted', 'PR #1 reviewed (approved) by rev')));
  assert.ok(!watch.isFailureEvent(ev('pull_request.merged', 'PR #1 merged: x')));
  assert.ok(!watch.isFailureEvent({ source: 'linear', type: 'checks.completed', summary: 'checks failed' }));
});

test('a PR failure reaches its developer with the reminder, and its ITSA without one', async () => {
  agent('stand'); // mail stam sends on its own behalf
  agent('dev1');
  activity('dev1', 'working');
  const x = await itsa.create({ title: 'PR 1', by: 'human', owner: 'human', links: [{ url: 'https://github.com/o/r/pull/1' }] });
  watch.createSubscription({ subscriber_kind: 'agent', subscriber_id: 'dev1', filter: { source: 'github', subjects: ['github:o/r#1'], types: ['checks.completed', 'review.submitted', 'comment.created'] }, note: 'PR #1 watch', by: 'dev1' });

  watch.ingest({ source: 'github', type: 'checks.completed', subjects: ['github:o/r#1'], summary: 'PR #1 checks failed: stam/gates', url: 'https://gh/1', dedupe_key: 'c1' });
  await watch.flush();
  assert.match(mail.inTurnNotice('dev1') ?? '', REMINDER, 'the developer hears it');
  const itsaCopy = db.threadMail(itsa.must(x.id).thread_id).find((m) => /checks failed/.test(m.body));
  assert.ok(itsaCopy, 'the ITSA hears the event too');
  assert.doesNotMatch(itsaCopy.body, REMINDER, 'but the manager does not get the reminder');
});

test('a passing checks event and a disabled setting leave the notice alone', async () => {
  agent('stand');
  agent('dev2');
  activity('dev2', 'working');
  watch.createSubscription({ subscriber_kind: 'agent', subscriber_id: 'dev2', filter: { source: 'github', subjects: ['github:o/r#2'], types: ['checks.completed'] }, note: 'PR #2 watch', by: 'dev2' });

  watch.ingest({ source: 'github', type: 'checks.completed', subjects: ['github:o/r#2'], summary: 'PR #2 checks passed', dedupe_key: 'p1' });
  await watch.flush();
  assert.doesNotMatch(mail.inTurnNotice('dev2') ?? '', REMINDER, 'a pass is not a failure');

  save({ retro: { reminders: { enabled: false } } });
  watch.ingest({ source: 'github', type: 'checks.completed', subjects: ['github:o/r#2'], summary: 'PR #2 checks failed: stam/gates', dedupe_key: 'c2' });
  await watch.flush();
  const notice = mail.inTurnNotice('dev2') ?? '';
  assert.match(notice, /checks failed/);
  assert.doesNotMatch(notice, REMINDER, 'off: no reminder');
});
