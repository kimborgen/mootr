#!/usr/bin/env node
// Unit tests for budgets across machines (S-395; src/peer-spend.ts, src/budgets.ts): a budget counts
// the peers' last known paid spend with this machine's, a stale peer stops counting, and only the
// settings home mails the human. The peers' totals are seeded with setForTest; no daemon, no
// network, no sleeps: `node --test test/peer-spend.test.mjs`.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-peerspend-');
const socket = `peerspend-test-${process.pid}`;
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = socket;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

const OR = { match: { harness: 'opencode', model: 'openrouter/' }, subscription: false };
function writeSettings(settingsHome = null) {
  writeFileSync(
    join(home, 'settings.json'),
    JSON.stringify({
      home: settingsHome,
      peers: [{ name: 'peer1', url: 'http://127.0.0.1:1', token: 't' }],
      chiefOfStaff: 'cos',
      cost: { subscriptionWarnPercent: [], accounts: { openrouter: { ...OR, budget: { usd: 10, per: 'day' } } } },
    }),
  );
}
writeSettings();

let db, blockers, budgets, ps, notices, sent;
before(async () => {
  db = await import('../src/db.ts');
  blockers = await import('../src/blockers.ts');
  budgets = await import('../src/budgets.ts');
  ps = await import('../src/peer-spend.ts');
  notices = await import('../src/cost-notices.ts');
  const { adapters } = await import('../src/adapters/index.ts');
  for (const h of ['claude', 'codex', 'opencode']) adapters[h].pushPrompt = async () => true;
});
after(() => {
  spawnSync('tmux', ['-L', socket, 'kill-server']);
  rmSync(home, { recursive: true, force: true });
});

let n = 0;
function agent() {
  const id = db.newAgentId();
  db.createAgent({ id, name: `p${++n}`, role: '', machine: 'test', harness: 'opencode', model: 'openrouter/x', effort: null, cwd: home, parent_id: null, session_id: null });
  db.updateAgent(id, { activity: 'working' });
  return db.getAgent(id);
}
const T0 = Date.parse('2026-10-14T12:00:00Z');
const totals = (day) => ({ day, week: day, month: day, cap: day });
const peerSpend = (usd) => ({ global: totals(usd), accounts: { openrouter: totals(usd) } });
function spend(a, usd) {
  db.open()
    .prepare("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd) VALUES (?, ?, 'opencode', 'openrouter/x', 'openrouter', ?) ON CONFLICT (agent_id, day, account) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd")
    .run(a.id, new Date(T0).toISOString().slice(0, 10), usd);
}
const budgetOf = (a) => blockers.blockers(a).find((b) => b.kind === 'budget');
const humanMail = () => db.inbox('human', false, 50).filter((m) => m.subject.includes('budget'));

beforeEach(() => {
  writeSettings();
  ps.setForTest('peer1', null);
  notices.notices(0);
  const d = db.open();
  for (const t of ['ledger_recon', 'cost_notices', 'blockers', 'agent_parents', 'usage', 'mail_recipients', 'mail', 'events', 'agents']) d.exec(`DELETE FROM ${t}`);
  d.exec('DROP TABLE IF EXISTS budget_mails');
  sent = [];
  budgets.setMailTesting({ send: async (to, subject, body) => (sent.push({ to, subject, body }), true) });
});

test('a peer\'s spend counts against the budget with the local spend', async () => {
  const a = agent();
  spend(a, 4);
  ps.setForTest('peer1', peerSpend(5), T0);
  await budgets.evaluateBudgets('openrouter', T0);
  assert.equal(budgetOf(a), undefined, '$9 across both is under $10');
  ps.setForTest('peer1', peerSpend(6), T0);
  await budgets.evaluateBudgets('openrouter', T0);
  assert.match(budgetOf(a).reason, /openrouter day budget of \$10 is spent/);
  assert.match(budgets.spawnHeld('openrouter', T0), /day budget of \$10 is spent/);
});

test('a peer that stopped answering counts until its last answer is stale, then not', async () => {
  const a = agent();
  spend(a, 4);
  ps.setForTest('peer1', peerSpend(7), T0);
  assert.ok(budgets.spawnHeld('openrouter', T0 + ps.STALE_MS - 1));
  assert.equal(budgets.spawnHeld('openrouter', T0 + ps.STALE_MS + 1), null, 'a stale peer never holds a spawn');
});

test('only the settings home mails the human', async () => {
  const a = agent();
  spend(a, 4);
  ps.setForTest('peer1', peerSpend(7), T0);
  writeSettings('peer1');
  await budgets.evaluateBudgets('openrouter', T0);
  assert.ok(budgetOf(a), 'a non-home machine still blocks its own agents');
  assert.equal(sent.length, 0, 'but it sends no mail');
  writeSettings();
  await budgets.evaluateBudgets('openrouter', T0 + 1000);
  assert.equal(sent.length, 1, 'the home mails once');
});

test('localSpend reports this machine\'s totals by period', () => {
  spend(agent(), 3);
  const s = ps.localSpend(T0);
  assert.equal(s.accounts.openrouter.day, 3);
  assert.equal(s.global.cap, 3);
  assert.equal(ps.perMachine('here', T0).peer1, null);
});

test('the spend route answers a peer only, not an agent or the browser', () => {
  assert.equal(ps.serve(false), null);
  assert.ok(ps.serve(true).global);
});

test('a peer going stale re-evaluates budgets once, and a late fresh answer re-arms it', async () => {
  let changes = 0;
  ps.start(() => changes++);
  ps.setForTest('peer1', peerSpend(7), T0);
  await ps.refresh(T0 + ps.STALE_MS + 1); // peer1 is unreachable, its answer is now stale
  assert.equal(changes, 1);
  await ps.refresh(T0 + ps.STALE_MS + 2);
  assert.equal(changes, 1, 'reported once');
});
