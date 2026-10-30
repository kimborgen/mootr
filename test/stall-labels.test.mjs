#!/usr/bin/env node
// The hook path's stall labels (S-1025): the daemon.log line for a slow hook names the step.
// A throwaway STAM_HOME, no daemon: `node --test test/stall-labels.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-stall-labels-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `stall-labels-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let db, org, stall;
before(async () => {
  db = await import('../src/db.ts');
  org = await import('../src/org.ts');
  stall = await import('../src/stall.ts');
  stall.stalls.threshold = 0;
});
after(() => rmSync(home, { recursive: true, force: true }));

const labels = () => new Set(stall.stalls.recent.map((s) => s.label));

test('an activity change names the observer and the children-waits step', () => {
  db.createAgent({ id: 'A1', name: 'a1', role: 'r', machine: 'x', harness: 'claude', model: 'm', effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  org.watchActivity();
  db.updateAgent('A1', { activity: 'working' });
  db.updateAgent('A1', { activity: 'idle' });
  assert.ok(labels().has('activity observer'));
  assert.ok(labels().has('activity change: children waits'));
});

test('the startup rebuild names its steps', () => {
  org.rebuildWaits();
  assert.ok(labels().has('rebuild waits: children'));
  assert.ok(labels().has('rebuild waits: settle asks'));
});

// S-4356: the activity slice by=itsa stalled 2.8 s under one label; its steps that don't yield name themselves.
test('the activity stats by itsa name their unyielded steps', async () => {
  const stats = await import('../src/activity-stats.ts');
  stats.activityStats({ by: 'itsa' });
  for (const l of ['activity: attribution', 'activity: reviewers']) assert.ok(labels().has(l), l);
});
