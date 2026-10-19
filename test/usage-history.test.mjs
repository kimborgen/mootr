#!/usr/bin/env node
// Unit tests for build step 9 of docs/cost-policy.md (src/usage-history.ts): percent of a window
// per hour by hour of day and weekday, per agent and tree, and the projection that follows the
// usual pattern. Synthetic calibrations for the arithmetic, and a seeded throwaway STAM_HOME
// (no daemon, no network, no models) for the summaries: `node --test test/usage-history.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

// Hours and weekdays are local time; pin it so the slots are the same on every machine.
process.env.TZ = 'UTC';
const home = tempHome('stam-usage-history-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `usage-history-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(
  join(home, 'settings.json'),
  JSON.stringify({ cost: { subscriptionWarnPercent: [80, 95], dailyWarnUsd: null, global: null, onError: 'soft-stop', accounts: { claude: { match: { harness: 'claude' } } } } }),
);
writeFileSync(join(home, 'registry.json'), JSON.stringify({ prices: { 'test-a': { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } } }));

let db, attr, hist;
before(async () => {
  db = await import('../src/db.ts');
  attr = await import('../src/attribution.ts');
  hist = await import('../src/usage-history.ts');
});
after(() => rmSync(home, { recursive: true, force: true }));

// Monday 2026-10-05, 00:00 UTC; WEEK later is the next Monday.
const MON = Date.parse('2026-10-05T00:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const WEEK = 7 * 24 * HOUR;
const iso = (t) => new Date(t).toISOString();
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);
const iv = (from, to, change, agents = {}) => ({ from: iso(from), to: iso(to), change, agents });

test('hourly > an interval is cut at the hour, and rates divide by covered hours across weeks', () => {
  const cal = {
    intervals: [
      // Week 1, Monday 10:50 to 11:10: 4 points, 3 to r and 1 to c; 2 land in each hour.
      iv(MON + 10 * HOUR + 50 * MIN, MON + 11 * HOUR + 10 * MIN, 4, { r: 3, c: 1 }),
      // Week 2, Monday 10:00 to 10:30: 1 point, nobody's (other).
      iv(MON + WEEK + 10 * HOUR, MON + WEEK + 10 * HOUR + 30 * MIN, 1),
      // Before `from`: left out.
      iv(MON - HOUR, MON - 30 * MIN, 50, { r: 50 }),
    ],
    scale: 0.001,
    current: null,
  };
  const h = hist.hourly(cal, MON);
  const p = hist.profile(h);
  // Hour 10: 2 + 1 points over 10 + 30 minutes.
  close(p.by_hour[10].percent_per_hour, 4.5, 'hour 10');
  close(p.by_hour[11].percent_per_hour, 12, 'hour 11: 2 points in 10 minutes');
  assert.equal(p.by_hour[9].percent_per_hour, null, 'an uncovered hour is null, not 0');
  assert.equal(p.by_weekday[1].day, 'Mon');
  close(p.by_weekday[1].percent_per_hour, 5 / (5 / 6), 'Monday: 5 points over 50 minutes');
  close(hist.average(h), 6, 'overall');
  // r has 1.5 of hour 10's 3 points, over the same 40 minutes; the tree {r, c} has 2.
  const r = new Set(['r']);
  close(hist.profile(h, r).by_hour[10].percent_per_hour, 2.25, 'agent r at 10');
  close(hist.hourRates(h, new Set(['r', 'c']))[10], 3, 'tree at 10');
  close(hist.hourRates(h, r)[11], 9, 'agent r at 11');
});

test('pattern > the current rate for this hour, then the slot, the hour of day, or the current rate', () => {
  const cal = {
    intervals: [
      // Monday 14:00-15:00 runs at 20% per hour; Tuesday 15:00-16:00 at 6%. Nothing at 16:00.
      iv(MON + 14 * HOUR, MON + 15 * HOUR, 20),
      iv(MON + 24 * HOUR + 15 * HOUR, MON + 24 * HOUR + 16 * HOUR, 6),
    ],
    scale: 0.001,
    current: null,
  };
  const h = hist.hourly(cal, MON);
  // The next Monday at 13:30, 60% used at 10% per hour, resetting at 18:00.
  const now = MON + WEEK + 13 * HOUR + 30 * MIN;
  const proj = (resets) => ({ estimate: true, used_percentage: 60, percent_per_hour: 10, reaches_100_at: null, resets_at: iso(resets) });
  // 13:30-14:00 at 10 → 65; 14-15 at Monday 14's 20 → 85; 15-16 at hour 15's 6 (Monday 15 has
  // nothing) → 91; then hour 16 has no history, so the current 10: 9 more at 16:54.
  const p = hist.patternProjection(h, proj(MON + WEEK + 18 * HOUR), 5 * HOUR, now);
  assert.equal(p.estimate, true);
  assert.equal(p.reaches_100_at, iso(MON + WEEK + 16 * HOUR + 54 * MIN));
  // At 10% per hour alone it is 17:30. A reset at 16:30 comes first:
  const early = hist.patternProjection(h, proj(MON + WEEK + 16 * HOUR + 30 * MIN), 5 * HOUR, now);
  assert.equal(early.reaches_100_at, null);
  assert.match(early.note, /resets before/);
  assert.equal(hist.patternProjection(h, { ...proj(now), used_percentage: null }, 5 * HOUR, now).note, 'no readings');
});

test('paces > a quiet week and a busy last day give two different forecasts; thin history gives null', () => {
  const now = MON + WEEK;
  const resets = now + 2 * 24 * HOUR;
  const proj = { estimate: true, used_percentage: 58, percent_per_hour: 1, reaches_100_at: null, resets_at: iso(resets) };
  // Days 0-5 of the week: 0.3 points in each of 100 hours; the last
  // 24 hours cover 20 hours at 3% per hour.
  const quiet = [];
  for (let i = 0; i < 100; i++) quiet.push(iv(now - 6 * 24 * HOUR + i * HOUR, now - 6 * 24 * HOUR + (i + 1) * HOUR, 0.3));
  const busy = [];
  for (let i = 0; i < 20; i++) busy.push(iv(now - 24 * HOUR + i * HOUR, now - 24 * HOUR + (i + 1) * HOUR, 3));
  const p = hist.paces({ intervals: [...quiet, ...busy], scale: 0.001, current: null }, proj, now);
  // 7 days: (30 + 60) points over 120 covered hours.
  close(p.pace_7d.percent_per_hour, 0.75, '7-day rate');
  close(p.pace_7d.covered_hours, 120, '7-day hours');
  assert.equal(p.pace_7d.reaches_100_at, null);
  close(p.pace_7d.at_reset, 94, '7-day at reset');
  // 24 hours: 3 per hour; 42 left reaches 100% in 14 hours, before the reset in 48.
  close(p.pace_24h.percent_per_hour, 3, '24h rate');
  assert.equal(p.pace_24h.reaches_100_at, iso(now + 14 * HOUR));
  assert.equal(p.pace_24h.at_reset, 100);
  // A reset sooner than 14 hours comes first: 8 hours at 3 per hour is 82%.
  const soon = hist.paces({ intervals: busy, scale: 0.001, current: null }, { ...proj, resets_at: iso(now + 8 * HOUR) }, now);
  assert.equal(soon.pace_24h.reaches_100_at, null);
  close(soon.pace_24h.at_reset, 82, '24h at reset');
  // Thin history: 20 covered hours is too few for a 7-day pace; an hour for the 24h one.
  assert.equal(soon.pace_7d, null);
  const thin = hist.paces({ intervals: [iv(now - 2 * HOUR, now - HOUR, 2)], scale: 0.001, current: null }, proj, now);
  assert.equal(thin.pace_24h, null);
  assert.equal(hist.paces({ intervals: busy, scale: 0.001, current: null }, { ...proj, used_percentage: null }, now).pace_24h, null);
});

test('pattern > reaching 100% exactly at the reset is not reaching it', () => {
  const h = hist.hourly({ intervals: [], scale: 0.001, current: null }, MON);
  const now = MON + 13 * HOUR;
  const proj = (resets) => ({ estimate: true, used_percentage: 60, percent_per_hour: 10, reaches_100_at: null, resets_at: iso(resets) });
  // 40 points at 10% per hour: 17:00, the same instant as the reset.
  assert.equal(hist.patternProjection(h, proj(now + 4 * HOUR), 5 * HOUR, now).reaches_100_at, null);
  assert.equal(hist.patternProjection(h, proj(now + 4 * HOUR + MIN), 5 * HOUR, now).reaches_100_at, iso(now + 4 * HOUR));
});

test('dst > hours follow the local clock: fall-back repeats 1 AM, spring-forward skips 2 AM', () => {
  process.env.TZ = 'America/New_York';
  try {
    // 2026-11-01: 05:30Z is 1:30 EDT; the next hour starts at 06:00Z (1:00 EST), then 07:00Z.
    const fall = Date.parse('2026-11-01T05:30:00.000Z');
    assert.equal(iso(hist.nextHour(fall)), '2026-11-01T06:00:00.000Z');
    assert.equal(iso(hist.nextHour(fall + 30 * MIN)), '2026-11-01T07:00:00.000Z');
    // 2026-03-08: 06:30Z is 1:30 EST; the next hour is 07:00Z, 3:00 EDT.
    assert.equal(iso(hist.nextHour(Date.parse('2026-03-08T06:30:00.000Z'))), '2026-03-08T07:00:00.000Z');
    // Both 1 AM hours of the fall-back land in Sunday 1:00, two covered hours.
    const h = hist.hourly({ intervals: [iv(fall - 30 * MIN, fall + 90 * MIN, 4)], scale: 0.001, current: null }, 0);
    close(h.slots[0 * 24 + 1].hours, 2, 'Sunday 1:00 covered twice');
    close(h.slots[0 * 24 + 1].change, 4, 'all of the change');
  } finally {
    process.env.TZ = 'UTC';
  }
});

test('summaries > account and tree carry the history and the pattern projection', () => {
  let n = 0;
  const agent = (name, parent = null) => {
    const id = `uh-${++n}`;
    db.createAgent({ id, name, role: 'test', machine: 'x', harness: 'claude', model: 'test-a', effort: null, cwd: '/tmp', parent_id: parent, session_id: null });
    return id;
  };
  const root = agent('root');
  const child = agent('child', root);
  const T = MON + WEEK + 10 * HOUR;
  const reading = (min, used) =>
    db.open().prepare('INSERT INTO window_readings (name, window, at, used_percentage, resets_at) VALUES (?, ?, ?, ?, ?)').run('claude', 'five_hour', iso(T + min * MIN + 30_000), used, (T + 5 * HOUR) / 1000);
  const sample = (id, min, tokens) =>
    db.open().prepare('INSERT INTO usage_samples (agent_id, account, harness, model, bucket, tokens_in) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'claude', 'claude', 'test-a', iso(T + min * MIN), tokens);
  // 10:00:30 to 10:10:30: 2 points, 3/4 to child and 1/4 to root → 12% per hour at 10.
  reading(0, 10);
  sample(child, 5, 1500);
  sample(root, 10, 500);
  reading(10, 12);
  const now = T + 20 * MIN;
  const s = attr.accountShares('claude', ['five_hour'], now).five_hour;
  close(s.history.by_hour[10].percent_per_hour, 12, 'account at 10');
  assert.equal(s.history.estimate, true);
  assert.equal(s.history.days, 14);
  assert.equal(s.history.trees[0].root, 'root');
  close(s.history.trees[0].by_hour[10], 12, 'the whole tree at 10');
  const c = s.history.agents.find((a) => a.agent === 'child');
  close(c.by_hour[10], 9, 'child at 10');
  assert.equal(s.projection.pattern.estimate, true);
  const t = attr.treeSummary(child, now).accounts.claude.five_hour;
  close(t.history.percent_per_hour, 9, 'child tree');
  assert.ok('pattern' in t.projection);
});
