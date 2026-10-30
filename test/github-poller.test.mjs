#!/usr/bin/env node
// Unit tests for the GitHub poller (S-55, src/sources/github.ts) against a fake GitHub API
// (test/fixtures/fake-github.mjs): the first poll is silent, a new head synchronizes, checks
// go pending to failure, a review and a comment each emit once, a merge emits, unchanged
// polls take the 304 path, and a low rate limit backs the poller off. Free; a throwaway
// STAM_HOME, no daemon, no network beyond the fake. Run with
// `node --test test/github-poller.test.mjs`.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-github-');
process.env.STAM_HOME = home;
process.env.STAM_GITHUB_TOKEN = 'test-token';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

let db, watch, github, fakeGithub;

before(async () => {
  db = await import('../src/db.ts');
  watch = await import('../src/watch.ts');
  github = await import('../src/sources/github.ts');
  ({ startFakeGithub: fakeGithub } = await import('./fixtures/fake-github.mjs'));
  db.open();
});
after(() => rmSync(home, { recursive: true, force: true }));

let fake;
beforeEach(async () => {
  for (const t of ['ext_events', 'event_subscriptions', 'watch_state', 'waits', 'agents']) db.open().exec(`DELETE FROM ${t}`);
  db.createAgent({ id: 'a1', name: 'alice', role: 'dev', machine: 'x', harness: 'claude', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  fake = await fakeGithub();
  process.env.STAM_GITHUB_API = fake.url;
  github.resetBackoff();
});
afterEach(async () => {
  await fake.close();
});

// A PR #1 that is open on head `sha1`, with one in-progress check run.
function seedOpenPr(head = 'sha1') {
  fake.update({
    issues: { 'o/r#1': { number: 1, title: 'PR one', state: 'open', html_url: 'https://github.com/o/r/pull/1', user: { login: 'octocat' }, pull_request: { url: 'x' } } },
    pulls: { 'o/r#1': { number: 1, title: 'PR one', state: 'open', merged: false, draft: false, html_url: 'https://github.com/o/r/pull/1', user: { login: 'octocat' }, head: { sha: head, ref: 'feature' }, base: { ref: 'main' } } },
  });
}

// Polls and threads the snapshot/etags through, as the daemon's tick does.
async function poll(subject, held) {
  const r = await github.pollSubject(subject, held.state, held.etags, 'test-token');
  return { ...r, held: { state: r.state, etags: r.etags } };
}
const types = (r) => r.events.map((e) => e.type);

test('parseSubject: a repo, a pull request or issue, and nothing else', () => {
  assert.deepEqual(github.parseSubject('github:o/r'), { owner: 'o', repo: 'r', number: null, key: 'github:o/r', repoKey: 'github:o/r' });
  assert.equal(github.parseSubject('github:o/r#12').number, 12);
  assert.equal(github.parseSubject('github:o/*'), null, 'a glob is not pollable');
  assert.equal(github.parseSubject('linear:TEAM-1'), null);
});

test('checksState: none, pending, success, and failure with the failing names', () => {
  assert.deepEqual(github.checksState([], []), { state: 'none', failing: [] });
  assert.equal(github.checksState([{ name: 'build', status: 'in_progress', conclusion: null }], []).state, 'pending');
  assert.equal(github.checksState([{ name: 'build', status: 'completed', conclusion: 'success' }], [{ context: 'ci', state: 'success' }]).state, 'success');
  const fail = github.checksState([{ name: 'build', status: 'completed', conclusion: 'failure' }], [{ context: 'lint', state: 'failure' }]);
  assert.equal(fail.state, 'failure');
  assert.deepEqual(fail.failing.sort(), ['build', 'lint']);
});

test('the first poll records the snapshot silently; an unchanged poll takes the 304 path', async () => {
  seedOpenPr();
  fake.update({ checkRuns: { 'o/r@sha1': [{ name: 'build', status: 'in_progress', conclusion: null }] }, statuses: { 'o/r@sha1': { state: 'pending', statuses: [] } } });
  const first = await poll('github:o/r#1', { state: null, etags: {} });
  assert.deepEqual(first.events, [], 'the first poll of a watched PR emits nothing');
  assert.equal(first.state.type, 'pr');
  assert.equal(first.state.state, 'open');
  assert.equal(first.state.checks, 'pending');
  assert.equal(first.state.head, 'sha1');

  const before = fake.calls.length;
  const second = await poll('github:o/r#1', first.held);
  assert.deepEqual(second.events, [], 'nothing changed, so nothing is emitted');
  assert.ok(fake.calls.slice(before).some((c) => c.includes('/issues/1')), 'the poll still asked');
  assert.deepEqual(second.state, first.state, 'the snapshot is unchanged through the 304s');
});

test('a new head synchronizes, and its checks completing emit checks.completed', async () => {
  seedOpenPr();
  fake.update({ checkRuns: { 'o/r@sha1': [{ name: 'build', status: 'completed', conclusion: 'success' }] }, statuses: { 'o/r@sha1': { state: 'success', statuses: [] } } });
  const first = await poll('github:o/r#1', { state: null, etags: {} });
  assert.deepEqual(first.events, [], 'the first poll is silent');

  fake.update({ pulls: { 'o/r#1': { head: { sha: 'sha2', ref: 'feature' } } }, checkRuns: { 'o/r@sha2': [{ name: 'build', status: 'in_progress', conclusion: null }] }, statuses: { 'o/r@sha2': { state: 'pending', statuses: [] } } });
  const second = await poll('github:o/r#1', first.held);
  assert.ok(types(second).includes('pull_request.synchronize'), `new head: ${types(second)}`);
  assert.equal(second.state.checks, 'pending', 'the new head starts pending');
  assert.ok(!types(second).includes('checks.completed'), 'no checks.completed while pending');

  fake.update({ checkRuns: { 'o/r@sha2': [{ name: 'build', status: 'completed', conclusion: 'failure', completed_at: '2026-10-11T12:00:00Z' }] } });
  const third = await poll('github:o/r#1', second.held);
  const done = third.events.find((e) => e.type === 'checks.completed');
  assert.ok(done, `checks.completed expected: ${types(third)}`);
  assert.equal(done.dedupe_key, 'checks.completed:github:o/r#1:sha2:failure:2026-10-11T12:00:00Z');
  assert.match(done.summary, /failed: build/);
});

test('a review, a comment, and a merge each emit once with stable dedupe keys', async () => {
  seedOpenPr();
  fake.update({ checkRuns: { 'o/r@sha1': [{ name: 'build', status: 'completed', conclusion: 'success' }] }, statuses: { 'o/r@sha1': { state: 'success', statuses: [] } } });
  let held = (await poll('github:o/r#1', { state: null, etags: {} })).held;

  fake.update({ reviews: { 'o/r#1': [{ id: 7, state: 'APPROVED', user: { login: 'octocat' }, submitted_at: '2026-10-11T10:00:00Z' }] } });
  let r = await poll('github:o/r#1', held);
  const review = r.events.find((e) => e.type === 'review.submitted');
  assert.ok(review, `review.submitted expected: ${types(r)}`);
  assert.equal(review.dedupe_key, 'review.submitted:github:o/r#1:7');
  assert.equal(r.state.review, 'approved');
  held = r.held;

  fake.update({ comments: { 'o/r#1': [{ id: 9, user: { login: 'bob' }, body: 'please rebase\nmore', created_at: '2026-10-11T11:00:00Z', updated_at: '2026-10-11T11:00:00Z' }] } });
  r = await poll('github:o/r#1', held);
  const comment = r.events.find((e) => e.type === 'comment.created');
  assert.ok(comment, `comment.created expected: ${types(r)}`);
  assert.equal(comment.dedupe_key, 'comment.created:github:o/r#1:9');
  assert.match(comment.summary, /comment by bob: please rebase$/);
  held = r.held;

  fake.update({ issues: { 'o/r#1': { updated_at: '2026-10-11T14:00:00Z' } }, pulls: { 'o/r#1': { merged: true, state: 'closed' } } });
  r = await poll('github:o/r#1', held);
  const merged = r.events.find((e) => e.type === 'pull_request.merged');
  assert.ok(merged, `pull_request.merged expected: ${types(r)}`);
  assert.equal(merged.dedupe_key, 'pull_request.merged:github:o/r#1:2026-10-11T14:00:00Z');
  assert.equal(r.state.state, 'merged');

  // The merged event's subjects name the PR and its repo, and the actor is the GitHub login.
  assert.deepEqual(merged.subjects, ['github:o/r#1', 'github:o/r']);
  assert.equal(merged.actor, 'octocat');
});

test('an issue emits opened, closed, and reopened', async () => {
  // The number is watched before it exists: the first poll sees a 404 and records absence,
  // so a later open is `opened`.
  let held = (await poll('github:o/r#5', { state: null, etags: {} })).held;
  assert.equal(held.state.absent, true, 'a missing issue is recorded as absent');
  fake.update({ issues: { 'o/r#5': { number: 5, title: 'Bug', state: 'open', html_url: 'https://github.com/o/r/issues/5', user: { login: 'octocat' } } } });
  let r = await poll('github:o/r#5', held);
  assert.ok(types(r).includes('issue.opened'), `issue.opened expected: ${types(r)}`);
  held = r.held;
  fake.update({ issues: { 'o/r#5': { state: 'closed' } } });
  r = await poll('github:o/r#5', held);
  assert.ok(types(r).includes('issue.closed'), `issue.closed expected: ${types(r)}`);
  held = r.held;
  fake.update({ issues: { 'o/r#5': { state: 'open' } } });
  r = await poll('github:o/r#5', held);
  assert.ok(types(r).includes('issue.reopened'), `issue.reopened expected: ${types(r)}`);
});

test('a repository event emits once, mapped to a push with its branch and count', async () => {
  fake.update({ events: { 'o/r': [{ id: 100, type: 'PushEvent', actor: { login: 'octocat' }, payload: { ref: 'refs/heads/main', commits: [{}, {}] }, created_at: '2026-10-11T10:00:00Z' }] } });
  let held = (await poll('github:o/r', { state: null, etags: {} })).held;
  assert.deepEqual((await poll('github:o/r', held)).events, [], 'the first poll of a repo is silent');
  fake.update({ events: { 'o/r': [{ id: 101, type: 'PushEvent', actor: { login: 'octocat' }, payload: { ref: 'refs/heads/main', commits: [{}] }, created_at: '2026-10-11T11:00:00Z' }, ...fake.data.events['o/r']] } });
  const r = await poll('github:o/r', held);
  const push = r.events.find((e) => e.type === 'push');
  assert.ok(push, `push expected: ${types(r)}`);
  assert.match(push.summary, /1 commit to main/);
  assert.equal(push.dedupe_key, 'push:github:o/r:101');
});

test('tick ingests changes for watched subjects, and a low rate limit backs it off', async () => {
  seedOpenPr();
  fake.update({ checkRuns: { 'o/r@sha1': [{ name: 'build', status: 'completed', conclusion: 'success' }] }, statuses: { 'o/r@sha1': { state: 'success', statuses: [] } } });
  watch.createSubscription({ subscriber_kind: 'agent', subscriber_id: 'a1', filter: { subjects: ['github:o/r#1'] }, by: 'a1' });
  assert.deepEqual(watch.watchedSubjects(), ['github:o/r#1']);

  assert.equal(await github.tick(), 0, 'the first tick is silent');
  fake.update({ pulls: { 'o/r#1': { head: { sha: 'sha2' } } }, checkRuns: { 'o/r@sha2': [{ name: 'build', status: 'completed', conclusion: 'success' }] }, statuses: { 'o/r@sha2': { state: 'success', statuses: [] } } });

  // A low remaining count backs the next tick off before it polls.
  fake.update({ rate: { remaining: 100, reset: Math.floor(Date.now() / 1000) + 3600 } });
  const next = await github.tick();
  const afterBackoff = fake.calls.length;
  fake.update({ pulls: { 'o/r#1': { head: { sha: 'sha3' } } } });
  assert.equal(await github.tick(), 0, 'a backed-off tick does nothing');
  assert.equal(fake.calls.length, afterBackoff, 'a backed-off tick makes no request');
  assert.ok(!watch.events({ subject: 'github:o/r#1' }).some((e) => e.type === 'pull_request.synchronize' && String(e.summary).includes('sha3')), 'nothing was ingested while backed off');

  github.resetBackoff();
  fake.update({ rate: { remaining: 5000 } });
  const ingested = await github.tick();
  assert.ok(ingested >= 1, `the poll after the back-off ingests: ${ingested}`);
  assert.ok(watch.events({ subject: 'github:o/r#1' }).some((e) => e.type === 'pull_request.synchronize'), 'the new head reached watch.ingest');
});

test('stateFor returns a pull request’s fields and an issue’s, for the dashboard', async () => {
  seedOpenPr();
  fake.update({ checkRuns: { 'o/r@sha1': [{ name: 'build', status: 'completed', conclusion: 'success' }] }, statuses: { 'o/r@sha1': { state: 'success', statuses: [] } }, reviews: { 'o/r#1': [{ id: 1, state: 'APPROVED', user: { login: 'octocat' }, submitted_at: '2026-10-11T10:00:00Z' }] } });
  db.setWatchState('github:o/r#1', (await poll('github:o/r#1', { state: null, etags: {} })).state, {});
  const view = github.stateFor(['github:o/r#1', 'github:o/r#9']);
  assert.equal(view['github:o/r#1'].state, 'open');
  assert.equal(view['github:o/r#1'].draft, false);
  assert.equal(view['github:o/r#1'].checks, 'success');
  assert.equal(view['github:o/r#1'].review, 'approved');
  assert.equal(view['github:o/r#1'].head, 'sha1');
  assert.equal(view['github:o/r#1'].base, 'main');
  assert.equal(view['github:o/r#1'].title, 'PR one');
  assert.ok(view['github:o/r#1'].updated_at, 'updated_at is set');
  assert.deepEqual(view['github:o/r#9'], { updated_at: null });
});

test('a change again later is a new event: close, reopen, and close again emit three', async () => {
  // Each change moves the issue's updated_at, so the dedupe key names the change, not just the type.
  let held = (await poll('github:o/r#6', { state: null, etags: {} })).held;
  fake.update({ issues: { 'o/r#6': { number: 6, title: 'Flaky', state: 'open', updated_at: '2026-10-11T10:00:00Z', html_url: 'https://github.com/o/r/issues/6', user: { login: 'octocat' } } } });
  held = (await poll('github:o/r#6', held)).held;
  const events = [];
  for (const [state, at] of [['closed', '2026-10-11T11:00:00Z'], ['open', '2026-10-11T12:00:00Z'], ['closed', '2026-10-11T13:00:00Z']]) {
    fake.update({ issues: { 'o/r#6': { state, updated_at: at } } });
    const r = await poll('github:o/r#6', held);
    events.push(...r.events);
    held = r.held;
  }
  assert.deepEqual(types({ events }), ['issue.closed', 'issue.reopened', 'issue.closed']);
  assert.equal(new Set(events.map((e) => e.dedupe_key)).size, 3, 'each change has its own key');
});

test('checks fail, a re-run fails again: two checks.completed, each with its own key', async () => {
  seedOpenPr();
  fake.update({ checkRuns: { 'o/r@sha1': [{ name: 'build', status: 'completed', conclusion: 'failure', completed_at: '2026-10-11T10:00:00Z' }] }, statuses: { 'o/r@sha1': { state: 'success', statuses: [] } } });
  let held = (await poll('github:o/r#1', { state: null, etags: {} })).held;
  // The fake's PR is unchanged until the check's completed_at moves, so the first failure is the first poll after the silent one.
  fake.update({ checkRuns: { 'o/r@sha1': [{ name: 'build', status: 'in_progress', conclusion: null }] } });
  held = (await poll('github:o/r#1', held)).held;
  fake.update({ checkRuns: { 'o/r@sha1': [{ name: 'build', status: 'completed', conclusion: 'failure', completed_at: '2026-10-11T10:00:00Z' }] } });
  const first = await poll('github:o/r#1', held);
  held = first.held;
  fake.update({ checkRuns: { 'o/r@sha1': [{ name: 'build', status: 'in_progress', conclusion: null }] } });
  held = (await poll('github:o/r#1', held)).held;
  fake.update({ checkRuns: { 'o/r@sha1': [{ name: 'build', status: 'completed', conclusion: 'failure', completed_at: '2026-10-11T11:00:00Z' }] } });
  const again = await poll('github:o/r#1', held);
  const done = [...first.events, ...again.events].filter((e) => e.type === 'checks.completed');
  assert.equal(done.length, 2, `two checks.completed expected: ${types({ events: [...first.events, ...again.events] })}`);
  assert.notEqual(done[0].dedupe_key, done[1].dedupe_key);
});

test('a busy repo: page 1 all new reads page 2, each event emits once, and a 304 on page 1 fetches nothing more', async () => {
  // Two events a page: page 1 is all new, so page 2 is read; its last event is the old one, so the read stops there.
  const ev = (id) => ({ id, type: 'PushEvent', actor: { login: 'octocat' }, payload: { ref: 'refs/heads/main', commits: [{}] }, created_at: '2026-10-11T10:00:00Z' });
  fake.update({ pageSize: 2, events: { 'o/r': [ev(100)] } });
  let held = (await poll('github:o/r', { state: null, etags: {} })).held;
  assert.equal(held.state.lastEventId, 100);
  fake.update({ events: { 'o/r': [ev(103), ev(102), ev(101), ev(100)] } });
  const before = fake.calls.length;
  const r = await poll('github:o/r', held);
  assert.deepEqual(r.events.map((e) => e.dedupe_key).sort(), ['push:github:o/r:101', 'push:github:o/r:102', 'push:github:o/r:103'], 'every new event once, none at or below lastEventId');
  assert.equal(r.state.lastEventId, 103);
  assert.ok(fake.calls.slice(before).some((c) => c.includes('page=2')), 'page 2 was read');
  held = r.held;

  const mid = fake.calls.length;
  const again = await poll('github:o/r', held);
  assert.deepEqual(again.events, [], 'nothing new, so nothing emitted');
  assert.deepEqual(fake.calls.slice(mid), ['GET /repos/o/r/events?per_page=100&page=1'], 'a 304 on page 1 fetches nothing more');
});

test('commit statuses alone (no check runs) emit checks.completed, and a re-run that fails again emits again', async () => {
  // Our gates post commit statuses (stam/gates, stam/review) and no check runs; each status has its own timestamp.
  seedOpenPr();
  const status = (state, at) => ({ state, statuses: [{ context: 'stam/gates', state, updated_at: at, created_at: at }] });
  fake.update({ statuses: { 'o/r@sha1': status('pending', '2026-10-11T10:00:00Z') } });
  let held = (await poll('github:o/r#1', { state: null, etags: {} })).held;
  assert.equal(held.state.checks, 'pending');

  fake.update({ statuses: { 'o/r@sha1': status('success', '2026-10-11T10:05:00Z') } });
  let r = await poll('github:o/r#1', held);
  assert.ok(types(r).includes('checks.completed'), `a success status alone fires checks.completed: ${types(r)}`);
  assert.match(r.events.find((e) => e.type === 'checks.completed').summary, /checks passed/);
  held = r.held;

  // A re-run of the gate on the same head: failure, then pending, then failure again.
  fake.update({ statuses: { 'o/r@sha1': status('failure', '2026-10-11T10:10:00Z') } });
  r = await poll('github:o/r#1', held);
  held = r.held;
  fake.update({ statuses: { 'o/r@sha1': status('pending', '2026-10-11T10:11:00Z') } });
  held = (await poll('github:o/r#1', held)).held;
  fake.update({ statuses: { 'o/r@sha1': status('failure', '2026-10-11T10:12:00Z') } });
  r = await poll('github:o/r#1', held);
  const again = r.events.find((e) => e.type === 'checks.completed');
  assert.ok(again, `the second failure fires too: ${types(r)}`);
  assert.match(again.summary, /checks failed: stam\/gates/);
  assert.match(again.dedupe_key, /2026-10-11T10:12:00Z$/, 'the key names this status, so it is not dropped as a duplicate');
});

test('a 304 on check runs or statuses keeps that side as the snapshot saw it, so no spurious checks.completed', async () => {
  seedOpenPr();
  fake.update({
    checkRuns: { 'o/r@sha1': [{ name: 'build', status: 'in_progress', conclusion: null }] },
    statuses: { 'o/r@sha1': { state: 'pending', statuses: [{ context: 'stam/gates', state: 'pending', updated_at: '2026-10-13T10:00:00Z', created_at: '2026-10-13T10:00:00Z' }] } },
  });
  let held = (await poll('github:o/r#1', { state: null, etags: {} })).held;
  assert.equal(held.state.checks, 'pending');

  // Only the check run changes: it passes. The statuses 304, and the gate is still pending.
  fake.update({ checkRuns: { 'o/r@sha1': [{ name: 'build', status: 'completed', conclusion: 'success', completed_at: '2026-10-13T10:01:00Z' }] } });
  let r = await poll('github:o/r#1', held);
  assert.deepEqual(types(r), [], `the gate is still pending, so nothing fires: ${types(r)}`);
  assert.equal(r.state.checks, 'pending', 'the 304 side is not counted as empty');
  held = r.held;

  // Now the gate passes: the statuses return 200, the check runs 304, and checks.completed fires once.
  fake.update({ statuses: { 'o/r@sha1': { state: 'success', statuses: [{ context: 'stam/gates', state: 'success', updated_at: '2026-10-13T10:02:00Z', created_at: '2026-10-13T10:02:00Z' }] } } });
  r = await poll('github:o/r#1', held);
  assert.equal(r.events.filter((e) => e.type === 'checks.completed').length, 1, `one checks.completed: ${types(r)}`);
  assert.equal(r.state.checks, 'success');
});

test('a comment carries when it happened, and a review comment names the agent that posted it (S-795, S-803)', async () => {
  seedOpenPr();
  fake.update({ checkRuns: { 'o/r@sha1': [{ name: 'build', status: 'completed', conclusion: 'success' }] }, statuses: { 'o/r@sha1': { state: 'success', statuses: [] } } });
  let held = (await poll('github:o/r#1', { state: null, etags: {} })).held;

  // Every agent posts as one GitHub account; the review script's text names the stam agent.
  fake.update({ comments: { 'o/r#1': [
    { id: 9, user: { login: 'octocat' }, body: 'please rebase', created_at: '2026-10-11T11:00:00Z', updated_at: '2026-10-11T11:00:00Z' },
    { id: 10, user: { login: 'octocat' }, body: 'Review (aminj): request_changes. not yet', created_at: '2026-10-11T11:05:00Z', updated_at: '2026-10-11T11:05:00Z' },
  ] } });
  const r = await poll('github:o/r#1', held);
  const comments = r.events.filter((e) => e.type === 'comment.created');
  assert.equal(comments.length, 2, `two comments expected: ${types(r)}`);
  assert.deepEqual(comments[0].payload, { at: '2026-10-11T11:00:00Z', review_agent: null }, 'a plain comment names no agent');
  assert.deepEqual(comments[1].payload, { at: '2026-10-11T11:05:00Z', review_agent: 'aminj' }, 'a review comment names its author');
});

test('a checks.completed its own stam/review status made names that agent; a gate failure does not (S-803)', async () => {
  seedOpenPr();
  const status = (context, state, at, description) => ({ context, state, description, updated_at: at, created_at: at });
  const gates = (state, at) => status('stam/gates', state, at);
  const review = (agent, state, at) => status('stam/review', state, at, `Review (${agent}): approve. ok`);
  const combined = (statuses) => ({ state: statuses.some((s) => s.state !== 'success') ? 'failure' : 'success', statuses });

  // The gates passed earlier, so the reviewer's own verdict status is the newest when it lands.
  fake.update({ statuses: { 'o/r@sha1': combined([gates('success', '2026-10-11T10:00:00Z')]) } });
  let held = (await poll('github:o/r#1', { state: null, etags: {} })).held;
  assert.equal(held.state.checksAt, '2026-10-11T10:00:00Z');

  fake.update({ statuses: { 'o/r@sha1': combined([gates('success', '2026-10-11T10:00:00Z'), review('aminj', 'success', '2026-10-11T10:05:00Z')]) } });
  let r = await poll('github:o/r#1', held);
  const own = r.events.find((e) => e.type === 'checks.completed');
  assert.ok(own, `checks.completed expected: ${types(r)}`);
  assert.deepEqual(own.payload, { at: '2026-10-11T10:05:00Z', review_agent: 'aminj', head: 'sha1', verdict: 'approve' }, 'the agent that posted the review status, the head, and the verdict it carries (S-948)');
  held = r.held;

  // A gate fails on the same head: real news, so no agent is named and everyone hears it.
  fake.update({ statuses: { 'o/r@sha1': combined([gates('failure', '2026-10-11T10:10:00Z'), review('aminj', 'success', '2026-10-11T10:05:00Z')]) } });
  r = await poll('github:o/r#1', held);
  const gate = r.events.find((e) => e.type === 'checks.completed');
  assert.ok(gate, `checks.completed expected: ${types(r)}`);
  assert.equal(gate.payload.review_agent, null, 'a gate failure is not the watcher\'s own review');
  assert.equal(gate.payload.verdict, 'approve', 'the review status on the head still carries its verdict');
});

test('a PR the first poll finds open mirrors once; a later poll with the same head does not; a reopen mirrors again (S-1363)', async () => {
  // Opened with `gh pr create` before the watch began: no pull_request.opened event, only the first poll sees it.
  seedOpenPr();
  const first = await poll('github:o/r#1', { state: null, etags: {} });
  assert.deepEqual(first.events, [], 'the first poll of a watched PR emits nothing');
  assert.equal(github.mirrorsHead(null, first), true, 'the first poll of an open PR with a head mirrors');

  const second = await poll('github:o/r#1', first.held);
  assert.equal(github.mirrorsHead(first.state, second), false, 'a later poll with the same head does not mirror again');

  fake.update({ pulls: { 'o/r#1': { state: 'closed' } } });
  const closed = await poll('github:o/r#1', second.held);
  assert.equal(github.mirrorsHead(second.state, closed), false, 'a close does not mirror');

  fake.update({ pulls: { 'o/r#1': { state: 'open' } } });
  const reopened = await poll('github:o/r#1', closed.held);
  assert.ok(types(reopened).includes('pull_request.reopened'), `pull_request.reopened expected: ${types(reopened)}`);
  assert.equal(github.mirrorsHead(closed.state, reopened), true, 'a reopen mirrors');
});

test('a first poll of a closed PR or an issue does not mirror', async () => {
  fake.update({ pulls: { 'o/r#1': { number: 1, title: 'PR one', state: 'closed', merged: false, draft: false, html_url: 'https://github.com/o/r/pull/1', user: { login: 'octocat' }, head: { sha: 'sha1', ref: 'feature' }, base: { ref: 'main' } } }, issues: { 'o/r#1': { number: 1, title: 'PR one', state: 'closed', html_url: 'https://github.com/o/r/pull/1', user: { login: 'octocat' }, pull_request: { url: 'x' } } } });
  const closed = await poll('github:o/r#1', { state: null, etags: {} });
  assert.equal(github.mirrorsHead(null, closed), false, 'a closed PR is not mirrored on first sight');
  assert.equal(github.mirrorsHead(null, { events: [], state: { type: 'issue', state: 'open' } }), false, 'an issue has no head to mirror');
});

test('a new head whose status fetch fails keeps nothing of the old head: no copied verdict (S-1917)', async () => {
  seedOpenPr('sha1');
  const rev = { context: 'stam/review', state: 'success', description: 'Review (rev-1): approve. fine', updated_at: '2026-10-19T10:00:00Z', created_at: '2026-10-19T10:00:00Z' };
  fake.update({ statuses: { 'o/r@sha1': { state: 'success', statuses: [rev] } } });
  let held = (await poll('github:o/r#1', { state: null, etags: {} })).held;
  assert.equal(held.state.checksHead, 'sha1');
  assert.equal(github.reviewVerdict(held.state.headStatuses), 'approve');
  // A push, and the new head's check calls fail: the snapshot moves to sha2 with nothing, not sha1's approve.
  seedOpenPr('sha2');
  fake.update({ failChecks: { 'o/r@sha2': true } });
  let r = await poll('github:o/r#1', held);
  assert.equal(r.state.checksHead, 'sha2');
  assert.deepEqual(r.state.headStatuses, []);
  assert.equal(github.reviewVerdict(r.state.headStatuses), null);
  // Same head, a later failed fetch still keeps what the snapshot saw of it.
  fake.update({ failChecks: { 'o/r@sha2': false }, statuses: { 'o/r@sha2': { state: 'success', statuses: [{ ...rev, updated_at: '2026-10-19T11:00:00Z' }] } } });
  held = (await poll('github:o/r#1', r.held)).held;
  assert.equal(github.reviewVerdict(held.state.headStatuses), 'approve');
  fake.update({ failChecks: { 'o/r@sha2': true } });
  r = await poll('github:o/r#1', held);
  assert.equal(github.reviewVerdict(r.state.headStatuses), 'approve');
});

test('a new head whose status fetch fails but whose check runs pass is not "checks passed" (S-1918)', async () => {
  seedOpenPr('sha1');
  let held = (await poll('github:o/r#1', { state: null, etags: {} })).held;
  // A push: sha2's check runs all pass, but its status call fails, so the status list is unknown.
  seedOpenPr('sha2');
  fake.update({ checkRuns: { 'o/r@sha2': [{ name: 'build', status: 'completed', conclusion: 'success', completed_at: '2026-10-19T10:00:00Z' }] }, failStatus: { 'o/r@sha2': true } });
  let r = await poll('github:o/r#1', held);
  assert.equal(r.state.checksHead, 'sha2');
  assert.equal(r.state.checks, 'pending', 'the run list alone is no pass');
  assert.ok(!types(r).includes('checks.completed'), `no early pass: ${types(r)}`);
  // The same head again, the status still failing: still nothing.
  r = await poll('github:o/r#1', r.held);
  assert.ok(!types(r).includes('checks.completed'));
  // The status list comes back with a pending gate: pending; then it passes and the pass is emitted once.
  const gate = (state, at) => ({ state, statuses: [{ context: 'stam/gates', state, updated_at: at, created_at: at }] });
  fake.update({ failStatus: { 'o/r@sha2': false }, statuses: { 'o/r@sha2': gate('success', '2026-10-19T10:05:00Z') } });
  r = await poll('github:o/r#1', r.held);
  assert.equal(r.state.checks, 'success');
  assert.deepEqual(types(r).filter((t) => t === 'checks.completed'), ['checks.completed']);
  // A later failed status fetch on this head keeps what was seen of it: known, still a pass, no second event.
  fake.update({ failStatus: { 'o/r@sha2': true } });
  r = await poll('github:o/r#1', r.held);
  assert.equal(r.state.checks, 'success');
  assert.ok(!types(r).includes('checks.completed'));
});


// S-4356: a tick logs one line of its requests, by endpoint family, as 200s, 304s and failures. The counts are exact.
function captureTick(fn) {
  const lines = [];
  const log = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  return fn().finally(() => {
    console.log = log;
  }).then((ret) => ({ ret, lines: lines.filter((l) => l.startsWith('github calls: ')) }));
}

test('family names each endpoint (S-4356)', () => {
  assert.equal(github.family('/repos/o/r/pulls/3'), 'pulls');
  assert.equal(github.family('/repos/o/r/pulls/3/reviews'), 'reviews');
  assert.equal(github.family('/repos/o/r/commits/abc/check-runs'), 'check-runs');
  assert.equal(github.family('/repos/o/r/commits/abc/status'), 'status');
  assert.equal(github.family('/repos/o/r/issues/3/comments?since=x'), 'comments');
  assert.equal(github.family('/repos/o/r/events?per_page=100&page=1'), 'events');
  assert.equal(github.family('/repos/o/r/contents/x'), 'other');
});

test('a tick logs exact counts: 200s on the first poll, 304s on an unchanged one (S-4356)', async () => {
  seedOpenPr();
  fake.update({ checkRuns: { 'o/r@sha1': [{ name: 'build', status: 'completed', conclusion: 'success' }] }, statuses: { 'o/r@sha1': { state: 'success', statuses: [] } } });
  watch.createSubscription({ subscriber_kind: 'agent', subscriber_id: 'a1', filter: { subjects: ['github:o/r#1'] }, by: 'a1' });
  const first = await captureTick(() => github.tick());
  assert.equal(first.lines.length, 1, 'one line for the tick');
  const callsFirst = fake.calls.length;
  assert.equal(first.lines[0], `github calls: subjects=1 requests=${callsFirst} other 1/0/0, pulls 1/0/0, check-runs 1/0/0, status 1/0/0, reviews 1/0/0, comments 1/0/0`);
  const second = await captureTick(() => github.tick());
  assert.equal(second.lines.length, 1, 'one line for the second tick');
  assert.equal(second.lines[0], `github calls: subjects=1 requests=${fake.calls.length - callsFirst} other 0/1/0, pulls 0/1/0, check-runs 0/1/0, status 0/1/0, reviews 0/1/0, comments 0/1/0`);
});

test('a fetch that never answers counts as a failure, and the tick still logs (S-4356)', async () => {
  seedOpenPr();
  watch.createSubscription({ subscriber_kind: 'agent', subscriber_id: 'a1', filter: { subjects: ['github:o/r#1'] }, by: 'a1' });
  const alive = process.env.STAM_GITHUB_API;
  process.env.STAM_GITHUB_API = 'http://127.0.0.1:1';
  try {
    const r = await captureTick(() => github.tick());
    assert.equal(r.ret, 0, 'the failed poll ingests nothing');
    assert.deepEqual(r.lines, ['github calls: subjects=1 requests=1 other 0/0/1']);
  } finally {
    process.env.STAM_GITHUB_API = alive;
  }
});

test('overlapping ticks each count only their own requests (S-4356)', async () => {
  seedOpenPr();
  fake.update({ checkRuns: { 'o/r@sha1': [{ name: 'build', status: 'completed', conclusion: 'success' }] }, statuses: { 'o/r@sha1': { state: 'success', statuses: [] } } });
  watch.createSubscription({ subscriber_kind: 'agent', subscriber_id: 'a1', filter: { subjects: ['github:o/r#1'] }, by: 'a1' });
  const before = fake.calls.length;
  const both = await captureTick(() => Promise.all([github.tick(), github.tick()]));
  assert.equal(both.lines.length, 2, 'each tick logs its own line');
  const requests = both.lines.map((l) => Number(/requests=(\d+)/.exec(l)[1]));
  for (const [i, line] of both.lines.entries()) {
    const parts = [...line.matchAll(/([a-z-]+) (\d+)\/(\d+)\/(\d+)/g)];
    const sum = parts.reduce((n, m) => n + Number(m[2]) + Number(m[3]) + Number(m[4]), 0);
    assert.equal(sum, requests[i], `line ${i} counts its own families: ${line}`);
  }
  assert.equal(requests[0] + requests[1], fake.calls.length - before, 'the two lines together count every request made');
});

test('a log sink that throws does not fail the tick (S-4356)', async () => {
  seedOpenPr();
  watch.createSubscription({ subscriber_kind: 'agent', subscriber_id: 'a1', filter: { subjects: ['github:o/r#1'] }, by: 'a1' });
  const log = console.log;
  console.log = () => {
    throw new Error('sink down');
  };
  try {
    assert.equal(await github.tick(), 0, 'the tick resolves with its count');
  } finally {
    console.log = log;
  }
});
