#!/usr/bin/env node
// Unit tests for budget blockers (docs/cost-policy.md, Rule enforcement: `budget:SCOPE`;
// src/budgets.ts): a spent account or global budget blocks the managed agents in scope, a
// raise or a period rollover lifts it, the 90% notice and the human's raise Decision go out
// once, and unmanaged agents are never touched. The ledger is seeded and `now` is passed in;
// no daemon, no network, no models, no sleeps: `node --test test/budgets.test.mjs`.
import { test, before, after, beforeEach } from 'node:test';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-budgets-');
const socket = `budgets-test-${process.pid}`;
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = socket;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

const OR = { match: { harness: 'opencode', model: 'openrouter/' }, subscription: false };
function writeSettings(cost = {}) {
  writeFileSync(
    join(home, 'settings.json'),
    JSON.stringify({ peers: [], chiefOfStaff: 'cos', cost: { subscriptionWarnPercent: [], accounts: { openrouter: { ...OR, budget: { usd: 10, per: 'day' } }, other: { match: { harness: 'codex' } } }, ...cost } }),
  );
}
writeSettings();

// Stands in for OpenRouter's decisions endpoint; each answer bills $5.
let calls = 0;
const server = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    calls++;
    res.end(JSON.stringify({ model: 'm', answers: { yes: { type: 'noul', noul: 0.5 } }, usage: { input_tokens: 1, output_tokens: 1, cost: 5 } }));
  });
});
writeFileSync(join(home, 'opencode.env'), 'OPENROUTER_API_KEY=test-key\n');

let db, blockers, budgets, mail, notices, rec, decide;
before(async () => {
  // A sandbox without loopback (Codex's) refuses the listen; fail at once rather than wait forever.
  await new Promise((r, j) => server.once('error', (e) => j(new Error(`can't listen on 127.0.0.1 (${e.code}): no loopback here, as in a Codex sandbox`))).listen(0, '127.0.0.1', r));
  process.env.STAM_OPENROUTER_URL = `http://127.0.0.1:${server.address().port}/api/v1`;
  rec = await import('../src/reconcile.ts');
  decide = await import('../src/decide.ts');
  db = await import('../src/db.ts');
  blockers = await import('../src/blockers.ts');
  budgets = await import('../src/budgets.ts');
  mail = await import('../src/mail.ts');
  notices = await import('../src/cost-notices.ts');
  const { adapters } = await import('../src/adapters/index.ts');
  for (const h of ['claude', 'codex', 'opencode']) adapters[h].pushPrompt = async () => true;
});
after(() => {
  server.close();
  spawnSync('tmux', ['-L', socket, 'kill-server']);
  rmSync(home, { recursive: true, force: true });
});

let n = 0;
function agent(harness, model, fields = {}) {
  const id = db.newAgentId();
  db.createAgent({ id, name: `b${++n}`, role: '', machine: 'test', harness, model, effort: null, cwd: home, parent_id: null, session_id: null, ...fields });
  db.updateAgent(id, { activity: 'working' });
  return db.getAgent(id);
}
const orAgent = (f) => agent('opencode', 'openrouter/x', f);
const budgetOf = (a) => blockers.blockers(a).find((b) => b.kind === 'budget');
const events = (a, type) => db.listEvents(a.id, 500).filter((e) => e.type === type).map((e) => JSON.parse(e.data ?? 'null'));
const T0 = Date.parse('2026-10-14T12:00:00Z');
const DAY = 86_400_000;
// Seeds paid spend on the openrouter account for the UTC day of `at`.
function spend(a, usd, at = T0) {
  db.open()
    .prepare("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd) VALUES (?, ?, 'opencode', 'openrouter/x', 'openrouter', ?) ON CONFLICT (agent_id, day, account) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd")
      .run(a.id, new Date(at).toISOString().slice(0, 10), usd);
}
const humanMail = () => db.inbox('human', false, 50).filter((m) => m.subject.includes('budget'));

beforeEach(() => {
  writeSettings();
  const d = db.open();
  notices.notices(0);
  for (const t of ['ledger_recon', 'cost_notices', 'blockers', 'agent_parents', 'usage', 'mail_recipients', 'mail', 'events', 'agents']) d.exec(`DELETE FROM ${t}`);
  d.exec('DROP TABLE IF EXISTS budget_mails');
});

test('a spent account budget blocks the managed agents on it, and only them', async () => {
  const a = orAgent();
  const b = orAgent();
  const other = agent('codex', 'gpt-6.1-sol');
  const unmanaged = agent('claude', 'claude-opus-5-5');
  spend(a, 9.99);
  await budgets.evaluateBudgets('openrouter', T0);
  assert.equal(budgetOf(a), undefined, 'under the budget nothing is set');
  spend(a, 0.01);
  await budgets.evaluateBudgets('openrouter', T0);
  for (const x of [a, b]) {
    assert.equal(budgetOf(x)?.account, 'openrouter');
    assert.match(budgetOf(x).reason, /openrouter day budget of \$10 is spent/);
    assert.equal(db.getAgent(x.id).lifecycle, 'paused');
  }
  assert.equal(budgetOf(other), undefined);
  assert.equal(budgetOf(unmanaged), undefined, 'an unmanaged agent is never blocked');
});

test('evaluating again writes nothing new', async () => {
  const a = orAgent();
  spend(a, 12);
  await budgets.evaluateBudgets('openrouter', T0);
  const since = budgetOf(a).since;
  const n1 = db.listEvents(a.id, 500).length;
  await budgets.evaluateBudgets('openrouter', T0 + 1000);
  assert.equal(budgetOf(a).since, since);
  assert.equal(db.listEvents(a.id, 500).length, n1);
  assert.equal(events(a, 'cost:rule').filter((e) => e.action === 'set').length, 1);
  assert.equal(humanMail().length, 1, 'the human is mailed once');
});

test('the human gets one mail from stam with a raise Decision under 150 words', async () => {
  const a = orAgent();
  spend(a, 10);
  await budgets.evaluateBudgets('openrouter', T0);
  await budgets.evaluateBudgets('openrouter', T0 + 5000);
  const [m] = humanMail();
  assert.ok(m);
  const body = db.getMail(m.id).body;
  assert.match(body, /```decision/);
  assert.match(body, /- Raise to \$15/);
  assert.match(body, /- Keep stopped/);
  assert.ok(body.split(/\s+/).length < 150, `${body.split(/\s+/).length} words`);
});

test('a raise lifts the stop and a later hit mails again; a lower stays stopped', async () => {
  const a = orAgent();
  spend(a, 10);
  await budgets.evaluateBudgets('openrouter', T0);
  writeSettings({ accounts: { openrouter: { ...OR, budget: { usd: 10.5, per: 'day' } } } });
  await budgets.evaluateBudgets('openrouter', T0); // 10 < 10.5
  assert.equal(budgetOf(a), undefined);
  assert.equal(db.getAgent(a.id).lifecycle, 'active');
  assert.match(events(a, 'blocker:clear').at(-1).cleared, /raised to \$10.5/);
  spend(a, 1);
  await budgets.evaluateBudgets('openrouter', T0);
  assert.ok(budgetOf(a));
  assert.equal(humanMail().length, 2, 'the new budget amount is a new Decision');
});

test('the period rolling over lifts it; a cap does not roll over', async () => {
  const a = orAgent();
  spend(a, 10);
  await budgets.evaluateBudgets('openrouter', T0);
  assert.ok(budgetOf(a));
  await budgets.evaluateBudgets('openrouter', T0 + DAY); // next UTC day: nothing spent yet
  assert.equal(budgetOf(a), undefined);
  assert.match(events(a, 'blocker:clear').at(-1).cleared, /rolled over/);

  writeSettings({ accounts: { openrouter: { ...OR, budget: { usd: 10, per: 'cap' } } } });
  await budgets.evaluateBudgets('openrouter', T0 + DAY);
  assert.ok(budgetOf(a), 'the cap counts all time');
  await budgets.evaluateBudgets('openrouter', T0 + 40 * DAY);
  assert.ok(budgetOf(a));
});

test('removing the budget lifts the stop', async () => {
  const a = orAgent();
  spend(a, 10);
  await budgets.evaluateBudgets('openrouter', T0);
  writeSettings({ accounts: { openrouter: { ...OR } } });
  await budgets.evaluateAll(T0);
  assert.equal(budgetOf(a), undefined);
});

test('the global budget sums every account and blocks every managed agent', async () => {
  writeSettings({ global: { budget: { usd: 4, per: 'day' } }, accounts: { openrouter: { ...OR }, other: { match: { harness: 'codex' } } } });
  const a = orAgent();
  const cx = agent('codex', 'gpt-6.1-sol');
  const unmanaged = agent('claude', 'claude-opus-5-5');
  spend(a, 4);
  await budgets.onSpend('openrouter', T0);
  assert.equal(budgetOf(a)?.account, 'global');
  assert.equal(budgetOf(cx)?.account, 'global');
  assert.equal(budgetOf(unmanaged), undefined);
  assert.match(budgetOf(a).reason, /global day budget of \$4/);
  assert.equal(humanMail().length, 1);
});

test('90% of a budget notifies the managers of the trees on the account, once', async () => {
  const mgr = agent('claude', 'claude-opus-5-5', { name: 'mgr' });
  const a = orAgent({ parent_id: mgr.id });
  spend(a, 9);
  await budgets.evaluateBudgets('openrouter', T0);
  await budgets.evaluateBudgets('openrouter', T0 + 1000);
  const lows = notices.notices().filter((x) => x.kind === 'budget-low');
  assert.equal(lows.length, 1);
  assert.equal(lows[0].account, 'openrouter');
  assert.equal(budgetOf(a), undefined, 'not stopped yet');
  assert.equal(humanMail().length, 0, 'the human hears at the budget, not at 90%');
});

test('a blocker set and cleared notifies the blocked agent\'s manager', async () => {
  const mgr = agent('claude', 'claude-opus-5-5', { name: 'mgr2' });
  const a = orAgent({ parent_id: mgr.id });
  spend(a, 10);
  await budgets.evaluateBudgets('openrouter', T0);
  assert.ok(notices.notices().some((x) => x.kind === 'blocker-set' && x.agent_id === a.id));
  await budgets.evaluateBudgets('openrouter', T0 + DAY);
  assert.ok(notices.notices().some((x) => x.kind === 'blocker-clear' && x.agent_id === a.id));
});

test('global spend sums the whole ledger: exact and estimated rows, and an account since deleted', async () => {
  writeSettings({ global: { budget: { usd: 4, per: 'day' } }, accounts: { openrouter: { ...OR }, 'claude-p': { match: { harness: 'claude' }, paid: true }, other: { match: { harness: 'codex' } } } });
  const a = orAgent();
  const c = agent('claude', 'claude-opus-5-5');
  const cx = agent('codex', 'gpt-6.1-sol');
  spend(a, 2);
  // Claude's statusline cost counts only as its paid estimate; cost_usd is not paid spend.
  db.open().prepare("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, paid_estimate_usd) VALUES (?, ?, 'claude', 'claude-opus-5-5', 'claude-p', 50, 1.5)").run(c.id, new Date(T0).toISOString().slice(0, 10));
  await budgets.evaluateBudgets('global', T0);
  assert.equal(budgetOf(cx), undefined, '2 + 1.5 is under 4');
  db.open().prepare("UPDATE usage SET paid_estimate_usd = 2 WHERE agent_id = ?").run(c.id);
  await budgets.evaluateBudgets('global', T0);
  assert.ok(budgetOf(cx), '2 + 2 reaches 4, counted once');
  // Deleting a spent account from settings doesn't lower what was spent.
  writeSettings({ global: { budget: { usd: 4, per: 'day' } }, accounts: { other: { match: { harness: 'codex' } } } });
  await budgets.evaluateBudgets('global', T0);
  assert.ok(budgetOf(cx), 'still stopped');
});

test('global spend counts a renamed or deleted OpenRouter account by billed cost, and decision calls under openrouter', async () => {
  writeSettings({ global: { budget: { usd: 3, per: 'day' } }, accounts: { other: { match: { harness: 'codex' } } } });
  const a = agent('opencode', 'openrouter/x');
  const cx = agent('codex', 'gpt-6.1-sol');
  const day = new Date(T0).toISOString().slice(0, 10);
  // Written under an account since deleted: only its harness and model say it was billed.
  db.open().prepare("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, paid_estimate_usd) VALUES (?, ?, 'opencode', 'openrouter/x', 'old-or', 2, 0)").run(a.id, day);
  await budgets.evaluateBudgets('global', T0);
  assert.equal(budgetOf(cx), undefined, '2 of 3');
  // stam's own decision calls are recorded under the account openrouter.
  db.open().prepare("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd) VALUES (?, ?, 'stam', 'mail-check', 'openrouter', 1)").run(cx.id, day);
  await budgets.evaluateBudgets('global', T0);
  assert.ok(budgetOf(cx), '2 + 1 reaches 3');
});

test('a spawn onto a spent account or the global scope is refused, others are not', async () => {
  const { admitSpawn } = await import('../src/admission.ts');
  const a = orAgent();
  spend(a, 10, Date.now()); // spawnHeld reads the clock
  assert.throws(() => admitSpawn({ name: 'n1', harness: 'opencode', model: 'openrouter/x', human: false }), /budget \(account openrouter's day budget of \$10 is spent\)/);
  assert.equal(admitSpawn({ name: 'n2', harness: 'codex', model: 'gpt-6.1-sol', human: false }), null);
  assert.ok(admitSpawn({ name: 'n3', harness: 'opencode', model: 'openrouter/x', human: true, force: true }), 'the human can force it');
  writeSettings({ global: { budget: { usd: 10, per: 'day' } }, accounts: { openrouter: { ...OR }, other: { match: { harness: 'codex' } } } });
  assert.throws(() => admitSpawn({ name: 'n4', harness: 'codex', model: 'gpt-6.1-sol', human: false }), /global day budget of \$10 is spent/);
  // A forced spawn carries the blocker from the start.
  const forced = orAgent();
  await budgets.attachSpawn(forced);
  assert.ok(budgetOf(forced));
});

test('an agent a settings change moves out of scope loses the blocker', async () => {
  const a = orAgent();
  spend(a, 10);
  const b = orAgent();
  await budgets.evaluateBudgets('openrouter', T0);
  assert.ok(budgetOf(a) && budgetOf(b));
  // The account now matches only openrouter/y: both agents become unmanaged. Bring one back.
  writeSettings({ accounts: { openrouter: { match: { harness: 'opencode', model: 'openrouter/y' }, subscription: false, budget: { usd: 10, per: 'day' } }, other: { match: { harness: 'codex' } } } });
  db.updateAgent(b.id, { model: 'openrouter/y' });
  await budgets.evaluateBudgets('openrouter', T0);
  assert.equal(budgetOf(a), undefined, 'a left the scope');
  assert.ok(budgetOf(b), 'b is still in it');
});

test('a mail that fails to send is retried on a timer with no later usage', async () => {
  const a = orAgent();
  const now = Date.now(); // the retry reads the clock itself
  spend(a, 10, now);
  let fail = true;
  const sent = [];
  budgets.setMailTesting({ delays: [1, 1, 1], send: async (to, subject, body) => (fail ? false : (sent.push(subject), true)) });
  await budgets.evaluateBudgets('openrouter', now);
  assert.equal(sent.length, 0);
  fail = false;
  for (let i = 0; i < 400 && !sent.length; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(sent.length, 1, 'the retry sent it');
  await budgets.evaluateBudgets('openrouter', now);
  assert.equal(sent.length, 1, 'and recorded it');
  budgets.setMailTesting({ send: mail.sendFromStam, delays: [60_000] });
});

// Waits for the chained evaluations a ledger write started.
const settled = () => Promise.all([budgets.evaluateBudgets('global'), budgets.evaluateBudgets('openrouter')]);

test('the decision model\'s own spend crossing the global cap blocks and mails, with no agent report', async () => {
  writeSettings({ global: { budget: { usd: 8, per: 'day' } }, accounts: { other: { match: { harness: 'codex' } } } });
  const cx = agent('codex', 'gpt-6.1-sol');
  const yes = { yes: { type: 'noul', question: 'q' } };
  await decide.decide('s', yes, { purpose: 'decide:test' }); // $5 of $8
  await settled();
  assert.equal(budgetOf(cx), undefined);
  await decide.decide('s', yes, { purpose: 'decide:test' }); // $10
  await settled();
  assert.match(budgetOf(cx)?.reason ?? '', /global day budget of \$8 is spent/);
  assert.equal(humanMail().length, 1);
});

test('a reconciliation that shows the cap was not reached lifts the stop, and says so', async () => {
  const a = orAgent();
  await rec.reconcile({ rows: [] }, 0); // the baseline
  const day = new Date().toISOString().slice(0, 10);
  db.open().prepare("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, unreconciled_usd) VALUES (?, ?, 'opencode', 'openrouter/x', 'openrouter', 10, 10)").run(a.id, day);
  await budgets.evaluateBudgets('openrouter');
  assert.ok(budgetOf(a), 'list price reaches the $10 budget');
  await rec.reconcile(rec.snapshot(), 4); // the bill shows $4
  await settled();
  assert.equal(budgetOf(a), undefined);
  assert.match(events(a, 'blocker:clear').at(-1).cleared, /ledger was corrected to the billed amount/);
  assert.equal(db.getAgent(a.id).lifecycle, 'active');
});

// The system scope (S-1077): stam's own calls bill to `openrouter-system`, whose budget is the
// system's, apart from the agents' budget on `openrouter`.
const SYS = { match: { harness: 'stam' } };
const sysSettings = (usd) => writeSettings({ accounts: { openrouter: { ...OR, budget: { usd: 10, per: 'day' } }, 'openrouter-system': { ...SYS, budget: { usd, per: 'day' } } } });
const yes = { yes: { type: 'noul', instructions: 'q' } };
const sysSpent = () => db.open().prepare("SELECT SUM(cost_usd) AS s FROM usage WHERE account = 'openrouter-system'").get().s ?? 0;

test('system calls are recorded under openrouter-system and count once against its budget, not the agents\'', async () => {
  sysSettings(100);
  const a = orAgent();
  const r = await decide.decide('s', yes, { purpose: 'decide:test' });
  assert.ok(r);
  assert.equal(sysSpent(), 5);
  assert.equal(db.open().prepare("SELECT COUNT(*) AS n FROM usage WHERE account = 'openrouter' AND agent_id = 'stam'").get().n, 0);
  const readings = (await import('../src/readings.ts')).accountReadings();
  const by = Object.fromEntries(readings.map((x) => [x.account, x]));
  assert.equal(by['openrouter-system'].budget.spent, 5);
  assert.equal(by.openrouter.budget.spent, 0, 'the agents\' budget does not see the system\'s spend');
  await settled();
  assert.equal(budgetOf(a), undefined);
});

test('a spent agents budget stops agents but not system calls', async () => {
  sysSettings(100);
  const a = orAgent();
  spend(a, 10);
  await budgets.evaluateBudgets('openrouter', T0);
  assert.ok(budgetOf(a), 'the agent is stopped');
  assert.equal(budgets.systemHeld(T0), null);
  assert.ok(await decide.decide('s', yes, { purpose: 'decide:test' }), 'the system call still runs');
});

test('a spent system budget makes decide fail with a decide:error event and no request, and leaves agents running', async () => {
  sysSettings(8);
  const a = orAgent();
  assert.ok(await decide.decide('s', yes, { purpose: 'decide:test' })); // $5 of $8
  assert.ok(await decide.decide('s', yes, { purpose: 'decide:test' })); // $10
  await settled();
  const before = calls;
  assert.match(budgets.systemHeld() ?? '', /system day budget of \$8 is spent/);
  assert.equal(await decide.decide('s', yes, { purpose: 'decide:held' }), null);
  assert.equal(calls, before, 'no request was sent');
  const err = db.listEvents('stam', 50).map((e) => JSON.parse(e.data ?? 'null')).find((d) => d?.purpose === 'decide:held');
  assert.match(err?.error ?? '', /system day budget/);
  assert.equal(budgetOf(a), undefined, 'agents on openrouter are not stopped by the system budget');
  assert.equal(humanMail().length, 1, 'the human gets the raise Decision once');
  const body = db.getMail(humanMail()[0].id).body;
  assert.match(body, /cost\.accounts\.openrouter-system\.budget\.usd/);
  assert.match(body, /model calls .* are skipped/);
  assert.match(body, /The calls resume when the day rolls over/);
  assert.match(body, /Keep stopped: the calls stay skipped/);
  assert.doesNotMatch(body, /stopped the agents|They resume/);
});

test('the system budget warns at 90% through cost notices', async () => {
  sysSettings(5.5);
  const cos = agent('claude', 'claude-opus-5-5', { name: 'cos' });
  assert.ok(await decide.decide('s', yes, { purpose: 'decide:test' })); // $5 of $5.5: 91%
  await settled();
  await budgets.evaluateBudgets('openrouter-system');
  const row = db.open().prepare("SELECT * FROM cost_notices WHERE account = 'openrouter-system' AND kind = 'budget-low'").get();
  assert.ok(row, 'a budget-low notice was raised');
  assert.deepEqual(JSON.parse(row.managers), [cos.id], 'it goes to the chief of staff');
});

test('global spend counts system calls once', async () => {
  writeSettings({ global: { budget: { usd: 4, per: 'day' } }, accounts: { 'openrouter-system': { ...SYS }, other: { match: { harness: 'codex' } } } });
  const cx = agent('codex', 'gpt-6.1-sol');
  assert.ok(await decide.decide('s', yes, { purpose: 'decide:test' })); // $5
  await settled();
  assert.match(budgetOf(cx)?.reason ?? '', /global day budget of \$4 is spent/);
});

// The one-off move of stam's old rows to openrouter-system (db.ts migrateSystemCalls).
const migrationRow = () => db.open().prepare("SELECT 1 AS n FROM migrations WHERE name = 'stam-calls-to-system-account'").get();
function seedStam(account, day, cost, tin, tout, unrec = 0) {
  db.open().prepare("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, tokens_in, tokens_out, unreconciled_usd) VALUES ('stam', ?, 'openrouter', 'decide:x', ?, ?, ?, ?, ?)").run(day, account, cost, tin, tout, unrec);
}
const stamRows = () => db.open().prepare("SELECT day, account, cost_usd, tokens_in, tokens_out, unreconciled_usd FROM usage WHERE agent_id = 'stam' ORDER BY day, account").all();

test('migration moves old stam rows to openrouter-system, once, and records it', () => {
  db.open().prepare("DELETE FROM migrations WHERE name = 'stam-calls-to-system-account'").run();
  seedStam('openrouter', '2026-10-10', 1, 10, 1);
  seedStam('openrouter', '2026-10-11', 2, 20, 2);
  db.migrateSystemCalls(db.open());
  assert.deepEqual(stamRows().map((r) => [r.day, r.account, r.cost_usd, r.tokens_in]), [['2026-10-10', 'openrouter-system', 1, 10], ['2026-10-11', 'openrouter-system', 2, 20]]);
  assert.ok(migrationRow());
  seedStam('openrouter', '2026-10-12', 4, 1, 1);
  db.migrateSystemCalls(db.open());
  assert.equal(stamRows().filter((r) => r.account === 'openrouter').length, 1, 'a recorded migration does not run again');
});

test('migration folds a day that has both accounts into the system row, and moves the rest', () => {
  db.open().prepare("DELETE FROM migrations WHERE name = 'stam-calls-to-system-account'").run();
  seedStam('openrouter', '2026-10-10', 1, 10, 1, 0.5);
  seedStam('openrouter-system', '2026-10-10', 2, 20, 2, 0.25);
  seedStam('openrouter', '2026-10-11', 4, 40, 4);
  const total = () => stamRows().reduce((t, r) => t + r.cost_usd, 0);
  assert.equal(total(), 7);
  db.migrateSystemCalls(db.open());
  assert.deepEqual(stamRows().map((r) => [r.day, r.account, r.cost_usd, r.tokens_in, r.tokens_out, r.unreconciled_usd]), [
    ['2026-10-10', 'openrouter-system', 3, 30, 3, 0.75],
    ['2026-10-11', 'openrouter-system', 4, 40, 4, 0],
  ]);
  assert.equal(total(), 7, 'nothing is lost or counted twice');
  assert.ok(migrationRow());
});

// The system reserve of the shared OpenRouter credit (budgets.ts reserveState): the agents' scope
// is held while the last credit reading is at or below the reserve, whatever the agents spent.
const reading = (remaining, total = 20, observed = new Date().toISOString()) =>
  db.open().prepare("INSERT INTO subscriptions (name, data, updated_at) VALUES ('openrouter', ?, ?) ON CONFLICT (name) DO UPDATE SET data = excluded.data").run(JSON.stringify({ credits: { total, used: total - remaining, remaining, key_limit: null, key_remaining: null, observed_at: observed } }), new Date().toISOString());
const noBudget = (extra = {}) => writeSettings({ accounts: { openrouter: { ...OR }, other: { match: { harness: 'codex' } }, ...extra } });
const reserveNotices = () => db.open().prepare("SELECT * FROM cost_notices WHERE kind = 'reserve-near'").all();

test('credit at the default $1 reserve holds the openrouter agents and refuses new ones, and a top-up clears it', async () => {
  noBudget();
  const a = orAgent();
  const cx = agent('codex', 'gpt-6.1-sol');
  reading(3);
  await budgets.evaluateBudgets('openrouter');
  assert.equal(budgetOf(a), undefined, 'above the reserve nothing is held');
  assert.equal(budgets.spawnHeld('openrouter'), null);
  reading(1);
  await budgets.evaluateBudgets('openrouter');
  assert.match(budgetOf(a)?.reason ?? '', /OpenRouter credit is down to the reserve kept for stam's own model calls/);
  assert.match(budgets.spawnHeld('openrouter') ?? '', /kept for stam's own model calls/);
  assert.equal(budgets.spawnHeld('other'), null, 'other accounts are untouched');
  assert.equal(budgetOf(cx), undefined);
  reading(8, 30);
  await budgets.evaluateBudgets('openrouter');
  assert.equal(budgetOf(a), undefined, 'a top-up clears it');
  assert.equal(budgets.spawnHeld('openrouter'), null);
  assert.ok(events(a, 'cost:rule').some((e) => e.action === 'clear' && /topped up/.test(e.cleared)));
});

test('the reserve is the unspent part of the system budget when one is set', async () => {
  noBudget({ 'openrouter-system': { ...SYS, budget: { usd: 4, per: 'day' } } });
  const a = orAgent();
  reading(3);
  await budgets.evaluateBudgets('openrouter');
  assert.match(budgetOf(a)?.reason ?? '', /kept for stam's own model calls/, '$3 left is under the unspent $4');
  db.open().prepare("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd) VALUES ('stam', ?, 'openrouter', 'decide:x', 'openrouter-system', 3)").run(new Date().toISOString().slice(0, 10));
  await budgets.evaluateBudgets('openrouter');
  assert.equal(budgetOf(a), undefined, 'after $3 of system calls the reserve is $1, and $3 left is above it');
});

test('the reserve notice goes out once per top-up, before the hold', async () => {
  noBudget();
  const cos = agent('claude', 'claude-opus-5-5', { name: 'cos' });
  const a = orAgent();
  reading(1.8);
  await budgets.evaluateBudgets('openrouter');
  await budgets.evaluateBudgets('openrouter');
  assert.equal(budgetOf(a), undefined, 'near, not yet held');
  assert.equal(reserveNotices().length, 1, 'one notice for the two evaluations');
  assert.ok(JSON.parse(reserveNotices()[0].managers).includes(cos.id));
  reading(0.5);
  await budgets.evaluateBudgets('openrouter');
  assert.ok(budgetOf(a), 'then held');
  assert.equal(reserveNotices().length, 1);
  reading(1.6, 40);
  await budgets.evaluateBudgets('openrouter');
  assert.equal(reserveNotices().length, 2, 'a top-up re-arms the notice');
});

test('creditReserve gives the reserve and the credit left, and null for a stale reading', () => {
  noBudget();
  reading(3);
  assert.deepEqual(budgets.creditReserve(), { reserve: 1, remaining: 3 });
  reading(3, 20, new Date(Date.now() - 3 * 3_600_000).toISOString());
  assert.deepEqual(budgets.creditReserve(), { reserve: 1, remaining: null }, 'a reading older than STALE_MS is unknown');
});

test('the agents\' own spent budget still wins over the reserve', async () => {
  writeSettings();
  const a = orAgent();
  spend(a, 10, Date.now());
  reading(0.5);
  await budgets.evaluateBudgets('openrouter');
  assert.match(budgetOf(a)?.reason ?? '', /openrouter day budget of \$10 is spent/);
});

test('a stale credit reading does not hold, and asks for a fresh balance', async () => {
  noBudget();
  const a = orAgent();
  let polls = 0;
  budgets.setCreditPoller(() => polls++);
  reading(0.5, 20, new Date(Date.now() - 3_600_000).toISOString());
  await budgets.evaluateBudgets('openrouter');
  assert.equal(budgetOf(a), undefined, 'an hour-old reading blocks nothing');
  assert.equal(budgets.spawnHeld('openrouter'), null);
  assert.ok(polls > 0, 'the stale reading is refreshed');
});

test('a hold stays through a stale reading, and a refused spawn polls; a fresh top-up with no agent running releases it', async () => {
  noBudget();
  const a = orAgent();
  let polls = 0;
  budgets.setCreditPoller(() => polls++);
  reading(0.5);
  await budgets.evaluateBudgets('openrouter');
  assert.ok(budgetOf(a));
  const before = polls;
  assert.match(budgets.spawnHeld('openrouter') ?? '', /kept for stam's own model calls/);
  assert.ok(polls > before, 'a refused spawn asks for a fresh balance');
  reading(0.5, 20, new Date(Date.now() - 3_600_000).toISOString());
  await budgets.evaluateBudgets('openrouter');
  assert.ok(budgetOf(a), 'a stale reading does not lift the hold');
  // The agent is held, so none is running; the next whole poll shows the top-up.
  db.updateAgent(a.id, { activity: 'idle' });
  reading(9, 30);
  await budgets.evaluateBudgets('openrouter');
  assert.equal(budgetOf(a), undefined);
  assert.equal(budgets.spawnHeld('openrouter'), null);
});

test('a moving reserve does not rewrite the hold', async () => {
  noBudget({ 'openrouter-system': { ...SYS, budget: { usd: 4, per: 'day' } } });
  const a = orAgent();
  reading(3);
  await budgets.evaluateBudgets('openrouter');
  const sets = () => events(a, 'cost:rule').filter((e) => e.action === 'set').length;
  const n = sets();
  assert.equal(n, 1);
  db.open().prepare("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd) VALUES ('stam', ?, 'openrouter', 'decide:x', 'openrouter-system', 0.5)").run(new Date().toISOString().slice(0, 10));
  reading(2.9);
  await budgets.evaluateBudgets('openrouter');
  assert.equal(sets(), n, 'the reserve moved from $4 to $3.5, no new set event');
});

// S-1183: budgets.ts -> mail.ts -> credits.ts, and credits.ts registers its poll at load. If budgets.ts
// is the first of the pair to load, the registration runs while budgets.ts is still evaluating its
// `let`, which throws a TDZ error. Each import order runs in a fresh process, so the cycle is real.
for (const first of ['budgets', 'credits']) {
  test(`importing ${first}.ts first, in a fresh process, does not throw (the poller cycle)`, () => {
    const src = join(import.meta.dirname, '..', 'src', `${first}.ts`);
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(src)});`], { env: process.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });
}
