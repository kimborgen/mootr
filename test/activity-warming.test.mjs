#!/usr/bin/env node
// Activity cold start (S-1206): the first summary after a daemon start answers with the digests built so far,
// marked `warming: true`, instead of waiting for the whole refresh; after the refresh it is the full answer.
// Free and deterministic: the realistic-scale fixture, no model. `node --test test/activity-warming.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-activity-warming-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `activity-warming-test-${process.pid}`;
process.env.STAM_ACTIVITY_WARM_MS = '1';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

test('a cold summary is marked warming, a warm one is not, and activity_info says so', async () => {
  const db = await import('../src/db.ts');
  const summary = await import('../src/activity-summary.ts');
  const { activityInfoOf } = await import('../src/activity-info.ts');
  const { seedScale } = await import('./activity-fixture.mjs');
  const fixture = seedScale(db, { agents: 60, days: 7 });
  summary.resetSummary();

  const cold = await summary.activitySummary({ days: 7, now: fixture.now });
  assert.equal(cold.warming, true, 'the cold answer is marked warming');
  assert.ok(cold.clock && cold.tiles, 'and still carries the summary');
  // S-1725: a second cold call reads the cached answer instead of merging again beside the refresh.
  assert.equal(await summary.activitySummary({ days: 7, now: fixture.now }), cold, 'a second cold call is served from the cache');
  const compact = activityInfoOf(cold);
  assert.equal(compact.warming, true);
  assert.match(compact.warming_note, /warming/);
  assert.equal(activityInfoOf(cold, { detail: true }).warming, true);

  await summary.warmSummary();
  const warm = await summary.activitySummary({ days: 7, now: fixture.now });
  assert.equal(warm.warming, undefined, 'the warm answer is not marked');
  assert.equal(activityInfoOf(warm).warming, undefined);
  assert.ok(warm.agents >= cold.agents, 'the warm answer has at least what the cold one had');
});
