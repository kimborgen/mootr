#!/usr/bin/env node
// Regression test for the activity endpoint's event-loop block (S-2094): GET /api/activity?by=agent|itsa|
// model|type blocked the live daemon for 3-10 s at today's scale, and every agent's MCP calls timed out. The
// report is now computed in slices (src/slice.ts) and kept for a while (activityStatsCached). On the
// realistic fixture (test/activity-fixture.mjs: 700 agents, three days of activity) no slice may pass the
// budget; the sliced report equals the whole one; and a repeat call reads the memo.
// A throwaway STAM_HOME, no daemon, no network, no models: `node --test test/activity-load.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-activity-load-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `activity-load-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), JSON.stringify({ cost: { accounts: { claude: { match: { harness: 'claude' } }, codex: { match: { harness: 'codex' } }, openrouter: { match: { harness: 'opencode' }, paid: true } } } }));

// The longest the loop may be held by one slice. The bench measures about 40 ms at 1300 agents over 7 days;
// the budget is the S-2094 target, with room for a slow machine.
const BUDGET_MS = 100;

let stats, fx;
before(async () => {
  const db = await import('../src/db.ts');
  stats = await import('../src/activity-stats.ts');
  const { seedScale } = await import('./activity-fixture.mjs');
  fx = seedScale(db, { agents: 700, days: 3 });
});
after(() => rmSync(home, { recursive: true, force: true }));

// Runs `fn` with a 5 ms timer beside it; returns the longest gap between timer ticks (what a request
// would have seen) and the longest slice `wrap` saw.
async function watched(fn) {
  let slice = 0;
  let last = performance.now();
  let gap = 0;
  const t = setInterval(() => {
    const now = performance.now();
    gap = Math.max(gap, now - last);
    last = now;
  }, 5);
  last = performance.now();
  try {
    const value = await fn((run) => {
      const t0 = performance.now();
      try {
        return run();
      } finally {
        slice = Math.max(slice, performance.now() - t0);
      }
    });
    return { value, slice, gap };
  } finally {
    clearInterval(t);
  }
}

for (const by of ['agent', 'itsa', 'model', 'type']) {
  test(`by=${by}: no slice passes ${BUDGET_MS} ms, and the report equals the whole one`, async () => {
    const opts = { by, days: 3, now: fx.now };
    const { value, slice, gap } = await watched((wrap) => stats.activityStatsSliced(opts, wrap));
    assert.ok(slice < BUDGET_MS, `a slice held the loop ${slice.toFixed(0)} ms`);
    // The timer's gap carries the machine's noise (GC, other tests); it only has to stay under the whole run's block.
    const whole = performance.now();
    const same = stats.activityStats(opts);
    const wholeMs = performance.now() - whole;
    assert.ok(gap < wholeMs, `the loop was held ${gap.toFixed(0)} ms between timer ticks; the whole call takes ${wholeMs.toFixed(0)} ms`);
    assert.ok(value.rows.length > 0, 'the fixture gives rows');
    assert.deepEqual(value, same);
  });
}

test('the daemon call: a repeat reads the memo, one refresh runs at a time, and a stale report is served at once', async () => {
  stats.resetActivityMemo();
  const opts = { by: 'itsa', days: 3, now: fx.now };
  // A run's slice count depends on timing; the slice that finishes a run (`done`) happens once per run.
  let slices = 0;
  let runs = 0;
  const count = (run) => {
    slices++;
    const r = run();
    if (r.done) runs++;
    return r;
  };
  const [a, b] = await Promise.all([stats.activityStatsCached(opts, count, 1_000), stats.activityStatsCached(opts, count, 1_000)]);
  assert.equal(a, b, 'two callers at once share one run');
  const runSlices = slices;
  assert.ok(runSlices > 1, 'the run is sliced');
  const t0 = performance.now();
  const again = await stats.activityStatsCached(opts, count, 1_000);
  assert.ok(performance.now() - t0 < 10, 'a memo read is instant');
  assert.equal(again, a);
  assert.equal(slices, runSlices, 'a fresh memo runs nothing');
  assert.equal(runs, 1, 'one run so far');
  // Past the fresh time the old report is returned at once and one refresh runs behind it.
  const late = 1_000 + stats.ACTIVITY_FRESH_MS + 1;
  const before = slices;
  const stale = await stats.activityStatsCached(opts, count, late);
  assert.equal(stale, a, 'the stale report is served at once');
  const second = await stats.activityStatsCached(opts, count, late);
  assert.equal(second, a, 'still the old one while the refresh runs');
  await stats.activityRefreshIdle();
  assert.equal(runs, 2, `exactly one refresh ran (${slices - before} slices, a run is ${runSlices})`);
  const fresh = await stats.activityStatsCached(opts, count, late + 1);
  assert.notEqual(fresh, a, 'the memo was replaced');
  assert.deepEqual(fresh, a);
});

test('the memo keeps a bounded number of keys', async () => {
  stats.resetActivityMemo();
  for (let d = 1; d <= 40; d++) await stats.activityStatsCached({ by: 'model', days: d, now: fx.now }, undefined, 1);
  await stats.activityRefreshIdle();
  assert.ok(stats.activityMemoSize() <= 32);
});
