#!/usr/bin/env node
// Unit tests for build step 7 of docs/cost-policy.md: per-agent and per-tree estimated shares
// of a subscription window, from synthetic samples and window readings. Runs against a
// throwaway STAM_HOME with no daemon, no network, and no models:
// `node --test test/attribution.test.mjs`.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-attribution-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `attribution-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

// One account on the claude harness, and test models priced through the user's registry.json,
// which also proves that prices are overridden there the way registry entries are.
writeFileSync(
  join(home, 'settings.json'),
  JSON.stringify({ cost: { subscriptionWarnPercent: [80, 95], dailyWarnUsd: null, global: null, onError: 'soft-stop', accounts: { claude: { match: { harness: 'claude' } } } } }),
);
writeFileSync(
  join(home, 'registry.json'),
  JSON.stringify({
    prices: {
      'test-a': { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
      'test-b': { input: 2, output: 4, cacheRead: null, cacheWrite: 3 },
      'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    },
  }),
);

let db, attr, usage, registry;
before(async () => {
  db = await import('../src/db.ts');
  attr = await import('../src/attribution.ts');
  usage = await import('../src/usage.ts');
  registry = await import('../src/registry.ts');
});
after(() => rmSync(home, { recursive: true, force: true }));

const T0 = Date.parse('2026-10-11T10:00:00.000Z');
const MIN = 60_000;
const RESET1 = (T0 + 5 * 60 * MIN) / 1000;
const RESET2 = RESET1 + 5 * 3600;
const iso = (t) => new Date(t).toISOString();

let n = 0;
function agent(name, parent = null) {
  const id = `att-${++n}`;
  db.createAgent({ id, name, role: 'test', machine: 'x', harness: 'claude', model: 'test-a', effort: null, cwd: '/tmp', parent_id: parent, session_id: null });
  return id;
}
// Input tokens only, so with test-a a sample's weight is its token count.
function sample(agentId, minute, tokens, model = 'test-a') {
  db.open()
    .prepare('INSERT INTO usage_samples (agent_id, account, harness, model, bucket, tokens_in) VALUES (?, ?, ?, ?, ?, ?)')
    .run(agentId, 'claude', 'claude', model, iso(T0 + minute * MIN), tokens);
}
function reading(minute, used, resets = RESET1, window = 'five_hour') {
  db.open().prepare('INSERT INTO window_readings (name, window, at, used_percentage, resets_at) VALUES (?, ?, ?, ?, ?)').run('claude', window, iso(T0 + minute * MIN + 30_000), used, resets);
}
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);
const sum = (o) => Object.values(o).reduce((s, v) => s + v, 0);

beforeEach(() => {
  const d = db.open();
  d.exec('DELETE FROM usage_samples');
  d.exec('DELETE FROM window_readings');
  d.exec('DELETE FROM agent_parents');
  d.exec('DELETE FROM agents');
});

test('weights > API prices per token type, null type uses input, unknown model weighs 1', () => {
  const t = { tokens_in: 10, tokens_out: 1, tokens_cache_read: 100, tokens_cache_write: 2 };
  assert.equal(attr.weighted({ model: 'claude-opus-5-5', ...t }), 10 * 4 + 20 + 100 * 0.2 + 2 * 5);
  assert.equal(attr.weighted({ model: 'claude-opus-5-5[1m]', ...t }), 10 * 4 + 20 + 100 * 0.2 + 2 * 5);
  assert.equal(attr.weighted({ model: 'test-b', ...t }), 10 * 2 + 4 + 100 * 2 + 2 * 3);
  assert.equal(attr.weighted({ model: 'no-such-model', ...t }), 113);
  // The shipped defaults price every known model, Claude from the API price list.
  const prices = registry.registry().prices;
  assert.equal(prices['test-a'].input, 1, 'user prices merged by key');
  assert.deepEqual(prices['claude-haiku-5-5'], { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 });
  for (const m of Object.keys(registry.registry().models)) assert.ok(m in prices, `price entry for ${m}`);
});

test('calibration > fits percent per weighted token, EMA within 25%, and shares sum to the change', () => {
  const a = agent('cal-a');
  const b = agent('cal-b');
  reading(0, 10);
  // Interval 1 (buckets 5 and 10): a 1500, b 500, Δ 2 → seed 2 / 2000 = 0.001.
  sample(a, 5, 1000); sample(b, 5, 500); sample(a, 10, 500);
  reading(10, 12);
  // Interval 2: W 2000, Δ 2.2 → within 25% of 2, so the EMA moves toward 0.0011.
  sample(a, 15, 2000);
  reading(20, 14.2);
  const cal = attr.calibrate('claude', 'five_hour', T0 - MIN, T0 + 30 * MIN);
  assert.equal(cal.intervals.length, 2);
  const [i1, i2] = cal.intervals;
  close(i1.scale, 0.001, 'seed');
  close(i1.agents[a], 1.5, 'a has 3/4 of Δ');
  close(i1.agents[b], 0.5, 'b has 1/4 of Δ');
  const alpha = 1 - Math.exp(-(10 * MIN) / (2 * 3_600_000));
  close(i2.scale, 0.001 + alpha * (0.0011 - 0.001), 'EMA step');
  assert.equal(i2.reset, null);
  for (const iv of cal.intervals) close(sum(iv.agents) + iv.other, iv.change, 'shares + other = change');
  const s = attr.windowShares('claude', 'five_hour', iso(T0), T0 + 30 * MIN);
  close(s.change, 4.2, 'total change');
  close(sum(s.agents) + s.other, s.change, 'window shares sum to the change');
  close(s.other, 0, 'no other');
  assert.equal(s.estimate, true);
});

test('other > a change no stam tokens explain, and a miss over 25% resets the fit', () => {
  const a = agent('other-a');
  reading(0, 10);
  sample(a, 5, 2000);
  reading(5, 12); // seed 0.001
  // Nothing ran: all of Δ is other, and the scale is kept.
  reading(10, 13);
  // Δ 4 where 2 was predicted: 2 to the agent, 2 to other, and the fit restarts at 0.002.
  sample(a, 15, 2000);
  reading(15, 17);
  const cal = attr.calibrate('claude', 'five_hour', T0 - MIN, T0 + 20 * MIN);
  const [, idle, spike] = cal.intervals;
  close(idle.other, 1, 'idle interval is other');
  close(idle.scale, 0.001, 'scale kept with no tokens');
  assert.equal(spike.reset, 'miss');
  close(spike.agents[a], 2, 'agent gets the prediction');
  close(spike.other, 2, 'the rest is other');
  close(spike.scale, 0.002, 'reseeded');
  const s = attr.windowShares('claude', 'five_hour', iso(T0), T0 + 20 * MIN);
  close(s.other, 3, 'other over the window');
  close(sum(s.agents) + s.other, 7, 'sum is the change');
});

test('reset > a new window counts from zero, only tokens after the reset, and the fit restarts', () => {
  const a = agent('reset-a');
  reading(280, 90);
  sample(a, 285, 1000);
  reading(285, 91); // seed 0.001
  // The window resets at minute 300; tokens at 295 belong to the old window.
  sample(a, 295, 5000);
  sample(a, 300, 3000);
  reading(300, 6, RESET2);
  const cal = attr.calibrate('claude', 'five_hour', T0, T0 + 310 * MIN);
  const iv = cal.intervals[1];
  assert.equal(iv.reset, 'window');
  close(iv.change, 6, 'change from zero');
  close(iv.weighted, 3000, 'only tokens from the reset on');
  close(iv.scale, 0.002, 'reseeded from the new window');
  close(iv.agents[a], 6, 'all of it to the agent');
  // The current period starts at the reset.
  const s = attr.windowShares('claude', 'five_hour', undefined, T0 + 310 * MIN);
  assert.equal(s.since, iso(RESET1 * 1000));
  close(s.change, 6, 'only the new window');
});

test('tree > a DAG counts each agent once', () => {
  const root = agent('root');
  const x = agent('x', root);
  const y = agent('y', root);
  const z = agent('z', x);
  db.addParent(z, y); // z has two parents: root reaches it twice
  const outside = agent('outside');
  reading(0, 10);
  sample(x, 5, 1000); sample(y, 5, 1000); sample(z, 5, 1000); sample(outside, 5, 1000);
  reading(5, 14);
  const s = attr.windowShares('claude', 'five_hour', iso(T0), T0 + 10 * MIN);
  assert.deepEqual([...attr.treeMembers(root)].sort(), [root, x, y, z].sort());
  close(attr.treeShare(root, 'claude', 'five_hour', iso(T0), s), 3, 'x + y + z once each');
  close(attr.treeShare(x, 'claude', 'five_hour', iso(T0), s), 2, 'x and z');
  close(attr.treeShare(y, 'claude', 'five_hour', iso(T0), s), 2, 'y and z');
  // The summary lists trees by their roots and the tree view counts z once.
  const tree = attr.treeSummary(root, T0 + 10 * MIN);
  close(tree.accounts.claude.five_hour.percent, 3, 'tree summary');
  const shares = attr.accountShares('claude', ['five_hour'], T0 + 10 * MIN).five_hour;
  assert.equal(shares.trees[0].root, 'root');
  assert.equal(shares.trees[0].percent, 3);
  assert.equal(shares.agents.length, 4);
});

test('projection > burn rate of the last 30 minutes times the scale, or null', () => {
  const a = agent('proj-a');
  reading(0, 40);
  sample(a, 5, 2000);
  reading(5, 42); // scale 0.001
  // Last 30 minutes before minute 35: buckets 10..35 → 6000 weighted → 6% per 30 min.
  for (const m of [10, 20, 30]) sample(a, m, 2000);
  reading(30, 48);
  const now = T0 + 35 * MIN;
  const s = attr.windowShares('claude', 'five_hour', iso(T0), now);
  const p = s.projection;
  assert.equal(p.estimate, true);
  assert.equal(p.used_percentage, 48);
  close(s.scale, 0.001, 'scale held');
  close(p.percent_per_hour, 12, '6% per 30 minutes');
  assert.equal(p.reaches_100_at, iso(now + (52 / 12) * 3_600_000));
  // A window that resets first projects null.
  db.open().exec('DELETE FROM window_readings');
  reading(0, 40); reading(5, 42); reading(30, 48, (T0 + 60 * MIN) / 1000);
  const q = attr.windowShares('claude', 'five_hour', iso(T0), now).projection;
  assert.equal(q.reaches_100_at, null);
  // No readings, no projection.
  db.open().exec('DELETE FROM window_readings');
  assert.equal(attr.windowShares('claude', 'five_hour', iso(T0), now).projection.reaches_100_at, null);
});

test('projection > an inflated scale with flat readings projects no 100%', () => {
  const a = agent('proj-flat');
  reading(0, 40);
  sample(a, 5, 1000);
  reading(5, 41); // scale 0.001 from one small interval
  // A burst after the seed: the scale says 6% per 30 minutes, the readings show no rise.
  for (const m of [10, 20, 30]) sample(a, m, 2000);
  reading(30, 41);
  const now = T0 + 35 * MIN;
  const p = attr.windowShares('claude', 'five_hour', iso(T0), now).projection;
  assert.equal(p.reaches_100_at, null);
  assert.equal(p.percent_per_hour, 0);
  assert.equal(p.note, 'readings show no rise in the last 30 minutes');
  // A seed from one big Δ inflates the scale: 120% per hour over this burst. The readings show
  // 2% in 25 minutes (4.8% per hour), so the projection is capped there.
  db.open().exec('DELETE FROM window_readings');
  const b = agent('proj-cap');
  reading(0, 40);
  sample(b, 5, 1000);
  reading(5, 50); // scale 0.01
  for (const m of [10, 20, 30]) sample(b, m, 2000);
  reading(30, 52);
  const c = attr.windowShares('claude', 'five_hour', iso(T0), now).projection;
  assert.ok(c.percent_per_hour <= 4.8 + 1e-9, `capped at the readings' rate, got ${c.percent_per_hour}`);
  assert.ok(c.percent_per_hour > 0);
  db.open().exec('DELETE FROM window_readings');
});

test('projection > a reset inside the 30 minutes gives no rise, so no 100% (S-532)', () => {
  // The seven-day window read 52%, reset to 2% at minute 8 (a new resets_at), and read 51% at
  // minute 30. The span since the reset rises 49 points in 22 minutes, which is no real burn: the
  // reset falls inside the 30 minutes, so the readings support no rate and the projection is null.
  const a = agent('proj-reset');
  reading(0, 52, RESET1, 'seven_day');
  reading(8, 2, RESET2, 'seven_day');
  reading(30, 51, RESET2, 'seven_day');
  sample(a, 2, 1000);
  sample(a, 7, 1000);
  for (const m of [10, 20, 30]) sample(a, m, 2000);
  const now = T0 + 35 * MIN;
  const s = attr.windowShares('claude', 'seven_day', iso(T0), now);
  assert.ok(s.scale != null, 'calibrated, so only the rise can stop the projection');
  assert.equal(s.projection.reaches_100_at, null);
  assert.equal(s.projection.percent_per_hour, 0);
  assert.equal(s.projection.note, 'window began in the last 30 minutes');
});

test('calibrate > a bogus low reading with an unchanged reset time is no reset (S-3243)', () => {
  // The seven-day window read 52%, 2%, then 51% under one resets_at: a window can't fall, so the
  // 2% is dropped. Counting it a reset charged the whole 51 points to the agent.
  const a = agent('bogus-low');
  reading(0, 52, RESET1, 'seven_day');
  sample(a, 2, 1000);
  reading(8, 2, RESET1, 'seven_day');
  sample(a, 12, 1000);
  reading(30, 51, RESET1, 'seven_day');
  const cal = attr.calibrate('claude', 'seven_day', T0, T0 + 35 * MIN);
  assert.equal(cal.current.used, 51, 'the isolated 2% is dropped');
  assert.ok(cal.intervals.every((iv) => iv.reset !== 'window' && iv.change <= 1));
  const s = attr.windowShares('claude', 'seven_day', iso(T0), T0 + 35 * MIN);
  assert.ok(s.change < 5, `no 51-point charge, got ${s.change}`);
  assert.equal(s.projection.reaches_100_at, null);
});

test('calibrate > a drop past the old reset time is a reset (S-3243)', () => {
  const a = agent('real-reset');
  reading(0, 52, RESET1, 'seven_day');
  sample(a, 2, 1000);
  // Same resets_at, but the reading is after it: the window has passed its reset.
  const at = RESET1 * 1000 + 5 * MIN - T0;
  db.open().prepare('INSERT INTO window_readings (name, window, at, used_percentage, resets_at) VALUES (?, ?, ?, ?, ?)').run('claude', 'seven_day', iso(T0 + at), 3, RESET1);
  const cal = attr.calibrate('claude', 'seven_day', T0, T0 + at + 10 * MIN);
  assert.equal(cal.intervals.at(-1).reset, 'window');
  close(cal.intervals.at(-1).change, 3, 'counted from zero');
});

test('calibrate > an isolated bogus high is dropped, and the window is not frozen (S-3243)', () => {
  const a = agent('bogus-high');
  reading(0, 40, RESET1, 'seven_day');
  sample(a, 2, 1000);
  reading(8, 95, RESET1, 'seven_day');
  sample(a, 12, 1000);
  reading(15, 41, RESET1, 'seven_day');
  sample(a, 17, 1000);
  reading(25, 43, RESET1, 'seven_day');
  const cal = attr.calibrate('claude', 'seven_day', T0, T0 + 35 * MIN);
  assert.equal(cal.current.used, 43, 'later readings still count after the bogus 95');
  const s = attr.windowShares('claude', 'seven_day', iso(T0), T0 + 35 * MIN);
  close(s.change, 3, '40 to 43');
});

test('calibrate > a lasting small drop is a correction: no change, no reset (S-3243)', () => {
  const a = agent('correction');
  reading(0, 52, RESET1, 'seven_day');
  sample(a, 2, 1000);
  reading(8, 51, RESET1, 'seven_day');
  sample(a, 12, 1000);
  reading(15, 51, RESET1, 'seven_day');
  reading(20, 53, RESET1, 'seven_day');
  const cal = attr.calibrate('claude', 'seven_day', T0, T0 + 35 * MIN);
  assert.ok(cal.intervals.every((iv) => iv.reset !== 'window'));
  assert.equal(cal.intervals[0].change, 0);
  const s = attr.windowShares('claude', 'seven_day', iso(T0), T0 + 35 * MIN);
  close(s.change, 2, 'only the rise from the new baseline');
});

test('calibrate > a fall with a null reset time is still a reset (S-3243)', () => {
  const a = agent('null-reset');
  reading(0, 52, null, 'seven_day');
  sample(a, 2, 1000);
  reading(8, 3, null, 'seven_day');
  const cal = attr.calibrate('claude', 'seven_day', T0, T0 + 35 * MIN);
  assert.equal(cal.intervals[0].reset, 'window');
  close(cal.intervals[0].change, 3, 'counted from zero');
});

test('projection > calibrate and the projection judge a bogus high the same over different ranges (S-3243)', () => {
  const a = agent('range');
  // The bogus 95 sits 8 hours back: outside observedRate's 6-hour range, inside calibrate's.
  reading(0, 40, RESET1, 'seven_day');
  reading(10, 95, RESET1, 'seven_day');
  reading(20, 41, RESET1, 'seven_day');
  sample(a, 25, 1000);
  reading(8 * 60 + 25, 42, RESET1, 'seven_day');
  for (const m of [8 * 60 + 30, 8 * 60 + 40]) sample(a, m, 1000);
  reading(8 * 60 + 45, 43, RESET1, 'seven_day');
  const now = T0 + (8 * 60 + 50) * MIN;
  const cal = attr.calibrate('claude', 'seven_day', T0, now);
  assert.equal(cal.current.used, 43);
  const p = attr.windowShares('claude', 'seven_day', iso(T0), now).projection;
  assert.equal(p.used_percentage, 43);
  assert.ok(p.percent_per_hour == null || p.percent_per_hour < 20, `no false burn, got ${p.percent_per_hour}`);
});

test('summary > each account carries shares, and a tree view when asked', () => {
  const a = agent('sum-a');
  reading(0, 10);
  sample(a, 5, 1000);
  reading(5, 11);
  db.open().prepare('INSERT INTO subscriptions (name, data, updated_at) VALUES (?, ?, ?)').run('claude', JSON.stringify({ five_hour: { used_percentage: 11, resets_at: RESET1 } }), iso(Date.now()));
  const s = usage.summary(7, a);
  const acct = s.accounts.find((x) => x.account === 'claude');
  assert.ok(acct.shares.five_hour, 'shares per window');
  assert.equal(acct.shares.five_hour.estimate, true);
  assert.match(s.shares_note, /Estimates/);
  assert.equal(s.tree.agent, 'sum-a');
  db.open().exec("DELETE FROM subscriptions");
});

test('snapshot memo > a narrower range is cut from the widest one read, and nothing outlives the callback', () => {
  const a = agent('memo-a');
  sample(a, 5, 1000); sample(a, 15, 500); sample(a, 25, 700);
  reading(0, 10); reading(10, 12); reading(20, 14); reading(30, 15);
  const wide = attr.calibrate('claude', 'five_hour', T0 - 60 * MIN, T0 + 40 * MIN);
  const narrow = attr.calibrate('claude', 'five_hour', T0 + 9 * MIN, T0 + 40 * MIN);
  const both = attr.withSampleMemo(() => [
    attr.calibrate('claude', 'five_hour', T0 - 60 * MIN, T0 + 40 * MIN),
    attr.calibrate('claude', 'five_hour', T0 + 9 * MIN, T0 + 40 * MIN),
  ]);
  assert.deepEqual(both, [wide, narrow], 'the memo changes no result');
  // A sample written after the callback is read: the memo is gone.
  attr.withSampleMemo(() => attr.calibrate('claude', 'five_hour', T0 - 60 * MIN, T0 + 40 * MIN));
  sample(a, 28, 300);
  const after = attr.calibrate('claude', 'five_hour', T0 - 60 * MIN, T0 + 40 * MIN);
  assert.notDeepEqual(after, wide);
});

test('kindCosts prices each token kind and the total (S-1440)', () => {
  const t = { tokens_in: 1_000_000, tokens_out: 500_000, tokens_cache_read: 10_000_000, tokens_cache_write: 200_000 };
  const c = attr.kindCosts('claude-opus-5-5', t);
  close(c.cost_in, 4, 'in');
  close(c.cost_out, 10, 'out');
  close(c.cost_cache_read, 2, 'cache read');
  close(c.cost_cache_write, 1, 'cache write');
  close(c.cost_api_total, 17, 'total');
  // The context suffix is ignored, as for the weights.
  close(attr.kindCosts('claude-opus-5-5[1m]', t).cost_api_total, 17, 'suffix');
});

test('kindCosts leaves a null price, an unknown model and an unreported counter null (S-1440)', () => {
  const t = { tokens_in: 1_000_000, tokens_out: 0, tokens_cache_read: 1_000_000, tokens_cache_write: null };
  // test-b has no cache-read price: that kind and the total are null, the priced kinds stay.
  const b = attr.kindCosts('test-b', t);
  close(b.cost_in, 2, 'in');
  assert.equal(b.cost_cache_read, null);
  assert.equal(b.cost_cache_write, null);
  assert.equal(b.cost_api_total, null);
  // No price at all, or no model.
  assert.deepEqual(Object.values(attr.kindCosts('nope', t)), [null, null, null, null, null]);
  assert.deepEqual(Object.values(attr.kindCosts(null, t)), [null, null, null, null, null]);
  // Only priced kinds reported: the total sums them even with a counter the harness lacks.
  close(attr.kindCosts('test-a', { tokens_in: 1_000_000, tokens_out: 1_000_000, tokens_cache_read: null, tokens_cache_write: null }).cost_api_total, 2, 'partial report');
});
