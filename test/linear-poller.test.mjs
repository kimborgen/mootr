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
  // The agent that holds the team subscriptions below (a subscription needs its subscriber to exist).
  db.createAgent({ id: 'a1', name: 'alice', role: 'dev', machine: 'x', harness: 'claude', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
});
after(() => rmSync(home, { recursive: true, force: true }));

let fake;
beforeEach(async () => {
  for (const t of ['ext_events', 'event_subscriptions', 'watch_state']) db.open().exec(`DELETE FROM ${t}`);
  fake = await fakeLinear();
  mcpClient.resetSessions();
  linear.resetBackoff();
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

test('parseSubject: an issue; parseTeamSubject: a team, its key uppercased', () => {
  assert.deepEqual(linear.parseSubject('linear:ENG-1'), { id: 'ENG-1' });
  assert.equal(linear.parseSubject('linear:team:ENG'), null);
  assert.equal(linear.parseSubject('github:o/r#1'), null);
  assert.deepEqual(linear.parseTeamSubject('linear:team:eng'), { key: 'ENG' });
  assert.equal(linear.parseTeamSubject('linear:team:'), null);
  assert.equal(linear.parseTeamSubject('linear:ENG-1'), null);
});

test('normalizeIssue and normalizeComments read names, objects, and bare values defensively', () => {
  const n = linear.normalizeIssue({ issue: issue({ assignee: { displayName: 'Dana' }, priority: 3 }) }, 'ENG-1');
  assert.equal(n.state, 'Todo');
  assert.equal(n.assignee, 'Dana');
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

  const moved = linear.normalizeIssue(issue({ state: { name: 'In Progress' }, assignee: { name: 'Dana' }, priority: { name: 'Urgent', value: 1 }, title: 'Fix login now', updatedAt: '2026-10-11T11:00:00Z' }), 'ENG-1');
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

  fake.update({ issues: { 'ENG-1': issue({ state: { name: 'Done' }, updatedAt: '2026-10-11T12:00:00Z' }) }, comments: { 'ENG-1': [{ id: 'c1', user: { name: 'bob' }, body: 'hello' }, { id: 'c2', user: { name: 'octocat' }, body: 'thanks' }] } });
  const second = await linear.pollIssue('linear:ENG-1', first.state);
  assert.deepEqual(second.events.map((e) => e.type), ['issue.state_changed', 'comment.created']);
  assert.equal(second.events[1].summary, 'ENG-1 comment by octocat: thanks');
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

// ---- a team (linear:team:KEY) ----

// Changes are dated after the test starts (T0, ten minutes out), so each lands after the team's
// cursor, which its first poll sets to now. OLD is history from before that first poll.
const T0 = Date.now() + 600_000;
const at = (ms) => new Date(T0 + ms).toISOString();
const OLD = '2026-10-11T10:00:00.000Z';
// An issue of team ENG, numbered n, changed at at(n). Created before any poll, so its first sight is never a creation.
const teamIssue = (n, over = {}) =>
  issue({ id: `ENG-${n}`, title: `Issue ${n}`, url: `https://linear.app/acme/issue/ENG-${n}`, updatedAt: at(n), createdAt: OLD, ...over });
const subscribeTeam = (subject = 'linear:team:ENG') => watch.createSubscription({ subscriber_kind: 'agent', subscriber_id: 'a1', filter: { source: 'linear', subjects: [subject] }, by: 'a1' });
const subscribeIssue = (subject) => watch.createSubscription({ subscriber_kind: 'agent', subscriber_id: 'a1', filter: { source: 'linear', subjects: [subject] }, by: 'a1' });
const eventsOf = (type) => watch.events({ limit: 500 }).filter((e) => e.type === type);
const cursorOf = (subject) => JSON.parse(db.getWatchState(subject).state).cursor;
const bulk = (count, over = () => ({})) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`ENG-${i + 1}`, teamIssue(i + 1, over(i + 1))]));
const c1 = { id: 'c1', user: { name: 'bob' }, body: 'hi' };
const c2 = { id: 'c2', user: { name: 'octocat' }, body: 'thanks' };
// Ticks until a long catch-up is through: ten comment calls a tick, so a team of 120 takes about 13.
const drain = async () => {
  for (let i = 0; i < 30; i++) await linear.tick();
};

test('a team: the first poll sets its cursor and baseline to now, and lists no history', async () => {
  seedLogin();
  subscribeTeam();
  fake.update({ issues: { 'ENG-1': teamIssue(1, { updatedAt: OLD }), 'ENG-2': teamIssue(2, { updatedAt: OLD }) } });
  assert.equal(await linear.tick(), 0);
  assert.equal(db.watchStateSubjects('linear:team:ENG/').length, 0, 'no issue is read on the first poll');
  const row = JSON.parse(db.getWatchState('linear:team:ENG').state);
  assert.equal(row.cursor, row.baseline, 'the cursor starts at the baseline');
  assert.ok(row.cursor > OLD, 'the baseline is now, after the history');
});

test('a team: a change after the first poll emits issue.updated, then state and comment changes', async () => {
  seedLogin();
  subscribeTeam();
  fake.update({ issues: { 'ENG-1': teamIssue(1, { updatedAt: OLD }) }, comments: { 'ENG-1': [c1] } });
  await linear.tick();
  fake.update({ issues: { 'ENG-1': teamIssue(1) }, comments: { 'ENG-1': [c1] } });
  assert.equal(await linear.tick(), 1);
  const [updated] = eventsOf('issue.updated');
  assert.deepEqual(updated.subjects, ['linear:team:ENG']);
  assert.deepEqual(updated.payload, { issue: 'linear:ENG-1' });
  assert.deepEqual(JSON.parse(db.getWatchState('linear:team:ENG/ENG-1').state).commentIds, ['c1'], 'its comments are seen');

  fake.update({ issues: { 'ENG-1': teamIssue(1, { state: { name: 'Done' }, updatedAt: at(2) }) }, comments: { 'ENG-1': [c1, c2] } });
  assert.equal(await linear.tick(), 2);
  const [state] = eventsOf('issue.state_changed');
  assert.deepEqual(state.subjects, ['linear:team:ENG']);
  assert.deepEqual(state.payload, { issue: 'linear:ENG-1' });
  assert.equal(state.dedupe_key, `issue.state_changed:linear:team:ENG:linear:ENG-1:${at(2)}`);
  assert.equal(state.summary, 'ENG-1 state: Todo → Done');
  assert.equal(eventsOf('comment.created').length, 1, 'only c2, which is new');

  assert.equal(await linear.tick(), 0, 'a tick with nothing new emits nothing');
  assert.equal(eventsOf('comment.created').length, 1, 'no duplicate after the next tick');
});

test('a team: an issue created after the first poll emits issue.created, not issue.updated', async () => {
  seedLogin();
  subscribeTeam();
  await linear.tick();
  fake.update({ issues: { 'ENG-2': teamIssue(2, { createdAt: at(2), updatedAt: at(2) }) } });
  assert.equal(await linear.tick(), 1);
  const [created] = eventsOf('issue.created');
  assert.deepEqual(created.subjects, ['linear:team:ENG']);
  assert.deepEqual(created.payload, { issue: 'linear:ENG-2' });
  assert.equal(created.summary, 'ENG-2 created: Issue 2');
  assert.equal(eventsOf('issue.updated').length, 0);
});

test('a team: ten or more issues at one updatedAt cannot stall the cursor; a newer change still lands', async () => {
  seedLogin();
  subscribeTeam();
  await linear.tick();
  // Snapshot twelve issues first, so the bulk edit below is a set of real state changes.
  fake.update({ issues: bulk(12, () => ({ updatedAt: at(1) })) });
  await drain();
  assert.equal(db.watchStateSubjects('linear:team:ENG/').length, 12);
  fake.update({
    issues: { ...bulk(12, () => ({ state: { name: 'Done' }, updatedAt: at(5) })), 'ENG-1': teamIssue(1, { title: 'Renamed', state: { name: 'Done' }, updatedAt: at(9) }) },
  });
  let renamed = 0;
  for (let t = 0; t < 6 && renamed === 0; t++) {
    await linear.tick();
    renamed = eventsOf('issue.title_changed').length;
  }
  assert.equal(renamed, 1, 'the newer change emits within a few ticks');
  assert.equal(eventsOf('issue.state_changed').length, 12, 'each bulk change emits once');
});

test('a team: changes never snapshotted emit issue.updated, past the first poll cap of ten', async () => {
  seedLogin();
  subscribeTeam();
  await linear.tick();
  fake.update({ issues: bulk(15) });
  await drain();
  assert.equal(eventsOf('issue.updated').length, 15, 'every change emits, including the five past the cap');
});

test('a team: every page is read, whichever order Linear lists them in', async () => {
  seedLogin();
  subscribeTeam();
  await linear.tick();
  fake.update({ teamOrder: 'desc', issues: bulk(120) });
  await drain();
  assert.equal(db.watchStateSubjects('linear:team:ENG/').length, 120, 'all 120 across three newest-first pages');
  fake.update({ issues: { 'ENG-1': teamIssue(1, { state: { name: 'Done' }, updatedAt: at(500) }) } });
  assert.equal(await linear.tick(), 1, 'the oldest issue in the list still emits');
  assert.equal(eventsOf('issue.state_changed').length, 1);
});

test('a team and its issue each keep their own event: an issue-only subscriber hears a change once', async () => {
  seedLogin();
  subscribeTeam();
  subscribeIssue('linear:ENG-1');
  await linear.tick();
  fake.update({ issues: { 'ENG-1': teamIssue(1) } });
  await linear.tick();
  fake.update({ issues: { 'ENG-1': teamIssue(1, { state: { name: 'Done' }, updatedAt: at(2) }) } });
  await linear.tick();
  const changed = eventsOf('issue.state_changed');
  assert.equal(changed.length, 2, 'one from the issue poll, one from the team poll');
  assert.deepEqual(changed.map((e) => e.subjects).sort(), [['linear:ENG-1'], ['linear:team:ENG']]);
  const forIssue = watch.events({ subject: 'linear:ENG-1', limit: 500 }).filter((e) => e.type === 'issue.state_changed');
  assert.equal(forIssue.length, 1, 'the issue-only subscriber gets exactly one delivery');
});

test('a team: a rate limit pauses the team poll and keeps the cursor; the token never reaches an event', async () => {
  seedLogin();
  subscribeTeam();
  await linear.tick();
  const before = cursorOf('linear:team:ENG');
  fake.update({ issues: { 'ENG-1': teamIssue(1) }, throttle: 1 });
  assert.equal(await linear.tick(), 0, 'a 429 ingests nothing and does not throw out of tick');
  assert.equal(cursorOf('linear:team:ENG'), before, 'the cursor stays');
  assert.equal(await linear.tick(), 0, 'the pause holds the next tick too');
  linear.resetBackoff();
  assert.equal(await linear.tick(), 1, 'the change lands once the pause is over');
  assert.ok(!JSON.stringify(watch.events({ limit: 500 })).includes('good'), 'the bearer is in no event');
});

test('a team: when its last subscription goes, its cursor and snapshots are dropped', async () => {
  seedLogin();
  const sub = subscribeTeam();
  await linear.tick();
  fake.update({ issues: { 'ENG-1': teamIssue(1) } });
  await linear.tick();
  assert.ok(db.getWatchState('linear:team:ENG/ENG-1'));
  watch.removeSubscription(sub.id, 'a1');
  await linear.tick();
  assert.equal(db.getWatchState('linear:team:ENG'), undefined);
  assert.equal(db.getWatchState('linear:team:ENG/ENG-1'), undefined);
});

test('a team: a list that ignores `after` fails the poll, moves no cursor, and does not hang', async () => {
  seedLogin();
  subscribeTeam();
  await linear.tick();
  fake.update({ ignoreAfter: true, issues: bulk(120) });
  const before = cursorOf('linear:team:ENG');
  assert.equal(await linear.tick(), 0, 'the poll fails and the tick returns');
  assert.equal(cursorOf('linear:team:ENG'), before, 'the cursor does not move on a failed list');
  assert.equal(db.watchStateSubjects('linear:team:ENG/').length, 0, 'nothing is snapshotted from a failed list');
});

test('a team: a list that never runs out fails at the page cap, moves no cursor, and does not hang', async () => {
  seedLogin();
  subscribeTeam();
  await linear.tick();
  fake.update({ endless: true, issues: { 'ENG-1': teamIssue(1) } });
  const before = cursorOf('linear:team:ENG');
  assert.equal(await linear.tick(), 0, 'the poll fails at the cap and the tick returns');
  assert.equal(cursorOf('linear:team:ENG'), before, 'the cursor does not move on a failed list');
});

test('a tick still running makes the next one join it, not stack', async () => {
  const first = linear.tickOnce();
  assert.equal(linear.tickOnce(), first, 'a second call joins the tick in flight');
  await first;
  const next = linear.tickOnce();
  assert.notEqual(next, first, 'once it ends, the next tick is a new one');
  await next;
});
