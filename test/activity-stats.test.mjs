#!/usr/bin/env node
// Unit tests for the activity baseline (S-212, src/activity-stats.ts): per agent, per ITSA, and per
// model and agent type, from seeded agents, activity items, usage rows and samples, and ITSA events.
// A throwaway STAM_HOME, no daemon, no network, no models: `node --test test/activity-stats.test.mjs`.
//
// Seeded story, T0 = 10:00Z (created an hour before, so every agent exists first):
//   W (developer, claude haiku) owns I1 from T0-1h, in_progress; R (reviewer) participates in I1.
//     I1: in_review at +30m, back to in_progress at +40m (one review round), done at +60m.
//     W's items all lie in I1's time: tool.test 60s, model.generate 60s, agent.child gap 60s, human.reply gap 60s.
//     W's usage: $0.50 in one sample at +30m.
//   Y (developer, opencode deepseek) owns I2 from +300m to done at +400m, and I3 from +500m to done at +600m.
//     I2: tool.build 30s. I3: model.generate 150s. $0.10 in a sample for each.
//   X has no items, only a usage row of $0.20 (no transcript yet).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-activity-stats-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `activity-stats-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(
  join(home, 'settings.json'),
  JSON.stringify({
    cost: {
      subscriptionWarnPercent: [80, 95],
      dailyWarnUsd: null,
      global: null,
      onError: 'soft-stop',
      accounts: { claude: { match: { harness: 'claude' } }, openrouter: { match: { harness: 'opencode' }, paid: true } },
    },
  }),
);

let db, stats;
before(async () => {
  db = await import('../src/db.ts');
  stats = await import('../src/activity-stats.ts');
});
after(() => rmSync(home, { recursive: true, force: true }));

const T0 = Date.parse('2026-10-11T10:00:00.000Z');
const MIN = 60_000;
const at = (min) => new Date(T0 + min * MIN).toISOString();
const HOUR_BEFORE = new Date(T0 - 60 * MIN).toISOString();
const DAY = at(0).slice(0, 10);

function seed() {
  const d = db.open();
  for (const t of ['activity_items', 'activity_cursors', 'usage', 'usage_samples', 'itsa_events', 'itsa_participants', 'itsa_links', 'itsas', 'agents']) d.exec(`DELETE FROM ${t}`);
  const agent = (id, type, harness, model) => {
    db.createAgent({ id, name: id, role: 'test', machine: 'x', harness, model, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
    d.prepare('UPDATE agents SET created_at = ?, type = ? WHERE id = ?').run(HOUR_BEFORE, type, id);
  };
  agent('W', 'developer', 'claude', 'claude-haiku-5-5');
  agent('R', 'reviewer', 'claude', 'claude-haiku-5-5');
  agent('Y', 'developer', 'opencode', 'deepseek-v4');
  agent('X', 'developer', 'claude', 'claude-opus-5-5');

  const itsa = (id, key, status, owner, created, closed = null) =>
    d.prepare('INSERT INTO itsas (id, key, parent_id, kind, title, status, owner, created_by, created_at, updated_at, closed_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, key, 'issue', `${key} title`, status, owner, 'W', created, created, closed,
    );
  const event = (id, ts, type, data) => d.prepare('INSERT INTO itsa_events (itsa_id, ts, actor, type, data) VALUES (?, ?, ?, ?, ?)').run(id, ts, 'W', type, JSON.stringify(data));
  const item = (agentId, seq, kind, waitKind, startMin, seconds, est = 0) =>
    d.prepare('INSERT INTO activity_items (agent_id, seq, turn, kind, name, start, "end", summary, wait_kind, raw_cost_usd, est_cost_usd, tokens_in, tokens_out) VALUES (?, ?, 1, ?, NULL, ?, ?, NULL, ?, 0, ?, 0, 0)').run(
      agentId, seq, kind, at(startMin), at(startMin + seconds / 60), waitKind, est,
    );
  const usage = (agentId, harness, model, account, cost) =>
    d.prepare('INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, paid_estimate_usd) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0)').run(agentId, DAY, harness, model, account, cost);
  const sample = (agentId, min, harness, model, account, cost) =>
    d.prepare('INSERT INTO usage_samples (agent_id, account, harness, model, bucket, cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0)').run(agentId, account, harness, model, at(min), cost);

  // I1: W's issue, one review round (in_review, then back), with R as its reviewer.
  itsa('I1', 'S-1', 'done', 'W', HOUR_BEFORE, at(60));
  event('I1', HOUR_BEFORE, 'created', { key: 'S-1', title: 'S-1 title', status: 'in_progress' });
  event('I1', at(30), 'status', { from: 'in_progress', to: 'in_review' });
  event('I1', at(40), 'status', { from: 'in_review', to: 'in_progress' });
  event('I1', at(60), 'status', { from: 'in_progress', to: 'done' });
  d.prepare('INSERT INTO itsa_participants (itsa_id, agent_id) VALUES (?, ?)').run('I1', 'R');
  // Item starts are minutes from T0; durations are seconds.
  item('W', 1, 'tool', 'tool.test', 0, 60, 0.01);
  item('W', 2, 'model', 'model.generate', 1, 60, 0.04);
  item('W', 3, 'gap', 'agent.child', 2, 60);
  item('W', 4, 'gap', 'human.reply', 3, 60);
  sample('W', 30, 'claude', 'claude-haiku-5-5', 'claude', 0.5);
  usage('W', 'claude', 'claude-haiku-5-5', 'claude', 0.5);

  // I2 and I3: Y's two issues, both closed, so the deepseek group has two ITSAs.
  itsa('I2', 'S-2', 'done', 'Y', at(300), at(400));
  event('I2', at(300), 'created', { key: 'S-2', title: 'S-2 title', status: 'in_progress' });
  event('I2', at(400), 'status', { from: 'in_progress', to: 'done' });
  item('Y', 1, 'tool', 'tool.build', 300, 30);
  sample('Y', 300, 'opencode', 'deepseek-v4', 'openrouter', 0.1);
  itsa('I3', 'S-3', 'done', 'Y', at(500), at(600));
  event('I3', at(500), 'created', { key: 'S-3', title: 'S-3 title', status: 'in_progress' });
  event('I3', at(600), 'status', { from: 'in_progress', to: 'done' });
  item('Y', 2, 'model', 'model.generate', 500, 150);
  sample('Y', 500, 'opencode', 'deepseek-v4', 'openrouter', 0.1);
  usage('Y', 'opencode', 'deepseek-v4', 'openrouter', 0.2);

  // X: usage only, no transcript yet.
  usage('X', 'claude', 'claude-opus-5-5', 'claude', 0.2);
}

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} != ${b}`);
const byAgent = (rows, name) => rows.find((r) => r.agent === name);

test('by=agent: working and waiting time by kind, cost from usage, unknown time without items', () => {
  seed();
  const { rows } = stats.activityStats({ by: 'agent', now: T0 + 700 * MIN });
  const w = byAgent(rows, 'W');
  assert.equal(w.working_s, 120);
  assert.equal(w.waiting_s, 120);
  assert.equal(w.wall_s, 240);
  assert.deepEqual(w.working_by_kind, { 'tool.test': 60, 'model.generate': 60 });
  assert.deepEqual(w.waiting_by_top, { agent: 60, human: 60 });
  assert.deepEqual(w.waiting_by_kind, { 'agent.child': 60, 'human.reply': 60 });
  close(w.cost_usd, 0.5, 'W usage cost');
  close(w.item_est_cost_usd, 0.05, 'W item est cost');
  const x = byAgent(rows, 'X');
  assert.equal(x.working_s, null);
  assert.equal(x.waiting_s, null);
  close(x.cost_usd, 0.2, 'X usage cost');
});

test('by=agent: time and est cost per category, NULL shown as unclassified (S-225)', () => {
  seed();
  // W's tool item is classified as a test run; its model item and two gaps stay unclassified (120s of gaps).
  // Y's build is classified; its model item stays unclassified.
  db.open().prepare("UPDATE activity_items SET category = ? WHERE agent_id = 'W' AND seq = 1").run('verify.test');
  db.open().prepare("UPDATE activity_items SET category = ? WHERE agent_id = 'Y' AND seq = 1").run('verify.build');
  const { rows, categories } = stats.activityStats({ by: 'agent', now: T0 + 700 * MIN });
  const w = byAgent(rows, 'W');
  // Categories count working items only: W's two gaps (120s) are left out.
  assert.deepEqual(w.categories.top_s, { verify: 60, unclassified: 60 });
  assert.deepEqual(w.categories.leaf_s, { 'verify.test': 60, unclassified: 60 });
  close(w.categories.top_cost_usd.verify, 0.01, 'W verify est cost');
  close(w.categories.top_cost_usd.unclassified, 0.04, 'W unclassified est cost');
  assert.deepEqual(byAgent(rows, 'Y').categories.top_s, { verify: 30, unclassified: 150 });
  assert.deepEqual(byAgent(rows, 'X').categories, { top_s: {}, leaf_s: {}, top_cost_usd: {}, top_cost_modes: {} });
  assert.equal(stats.activityStats({ by: 'agent', now: T0 + 700 * MIN }).labels['tool.test'], 'Running tests');
  assert.equal(stats.activityStats({ by: 'agent', now: T0 + 700 * MIN }).labels['verify'], 'Verifying');
  assert.deepEqual(categories.top_s, { verify: 90, unclassified: 210 });
});

test('by=agent: overall category totals sum unrounded times, so two 0.4 s agents total 1 s (S-225)', () => {
  seed();
  const d = db.open();
  d.exec("DELETE FROM activity_items");
  // Two agents, each one 0.4 s verify item: rounded per agent they are 0, but overall they are 0.8 s, which rounds to 1.
  const ins = d.prepare('INSERT INTO activity_items (agent_id, seq, turn, kind, name, start, "end", summary, wait_kind, raw_cost_usd, est_cost_usd, tokens_in, tokens_out, category) VALUES (?, 1, 1, ?, NULL, ?, ?, NULL, ?, 0, 0, 0, 0, ?)');
  ins.run('X', 'tool', at(0), new Date(T0 + 400).toISOString(), 'tool.test', 'verify.unit');
  ins.run('Y', 'tool', at(0), new Date(T0 + 400).toISOString(), 'tool.test', 'verify.unit');
  const { categories } = stats.activityStats({ by: 'agent', now: T0 + 700 * MIN });
  assert.equal(categories.top_s.verify, 1);
});

test('by=itsa: own and roll-up time, cost, review rounds, and lead time', () => {
  seed();
  const { rows } = stats.activityStats({ by: 'itsa', now: T0 + 700 * MIN });
  const i1 = rows.find((r) => r.key === 'S-1');
  assert.equal(i1.own.working_s, 120);
  assert.equal(i1.own.waiting_s, 120);
  assert.deepEqual(i1.own.waiting_by_top, { agent: 60, human: 60 });
  close(i1.own.cost_usd, 0.5, 'I1 cost');
  assert.equal(i1.review_moves, 1, 'one move from in_review back to in_progress');
  assert.equal(i1.reviewer_agents, 1, 'R joined as a reviewer');
  assert.equal(i1.review_rounds, 2);
  assert.equal(i1.lead_s, 2 * 3600, 'created an hour before T0, closed at +60m');
  // Who worked on it: their working time there adds up to the ITSA's own (S-226).
  const w = i1.agents.find((x) => x.id === 'W');
  assert.equal(w.name, 'W');
  assert.equal(w.working_s, i1.own.working_s, 'W did all of I1\'s working time');
  assert.equal(i1.agents.reduce((n, x) => n + x.working_s, 0), i1.own.working_s);
  const i2 = rows.find((r) => r.key === 'S-2');
  assert.equal(i2.own.working_s, 30);
  assert.equal(i2.review_rounds, 0);
  assert.equal(i2.lead_s, 6000, 'closed ITSA: lead time from creation (+300m) to close (+400m)');
});

test('review rounds: reviewers that name the ITSA key or its branch count, on whole tokens only (S-244)', () => {
  seed();
  const d = db.open();
  // Q names I1's branch; P names S-10 and I1's branch with a suffix, so neither key S-1 nor the branch matches.
  // T names S-20, which is not S-2. RV names stam/feature-x.v2, a different branch. RW ends its branch with a sentence dot.
  const reviewer = (id, prompt) => {
    db.createAgent({ id, name: id, role: 'test', machine: 'x', harness: 'claude', model: 'claude-haiku-5-5', effort: null, cwd: '/tmp', parent_id: null, session_id: null });
    d.prepare("UPDATE agents SET type = 'reviewer', first_prompt = ? WHERE id = ?").run(prompt, id);
  };
  reviewer('Q', 'Review branch `stam/feature-x` (commit abc) against main.');
  reviewer('P', 'Review S-10 and branch stam/feature-x-2 against main.');
  reviewer('T', 'Review S-20 against main.');
  reviewer('RV', 'Review stam/feature-x.v2 against main.');
  reviewer('RW', 'Review branch stam/feature-x. Then reply.');
  d.prepare("INSERT INTO itsa_links (itsa_id, n, system, external_id, url) VALUES ('I1', 1, 'branch', 'stam/feature-x', 'https://example.test/x')").run();
  const { rows } = stats.activityStats({ by: 'itsa', now: T0 + 700 * MIN });
  const i1 = rows.find((r) => r.key === 'S-1');
  assert.equal(i1.reviewer_agents, 3, 'R (participant), Q (names the branch), and W (branch at a sentence end)');
  assert.equal(i1.review_rounds, 4, 'one move back to in_progress, plus the three reviewers');
  const i2 = rows.find((r) => r.key === 'S-2');
  assert.equal(i2.reviewer_agents, 0, 'S-20 is not S-2');
  assert.equal(i2.review_rounds, 0);
});

test('by=model: median and p75 over closed ITSAs, per worker config', () => {
  seed();
  const { rows } = stats.activityStats({ by: 'model', closed: true, now: T0 + 700 * MIN });
  const ds = rows.find((r) => r.model === 'opencode · deepseek-v4');
  assert.equal(ds.n, 2);
  // Working per ITSA: I2 30s and I3 150s; the median is 90, the p75 is 30 + 0.75 × 120 = 120.
  assert.equal(ds.working_s.median, 90);
  assert.equal(ds.working_s.p75, 120);
  close(ds.cost_usd.median, 0.1, 'deepseek cost median');
  const hk = rows.find((r) => r.model === 'claude · claude-haiku-5-5');
  assert.equal(hk.n, 1);
  assert.equal(hk.working_s.median, 120);
  assert.equal(hk.review_rounds.median, 2);
});

test('by=type: groups closed ITSAs by the agent type with the most working time', () => {
  seed();
  const { rows } = stats.activityStats({ by: 'type', closed: true, now: T0 + 700 * MIN });
  const dev = rows.find((r) => r.type === 'developer');
  assert.equal(dev.n, 3);
  assert.equal(dev.working_s.median, 120);
});

test('window: an item crossing the cutoff counts only its part inside [since, now]', () => {
  seed();
  // Cutoff at +2.5m: W's agent.child gap (+2m to +3m) keeps its last 30s, the human gap keeps 60s, and
  // the tool and model items, which end by +2m, drop out.
  const days = 697.5 / 1440;
  const { rows } = stats.activityStats({ by: 'agent', days, now: T0 + 700 * MIN });
  const w = byAgent(rows, 'W');
  assert.equal(w.waiting_s, 90);
  assert.deepEqual(w.waiting_by_kind, { 'agent.child': 30, 'human.reply': 60 });
  assert.equal(w.working_s, 0);
});

test('percentile keeps sub-cent precision: $0.001 and $0.003 give a median of $0.002, not $0', () => {
  assert.equal(stats.percentile([0.001, 0.003], 0.5), 0.002);
  assert.equal(stats.percentile([0.001, 0.003], 0.75), 0.0025);
});

test('cost modes: agent rows, categories and group spreads carry every Measure mode (S-663)', () => {
  seed();
  db.open().prepare("UPDATE activity_items SET category = 'verify.test' WHERE agent_id = 'W' AND seq = 1").run();
  const a = stats.activityStats({ by: 'agent', now: T0 + 700 * MIN });
  const w = byAgent(a.rows, 'W');
  close(w.modes.api, 0.5, 'W api');
  close(w.modes.paid_usd, 0, 'W is on a subscription account');
  const y = byAgent(a.rows, 'Y');
  close(y.modes.paid_usd, 0.2, 'Y bills per use, so its api spend is paid');
  close(w.categories.top_cost_modes.verify.api, 0.01, 'W verify api');
  close(a.categories.top_cost_modes.unclassified.api, 0.04 + 0, 'unclassified api: W model item only; Y is on openrouter');
  const m = stats.activityStats({ by: 'model', closed: true, now: T0 + 700 * MIN });
  const ds = m.rows.find((r) => r.model === 'opencode · deepseek-v4');
  assert.deepEqual(Object.keys(ds.cost_modes).sort(), ['api', 'five_hour', 'paid_usd', 'real', 'seven_day', 'subscription']);
  close(ds.cost_modes.api.median, 0.1, 'deepseek api median');
  close(ds.cost_modes.paid_usd.median, 0.1, 'deepseek paid median');
  // Real $ per row is subscription + paid, so its spread is the rows', not a sum of spreads.
  close(ds.cost_modes.real.median, 0.1, 'deepseek real median: all paid');
});

test('the real spread leaves out issues whose subscription is not known: null, never 0 (S-1012)', () => {
  const m = (subscription, paid_usd) => ({ api: 1, five_hour: null, seven_day: null, subscription, paid_usd });
  assert.deepEqual(stats.modesSpread([m(null, 0), m(null, 0.5)]).real, { n: 0, median: null, p75: null });
  const mixed = stats.modesSpread([m(null, 9), m(0.2, 0.1), m(0.4, 0)]).real;
  assert.equal(mixed.n, 2);
  close(mixed.median, 0.35, 'real median of the known rows: 0.3 and 0.4');
});

test('by=model and by=type: only closed work issues with working time; reviewers do not set the type; lead time (S-1007)', () => {
  seed();
  const d = db.open();
  // A retro item and a proposal with working time, an issue nobody worked on, and a reviewer who out-worked the developer on I2.
  const add = (id, key, kind) => d.prepare('INSERT INTO itsas (id, key, parent_id, kind, title, status, owner, created_by, created_at, updated_at, closed_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, key, kind, key, 'done', 'Y', 'W', at(300), at(300), at(400));
  add('K1', 'S-91', 'retro');
  add('K2', 'S-92', 'issue');
  d.prepare('INSERT INTO activity_items (agent_id, seq, turn, kind, name, start, "end", summary, wait_kind, raw_cost_usd, est_cost_usd, tokens_in, tokens_out) VALUES (?, 9, 1, ?, NULL, ?, ?, NULL, ?, 0, 0, 0, 0)').run('R', 'tool', at(300), at(305), 'tool.test');
  d.prepare("INSERT INTO itsa_events (itsa_id, ts, actor, type, data) VALUES ('I2', ?, 'W', 'owner', ?)").run(at(299), JSON.stringify({ from: null, to: 'Y' }));
  const t = stats.activityStats({ by: 'type', closed: true, now: T0 + 700 * MIN });
  assert.equal(t.rows.find((r) => r.type === 'unknown'), undefined, 'no unknown row from items nobody worked on');
  assert.equal(t.rows.find((r) => r.type === 'reviewer'), undefined, 'a reviewer never sets the type');
  assert.equal(t.rows.find((r) => r.type === 'developer').n, 3, 'S-1, S-2, S-3 only: no retro, no empty issue');
  const m = stats.activityStats({ by: 'model', closed: true, now: T0 + 700 * MIN });
  assert.equal(m.rows.reduce((n, r) => n + r.n, 0), 3);
  const ds = m.rows.find((r) => r.model === 'opencode · deepseek-v4');
  assert.equal(ds.lead_s.median, 6000, 'I2 and I3 both took 100 minutes');
  assert.equal(ds.lead_s.p75, 6000);
});

test('review rounds: reviewers of any reviewer type count, not only the type named reviewer (S-1007)', () => {
  seed();
  const d = db.open();
  db.createAgent({ id: 'RO', name: 'RO', role: 'test', machine: 'x', harness: 'claude', model: 'claude-opus-5-5', effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  d.prepare("UPDATE agents SET type = 'reviewer-opus', first_prompt = ? WHERE id = ?").run('Review S-2 against main.', 'RO');
  const { rows } = stats.activityStats({ by: 'itsa', now: T0 + 700 * MIN });
  assert.equal(rows.find((r) => r.key === 'S-2').reviewer_agents, 1);
});
