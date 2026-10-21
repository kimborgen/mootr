#!/usr/bin/env node
// Provider budgets (S-2119, src/readings.ts): a pay-per-token provider other than OpenRouter has no
// balance endpoint, so its spend is the ledger's tokens at the registry's per-provider prices, or the
// harness's reported cost for a model with no price. Its readings, its budget, the global budget and a
// spawn hold all use that figure. Throwaway STAM_HOME, no daemon: `node --test test/provider-spend.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-provider-spend-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `provider-spend-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];
writeFileSync(
  join(home, 'settings.json'),
  JSON.stringify({
    providers: { myazure: { kind: 'azure', endpoint: 'https://r.openai.azure.com', apiVersion: 'v1' } },
    cost: {
      subscriptionWarnPercent: [80, 95], dailyWarnUsd: null, onError: 'soft-stop',
      global: { budget: { usd: 100, per: 'month' } },
      accounts: {
        az: { match: { harness: 'opencode', model: 'myazure/' }, budget: { usd: 5, per: 'month' } },
        claude: { match: { harness: 'claude' }, paid: true },
      },
    },
  }),
);
// Per-provider prices: USD per million tokens, keyed by the full `PROVIDER/MODEL` id.
writeFileSync(join(home, 'registry.json'), JSON.stringify({ prices: { 'myazure/gpt-prod': { input: 2, output: 10, cacheRead: 0.5, cacheWrite: null } } }));

const db = await import('../src/db.ts');
const readings = await import('../src/readings.ts');
const budgets = await import('../src/budgets.ts');

const today = new Date().toISOString().slice(0, 10);
const row = (agent, account, model, t, extra = {}) =>
  db.open()
    .prepare('INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, paid_estimate_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(agent, today, extra.harness ?? 'opencode', model, account, extra.cost ?? 0, t.in ?? 0, t.out ?? 0, t.cr ?? 0, t.cw ?? 0, extra.estimate ?? 0);

test('a provider account is pay-per-token, priced from its tokens at the registry prices', () => {
  db.open().exec('DELETE FROM usage');
  // 1M in at $2, 100k out at $10, 1M cache read at $0.5, 100k cache write at the input price $2.
  row('a1', 'az', 'myazure/gpt-prod', { in: 1_000_000, out: 100_000, cr: 1_000_000, cw: 100_000 }, { cost: 99 });
  const r = readings.accountReadings().find((x) => x.account === 'az');
  assert.equal(r.provider, 'myazure');
  assert.equal(r.paid.month.source, 'estimate');
  assert.ok(Math.abs(r.paid.month.usd - 3.7) < 1e-9, `month ${r.paid.month.usd}`);
  assert.ok(Math.abs(r.budget.spent - 3.7) < 1e-9);
  assert.ok(Math.abs(r.budget.remaining - 1.3) < 1e-9);
  assert.equal(r.balance, null, 'no balance endpoint');
  assert.equal(readings.accountReadings().find((x) => x.account === 'claude').provider, null);
});

test('a model with no registry price counts the cost the harness reported', () => {
  db.open().exec('DELETE FROM usage');
  row('a1', 'az', 'myazure/unpriced', { in: 5_000_000 }, { cost: 0.42 });
  assert.ok(Math.abs(readings.paidSpentIn('az', 'month') - 0.42) < 1e-9);
});

test('a context suffix such as [1m] prices as its model, as attribution.priceUsd does', () => {
  db.open().exec('DELETE FROM usage');
  row('a1', 'az', 'myazure/gpt-prod[1m]', { in: 1_000_000 }, { cost: 99 });
  assert.ok(Math.abs(readings.paidSpentIn('az', 'month') - 2) < 1e-9, `${readings.paidSpentIn('az', 'month')}`);
});

test('the global budget adds the priced spend to the other accounts\' paid spend', () => {
  db.open().exec('DELETE FROM usage');
  row('a1', 'az', 'myazure/gpt-prod', { in: 1_000_000 }, { cost: 50 });
  row('c1', 'claude', 'claude-opus-5-5', { in: 1 }, { harness: 'claude', cost: 7, estimate: 1.5 });
  assert.ok(Math.abs(readings.paidSpentAll('month') - 3.5) < 1e-9, `${readings.paidSpentAll('month')}`);
});

test('a spent provider budget holds a new agent on that account', () => {
  db.open().exec('DELETE FROM usage');
  row('a1', 'az', 'myazure/gpt-prod', { out: 600_000 });
  assert.match(budgets.spawnHeld('az') ?? '', /account az's month budget of \$5 is spent/);
  db.open().exec('DELETE FROM usage');
  assert.equal(budgets.spawnHeld('az'), null);
});
