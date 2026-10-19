#!/usr/bin/env node
// Unit tests for the Linear poller (S-56, src/sources/linear.ts) and its MCP client: the
// subject and the defensive parsing, the diff of one poll against the last snapshot (the
// first poll is silent, a change emits once with a key that names its time, a comment emits
// once), and a poll through a fake Linear MCP server (test/fixtures/fake-linear.mjs) with the
// login seeded in a temp STAM_HOME, including a server that rejects the bearer. Free: no
// daemon, no network beyond the fake, no real Linear. Run with
// `node --test test/linear-poller.test.mjs`.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-linear-');
process.env.STAM_HOME = home;
process.env.STAM_MCP_AUTH_INSECURE = '1';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE', 'STAM_GITHUB_TOKEN']) delete process.env[k];

let db, watch, linear, mcpClient, fakeLinear;

before(async () => {
  db = await import('../src/db.ts');
  watch = await import('../src/watch.ts');
  linear = await import('../src/sources/linear.ts');
  mcpClient = await import('../src/sources/mcp-client.ts');
  ({ startFakeLinear: fakeLinear } = await import('./fixtures/fake-linear.mjs'));
  db.open();
});
after(() => rmSync(home, { recursive: true, force: true }));

let fake;
beforeEach(async () => {
  for (const t of ['ext_events', 'event_subscriptions', 'watch_state']) db.open().exec(`DELETE FROM ${t}`);
  fake = await fakeLinear();
  mcpClient.resetSessions();
});
afterEach(async () => {
  await fake.close();
});

// Writes the settings (the `linear` MCP server, pointed at the fake) and a login for it.
function seedLogin({ token = 'good', serverUrl = fake.url } = {}) {
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ mcpServers: { linear: { url: serverUrl, auth: { type: 'oauth' } } } }, null, 2));
  const path = join(home, 'mcp-auth.json');
  writeFileSync(path, JSON.stringify({ linear: { server_url: serverUrl, client_id: 'stam', access_token: token, expires_at: Date.now() + 3_600_000, resource: serverUrl } }, null, 2));
  chmodSync(path, 0o600);
}

const issue = (over = {}) => ({ id: 'ENG-1', title: 'Fix login', url: 'https://linear.app/acme/issue/ENG-1/fix-login', state: { name: 'Todo' }, assignee: null, priority: { value: 2, name: 'High' }, updatedAt: '2026-10-11T10:00:00Z', ...over });

test('parseSubject: a team-prefixed issue is polled; a team is not yet', () => {
  assert.deepEqual(linear.parseSubject('linear:ENG-1'), { id: 'ENG-1' });
  assert.equal(linear.parseSubject('linear:team:ENG'), null);
  assert.equal(linear.parseSubject('github:o/r#1'), null);
});

test('normalizeIssue and normalizeComments read names, objects, and bare values defensively', () => {
  const n = linear.normalizeIssue({ issue: issue({ assignee: { displayName: 'Kim' }, priority: 3 }) }, 'ENG-1');
  assert.equal(n.state, 'Todo');
  assert.equal(n.assignee, 'Kim');
  assert.equal(n.priority, '3');
  assert.equal(linear.normalizeIssue({}, 'ENG-2').title, null);
  const c = linear.normalizeComments({ nodes: [{ id: 9, user: { name: 'bob' }, body: 'hi' }, { body: 'no id' }] });
  assert.deepEqual(c, [{ id: '9', author: 'bob', body: 'hi', createdAt: null }]);
});

test('diffIssue: the first poll is silent; each change emits once with a key that names its time', () => {
  const first = linear.normalizeIssue(issue(), 'ENG-1');
  const snap = { ...first, commentIds: [] };
  assert.deepEqual(linear.diffIssue('linear:ENG-1', null, first, []), [], 'the first poll is silent');
  assert.deepEqual(linear.diffIssue('linear:ENG-1', snap, first, []), [], 'no change, no event');

  const moved = linear.normalizeIssue(issue({ state: { name: 'In Progress' }, assignee: { name: 'Kim' }, priority: { name: 'Urgent', value: 1 }, title: 'Fix login now', updatedAt: '2026-10-11T11:00:00Z' }), 'ENG-1');
  const events = linear.diffIssue('linear:ENG-1', snap, moved, [{ id: '5', author: 'bob', body: 'on it\nmore', createdAt: null }]);
  assert.deepEqual(
    events.map((e) => e.type),
    ['issue.state_changed', 'issue.assigned', 'issue.priority_changed', 'issue.title_changed', 'comment.created'],
  );
  assert.equal(events[0].summary, 'ENG-1 state: Todo → In Progress');
  assert.equal(events[0].dedupe_key, 'issue.state_changed:linear:ENG-1:2026-10-11T11:00:00Z');
  assert.equal(events[4].dedupe_key, 'comment.created:linear:ENG-1:5');
  assert.equal(events[4].actor, 'bob');
  assert.deepEqual(events[0].subjects, ['linear:ENG-1']);
});

test('diffIssue: a comment the snapshot already holds emits nothing; a title rename emits', () => {
  const cur = linear.normalizeIssue(issue({ title: 'Fix login (renamed)' }), 'ENG-1');
  const prev = { ...linear.normalizeIssue(issue(), 'ENG-1'), commentIds: ['5'] };
  const events = linear.diffIssue('linear:ENG-1', prev, cur, [{ id: '5', author: 'bob', body: 'old', createdAt: null }]);
  assert.deepEqual(events.map((e) => e.type), ['issue.title_changed']);
});

test('pollIssue: polls through the fake Linear MCP server, and the snapshot carries the comment ids', async () => {
  seedLogin();
  fake.update({ issues: { 'ENG-1': issue() }, comments: { 'ENG-1': [{ id: 'c1', user: { name: 'bob' }, body: 'hello', createdAt: '2026-10-11T09:00:00Z' }] } });
  const first = await linear.pollIssue('linear:ENG-1', null);
  assert.deepEqual(first.events, [], 'the first poll is silent');
  assert.equal(first.state.state, 'Todo');
  assert.deepEqual(first.state.commentIds, ['c1']);

  fake.update({ issues: { 'ENG-1': issue({ state: { name: 'Done' }, updatedAt: '2026-10-11T12:00:00Z' }) }, comments: { 'ENG-1': [{ id: 'c1', user: { name: 'bob' }, body: 'hello' }, { id: 'c2', user: { name: 'kim' }, body: 'thanks' }] } });
  const second = await linear.pollIssue('linear:ENG-1', first.state);
  assert.deepEqual(second.events.map((e) => e.type), ['issue.state_changed', 'comment.created']);
  assert.equal(second.events[1].summary, 'ENG-1 comment by kim: thanks');
});

test('pollIssue: a server that rejects the bearer throws, so the tick keeps the old snapshot', async () => {
  seedLogin({ token: 'bad' });
  fake.update({ issues: { 'ENG-1': issue() } });
  await assert.rejects(linear.pollIssue('linear:ENG-1', null), /HTTP 401|not logged in|401/);
});

test('pollIssue: a server missing from settings throws', async () => {
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ mcpServers: {} }));
  await assert.rejects(linear.pollIssue('linear:ENG-1', null), /has no auth configured/);
});
