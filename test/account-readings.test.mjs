#!/usr/bin/env node
// accountReadings (S-344, src/readings.ts) reads settings.json a fixed number of times, not once per agent:
// the active accounts are matched once per call. Throwaway STAM_HOME, no daemon:
// `node --test test/account-readings.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-account-readings-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `account-readings-test-${process.pid}`;
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
const { accountReadings } = await import('../src/readings.ts');
const { settingsReads } = await import('../src/settings.ts');

test('accountReadings reads settings a fixed number of times, not once per agent', () => {
  for (let i = 0; i < 60; i++) db.createAgent({ id: `id-${i}`, name: `ag-${i}`, role: '', machine: 'test', harness: i % 2 ? 'codex' : 'claude', model: null, effort: null, cwd: '', parent_id: null, session_id: null });
  const before = settingsReads();
  const out = accountReadings(Date.now());
  const reads = settingsReads() - before;
  assert.ok(reads <= 4, `settings read ${reads} times for 60 agents`);
  assert.equal(out.length, 2);
});

test('each configured account comes back once', () => {
  assert.deepEqual(accountReadings(Date.now()).map((r) => r.account).sort(), ['claude', 'codex']);
});
