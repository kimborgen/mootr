#!/usr/bin/env node
// Unit tests for build step 3 of docs/cost-policy.md: accountReadings() staleness, each
// billing source (exact, estimate, unknown), and that the paid estimate only accrues while a
// reported window reads 100%. Runs against a throwaway STAM_HOME, no daemon, no network, no
// models: `node --test test/readings.test.mjs`.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempHome, tempDir } from './tmphome.mjs';

const home = tempHome('stam-readings-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `readings-test-${process.pid}`;
// Nothing here talks to a daemon; drop pointers to the live one anyway.
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let db, usage, readings;
before(async () => {
  db = await import('../src/db.ts');
  usage = await import('../src/usage.ts');
  readings = await import('../src/readings.ts');
});
after(() => rmSync(home, { recursive: true, force: true }));

// A cost config with the built-in warning settings, so only the part under test differs.
const costWith = (accountsObj, extra = {}) => ({
  subscriptionWarnPercent: [80, 95], dailyWarnUsd: null, global: null, accounts: accountsObj, onError: 'soft-stop', ...extra,
});
// settings() reads the file, so a test writes what it wants there first.
function writeCost(cost) {
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ cost }, null, 2));
}
// A subscription-like reading, as usage.reportSubscription and credits.ts write it.
function writeSub(name, data, updatedAt = new Date().toISOString()) {
  db.open()
    .prepare('INSERT INTO subscriptions (name, data, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
    .run(name, JSON.stringify(data), updatedAt);
}
let n = 0;
function agent(harness, model = null) {
  const id = `r-agent-${++n}`;
  db.createAgent({ id, name: `read-${n}`, role: 'test', machine: 'x', harness, model, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  return db.getAgent(id);
}
const reading = (name) => readings.accountReadings().find((r) => r.account === name);
const ago = (ms) => new Date(Date.now() - ms).toISOString();

beforeEach(() => {
  const d = db.open();
  d.exec('DELETE FROM usage');
  d.exec('DELETE FROM subscriptions');
  d.exec('DELETE FROM agents');
});

test('staleness > an old Codex reading is stale with no Codex agent running', () => {
  writeCost(costWith({ codex: { match: { harness: 'codex' } } }));
  writeSub('codex', { five_hour: { used_percentage: 10, resets_at: 1 } }, ago(20 * 60_000));
  assert.equal(reading('codex').stale, true);
  writeSub('codex', { five_hour: { used_percentage: 10, resets_at: 1 } });
  assert.equal(reading('codex').stale, false);
});

test('staleness > an old reading is stale only while an agent on the account is active', () => {
  writeCost(costWith({ claude: { match: { harness: 'claude' } } }));
  writeSub('claude', { five_hour: { used_percentage: 40, resets_at: 123 } }, ago(20 * 60_000));
  // No active agent: the old reading is not stale, but its age is reported.
  assert.equal(reading('claude').stale, false);
  assert.ok(reading('claude').age_ms > 15 * 60_000);
  // An active agent on the account makes it stale.
  agent('claude');
  assert.equal(reading('claude').stale, true);
  // A fresh reading is not stale, and the windows carry their fields.
  writeSub('claude', { five_hour: { used_percentage: 40, resets_at: 123 } });
  assert.equal(reading('claude').stale, false);
  assert.deepEqual(reading('claude').windows.five_hour, { used_percentage: 40, resets_at: 123 });
});

test('exact > OpenRouter period spend is the ledger cost, always labelled exact', () => {
  writeCost(costWith({ openrouter: { match: { harness: 'opencode', model: 'openrouter/' }, subscription: false, budget: { usd: 10, per: 'day' } } }));
  const a = agent('opencode', 'openrouter/deepseek/deepseek-v4.1-flash');
  usage.report(a, { cost: 3, tokensIn: 1, tokensOut: 1 });
  writeSub('openrouter', { credits: { used: 30, remaining: 4, total: 34, key_limit: null, key_remaining: null } });
  const r = reading('openrouter');
  assert.equal(r.paid.today.source, 'exact');
  assert.equal(r.paid.today.usd, 3);
  assert.equal(r.balance, 4, "OpenRouter's remaining credit is the balance");
  assert.equal(r.budget.spent, 3);
  assert.equal(r.budget.remaining, 7);
});

test('exact > OpenRouter spend stays exact without a fresh credits reading', () => {
  writeCost(costWith({ openrouter: { match: { harness: 'opencode', model: 'openrouter/' }, subscription: false } }));
  const a = agent('opencode', 'openrouter/x');
  usage.report(a, { cost: 3, tokensIn: 1, tokensOut: 1 });
  // Real billed money, so exact even with no credits entry; no balance to show.
  assert.equal(reading('openrouter').paid.today.source, 'exact');
  assert.equal(reading('openrouter').balance, null);
  // A stale credits entry, with an active agent, leaves spend exact but the balance unshown.
  writeSub('openrouter', { credits: { used: 30, remaining: 4 } }, ago(20 * 60_000));
  assert.equal(reading('openrouter').paid.today.source, 'exact');
  assert.equal(reading('openrouter').balance, null);
  // The ledger spend is reported.
  assert.equal(reading('openrouter').paid.today.usd, 3);
});

test('exact > Codex reports credits.balance, with period spend unknown', () => {
  writeCost(costWith({ codex: { match: { harness: 'codex' } } }));
  agent('codex', 'gpt-6.1-sol');
  writeSub('codex', { five_hour: { used_percentage: 10, resets_at: 1 }, credits: { hasCredits: true, unlimited: false, balance: 7.25 } });
  const r = reading('codex');
  assert.equal(r.balance, 7.25);
  assert.equal(r.paid.today.usd, null);
  assert.equal(r.paid.today.source, 'unknown');
});

test('unknown > a paid account with no reading at all is unknown', () => {
  writeCost(costWith({ claude: { match: { harness: 'claude' }, paid: true } }));
  agent('claude', 'claude-opus-5-5');
  const r = reading('claude');
  assert.equal(r.paid.today.source, 'unknown');
  assert.equal(r.updated_at, null);
  assert.equal(r.age_ms, null);
  assert.equal(r.stale, false);
  assert.equal(r.balance, null);
});

test('estimate > a paid Claude account accrues statusline cost only while a window is at 100%', () => {
  writeCost(costWith({ claude: { match: { harness: 'claude' }, paid: true, budget: { usd: 10, per: 'day' } } }));
  const a = agent('claude', 'claude-opus-5-5');
  // node:sqlite returns null-prototype rows, so compare plain objects.
  const estimate = () => ({ ...db.open().prepare('SELECT cost_usd, paid_estimate_usd FROM usage WHERE agent_id = ?').get(a.id) });
  // Below 100%: cost is recorded, but no paid estimate accrues.
  writeSub('claude', { five_hour: { used_percentage: 80, resets_at: 1 } });
  usage.report(a, { cost: 2, tokensIn: 1, tokensOut: 1 });
  assert.deepEqual(estimate(), { cost_usd: 2, paid_estimate_usd: 0 });
  // At 100%: the growth in statusline cost is the paid estimate.
  writeSub('claude', { five_hour: { used_percentage: 100, resets_at: Math.floor(Date.now() / 1000) + 3600 } });
  usage.report(db.getAgent(a.id), { cost: 5, tokensIn: 2, tokensOut: 2 });
  assert.deepEqual(estimate(), { cost_usd: 5, paid_estimate_usd: 3 });
  // Back below 100%: no further estimate.
  writeSub('claude', { five_hour: { used_percentage: 90, resets_at: 1 } });
  usage.report(db.getAgent(a.id), { cost: 6, tokensIn: 3, tokensOut: 3 });
  assert.deepEqual(estimate(), { cost_usd: 6, paid_estimate_usd: 3 });
  // The reading reports the estimate, labelled estimate while the reading is fresh.
  const r = reading('claude');
  assert.equal(r.paid.today.source, 'estimate');
  assert.equal(r.paid.today.usd, 3);
  assert.equal(r.budget.spent, 3);
  assert.equal(r.budget.remaining, 7);
});

test('estimate > a subscription account and an unmanaged agent never accrue it', () => {
  writeCost(costWith({ 'claude-max': { match: { harness: 'claude' }, paid: false } }));
  const a = agent('claude', 'claude-opus-5-5');
  writeSub('claude', { five_hour: { used_percentage: 100, resets_at: 1 } });
  usage.report(a, { cost: 4, tokensIn: 1, tokensOut: 1 });
  assert.equal(db.open().prepare('SELECT paid_estimate_usd FROM usage WHERE agent_id = ?').get(a.id).paid_estimate_usd, 0);
  // Unmanaged: an agent that matches no account keeps today's behaviour.
  const u = agent('codex', 'gpt-6.1-sol');
  usage.report(u, { cost: 4, tokensIn: 1, tokensOut: 1 });
  const urow = db.open().prepare('SELECT account, paid_estimate_usd FROM usage WHERE agent_id = ?').get(u.id);
  assert.equal(urow.account, '');
  assert.equal(urow.paid_estimate_usd, 0);
  // paid: false stops accrual, but the ledger is still read: the account shows its estimate.
  assert.equal(reading('claude-max').paid.today.source, 'estimate');
  assert.equal(reading('claude-max').paid.today.usd, 0);
});

test('estimate > a reset or stale 100% window does not accrue', () => {
  writeCost(costWith({ claude: { match: { harness: 'claude' }, paid: true } }));
  const a = agent('claude', 'claude-opus-5-5');
  const estimate = () => db.open().prepare('SELECT paid_estimate_usd FROM usage WHERE agent_id = ?').get(a.id)?.paid_estimate_usd ?? 0;
  const future = Math.floor(Date.now() / 1000) + 3600;
  // 100%, but resets_at already passed: the window has reset, so no accrual.
  writeSub('claude', { five_hour: { used_percentage: 100, resets_at: Math.floor(Date.now() / 1000) - 60 } });
  usage.report(a, { cost: 3, tokensIn: 1, tokensOut: 1 });
  assert.equal(estimate(), 0);
  // 100% with a future reset, but the reading is stale: no accrual.
  writeSub('claude', { five_hour: { used_percentage: 100, resets_at: future } }, ago(20 * 60_000));
  usage.report(db.getAgent(a.id), { cost: 6, tokensIn: 2, tokensOut: 2 });
  assert.equal(estimate(), 0);
  // A fresh 100% with a future reset accrues.
  writeSub('claude', { five_hour: { used_percentage: 100, resets_at: future } });
  usage.report(db.getAgent(a.id), { cost: 9, tokensIn: 3, tokensOut: 3 });
  assert.equal(estimate(), 3); // the growth from 6 to 9
});

test('statusline > the cost is classified against the same refresh\'s windows', () => {
  writeCost(costWith({ claude: { match: { harness: 'claude' }, paid: true } }));
  const a = agent('claude', 'claude-opus-5-5');
  const future = Math.floor(Date.now() / 1000) + 3600;
  const estimate = () => db.open().prepare('SELECT paid_estimate_usd FROM usage WHERE agent_id = ?').get(a.id)?.paid_estimate_usd ?? 0;
  // This refresh reports 100% and a cost increase; the previous window was below 100%.
  writeSub('claude', { five_hour: { used_percentage: 40, resets_at: future } });
  usage.reportStatusline(a, { cost: 2, tokensIn: 1, tokensOut: 1, subscription: { five_hour: { used_percentage: 100, resets_at: future } } });
  assert.equal(estimate(), 2, 'the growth counts on the refresh that reports 100%, not one later');
  usage.reportStatusline(db.getAgent(a.id), { cost: 5, tokensIn: 2, tokensOut: 2, subscription: { five_hour: { used_percentage: 100, resets_at: future } } });
  assert.equal(estimate(), 5); // 2 + the growth from 2 to 5
});

test('paid: false > historical paid spend is still read', () => {
  writeCost(costWith({ claude: { match: { harness: 'claude' }, paid: false } }));
  const a = agent('claude', 'claude-opus-5-5');
  // Spend recorded while the account was paid, then paid turned off.
  db.open()
    .prepare('INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, paid_estimate_usd) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(a.id, new Date().toISOString().slice(0, 10), 'claude', a.model, 'claude', 5, 5);
  writeSub('claude', { five_hour: { used_percentage: 90, resets_at: Math.floor(Date.now() / 1000) + 3600 } });
  const r = reading('claude');
  assert.equal(r.paid.today.usd, 5, 'the historical estimate is still shown');
  assert.equal(r.paid.today.source, 'estimate');
  // And no new accrual while paid is false.
  writeSub('claude', { five_hour: { used_percentage: 100, resets_at: Math.floor(Date.now() / 1000) + 3600 } });
  usage.report(a, { cost: 2, tokensIn: 1, tokensOut: 1 });
  assert.equal(reading('claude').paid.today.usd, 5);
});

test('summary > exposes the account readings', () => {
  writeCost(costWith({ claude: { match: { harness: 'claude' }, paid: true } }));
  agent('claude', 'claude-opus-5-5');
  writeSub('claude', { five_hour: { used_percentage: 50, resets_at: 1 } });
  const s = usage.summary(14);
  assert.ok(Array.isArray(s.accounts), 'summary has accounts');
  const r = s.accounts.find((x) => x.account === 'claude');
  assert.ok(r, 'the claude account is listed');
  assert.equal(r.windows.five_hour.used_percentage, 50);
  assert.equal(r.stale, false);
});

test('migration > an old usage table gains paid_estimate_usd at 0, keeping its totals', () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db.ts');
  const script = `const db = await import(${JSON.stringify(pathToFileURL(src).href)}); console.log(JSON.stringify(db.open().prepare('PRAGMA table_info(usage)').all())); console.log(JSON.stringify(db.open().prepare('SELECT account, cost_usd, paid_estimate_usd FROM usage').all()));`;
  const cases = [
    // The account-in-key table from build step 2, before this column.
    'CREATE TABLE usage (agent_id TEXT NOT NULL, day TEXT NOT NULL, harness TEXT NOT NULL, model TEXT, account TEXT NOT NULL DEFAULT \'\', cost_usd REAL NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, tokens_cache_read INTEGER NOT NULL DEFAULT 0, tokens_cache_write INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (agent_id, day, account));',
    // The older table with no account column at all.
    'CREATE TABLE usage (agent_id TEXT NOT NULL, day TEXT NOT NULL, harness TEXT NOT NULL, model TEXT, cost_usd REAL NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, tokens_cache_read INTEGER NOT NULL DEFAULT 0, tokens_cache_write INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (agent_id, day));',
  ];
  for (const [i, ddl] of cases.entries()) {
    const home2 = tempDir('stam-readings-migrate-');
    try {
      const old = new DatabaseSync(join(home2, 'stam.db'));
      old.exec(ddl);
      old.prepare('INSERT INTO usage (agent_id, day, harness, model, cost_usd) VALUES (?, ?, ?, ?, ?)').run('a1', '2026-10-11', 'claude', 'm', 5);
      old.close();
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, STAM_HOME: home2 }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const [infoLine, rowLine] = out.trim().split('\n');
      assert.ok(JSON.parse(infoLine).some((c) => c.name === 'paid_estimate_usd'), `case ${i}: the column is added`);
      const rows = JSON.parse(rowLine);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].paid_estimate_usd, 0, `case ${i}: old rows start at 0`);
      assert.equal(rows[0].cost_usd, 5, `case ${i}: their totals are unchanged`);
    } finally {
      rmSync(home2, { recursive: true, force: true });
    }
  }
});
