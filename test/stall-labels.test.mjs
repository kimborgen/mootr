#!/usr/bin/env node
// The hook path's stall labels (S-1025): the daemon.log line for a slow hook names the step.
// A throwaway STAM_HOME, no daemon: `node --test test/stall-labels.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-stall-labels-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `stall-labels-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
// A paid Claude account and a daily warning, so a statusline report runs every usage step (S-4872).
writeFileSync(join(home, 'settings.json'), JSON.stringify({ cost: { accounts: { max: { match: { harness: 'claude' }, paid: true } }, dailyWarnUsd: 5000 } }));

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

// S-4872: after S-4851 the live stalls sat under "statusline: usage" at 130-160 ms, which a seeded ledger
// doesn't reproduce; its steps name themselves so daemon.log says which one it is.
test('a statusline report names its usage steps', async () => {
  const usage = await import('../src/usage.ts');
  const a = db.createAgent({ id: 'U1', name: 'u1', role: 'r', machine: 'x', harness: 'claude', model: 'm', effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  stall.stalls.recent.length = 0;
  usage.reportStatusline(a, { cost: 1, tokensIn: 10, session: 's', subscription: { five_hour: { used_percentage: 12, resets_at: 4102444800 } } });
  const want = ['usage: subscription', 'usage: window reading', 'usage: projection', 'usage: window allocations', 'usage: rules', 'usage: pauses',
    'usage: baseline', 'usage: window at 100', 'usage: ledger', 'usage: sample', 'usage: usd allocations', 'usage: budgets', 'usage: daily spend'];
  for (const l of want) assert.ok(labels().has(l), l);
});

// S-4895: a recurring timer's work runs on the event loop with no request around it, so without a label its stall
// is logged as unlabelled. Every setInterval in src/ wraps its callback in timed(), except these, each for a reason.
const UNLABELLED_TIMERS = [
  ['stall.ts', 'meter.tick', 'the stall meter itself'],
  ['agent-view.ts', "': ping", 'an SSE keepalive write'],
  ['events.ts', "': ping", 'an SSE keepalive write'],
  ['layout.ts', "': ping", 'an SSE keepalive write'],
  ['push.ts', "': ping", 'an SSE keepalive write'],
  ['mcp.ts', 'reexecWhenIdle', 'runs in the MCP server process, not the daemon'],
  ['notices.ts', 'setInterval(run,', 'run labels its sweep (notices sweep)'],
  ['auto-archive.ts', 'setInterval(run,', 'run labels its pass (auto-archive)'],
  ['daemon.ts', 'reconcileTick()', "awaits tmux, then labels its work (reconcile)"],
  ['daemon.ts', 'bannersTick()', 'awaits tmux, then labels its work (banners)'],
];
test('every recurring timer in src/ names its work', () => {
  const root = new URL('../src/', import.meta.url).pathname;
  const files = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? files(join(d, n)) : n.endsWith('.ts') ? [join(d, n)] : []));
  const missing = [];
  const used = new Set();
  for (const f of files(root)) {
    const rel = f.slice(root.length);
    const s = readFileSync(f, 'utf8');
    for (let i = s.indexOf('setInterval('); i >= 0; i = s.indexOf('setInterval(', i + 1)) {
      // The call's text, to its closing parenthesis.
      let depth = 0;
      let j = i + 'setInterval'.length;
      for (; j < s.length; j++) {
        if (s[j] === '(') depth++;
        else if (s[j] === ')' && --depth === 0) break;
      }
      const call = s.slice(i, j + 1);
      if (call.includes('timed(')) continue;
      const allowed = UNLABELLED_TIMERS.findIndex(([file, text]) => rel === file && call.includes(text));
      if (allowed >= 0) used.add(allowed);
      else missing.push(`${rel}:${s.slice(0, i).split('\n').length}`);
    }
  }
  assert.deepEqual(missing, [], 'wrap these timers\' callbacks in timed(label, ...), or list them with a reason');
  assert.deepEqual(UNLABELLED_TIMERS.filter((_, k) => !used.has(k)), [], 'stale entries in UNLABELLED_TIMERS');
});
