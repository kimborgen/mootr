#!/usr/bin/env node
// Free unit tests for the Usage page's daemon data (docs/cost-policy.md, "Attribution and
// estimates"): per-window worth (the dollars a full window is worth, used and left), the
// per-model and per-day shares, the full agent and tree lists, and the nested tree totals
// over a DAG. Synthetic samples and readings; a throwaway STAM_HOME with no daemon, network or
// models: `node --test test/worth.test.mjs`.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-worth-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `worth-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

// One account on the claude harness; two models priced through the user's registry.json, one
// at $1 per million input tokens (so a sample's weight is its token count) and one at $2.
writeFileSync(
  join(home, 'settings.json'),
  JSON.stringify({ cost: { subscriptionWarnPercent: [80, 95], dailyWarnUsd: null, global: null, onError: 'soft-stop', accounts: { claude: { match: { harness: 'claude' } } } } }),
);
writeFileSync(join(home, 'registry.json'), JSON.stringify({ prices: { m1: { input: 1 }, m2: { input: 2 } } }));

let db, attr, usage;
before(async () => {
  db = await import('../src/db.ts');
  attr = await import('../src/attribution.ts');
  usage = await import('../src/usage.ts');
});
after(() => rmSync(home, { recursive: true, force: true }));

const T0 = Date.parse('2026-10-11T10:00:00.000Z');
const MIN = 60_000;
const DAY = 86_400_000;
const RESET1 = (T0 + 5 * 60 * MIN) / 1000;
const RESET2 = RESET1 + 5 * 3600;
const iso = (t) => new Date(t).toISOString();

let n = 0;
function agent(name, parent = null) {
  const id = `worth-${++n}`;
  db.createAgent({ id, name, role: 'test', machine: 'x', harness: 'claude', model: 'm1', effort: null, cwd: '/tmp', parent_id: parent, session_id: null });
  return id;
}
function sample(agentId, minute, tokens, model = 'm1') {
  db.open()
    .prepare('INSERT INTO usage_samples (agent_id, account, harness, model, bucket, tokens_in) VALUES (?, ?, ?, ?, ?, ?)')
    .run(agentId, 'claude', 'claude', model, iso(T0 + minute * MIN), tokens);
}
function reading(minute, used, resets = RESET1, window = 'five_hour') {
  db.open().prepare('INSERT INTO window_readings (name, window, at, used_percentage, resets_at) VALUES (?, ?, ?, ?, ?)').run('claude', window, iso(T0 + minute * MIN + 30_000), used, resets);
}
function usageRow(agentId, cost, tokens, day = '2026-10-11') {
  db.open()
    .prepare('INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, tokens_in) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(agentId, day, 'claude', 'm1', 'claude', cost, tokens);
}
const near = (a, b, tol = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} != ${b}`);
// The worth amounts are rounded to hundredths of a dollar, as the summary reports them.
const r2 = (x) => Math.round(x * 100) / 100;

beforeEach(() => {
  const d = db.open();
  d.exec('DELETE FROM usage');
  d.exec('DELETE FROM usage_samples');
  d.exec('DELETE FROM window_readings');
  d.exec('DELETE FROM agent_parents');
  d.exec('DELETE FROM agents');
  d.exec('DELETE FROM subscriptions');
  usage.resetSnapshotMemo();
});

test('worth > a range from recent scales, with used and left dollars', () => {
  const a = agent('w-a');
  // One interval: 10,000 weighted tokens move the window 10%. 100 / (0.001 × 1e6) = $0.10.
  reading(0, 10);
  sample(a, 5, 10000);
  reading(5, 20);
  const now = T0 + 10 * MIN;

  const w = attr.accountShares('claude', ['five_hour'], now).five_hour.worth;
  assert.equal(w.estimate, true);
  assert.equal(w.samples, 1);
  assert.equal(w.percent_used, 20);
  // Few samples: ±25% around the current scale, in hundredths of a dollar.
  near(w.worth_usd.mid, 0.1, 0.006);
  near(w.worth_usd.low, 0.075, 0.006);
  near(w.worth_usd.high, 0.125, 0.006);
  near(w.used_usd, 0.02, 0.006);
  near(w.left_usd, 0.08, 0.006);

  // Not calibrated (no readings): every amount is null.
  db.open().exec('DELETE FROM window_readings');
  usage.resetSnapshotMemo();
  const nc = attr.accountShares('claude', ['five_hour'], now).five_hour.worth;
  assert.equal(nc.worth_usd, null);
  assert.equal(nc.used_usd, null);
  assert.equal(nc.left_usd, null);
});

test('worth > the 20th and 80th percentiles of recent interval scales', () => {
  const a = agent('w-b');
  // Five intervals in the last day, each reseeded (a miss), with scales 1e-3, 2e-3, 5e-4,
  // 4e-3, 1e-3 → worth 0.10, 0.05, 0.20, 0.025, 0.10 dollars.
  const steps = [
    [0, 10, null, null],
    [5, 20, 10000, 0], // Δ 10 over 10,000 → 0.001
    [10, 22, 1000, 5], // Δ 2 over 1,000 → 0.002 (miss)
    [15, 24, 4000, 10], // Δ 2 over 4,000 → 0.0005 (miss)
    [20, 28, 1000, 15], // Δ 4 over 1,000 → 0.004 (miss)
    [25, 30, 2000, 20], // Δ 2 over 2,000 → 0.001 (miss)
  ];
  reading(0, steps[0][1]);
  for (const [minute, used, tokens, sampleMinute] of steps.slice(1)) {
    sample(a, sampleMinute + 5, tokens);
    reading(minute, used);
  }
  const now = T0 + 30 * MIN;
  const w = attr.accountShares('claude', ['five_hour'], now).five_hour.worth;
  assert.equal(w.samples, 5);
  // Percentiles of [0.025, 0.05, 0.1, 0.1, 0.2], rounded to hundredths: p20 0.045→0.05, median
  // 0.1, p80 0.12.
  assert.equal(w.worth_usd.mid, r2(0.1));
  assert.equal(w.worth_usd.low, r2(0.045));
  assert.equal(w.worth_usd.high, r2(0.12));
  assert.ok(w.worth_usd.low <= w.worth_usd.mid && w.worth_usd.mid <= w.worth_usd.high);
  // used and left follow the midpoint and the reading.
  assert.equal(w.percent_used, 30);
  near(w.used_usd, 0.3 * w.worth_usd.mid, 1e-9);
  near(w.left_usd, 0.7 * w.worth_usd.mid, 1e-9);
});

test('by_model > each model gets its API-weighted share of the window', () => {
  const a = agent('m-a');
  reading(0, 10);
  sample(a, 5, 3000, 'm1'); // weight 3000
  sample(a, 5, 500, 'm2'); // weight 500 × 2 = 1000
  reading(5, 14); // Δ 4 over 4000 → 0.001
  const now = T0 + 10 * MIN;

  const s = attr.accountShares('claude', ['five_hour'], now).five_hour;
  const by = Object.fromEntries(s.by_model.map((m) => [m.model, m.percent]));
  near(by.m1, 3, 1e-9, 'm1 share');
  near(by.m2, 1, 1e-9, 'm2 share');
  // The model shares plus `other` are the window's change.
  const sum = s.by_model.reduce((t, m) => t + m.percent, 0) + s.other;
  near(sum, s.change, 1e-9, 'models + other = change');
});

test('full lists > by_agent and by_tree carry every agent and tree, not the top 5', () => {
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push(agent(`full-${i}`));
  reading(0, 10);
  for (const id of ids) sample(id, 5, 1000);
  reading(5, 16); // Δ 6 over 6000 → each agent 1
  const now = T0 + 10 * MIN;

  const s = attr.accountShares('claude', ['five_hour'], now).five_hour;
  assert.equal(s.agents.length, 5, 'the top list is still five');
  assert.equal(s.by_agent.length, 6, 'the full agent list has all six');
  assert.equal(s.by_tree.length, 6, 'each unparented agent is its own tree');
  // A tree of one, so its share is the agent's.
  near(s.by_tree.find((t) => t.id === ids[0]).percent, 1, 1e-9);
});

test('by_day > the window percent consumed on each of the last 14 days', () => {
  const a = agent('d-a');
  // Day 1: one interval moves the window 10%.
  reading(0, 50);
  sample(a, 5, 1000);
  reading(5, 60);
  // Day 2: the window resets at the day boundary (change 0 there), then moves 5%.
  reading(840, 0, RESET2);
  sample(a, 845, 1000);
  reading(845, 5, RESET2);
  const now = T0 + 850 * MIN;

  const s = attr.accountShares('claude', ['five_hour'], now).five_hour;
  assert.equal(s.by_day.length, 14);
  assert.equal(s.by_day[13].day, '2026-10-12', 'oldest first, today last');
  const byDay = Object.fromEntries(s.by_day.map((d) => [d.day, d.percent]));
  assert.equal(byDay['2026-10-11'], 10);
  assert.equal(byDay['2026-10-12'], 5);
  // The days add up to the change the calibration saw over the whole 14 days.
  const cal = attr.calibrate('claude', 'five_hour', now - 14 * DAY - 6 * 3_600_000, now);
  const total = cal.intervals.filter((iv) => Date.parse(iv.to) >= now - 14 * DAY).reduce((t, iv) => t + iv.change, 0);
  near(s.by_day.reduce((t, d) => t + d.percent, 0), total, 0.05, 'days sum to the change');
});

test('trees > a DAG counts each agent once and nests children', (t) => {
  // summary() reads the clock itself (it takes no now), so pin Date to just after the data (T0 + 10 min, the
  // subscription's updated_at) to keep the 7-day window and the readings on the data.
  t.mock.timers.enable({ apis: ['Date'], now: T0 + 10 * MIN });
  const root = agent('root');
  const x = agent('x', root);
  const y = agent('y', root);
  const z = agent('z', x);
  db.addParent(z, y); // z has two parents: root reaches it by two paths
  const outside = agent('outside');
  usageRow(root, 1, 100);
  usageRow(x, 2, 200);
  usageRow(y, 3, 300);
  usageRow(z, 4, 400);
  usageRow(outside, 5, 500);

  // A window where x, y, z and outside each ran 1,000 weighted tokens; Δ 4 → 1 each.
  reading(0, 10);
  for (const id of [x, y, z, outside]) sample(id, 5, 1000);
  reading(5, 14);
  db.open().prepare('INSERT INTO subscriptions (name, data, updated_at) VALUES (?, ?, ?)').run('claude', JSON.stringify({ five_hour: { used_percentage: 14, resets_at: RESET1 } }), iso(T0 + 10 * MIN));

  const s = usage.summary(7);
  const rootNode = s.trees.find((t) => t.name === 'root');
  assert.ok(rootNode, 'root tree present');
  // z counted once: 1 + 2 + 3 + 4 = 10 (14 if z were counted twice for its two parents).
  assert.equal(rootNode.cost_usd, 10);
  assert.equal(rootNode.tokens, 1000);
  const xN = rootNode.children.find((c) => c.name === 'x');
  const yN = rootNode.children.find((c) => c.name === 'y');
  assert.ok(xN, 'x is a child of root');
  assert.ok(yN, 'y is a child of root');
  assert.ok(xN.children.some((c) => c.name === 'z'), 'z under x');
  assert.ok(yN.children.some((c) => c.name === 'z'), 'z under y (a DAG)');
  assert.equal(xN.cost_usd, 6, 'x subtree: x + z');
  assert.equal(yN.cost_usd, 7, 'y subtree: y + z');
  near(rootNode.shares.claude.five_hour.percent, 3, 1e-9, 'tree share: x + y + z once');
  const outsideNode = s.trees.find((t) => t.name === 'outside');
  assert.equal(outsideNode.cost_usd, 5);
  near(outsideNode.shares.claude.five_hour.percent, 1, 1e-9);
});
