#!/usr/bin/env node
// Unit tests for the away digest (S-2821): the presence heartbeat that opens an away window, the window's
// survival in the db, dismissal, and the digest's lists (what happened, what waits on the human, what runs
// next), read from the sources stam already keeps. Runs against a throwaway STAM_HOME; no daemon, no network,
// no models: `node --test test/digest.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-digest-');
process.env.STAM_HOME = home;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let db, digest;
before(async () => {
  db = await import('../src/db.ts');
  digest = await import('../src/digest.ts');
});
after(() => rmSync(home, { recursive: true, force: true }));

const MIN = 60_000;
const at = (min) => new Date(Date.UTC(2026, 9, 20, 9, 0, 0) + min * MIN);
const iso = (min) => at(min).toISOString();
// Rows read from sqlite have no prototype; the JSON the daemon sends is plain.
const plain = (x) => JSON.parse(JSON.stringify(x));
const row = (sql, ...args) => db.open().prepare(sql).get(...args);
const run = (sql, ...args) => db.open().prepare(sql).run(...args);
const resetWindow = () => run("DELETE FROM kv WHERE key IN ('digest.window', 'digest.lastActiveAt')");
let n = 0;
const agent = (fields = {}) => {
  const id = db.newAgentId();
  db.createAgent({ id, name: `d${++n}`, role: '', machine: 'test', harness: 'fake', model: null, effort: null, cwd: home, parent_id: null, session_id: null, ...fields });
  return db.getAgent(id);
};
const insertItsa = (key, title, status, owner = null, rank = null, createdAt = iso(0)) => {
  const id = `i-${key}`;
  run(`INSERT INTO itsas (id, key, kind, title, status, owner, rank, created_by, created_at, updated_at) VALUES (?, ?, 'issue', ?, ?, ?, ?, 'test', ?, ?)`,
    id, key, title, status, owner, rank, createdAt, createdAt);
  return id;
};
const statusMove = (itsaId, ts, from, to) => run("INSERT INTO itsa_events (itsa_id, ts, actor, type, data) VALUES (?, ?, 'test', 'status', ?)", itsaId, ts, JSON.stringify({ from, to }));
const event = (agentId, ts, type) => run('INSERT INTO events (agent_id, ts, type, data) VALUES (?, ?, ?, NULL)', agentId, ts, type);
// A mail from an agent to the human, in a thread; the decision row is what makes it a decision.
const mailToHuman = (from, { id, thread, subject, body, kind = null, aboutItsa = null, created = null }) => {
  db.createMail({ id, from_id: from.id, from_name: from.name, subject, body, thread_id: thread, reply_to: null, kind, about_itsa: aboutItsa }, ['human']);
  if (created) run('UPDATE mail SET created_at = ? WHERE id = ?', created, id);
  return id;
};

test('a gap longer than awayMinutes closes one window; the first report opens none', () => {
  assert.deepEqual(digest.presence(at(0)), { window: null });
  assert.deepEqual(digest.presence(at(60)), { window: null }, 'an hour is inside the 120-minute default');
  assert.deepEqual(digest.presence(at(60 + 120)), { window: null }, 'exactly awayMinutes is not away');
  assert.deepEqual(digest.presence(at(60 + 120 + 121)), { window: { since: iso(180), until: iso(301) } });
  assert.equal(digest.digest().window?.since, iso(180));
  assert.equal(digest.digest().window?.until, iso(301));
});

test('several tabs reporting at once open no spurious window', () => {
  digest.presence(at(400));
  // Each tab checks the same stored activity; the first one's report is that activity, so the rest see no gap.
  const results = [at(401), at(401), at(402), at(402)].map((t) => digest.presence(t));
  assert.deepEqual(results, [{ window: null }, { window: null }, { window: null }, { window: null }]);
  assert.equal(digest.digest().window?.until, iso(301), 'the window from before is still the latest');
});

test('two tabs reporting after a gap open exactly one window', () => {
  resetWindow();
  digest.presence(at(0));
  const results = [at(300), at(300), at(301)].map((t) => digest.presence(t));
  assert.deepEqual(results[0], { window: { since: iso(0), until: iso(300) } }, 'the first report after the gap closes it');
  assert.deepEqual(results.slice(1), [{ window: null }, { window: null }], 'the others see the activity it stored');
  assert.deepEqual(digest.digest().window, { since: iso(0), until: iso(300) });
});

test('an interleaved late report keeps the newer stored activity', () => {
  digest.presence(at(600));
  digest.presence(at(590));
  assert.equal(row("SELECT value FROM kv WHERE key = 'digest.lastActiveAt'").value, JSON.stringify(iso(600)));
});

test('the window and lastActiveAt are stored in the db, not memory', () => {
  assert.ok(row("SELECT value FROM kv WHERE key = 'digest.window'"), 'the window is a kv row');
  assert.ok(row("SELECT value FROM kv WHERE key = 'digest.lastActiveAt'"), 'lastActiveAt is a kv row');
});

test('dismissal marks the window that ends at until, once; the next window starts undismissed', () => {
  digest.presence(at(1000));
  const until = iso(1000);
  assert.deepEqual(digest.dismiss(until, at(1001)), { dismissed: true, dismissedAt: iso(1001) });
  assert.equal(digest.digest().dismissedAt, iso(1001));
  assert.deepEqual(digest.dismiss(until, at(1002)), { dismissed: true, dismissedAt: iso(1001) }, 'the first dismissal stands');
  digest.presence(at(1000 + 200));
  assert.equal(digest.digest().dismissedAt, null, 'a new window is not dismissed');
});

test('a stale until dismisses nothing', () => {
  const current = digest.digest().window.until;
  assert.deepEqual(digest.dismiss(iso(1), at(1500)), { dismissed: false });
  assert.equal(digest.digest().dismissedAt, null, 'the current window is untouched');
  assert.deepEqual(digest.dismiss(current, at(1500)), { dismissed: true, dismissedAt: iso(1500) });
});

test('dismissing with no window dismisses nothing', () => {
  run("DELETE FROM kv WHERE key = 'digest.window'");
  assert.deepEqual(digest.dismiss(iso(2000), at(2000)), { dismissed: false });
});

test('the digest lists what happened in the window, newest first, from the existing sources', () => {
  resetWindow();
  digest.presence(at(3000));
  digest.presence(at(3000 + 200));
  assert.deepEqual(digest.digest().window, { since: iso(3000), until: iso(3200) });

  const itsaId = insertItsa('S-9001', 'Digest closes', 'done');
  statusMove(itsaId, iso(3100), 'in_progress', 'done');
  statusMove(itsaId, iso(2000), 'todo', 'done');
  const busy = agent({ name: 'digest-busy' });
  event(busy.id, iso(3050), 'spawn');
  const old = agent({ name: 'digest-old' });
  event(old.id, iso(3150), 'archive');
  // Updated in the window but never archived there: not listed.
  const stale = agent({ name: 'digest-stale' });
  db.updateAgent(stale.id, { lifecycle: 'archived' });
  run('UPDATE agents SET updated_at = ? WHERE id = ?', iso(3160), stale.id);
  run(`INSERT INTO usage_samples (agent_id, account, harness, model, bucket, cost_usd) VALUES (?, 'claude', 'claude', 'm', ?, 1.25)`, busy.id, iso(3010));
  run(`INSERT INTO usage_samples (agent_id, account, harness, model, bucket, cost_usd) VALUES (?, 'codex', 'codex', 'm', ?, 0.5)`, busy.id, iso(3020));

  const mergeDir = join(home, 'pr-merge', 'done');
  mkdirSync(mergeDir, { recursive: true });
  writeFileSync(join(mergeDir, '77.json'), JSON.stringify({ pr: 77, by: 'x', itsa: 'S-9001', branch: 'stam/x', state: 'merged', started: iso(3080), ended: iso(3090), sha: 'abc' }));
  writeFileSync(join(mergeDir, '78.json'), JSON.stringify({ pr: 78, by: 'x', itsa: null, branch: 'stam/y', state: 'refused', started: iso(3000), ended: iso(3001) }));

  const d = digest.digest();
  assert.deepEqual(plain(d.happened.closed), [{ itsa: 'S-9001', title: 'Digest closes', at: iso(3100) }], 'only closes in the window');
  assert.deepEqual(plain(d.happened.merged), [{ pr: 77, title: 'Digest closes', itsa: 'S-9001', at: iso(3090) }]);
  assert.deepEqual(plain(d.happened.spawned), [{ agent: 'digest-busy', at: iso(3050) }]);
  assert.deepEqual(plain(d.happened.archived), [{ agent: 'digest-old', at: iso(3150) }], 'an archive event, not an updated_at');
  assert.deepEqual(plain(d.happened.spend), { usd: 1.75, byHarness: { claude: 1.25, codex: 0.5 } });
});

test('a merge GitHub reported counts too, once per PR, and the record names its ITSA', () => {
  // PR 77 is in the done records and in GitHub's events: one row. PR 79 is only in GitHub's events.
  const subjects = (pr) => JSON.stringify([`github:example/app#${pr}`, 'github:example/app']);
  const ins = db.open().prepare('INSERT INTO ext_events (source, type, subjects, actor, url, summary, payload, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  ins.run('github', 'pull_request.merged', subjects(77), null, null, 'PR #77 merged: Digest closes', null, 'merged:77', iso(3090));
  ins.run('github', 'pull_request.merged', subjects(79), null, null, 'PR #79 merged: Manual merge', null, 'merged:79', iso(3120));
  const d = digest.digest();
  assert.deepEqual(plain(d.happened.merged), [
    { pr: 79, title: 'Manual merge', at: iso(3120) },
    { pr: 77, title: 'Digest closes', itsa: 'S-9001', at: iso(3090) },
  ]);
});

test('a close counts from an open status, once per ITSA, only while the ITSA stays closed', () => {
  resetWindow();
  digest.presence(at(5000));
  digest.presence(at(5200));
  const twice = insertItsa('S-9101', 'Closed twice', 'done');
  statusMove(twice, iso(5050), 'todo', 'done');
  statusMove(twice, iso(5060), 'done', 'in_progress');
  statusMove(twice, iso(5070), 'in_progress', 'done');
  const doneAlready = insertItsa('S-9102', 'Done before', 'done');
  statusMove(doneAlready, iso(5080), 'done', 'done');
  const reopened = insertItsa('S-9103', 'Closed then reopened', 'in_progress');
  statusMove(reopened, iso(5090), 'in_progress', 'done');
  statusMove(reopened, iso(5100), 'done', 'in_progress');
  const d = digest.digest();
  assert.deepEqual(plain(d.happened.closed), [{ itsa: 'S-9101', title: 'Closed twice', at: iso(5070) }], 'the latest close, and only the closes that count');
  // The spawns: one agent spawned twice (a recovery of its first prompt) counts once, at its first spawn.
  const spawner = agent({ name: 'digest-respawn' });
  event(spawner.id, iso(5110), 'spawn');
  event(spawner.id, iso(5120), 'spawn');
  assert.deepEqual(plain(digest.digest().happened.spawned), [{ agent: 'digest-respawn', at: iso(5110) }]);
});

test('needs carry a decision, a wait and a pending request; a parked thread leaves the list', () => {
  resetWindow();
  digest.presence(at(6000));
  digest.presence(at(6200));
  const sender = agent({ name: 'digest-sender' });
  const decisionId = mailToHuman(sender, { id: 'm-decision-1', thread: 'th-decision-1', subject: 'Pick a name', body: 'MARKER-BODY-7741 decide', created: iso(6100) });
  db.addDecisionMail(decisionId, 'th-decision-1');
  // A decision the human deferred (Defer): it leaves the list with its thread.
  const parkedId = mailToHuman(sender, { id: 'm-parked-1', thread: 'th-parked-1', subject: 'Parked decision', body: 'later' });
  db.addDecisionMail(parkedId, 'th-parked-1');
  db.deferThread('human', 'th-parked-1', [parkedId]);
  // An ask on a waiting ITSA, parked by Defer: the ITSA leaves the list; a second ITSA stays.
  const askId = mailToHuman(sender, { id: 'm-ask-1', thread: 'th-ask-1', subject: 'Needs your answer', body: 'ask body', kind: 'ask', aboutItsa: 'i-S-9201', created: '2026-10-19T00:00:00.000Z' });
  insertItsa('S-9201', 'Parked ask', 'needs_input', null, null, '2026-10-19T00:00:00.000Z');
  run('UPDATE mail SET about_itsa = ? WHERE id = ?', 'i-S-9201', askId);
  db.deferThread('human', 'th-ask-1', [askId]);
  insertItsa('S-9202', 'Live ask', 'needs_input', null, null, '2026-10-19T00:00:00.000Z');
  // A wait the agent declared on a thread: it shows as the agent's row.
  const waiter = agent({ name: 'digest-waiter' });
  db.addWait({ agent_id: waiter.id, kind: 'human', source: 'stam', detail: 'Waiting on the answer', data: JSON.stringify({ thread: 'th-wait-1' }) });
  // A pending request with no wait row: its own row.
  const req = db.createPermissionRequest(sender.id, 'run a secret command', 'why', 'details with a token sk-123');

  const d = digest.digest();
  const refs = d.needs.map((r) => r.ref);
  assert.ok(refs.includes(decisionId), 'the decision shows');
  assert.ok(d.needs.some((r) => r.kind === 'decision' && r.title === 'Pick a name'));
  assert.ok(d.needs.some((r) => r.kind === 'agent' && r.ref === 'digest-waiter' && r.title === 'Waiting on the answer'), 'the wait shows');
  assert.ok(d.needs.some((r) => r.kind === 'permission' && r.ref === req.id && r.title === 'A permission request from digest-sender'), 'the request shows');
  assert.ok(refs.includes('S-9202'), 'the ask that is not parked shows');
  assert.ok(!refs.includes('S-9201'), 'a parked ask leaves the list');
  assert.ok(!refs.includes(parkedId), 'a parked decision leaves the list');
  assert.ok(!JSON.stringify(d).includes('MARKER-BODY-7741'), 'a mail body never leaves the daemon');
  assert.ok(!JSON.stringify(d).includes('sk-123'), 'permission details stay out');
});

test('needs carry new when they arrived after the window started', () => {
  const d = digest.digest();
  const s9202 = d.needs.find((r) => r.ref === 'S-9202');
  assert.equal(s9202.new, false, 'created before the window');
  const decision = d.needs.find((r) => r.kind === 'decision');
  assert.equal(decision.new, true, 'arrived in the window');
});

test('the next ITSAs are the active and ready ones by rank, and the agents working now', () => {
  const owner = agent({ name: 'digest-owner' });
  db.updateAgent(owner.id, { activity: 'working' });
  insertItsa('S-9011', 'Ranked second', 'in_progress', owner.id, 2);
  insertItsa('S-9012', 'Ranked first', 'todo', null, 1);
  insertItsa('S-9013', 'Unranked', 'ready', null, null);
  insertItsa('S-9014', 'Closed one', 'done', null, 0);
  const d = digest.digest();
  // Ranked first (1, 2), then unranked oldest first; the human-status ITSAs are active too, so they follow.
  assert.deepEqual(d.next.itsas.map((x) => x.key).filter((k) => ['S-9011', 'S-9012', 'S-9013'].includes(k)), ['S-9012', 'S-9011', 'S-9013']);
  assert.ok(!d.next.itsas.some((x) => x.key === 'S-9014'), 'a closed ITSA is not next');
  assert.deepEqual(d.next.itsas.find((x) => x.key === 'S-9011'), { key: 'S-9011', title: 'Ranked second', status: 'in_progress', owner: 'digest-owner' });
  assert.ok(d.next.working.some((x) => x.agent === 'digest-owner' && x.itsa === 'S-9011'));
});

test('the digest is deterministic: the same state gives the same answer', () => {
  assert.deepEqual(digest.digest(), digest.digest());
});

test('a list over the cap is cut to CAP and counted in its more map', () => {
  resetWindow();
  digest.presence(at(3000));
  digest.presence(at(3200));
  const busy = agent({ name: 'digest-many-busy' });
  event(busy.id, iso(3050), 'spawn');
  for (let i = 0; i < digest.CAP + 3; i++) event(agent({ name: `digest-many-${i}` }).id, iso(3100 + i / 100), 'spawn');
  const d = digest.digest();
  assert.equal(d.happened.spawned.length, digest.CAP);
  assert.equal(d.happened.more.spawned, 5, 'the 25 agents spawned in the window (digest-busy included), less the 20 kept');
  assert.equal(d.needsMore, undefined, 'a list that was not cut has no count');
});
