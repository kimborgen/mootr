#!/usr/bin/env node
// Unit tests for build step 2 of docs/cost-policy.md: cost account matching and config
// validation, and that an invalid config is rejected while the last valid one is kept.
// Runs against a throwaway STAM_HOME, no daemon, no network, no models:
// `node --test test/accounts.test.mjs`.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempHome, tempDir } from './tmphome.mjs';

const home = tempHome('stam-accounts-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `accounts-test-${process.pid}`;
// Nothing here talks to a daemon; drop pointers to the live one anyway.
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let accounts, settings, db, usage;
before(async () => {
  accounts = await import('../src/accounts.ts');
  settings = await import('../src/settings.ts');
  db = await import('../src/db.ts');
  usage = await import('../src/usage.ts');
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
beforeEach(() => db.open().exec('DELETE FROM usage'));

test('accountFor > matches by harness and model prefix, and null when unmanaged', () => {
  writeCost(costWith({ claude: { match: { harness: 'claude' } }, openrouter: { match: { harness: 'opencode', model: 'openrouter/' } } }));
  assert.equal(accounts.accountFor({ harness: 'claude', model: 'claude-opus-5-5' }), 'claude');
  assert.equal(accounts.accountFor({ harness: 'opencode', model: 'openrouter/deepseek/deepseek-v4.1-flash' }), 'openrouter');
  assert.equal(accounts.accountFor({ harness: 'opencode', model: 'work/x' }), null);
  assert.equal(accounts.accountFor({ harness: 'codex', model: 'gpt-6.1-sol' }), null);
});

test('accountFor > the longest model prefix wins', () => {
  const cost = costWith({ wide: { match: { harness: 'opencode', model: 'openrouter/' } }, narrow: { match: { harness: 'opencode', model: 'openrouter/deepseek/' } } });
  assert.equal(accounts.matchAccount(cost, 'opencode', 'openrouter/deepseek/x'), 'narrow');
  assert.equal(accounts.matchAccount(cost, 'opencode', 'openrouter/openai/y'), 'wide');
});

test('validate > two accounts that match the same harness and model are rejected', () => {
  assert.match(accounts.validate(costWith({ a: { match: { harness: 'claude' } }, b: { match: { harness: 'claude' } } })), /both match/);
  assert.match(
    accounts.validate(costWith({ a: { match: { harness: 'opencode', model: 'openrouter/' } }, b: { match: { harness: 'opencode', model: 'openrouter/deepseek/' } } })),
    /both match/,
  );
  assert.equal(accounts.validate(costWith({ a: { match: { harness: 'claude' } }, b: { match: { harness: 'opencode', model: 'openrouter/' } } })), null);
});

test('payPerTokenProvider > OpenRouter, an explicit provider, and an OpenCode match on a configured provider (S-2118)', () => {
  const providers = { myazure: { kind: 'azure' } };
  const p = (acct, name = 'x') => accounts.payPerTokenProvider(acct, name, providers);
  assert.equal(p({ match: { harness: 'opencode', model: 'openrouter/' } }), 'openrouter');
  assert.equal(p({ match: { harness: 'stam' } }, 'openrouter-system'), 'openrouter');
  assert.equal(p({ match: { harness: 'opencode', model: 'myazure/' } }), 'myazure');
  assert.equal(p({ match: { harness: 'opencode', model: 'myazure/gpt-prod' } }), 'myazure');
  assert.equal(p({ match: { harness: 'opencode', model: 'myazure' } }), null, 'no slash: not a provider prefix');
  assert.equal(p({ match: { harness: 'opencode', model: 'other/' } }), null, 'an unconfigured provider');
  assert.equal(p({ match: { harness: 'codex', model: 'myazure/' } }), null, 'only OpenCode names providers by prefix');
  assert.equal(p({ match: { harness: 'codex' }, provider: 'openai' }), 'openai');
  assert.equal(p({ match: { harness: 'claude' }, paid: false }), null);
});

test('validate > a provider must be a non-empty string (S-2118)', () => {
  assert.match(accounts.validate(costWith({ a: { match: { harness: 'opencode', model: 'x/' }, provider: 3 } })), /bad provider/);
  assert.match(accounts.validate(costWith({ a: { match: { harness: 'opencode', model: 'x/' }, provider: '' } })), /bad provider/);
  assert.equal(accounts.validate(costWith({ a: { match: { harness: 'opencode', model: 'x/' }, provider: 'x' } })), null);
});

test('kindResolver > a pay-per-token account on a configured provider is paid (S-2118)', async () => {
  const { kindResolver } = await import('../src/cost-display.ts');
  writeFileSync(
    join(home, 'settings.json'),
    JSON.stringify({
      providers: { myazure: { kind: 'azure', endpoint: 'https://r.openai.azure.com', apiVersion: 'v1' } },
      cost: costWith({
        az: { match: { harness: 'opencode', model: 'myazure/' } },
        claude: { match: { harness: 'claude' } },
        gw: { match: { harness: 'codex' }, provider: 'gw' },
        unpaid: { match: { harness: 'opencode', model: 'openrouter/' }, paid: false },
      }),
    }),
  );
  const kind = kindResolver();
  assert.equal(kind('az'), 'paid');
  assert.equal(kind('gw'), 'paid');
  assert.equal(kind('claude'), 'subscription');
  assert.equal(kind('unpaid'), 'subscription', 'an explicit paid: false wins');
  assert.equal(kind('nobody'), 'none');
});

test('validate > a take-over target that resolves to the listing account is rejected', () => {
  // "standard" is a claude preset, so it resolves back to claude-max.
  const cost = costWith({ 'claude-max': { match: { harness: 'claude' }, onSubExhausted: { action: 'take-over', to: ['standard'], else: 'wait' } } });
  assert.match(accounts.validate(cost), /same account/);
});

test('validate > a take-over target that matches no account is rejected', () => {
  const cost = costWith({ 'claude-max': { match: { harness: 'claude' }, onSubExhausted: { action: 'take-over', to: ['nope'], else: 'wait' } } });
  assert.match(accounts.validate(cost), /matches no account/);
});

test('validate > unknown action names are rejected', () => {
  assert.match(accounts.validate(costWith({ a: { match: { harness: 'claude' }, onSubExhausted: 'explode' } })), /unknown action/);
  assert.match(accounts.validate(costWith({ a: { match: { harness: 'claude' } } }, { onError: { action: 'take-over', to: ['standard'], else: 'explode' } })), /unknown else action/);
  assert.match(accounts.validate(costWith({ a: { match: { harness: 'claude' } } }, { global: { onExhausted: 'explode' } })), /onExhausted/);
});

test('validate > cost.instructions and cost.fallbackMinutes are checked', () => {
  assert.equal(accounts.validate(costWith({}, { instructions: 'be careful', fallbackMinutes: 5 })), null);
  assert.equal(accounts.validate(costWith({})), null, 'both are optional');
  assert.match(accounts.validate(costWith({}, { instructions: 3 })), /instructions/);
  assert.match(accounts.validate(costWith({}, { fallbackMinutes: 0 })), /fallbackMinutes/);
  assert.match(accounts.validate(costWith({}, { fallbackMinutes: 'soon' })), /fallbackMinutes/);
});

test('validate > a take-over cycle is rejected', () => {
  const cost = costWith({
    a: { match: { harness: 'claude' }, onSubExhausted: { action: 'take-over', to: ['b'], else: 'wait' } },
    b: { match: { harness: 'codex' }, onSubExhausted: { action: 'take-over', to: ['a'], else: 'wait' } },
  });
  assert.match(accounts.validate(cost), /cycle/);
});

// The two examples in docs/cost-policy.md, verbatim.
const PRIVATE = {
  global: { budget: { usd: 20, per: 'day' }, onExhausted: 'soft-stop', subscriptionWork: 'continue' },
  accounts: {
    'claude-max': { match: { harness: 'claude' }, paid: false, warnPercent: [80, 95], onSubExhausted: { action: 'take-over', to: ['codex', 'second-opinion'], else: 'wait' } },
    'codex-plus': { match: { harness: 'codex' }, paid: false, onSubExhausted: { action: 'take-over', to: ['second-opinion'], else: 'wait' } },
    openrouter: {
      match: { harness: 'opencode', model: 'openrouter/' }, subscription: false, budget: { usd: 10, per: 'day' }, lowCreditsUsd: 2,
      onBudgetExhausted: 'soft-stop', onCreditsOut: 'hard-stop',
    },
  },
  onError: 'soft-stop',
};
const WORK = {
  global: null,
  accounts: {
    'claude-work': {
      match: { harness: 'claude' }, paid: true, onBillingUnknown: 'continue', budget: { usd: 500, per: 'cap', raiseSteps: [300, 500] },
      onSubExhausted: 'continue', onBudgetExhausted: { action: 'soft-stop', askRaise: true },
    },
    'codex-work': { match: { harness: 'codex' }, paid: false, onSubExhausted: { action: 'take-over', to: ['standard'], else: 'wait' } },
    oss: { match: { harness: 'opencode', model: 'work/' }, subscription: false, budget: null },
  },
  onError: { action: 'take-over', to: ['standard'], else: 'soft-stop' },
};

test("validate > the doc's two example configs both validate", () => {
  assert.equal(accounts.validate({ subscriptionWarnPercent: [80, 95], dailyWarnUsd: null, ...PRIVATE }), null);
  assert.equal(accounts.validate({ subscriptionWarnPercent: [80, 95], dailyWarnUsd: null, ...WORK }), null);
});

test('validate > never throws on malformed values, and rejects them', () => {
  assert.equal(typeof accounts.validate(null), 'string');
  const junk = [
    { accounts: { a: { match: { harness: 'claude' } } }, global: { onExhausted: { toString: null } } },
    { accounts: { a: { match: { harness: { toString: null } } } } },
    { accounts: { a: { match: { harness: 'claude' }, onSubExhausted: { toString: null } } } },
    { accounts: { a: { match: { harness: 'claude' } } }, onError: { action: { toString: null } } },
    { accounts: { a: null } },
  ];
  for (const c of junk) {
    const cfg = { subscriptionWarnPercent: [], dailyWarnUsd: null, global: null, accounts: {}, onError: 'soft-stop', ...c };
    let out;
    assert.doesNotThrow(() => { out = accounts.validate(cfg); }, `threw on ${JSON.stringify(c)}`);
    assert.equal(typeof out, 'string', `no error for ${JSON.stringify(c)}`);
  }
});

test('an invalid config is rejected and the last valid one is kept', () => {
  const valid = costWith({ claude: { match: { harness: 'claude' } } });
  writeCost(valid);
  assert.deepEqual(settings.settings().cost.accounts, { claude: { match: { harness: 'claude' } } });
  // Write an invalid config: two accounts that match the same harness.
  writeCost(costWith({ a: { match: { harness: 'claude' } }, b: { match: { harness: 'claude' } } }));
  assert.deepEqual(settings.settings().cost.accounts, { claude: { match: { harness: 'claude' } } }, 'the last valid config is kept');
  // A valid config is accepted again.
  writeCost(costWith({ codex: { match: { harness: 'codex' } } }));
  assert.deepEqual(settings.settings().cost.accounts, { codex: { match: { harness: 'codex' } } });
});

test('a malformed settings.json keeps the last valid config, not the defaults', () => {
  writeCost(costWith({ claude: { match: { harness: 'claude' } } }));
  assert.deepEqual(settings.settings().cost.accounts, { claude: { match: { harness: 'claude' } } });
  writeFileSync(join(home, 'settings.json'), '{ this is not json');
  assert.deepEqual(settings.settings().cost.accounts, { claude: { match: { harness: 'claude' } } }, 'the last valid config is kept');
});

test('costProblem > flags an invalid cost section before the save route writes it', () => {
  assert.equal(settings.costProblem({ cost: { accounts: {} } }), null);
  assert.match(settings.costProblem({ cost: { accounts: { a: { match: { harness: 'claude' } }, b: { match: { harness: 'claude' } } } } }), /both match/);
});

test('report > fills the account column and summary groups by account', () => {
  writeCost(costWith({ claude: { match: { harness: 'claude' } } }));
  const id = 'a-cost-1';
  db.createAgent({ id, name: 'cost-a', role: 'test', machine: 'x', harness: 'claude', model: 'claude-sonnet-5-5', effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  usage.report(db.getAgent(id), { cost: 2, tokensIn: 1, tokensOut: 2 });
  const row = db.open().prepare('SELECT account, cost_usd FROM usage WHERE agent_id = ?').get(id);
  assert.equal(row.account, 'claude');
  assert.equal(row.cost_usd, 2);
  assert.equal(usage.summary(14).by_account.find((r) => r.account === 'claude').cost_usd, 2);
});

test('report > a mid-day account change splits the day, and the totals still add up', () => {
  const id = 'a-cost-2';
  db.createAgent({ id, name: 'cost-b', role: 'test', machine: 'x', harness: 'claude', model: 'claude-sonnet-5-5', effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  writeCost(costWith({ first: { match: { harness: 'claude' } } }));
  usage.report(db.getAgent(id), { cost: 1, tokensIn: 1, tokensOut: 1 });
  writeCost(costWith({ second: { match: { harness: 'claude' } } }));
  usage.report(db.getAgent(id), { cost: 3, tokensIn: 3, tokensOut: 3 });
  const rows = db.open().prepare('SELECT account, cost_usd FROM usage WHERE agent_id = ? ORDER BY account').all(id);
  assert.deepEqual(rows.map((r) => [r.account, r.cost_usd]), [['first', 1], ['second', 2]]);
  const s = usage.summary(14);
  assert.equal(s.by_agent.find((r) => r.agent === 'cost-b').cost_usd, 3, 'the agent total adds up across accounts');
  assert.equal(s.by_account.find((r) => r.account === 'first').cost_usd, 1);
  assert.equal(s.by_account.find((r) => r.account === 'second').cost_usd, 2);
});

test('migration > an old usage table is rebuilt with account in its key', () => {
  const home2 = tempDir('stam-usage-migrate-');
  try {
    // An old table: PRIMARY KEY (agent_id, day), no account column.
    const old = new DatabaseSync(join(home2, 'stam.db'));
    old.exec('CREATE TABLE usage (agent_id TEXT NOT NULL, day TEXT NOT NULL, harness TEXT NOT NULL, model TEXT, cost_usd REAL NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, tokens_cache_read INTEGER NOT NULL DEFAULT 0, tokens_cache_write INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (agent_id, day));');
    old.prepare('INSERT INTO usage (agent_id, day, harness, model, cost_usd) VALUES (?, ?, ?, ?, ?)').run('a1', '2026-10-11', 'claude', 'm', 5);
    old.close();
    const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db.ts');
    const script = `const db = await import(${JSON.stringify(pathToFileURL(src).href)}); console.log(JSON.stringify(db.open().prepare('PRAGMA table_info(usage)').all())); console.log(JSON.stringify(db.open().prepare('SELECT * FROM usage').all()));`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, STAM_HOME: home2 }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const [infoLine, rowLine] = out.trim().split('\n');
    assert.ok(JSON.parse(infoLine).some((c) => c.name === 'account' && c.pk > 0), 'account is in the key');
    const rows = JSON.parse(rowLine);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].account, '', 'old rows become unmanaged');
    assert.equal(rows[0].cost_usd, 5, 'their totals are unchanged');
  } finally {
    rmSync(home2, { recursive: true, force: true });
  }
});

test('noteInvalid > mails the error once, as a new thread', async () => {
  const id = 'a-cost-mail';
  db.createAgent({ id, name: 'cost-mail', role: 'test', machine: 'x', harness: 'claude', model: 'm', effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  accounts.noteInvalid('test: bad cost config');
  await new Promise((r) => setTimeout(r, 20));
  accounts.noteInvalid('test: bad cost config');
  await new Promise((r) => setTimeout(r, 20));
  // Earlier tests leave their own invalid-config errors pending (no agent existed to send them), and
  // the agent made here delivers those too; count only the mail for this test's error.
  const rows = db.open().prepare("SELECT id, thread_id FROM mail WHERE subject = '[stam] Cost config rejected' AND body LIKE '%test: bad cost config%'").all();
  assert.equal(rows.length, 1, 'the same error is mailed once');
  assert.equal(rows[0].thread_id, rows[0].id, 'it starts its own thread');
});
