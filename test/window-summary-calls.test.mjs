#!/usr/bin/env node
// One snapshot at 300 agents in trees (S-344), with usage and window readings seeded so every window has
// shares, runs a small, constant number of SQL executions: the tree walks read one per-snapshot index, not a
// query per node. Counts get/all/run calls on the daemon's statements, not time.
// Throwaway STAM_HOME, no daemon: `node --test test/window-summary-calls.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-window-summary-calls-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `window-summary-calls-test-${process.pid}`;
writeFileSync(
  join(home, 'settings.json'),
  JSON.stringify({
    cost: {
      subscriptionWarnPercent: [80, 95], dailyWarnUsd: null, global: null, onError: 'soft-stop',
      accounts: { claude: { match: { harness: 'claude' }, subscription: true }, codex: { match: { harness: 'codex' }, subscription: true } },
    },
  }),
);
const db = await import('../src/db.ts');
const { displayContext } = await import('../src/usage.ts');

const MIN = 60_000;
const now = Date.now();
const iso = (t) => new Date(t).toISOString();

test('one snapshot at 300 agents in trees runs a constant number of statement executions', () => {
  // Chains of four: agent i's parent is i-1 unless i starts a chain, so the trees are three levels deep.
  for (let i = 0; i < 300; i++) {
    db.createAgent({ id: `id-${i}`, name: `ag-${i}`, role: '', machine: 'test', harness: 'claude', model: 'test-a', effort: null, cwd: '', parent_id: i % 4 ? `id-${i - 1}` : null, session_id: null });
  }
  const d = db.open();
  const resets = Math.floor((now + 3 * 3_600_000) / 1000);
  const sample = d.prepare('INSERT INTO usage_samples (agent_id, account, harness, model, bucket, tokens_in) VALUES (?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 300; i++) sample.run(`id-${i}`, 'claude', 'claude', 'test-a', iso(now - 50 * MIN), 1000 + i);
  const reading = d.prepare('INSERT INTO window_readings (name, window, at, used_percentage, resets_at) VALUES (?, ?, ?, ?, ?)');
  for (const window of ['five_hour', 'seven_day']) {
    reading.run('claude', window, iso(now - 60 * MIN), 10, resets);
    reading.run('claude', window, iso(now - 5 * MIN), 12, resets);
  }

  // The account's current windows come from its subscription row (accountReadings), so each window is live.
  d.prepare('INSERT INTO subscriptions (name, data, updated_at) VALUES (?, ?, ?)').run(
    'claude',
    JSON.stringify({ five_hour: { used_percentage: 12, resets_at: resets }, seven_day: { used_percentage: 12, resets_at: resets } }),
    iso(now - MIN),
  );

  // Count every execution on the statements the daemon prepares while the snapshot runs.
  const prepare = d.prepare.bind(d);
  let executions = 0;
  d.prepare = (sql) => {
    const st = prepare(sql);
    for (const m of ['get', 'all', 'run']) {
      const f = st[m].bind(st);
      st[m] = (...args) => {
        executions++;
        return f(...args);
      };
    }
    return st;
  };
  let ctx;
  try {
    ctx = displayContext(now);
  } finally {
    delete d.prepare;
  }
  // The summaries really ran: a seeded agent deep in a tree has a share of its window.
  assert.ok(ctx.share('id-3', 'claude', 'five_hour') > 0, 'a seeded agent has no share, so no summary was built');
  // Two accounts' windows, each with a few fixed reads, and the index: far below one per agent.
  assert.ok(executions <= 40, `${executions} statement executions for 300 agents in trees`);
});
