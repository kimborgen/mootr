#!/usr/bin/env node
// Unit tests for src/issue-costs.ts (S-155, part 2): issue costs from synthetic usage samples
// and ITSA events. A seeded throwaway STAM_HOME, no daemon, no network, no models:
// `node --test test/issue-costs.test.mjs`.
//
// Seeded story, T0 = 10:00Z. Agents A, B, D, E exist from T0-1h; C from T0+30m; H is a child of A,
// so A is a manager.
//   P  project (A owns; in_progress from T0), children:
//   C1 issue (A owns, B participates): todo, in_progress at +20m, done at +60m
//   C2 issue (B owns, C participates): in_progress; owner B -> A at +50m
//   C3 issue (D owns, A participates, opencode/deepseek): in_progress; done at +30m
// Samples (cost in $; tokens_in = cost × 1000) and what each should land on are in the cases below.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-issue-costs-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `issue-costs-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

writeFileSync(
  join(home, 'settings.json'),
  JSON.stringify({
    cost: {
      subscriptionWarnPercent: [80, 95],
      dailyWarnUsd: null,
      global: null,
      onError: 'soft-stop',
      accounts: {
        claude: { match: { harness: 'claude' } },
        openrouter: { match: { harness: 'opencode' }, paid: true },
      },
    },
  }),
);

let db, ic, usage;
before(async () => {
  db = await import('../src/db.ts');
  usage = await import('../src/usage.ts');
  ic = await import('../src/issue-costs.ts');
});
after(() => rmSync(home, { recursive: true, force: true }));

const T0 = Date.parse('2026-10-11T10:00:00.000Z');
const MIN = 60_000;
const iso = (t) => new Date(t).toISOString();
const at = (min) => iso(T0 + min * MIN);
const HOUR_BEFORE = iso(T0 - 60 * MIN);
const HAIKU = { harness: 'claude', model: 'claude-haiku-5-5' };
const DEEPSEEK = { harness: 'opencode', model: 'deepseek-v4' };
// Stub: the claude account's 7-day worth is $50; the paid account has none.
const worthMid = (account) => (account === 'claude' ? 50 : null);

function makeAgent(id, created, parent = null) {
  db.createAgent({ id, name: id, role: 'test', machine: 'x', harness: 'claude', model: null, effort: null, cwd: '/tmp', parent_id: parent, session_id: null });
  db.open().prepare('UPDATE agents SET created_at = ? WHERE id = ?').run(created, id);
}

function seed() {
  const d = db.open();
  for (const t of ['usage_samples', 'itsa_events', 'itsa_participants', 'itsas', 'agents']) d.exec(`DELETE FROM ${t}`);
  makeAgent('A', HOUR_BEFORE);
  makeAgent('B', HOUR_BEFORE);
  makeAgent('D', HOUR_BEFORE);
  makeAgent('E', HOUR_BEFORE);
  makeAgent('C', at(30));
  makeAgent('H', HOUR_BEFORE, 'A');

  const itsa = (id, key, parent, kind, status, owner, createdAt, closedAt = null) =>
    d.prepare('INSERT INTO itsas (id, key, parent_id, kind, title, status, owner, created_by, created_at, updated_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, key, parent, kind, `${key} title`, status, owner, 'A', createdAt, createdAt, closedAt,
    );
  const event = (id, ts, type, data) =>
    d.prepare('INSERT INTO itsa_events (itsa_id, ts, actor, type, data) VALUES (?, ?, ?, ?, ?)').run(id, ts, 'A', type, JSON.stringify(data));
  const participant = (id, agentId) => d.prepare('INSERT INTO itsa_participants (itsa_id, agent_id) VALUES (?, ?)').run(id, agentId);

  itsa('p', 'P-1', null, 'project', 'in_progress', 'A', HOUR_BEFORE);
  event('p', HOUR_BEFORE, 'created', { key: 'P-1', title: 'P-1 title', status: 'backlog' });
  event('p', at(0), 'status', { from: 'backlog', to: 'in_progress' });

  itsa('c1', 'C-1', 'p', 'issue', 'done', 'A', HOUR_BEFORE, at(60));
  event('c1', HOUR_BEFORE, 'created', { key: 'C-1', title: 'C-1 title', status: 'todo' });
  event('c1', at(20), 'status', { from: 'todo', to: 'in_progress' });
  event('c1', at(60), 'status', { from: 'in_progress', to: 'done' });
  participant('c1', 'B');

  itsa('c2', 'C-2', 'p', 'issue', 'in_progress', 'A', HOUR_BEFORE);
  event('c2', HOUR_BEFORE, 'created', { key: 'C-2', title: 'C-2 title', status: 'in_progress' });
  event('c2', at(50), 'owner', { from: 'B', to: 'A' });
  participant('c2', 'C');

  itsa('c3', 'C-3', null, 'issue', 'done', 'D', HOUR_BEFORE, at(30));
  event('c3', HOUR_BEFORE, 'created', { key: 'C-3', title: 'C-3 title', status: 'in_progress' });
  event('c3', at(30), 'status', { from: 'in_progress', to: 'done' });
  participant('c3', 'A');

  const sample = (agent, min, { harness, model }, cost, account = harness === 'claude' ? 'claude' : 'openrouter') => {
    d.prepare(
      'INSERT INTO usage_samples (agent_id, account, harness, model, bucket, cost_usd, tokens_in) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(agent, account, harness, model, at(min), cost, cost * 1000);
  };
  sample('B', 10, HAIKU, 4);
  sample('A', 10, HAIKU, 6);
  sample('A', 30, HAIKU, 10);
  sample('B', 30, HAIKU, 8);
  sample('A', 60, HAIKU, 9);
  sample('B', 70, HAIKU, 6);
  sample('C', 40, HAIKU, 5);
  sample('D', 10, DEEPSEEK, 2);
  sample('D', 40, DEEPSEEK, 3);
  sample('E', 10, HAIKU, 1.5);
}

const close = (a, b, msg, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} != ${b}`);
const byKey = (r, key) => r.issues.find((x) => x.key === key);

beforeEach(seed);

test('time split > an agent counts toward the ITSAs it owns or joins while they are active', () => {
  const r = ic.issueCosts({ worthMid });
  // A at +10m: P-1 is its only owned active ITSA (C-1 is still todo), so all 6 goes to P-1.
  // B at +10m: C-2 is B's owned active ITSA, so all 4 goes to C-2 (C-1 is still todo).
  // A at +30m: P-1 and C-1 are both owned and in progress, so 10 splits 5 and 5.
  // B at +30m: C-2 is owned by B and active, so all 8 goes there; C-1 (participant) gets none.
  // A at +60m: C-1 is done, so 9 splits between P-1 and C-2 (owner since +50m) as 4.5 each.
  assert.equal(byKey(r, 'C-2').own.cost_usd, 4 + 8 + 4.5 + 3 + 5);
  assert.equal(byKey(r, 'C-1').own.cost_usd, 5 + 3);
  assert.equal(byKey(r, 'P-1').own.cost_usd, 6 + 5 + 4.5);
  assert.equal(byKey(r, 'C-2').own.tokens_in, 24500, 'tokens follow the split too');
});

test('even fallback > with no active ITSA, a sample splits over all the agent\'s ITSAs', () => {
  const r = ic.issueCosts({ worthMid });
  // B at +70m: C-1 is done and C-2 is owned by A, so B\'s ITSAs are C-1 and C-2, 3 each.
  // D at +40m: C-3 is done, so all of D\'s ITSAs (C-3 only) take it.
  const c1 = byKey(r, 'C-1');
  assert.equal(c1.own.cost_usd, 5 + 3, 'C-1 got 3 of B\'s 6 at +70m');
  assert.equal(byKey(r, 'C-3').own.cost_usd, 2 + 3);
});

test('C agent before and after its creation > samples count only once it exists', () => {
  const r = ic.issueCosts({ worthMid });
  // C was created at +30m, so its +40m sample goes to C-2, the only ITSA it participates in.
  assert.equal(byKey(r, 'C-2').agents, 3, 'C-2 has spend from B, A, and C');
});

test('unattributed > an agent with no ITSA goes to unattributed, and the totals add up', () => {
  const r = ic.issueCosts({ worthMid });
  assert.equal(r.unattributed.cost_usd, 1.5);
  assert.equal(r.unattributed.tokens_in, 1500);
  assert.equal(r.all.cost_usd, 54.5);
  const own = r.issues.reduce((s, x) => s + x.own.cost_usd, 0);
  close(own + r.unattributed.cost_usd, r.all.cost_usd, 'own + unattributed = all');
});

test('own vs total > a parent\'s total adds each child\'s own once', () => {
  const r = ic.issueCosts({ worthMid });
  const p = byKey(r, 'P-1');
  close(p.own.cost_usd, 6 + 5 + 4.5, 'P-1 own');
  close(p.total.cost_usd, p.own.cost_usd + byKey(r, 'C-1').own.cost_usd + byKey(r, 'C-2').own.cost_usd, 'P-1 total = own + children');
  assert.equal(byKey(r, 'C-3').total.cost_usd, byKey(r, 'C-3').own.cost_usd, 'a leaf totals its own');
  assert.equal(r.issues[0].key, 'P-1', 'issues sort by total cost, largest first');
});

test('weekly percent > subscription spend over the 7-day worth; null on paid spend', () => {
  const r = ic.issueCosts({ worthMid });
  close(byKey(r, 'C-1').weekly_percent, (8 / 50) * 100, 'C-1 weekly');
  close(byKey(r, 'C-2').weekly_percent, (24.5 / 50) * 100, 'C-2 weekly');
  assert.equal(byKey(r, 'C-3').weekly_percent, null, 'paid account has no weekly percent');
  const uncal = ic.issueCosts({ worthMid: () => null });
  assert.equal(byKey(uncal, 'C-1').weekly_percent, null, 'an uncalibrated window gives null');
});

test('display cost > window percents count only spend since the current window began', () => {
  const display = { kind: (a) => (a === 'claude' ? 'subscription' : 'paid'), price: () => null, worth: (a, w) => (a === 'claude' ? (w === 'five_hour' ? 10 : 50) : null) };
  // No readings: a window began its length before `now`. At +80m every sample is inside both.
  const inside = byKey(ic.issueCosts({ display, now: T0 + 80 * MIN }), 'C-1').cost;
  close(inside.own.seven_day, (8 / 50) * 100, 'seven_day inside');
  close(inside.own.five_hour, (8 / 10) * 100, 'five_hour inside');
  const p = byKey(ic.issueCosts({ display, now: T0 + 80 * MIN }), 'P-1').cost;
  const kids = ['C-1', 'C-2'].map((k) => byKey(ic.issueCosts({ display, now: T0 + 80 * MIN }), k).cost.own);
  for (const w of ['five_hour', 'seven_day']) {
    close(p.total[w], p.own[w] + kids[0][w] + kids[1][w], `P-1 total ${w} = own + children`);
    close(inside.total[w], inside.own[w], `a leaf's total ${w} is its own`);
  }
  // Eight days on, none is: 0, not null.
  const later = byKey(ic.issueCosts({ display, now: T0 + 8 * 24 * 60 * MIN }), 'C-1').cost;
  assert.equal(later.own.seven_day, 0);
  assert.equal(later.own.five_hour, 0);
  // An uncalibrated worth gives null for an ITSA with spend in the window.
  const uncal = byKey(ic.issueCosts({ display: { ...display, worth: () => null }, now: T0 + 80 * MIN }), 'C-1').cost;
  assert.equal(uncal.own.seven_day, null);
});

test('config > the harness and model with the largest share of own cost', () => {
  const r = ic.issueCosts({ worthMid });
  assert.equal(byKey(r, 'C-1').config, 'claude · claude-haiku-5-5');
  assert.equal(byKey(r, 'C-3').config, 'opencode · deepseek-v4');
  assert.equal(byKey(r, 'C-2').agents, 3);
  assert.equal(byKey(r, 'C-1').agents, 2);
});

test('owner first > a manager participating in a leaf it does not own gets nothing there', () => {
  const r = ic.issueCosts({ worthMid });
  // A (a manager) participates in C-3 but owns P-1, which is active: its +10m sample goes to P-1 only.
  assert.equal(byKey(r, 'C-3').own.cost_usd, 2 + 3, 'C-3 has D\'s spend only');
  assert.equal(byKey(r, 'C-3').agents, 1);
});

test('owner first > a manager owning a leaf still lands its spend there, counted as manager cost', () => {
  const r = ic.issueCosts({ worthMid });
  // A owns C-1 (+30m, 5), C-2 (+60m, 4.5) and P-1 (15.5); the workers B and C and D have no manager cost.
  assert.equal(byKey(r, 'C-1').own.manager_cost_usd, 5);
  assert.equal(byKey(r, 'C-2').own.manager_cost_usd, 4.5);
  assert.equal(byKey(r, 'P-1').own.manager_cost_usd, 6 + 5 + 4.5);
  assert.equal(byKey(r, 'C-3').own.manager_cost_usd, 0);
});

test('config > a manager\'s larger share does not set the config; the workers\' does', () => {
  const d = db.open();
  makeAgent('G', HOUR_BEFORE);
  makeAgent('K', HOUR_BEFORE, 'G');
  makeAgent('F', HOUR_BEFORE);
  // M-1 is owned by manager G and in progress; worker F participates. Both sample at +5m.
  // G's Opus 30 goes all to M-1 (owned); F's Haiku 2 goes to M-1 as its participation.
  d.prepare("INSERT INTO itsas (id, key, kind, title, status, owner, created_by, created_at, updated_at) VALUES ('m1', 'M-1', 'issue', 'm1', 'in_progress', 'G', 'A', ?, ?)").run(HOUR_BEFORE, HOUR_BEFORE);
  d.prepare("INSERT INTO itsa_events (itsa_id, ts, actor, type, data) VALUES ('m1', ?, 'A', 'created', '{\"status\":\"in_progress\"}')").run(HOUR_BEFORE);
  d.prepare('INSERT INTO itsa_participants (itsa_id, agent_id) VALUES (?, ?)').run('m1', 'F');
  for (const [agent, model, cost] of [['G', 'claude-opus-5-5', 30], ['F', 'claude-haiku-5-5', 2]]) {
    d.prepare('INSERT INTO usage_samples (agent_id, account, harness, model, bucket, cost_usd, tokens_in) VALUES (?, ?, ?, ?, ?, ?, ?)').run(agent, 'claude', 'claude', model, at(5), cost, cost * 1000);
  }
  const x = ic.itsaCost('M-1', { worthMid });
  assert.equal(x.own.cost_usd, 32);
  assert.equal(x.own.manager_cost_usd, 30);
  assert.equal(x.config, 'claude · claude-haiku-5-5', 'the manager\'s Opus share is ignored');
});

test('config > a parent of a peer agent, and an adopting parent, count as managers (S-1620)', () => {
  const d = db.open();
  makeAgent('G', HOUR_BEFORE);
  makeAgent('G2', HOUR_BEFORE);
  makeAgent('K2', HOUR_BEFORE);
  makeAgent('F', HOUR_BEFORE);
  db.rememberPeerAgent({ id: 'peerkid', name: 'peerkid', machine: 'there', parents: ['G'] });
  d.prepare('INSERT INTO agent_parents (child_id, parent_id) VALUES (?, ?)').run('K2', 'G2');
  for (const [id, key, owner] of [['m1', 'M-1', 'G'], ['m2', 'M-2', 'G2']]) {
    d.prepare("INSERT INTO itsas (id, key, kind, title, status, owner, created_by, created_at, updated_at) VALUES (?, ?, 'issue', ?, 'in_progress', ?, 'A', ?, ?)").run(id, key, key, owner, HOUR_BEFORE, HOUR_BEFORE);
    d.prepare("INSERT INTO itsa_events (itsa_id, ts, actor, type, data) VALUES (?, ?, 'A', 'created', '{\"status\":\"in_progress\"}')").run(id, HOUR_BEFORE);
    d.prepare('INSERT INTO itsa_participants (itsa_id, agent_id) VALUES (?, ?)').run(id, 'F');
  }
  for (const [agent, model, cost] of [['G', 'claude-opus-5-5', 30], ['G2', 'claude-opus-5-5', 20], ['F', 'claude-haiku-5-5', 2]]) {
    d.prepare('INSERT INTO usage_samples (agent_id, account, harness, model, bucket, cost_usd, tokens_in) VALUES (?, ?, ?, ?, ?, ?, ?)').run(agent, 'claude', 'claude', model, at(5), cost, cost * 1000);
  }
  const r = ic.issueCosts({ worthMid });
  assert.equal(byKey(r, 'M-1').own.manager_cost_usd, 30, 'G has only a peer child');
  assert.equal(byKey(r, 'M-1').config, 'claude · claude-haiku-5-5');
  assert.equal(byKey(r, 'M-2').own.manager_cost_usd, 20, 'G2 has only an adopted child');
  assert.equal(byKey(r, 'M-2').config, 'claude · claude-haiku-5-5');
});

test('by_config > closed issues with spend, per config, with median/average/min/max of own cost', () => {
  const r = ic.issueCosts({ worthMid });
  assert.deepEqual(
    r.by_config.map((g) => g.config),
    ['claude · claude-haiku-5-5', 'opencode · deepseek-v4'],
  );
  const haiku = r.by_config[0];
  assert.deepEqual(
    { n: haiku.n, median: haiku.median, average: haiku.average, min: haiku.min, max: haiku.max },
    { n: 1, median: 8, average: 8, min: 8, max: 8 },
  );
  close(haiku.median_weekly_percent, 16, 'median weekly percent');
  assert.equal(r.by_config[1].median_weekly_percent, null);
});

test('typicalIssue > issues closed in the last 28 days at their whole cost, complete history only, memoized', () => {
  const DAY = 86_400_000;
  const typical = (now) => {
    ic.resetTypicalMemo();
    return ic.typicalIssue('claude · claude-haiku-5-5', { worthMid, now });
  };
  const t = typical(T0 + 120 * MIN);
  assert.deepEqual(
    { estimate: t.estimate, n: t.n, median_cost_usd: t.median_cost_usd },
    { estimate: true, n: 1, median_cost_usd: 8 },
  );
  assert.match(t.note, /closed in the last 28 days/);
  close(t.median_weekly_percent, 16, 'median weekly percent');
  assert.equal(ic.typicalIssue('codex · none', { worthMid, now: T0 + 120 * MIN }), null);
  // Closed 28 days minus 30 minutes ago: C-1's spend before the 28 days still counts in full.
  assert.equal(typical(T0 + 28 * DAY + 30 * MIN).median_cost_usd, 8);
  // Closed before the 28 days: left out.
  assert.equal(typical(T0 + 30 * DAY), null);
  // Memoized: a change within 10 minutes is not seen; after a reset it is.
  ic.resetTypicalMemo();
  assert.equal(ic.typicalIssue('claude · claude-haiku-5-5', { worthMid, now: T0 + 120 * MIN }).n, 1);
  db.open().prepare('UPDATE itsas SET created_at = ? WHERE id = ?').run(iso(T0 - 60 * DAY), 'c1');
  assert.equal(ic.typicalIssue('claude · claude-haiku-5-5', { worthMid, now: T0 + 125 * MIN }).n, 1);
  // Created before the 35 days usage samples are kept: its history is incomplete, so it is left
  // out. Closed 26 days ago and created 36 days ago, with the samples pruned as ingestion does.
  const now = T0 + 26 * DAY;
  usage.pruneSamples(now);
  db.open().prepare('UPDATE itsas SET created_at = ? WHERE id = ?').run(iso(T0 - 10 * DAY), 'c1');
  assert.equal(typical(now), null);
  assert.match(ic.TYPICAL_NOTE, /created in the last 35/);
  // Created 34 days ago: complete, at its whole cost.
  db.open().prepare('UPDATE itsas SET created_at = ? WHERE id = ?').run(iso(T0 - 8 * DAY), 'c1');
  assert.equal(typical(now).median_cost_usd, 8);
});

test('by_config > the median of an odd count, and the average over all', () => {
  const d = db.open();
  // Two more closed haiku issues, owned by F and G with 2 and 8 of spend (F and G work nowhere else):
  // with C-1 at 8, the costs are 2, 8 and 8, so the median is 8 and the average 18 / 3.
  makeAgent('F', HOUR_BEFORE);
  makeAgent('G', HOUR_BEFORE);
  for (const [id, key, owner] of [['x1', 'X-1', 'F'], ['x2', 'X-2', 'G']]) {
    d.prepare("INSERT INTO itsas (id, key, kind, title, status, owner, created_by, created_at, updated_at, closed_at) VALUES (?, ?, 'issue', 'x', 'done', ?, 'A', ?, ?, ?)").run(id, key, owner, at(0), at(0), at(0));
    d.prepare("INSERT INTO itsa_events (itsa_id, ts, actor, type, data) VALUES (?, ?, 'A', 'created', '{\"status\":\"done\"}')").run(id, at(0));
  }
  for (const [agent, cost] of [['F', 2], ['G', 8]]) d.prepare('INSERT INTO usage_samples (agent_id, account, harness, model, bucket, cost_usd, tokens_in) VALUES (?, ?, ?, ?, ?, ?, ?)').run(agent, 'claude', 'claude', 'claude-haiku-5-5', at(0), cost, cost * 1000);
  const r = ic.issueCosts({ worthMid });
  const haiku = r.by_config.find((g) => g.config === 'claude · claude-haiku-5-5');
  assert.equal(haiku.n, 3);
  assert.equal(haiku.median, 8);
  close(haiku.average, 6, 'average', 1e-5);
  assert.equal(haiku.min, 2);
  assert.equal(haiku.max, 8);
});

test('itsaCost > one ITSA: own, total, agents with their share, config, and weekly percent', () => {
  const x = ic.itsaCost('C-2', { worthMid });
  assert.equal(x.key, 'C-2');
  assert.equal(x.own.cost_usd, 24.5);
  assert.equal(x.total.cost_usd, 24.5);
  assert.equal(x.own.manager_cost_usd, 4.5, 'A is a manager; its 4.5 is manager cost');
  assert.deepEqual(
    x.agents.map((a) => [a.agent, a.cost_usd]),
    [['B', 15], ['C', 5], ['A', 4.5]],
  );
  close(x.agents.reduce((s, a) => s + a.share, 0), 1, 'shares add to 1', 1e-5);
  assert.equal(x.config, 'claude · claude-haiku-5-5');
  close(x.weekly_percent, (24.5 / 50) * 100, 'weekly');
  const p = ic.itsaCost('P-1', { worthMid });
  assert.equal(p.total.cost_usd, 48);
  assert.throws(() => ic.itsaCost('NOPE-1', { worthMid }), /no ITSA/);
});

test('attributor > owner over participant, the fallback to all ITSAs, and unattributed', () => {
  seed();
  const attribute = ic.attributor();
  const shares = (r) => r.map((x) => [x.itsaId, x.share]).sort((a, b) => a[0].localeCompare(b[0]));
  // +45m: A owns P and C1 (both active) and participates in C3 (done at +30m): owned ones split.
  assert.deepEqual(shares(attribute('A', Date.parse(at(45)))), [['c1', 0.5], ['p', 0.5]]);
  // +55m: B owns nothing active, so it falls back to its participation in C1 (still in progress).
  assert.deepEqual(shares(attribute('B', Date.parse(at(55)))), [['c1', 1]]);
  // E has no ITSA at all: unattributed.
  assert.deepEqual(attribute('E', Date.parse(at(45))), []);
});

// The old attribute, which read every candidate's timelines on each call: the index must answer as it did.
function scanAttribute(attr, agent, t) {
  const d = db.open();
  const created = d.prepare('SELECT created_at FROM agents WHERE id = ?').get(agent)?.created_at;
  const existed = created == null || Date.parse(created) <= t;
  const category = new Map([['backlog', 'backlog'], ['todo', 'ready'], ['in_progress', 'active'], ['blocked', 'active'], ['in_review', 'review'], ['done', 'closed']]);
  const last = (list) => {
    let cur = null;
    for (const e of list) {
      if (e.at > t) break;
      cur = e;
    }
    return cur;
  };
  const candidates = [...attr.items.values()].filter((x) => x.participants.has(agent) || x.owners.some((o) => o.owner === agent));
  const active = (x) => existed && !(t < x.created) &&['active', 'review'].includes(category.get(last(x.statuses)?.to ?? x.initialStatus));
  let split = candidates.filter((x) => last(x.owners)?.owner === agent && active(x));
  if (!split.length) split = candidates.filter((x) => x.participants.has(agent) && active(x));
  if (!split.length) split = candidates;
  return split.map((x) => [x.id, 1 / split.length]).sort((a, b) => a[0].localeCompare(b[0]));
}

test('attributor > the per-agent index answers as a scan of every candidate, at and between event times (S-4356)', () => {
  const d = db.open();
  for (const t of ['usage_samples', 'itsa_events', 'itsa_participants', 'itsas', 'agents']) d.exec(`DELETE FROM ${t}`);
  let seed = 7;
  const r = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const agents = ['A', 'B', 'C', 'D'];
  makeAgent('A', HOUR_BEFORE);
  makeAgent('B', HOUR_BEFORE);
  makeAgent('C', at(30));
  makeAgent('D', at(90));
  const statuses = ['backlog', 'todo', 'in_progress', 'blocked', 'in_review', 'done'];
  const times = new Set([-Infinity, Infinity, NaN, Date.parse(at(30)), Date.parse(at(90))]);
  for (let i = 0; i < 40; i++) {
    const created = T0 + Math.floor(r() * 120) * MIN;
    times.add(created);
    d.prepare('INSERT INTO itsas (id, key, parent_id, kind, title, status, owner, created_by, created_at, updated_at, closed_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL)').run(
      `r${i}`, `R-${i}`, 'issue', `R-${i}`, 'todo', pick(agents), 'A', iso(created), iso(created),
    );
    const event = (ts, type, data) => d.prepare('INSERT INTO itsa_events (itsa_id, ts, actor, type, data) VALUES (?, ?, ?, ?, ?)').run(`r${i}`, iso(ts), 'A', type, JSON.stringify(data));
    event(created, 'created', { status: pick(statuses) });
    // Events in id order whose times now and then go back, as a clock step can leave them.
    for (let k = 0; k < 6; k++) {
      const ts = created + Math.floor((r() - 0.15) * 90) * MIN;
      times.add(ts);
      if (r() < 0.7) event(ts, 'status', { from: pick(statuses), to: pick(statuses) });
      else event(ts, 'owner', { from: pick(agents), to: pick([...agents, null]) });
    }
    for (const a of agents) if (r() < 0.3) d.prepare('INSERT INTO itsa_participants (itsa_id, agent_id) VALUES (?, ?)').run(`r${i}`, a);
  }
  const attr = ic.buildAttribution();
  const shares = (list) => list.map((x) => [x.itsaId, x.share]).sort((a, b) => a[0].localeCompare(b[0]));
  // In creation order (the cursor jumps both ways), then forward, then back.
  const moments = [...times].flatMap((t) => [t - 1, t, t + 1]);
  const sorted = moments.filter((t) => !Number.isNaN(t)).sort((a, b) => a - b);
  for (const t of [...moments, ...sorted, ...sorted.reverse()]) {
    for (const a of [...agents, 'E']) assert.deepEqual(shares(attr.attribute(a, t)), scanAttribute(attr, a, t), `${a} at ${t}`);
  }
});

// Created at distinct times and never closed: every creation adds to the agent's owned set, so splits
// grow to 3,000 ITSAs. The index keeps only the changes, so the first call stays short and later calls
// in the same stretch reuse one split.
test('attributor > an agent on 3,000 overlapping active ITSAs indexes them in well under a slice (S-4356)', () => {
  const d = db.open();
  for (const t of ['usage_samples', 'itsa_events', 'itsa_participants', 'itsas', 'agents']) d.exec(`DELETE FROM ${t}`);
  makeAgent('A', HOUR_BEFORE);
  d.exec('BEGIN');
  for (let i = 0; i < 3000; i++) {
    const t = T0 + i * MIN;
    d.prepare('INSERT INTO itsas (id, key, parent_id, kind, title, status, owner, created_by, created_at, updated_at, closed_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL)').run(
      `o${i}`, `O-${i}`, 'issue', `O-${i}`, 'in_progress', 'A', 'A', iso(t), iso(t),
    );
    d.prepare('INSERT INTO itsa_events (itsa_id, ts, actor, type, data) VALUES (?, ?, ?, ?, ?)').run(`o${i}`, iso(t), 'A', 'created', JSON.stringify({ status: 'in_progress' }));
  }
  d.exec('COMMIT');
  const attr = ic.buildAttribution();
  const t0 = performance.now();
  const first = attr.attribute('A', T0 + 1500 * MIN);
  const ms = performance.now() - t0;
  // Keeping every split cost 1 + 2 + ... + 3,000 = 4.5M share objects here, and over a second.
  assert.ok(ms < 250, `the first call took ${Math.round(ms)} ms`);
  assert.equal(first.length, 1501);
  assert.equal(attr.attribute('A', T0 + 1500 * MIN + 30_000), first);
  assert.equal(attr.attribute('A', T0 + 3000 * MIN).length, 3000);
  assert.equal(attr.attribute('A', T0 - MIN).length, 3000, 'before any is active: the even fallback over all');
});

test('attributor > an agent on 3,000 ITSAs answers 5,000 moments in well under a slice (S-4356)', () => {
  const d = db.open();
  for (const t of ['usage_samples', 'itsa_events', 'itsa_participants', 'itsas', 'agents']) d.exec(`DELETE FROM ${t}`);
  makeAgent('A', HOUR_BEFORE);
  const span = 7 * 24 * 60 * MIN;
  d.exec('BEGIN');
  for (let i = 0; i < 3000; i++) {
    const t = T0 + (i / 3000) * span;
    d.prepare('INSERT INTO itsas (id, key, parent_id, kind, title, status, owner, created_by, created_at, updated_at, closed_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      `h${i}`, `H-${i}`, 'issue', `H-${i}`, 'done', 'A', 'A', iso(t), iso(t), iso(t + 60 * MIN),
    );
    const event = (ts, type, data) => d.prepare('INSERT INTO itsa_events (itsa_id, ts, actor, type, data) VALUES (?, ?, ?, ?, ?)').run(`h${i}`, iso(ts), 'A', type, JSON.stringify(data));
    event(t, 'created', { status: 'todo' });
    event(t + MIN, 'status', { from: 'todo', to: 'in_progress' });
    event(t + 30 * MIN, 'status', { from: 'in_progress', to: 'in_review' });
    event(t + 60 * MIN, 'status', { from: 'in_review', to: 'done' });
  }
  d.exec('COMMIT');
  const attr = ic.buildAttribution();
  const t0 = performance.now();
  for (let k = 0; k < 5000; k++) attr.attribute('A', T0 + (k / 5000) * span);
  // A scan of every candidate per moment took over a second here; the index takes a few ms.
  const ms = performance.now() - t0;
  assert.ok(ms < 250, `5,000 moments took ${Math.round(ms)} ms`);
});
