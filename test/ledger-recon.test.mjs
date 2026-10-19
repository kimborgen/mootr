#!/usr/bin/env node
// OpenRouter ledger reconciliation (S-106): src/reconcile.ts scales OpenCode's reported cost
// to the billed /credits delta on each poll. Throwaway STAM_HOME, a stubbed /credits
// (STAM_OPENROUTER_URL), no daemon, no network, no models: `node --test test/ledger-recon.test.mjs`.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-recon-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `recon-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'OPENROUTER_API_KEY']) delete process.env[k];
writeFileSync(join(home, 'opencode.env'), 'OPENROUTER_API_KEY=test-key\n');
const settingsFile = join(home, 'settings.json');
const withAccounts = (accounts) => writeFileSync(settingsFile, JSON.stringify({ cost: { accounts } }));
const OR = { harness: 'opencode', model: 'openrouter/' };
withAccounts({ openrouter: { match: OR } });

let used = 0;
let onKey = null; // runs while the stub answers /key
const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/api/v1/credits') res.end(JSON.stringify({ data: { total_credits: 100, total_usage: used } }));
  else if (req.url === '/api/v1/key') { onKey?.(); res.end(JSON.stringify({ data: { limit: null, limit_remaining: null } })); }
  else res.writeHead(404).end('{}');
});

let db, usage, credits, rec;
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.STAM_OPENROUTER_URL = `http://127.0.0.1:${server.address().port}/api/v1`;
  db = await import('../src/db.ts');
  usage = await import('../src/usage.ts');
  credits = await import('../src/credits.ts');
  rec = await import('../src/reconcile.ts');
});
after(() => { server.close(); rmSync(home, { recursive: true, force: true }); });

let n = 0;
const agent = () => {
  const id = `r-agent-${++n}`;
  db.createAgent({ id, name: `recon-${n}`, role: 'test', machine: 'x', harness: 'opencode', model: 'openrouter/deepseek/deepseek-v4.1-flash', effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  return db.getAgent(id);
};
const cost = (id) => db.open().prepare('SELECT ROUND(SUM(cost_usd), 6) AS c FROM usage WHERE agent_id = ?').get(id).c;
const pending = () => db.open().prepare('SELECT ROUND(COALESCE(SUM(unreconciled_usd), 0), 6) AS u FROM usage').get().u;
const state = () => db.open().prepare('SELECT * FROM ledger_recon WHERE id = 1').get();
const poll = async (total) => { used = total; await credits.pollCredits(); };
const spend = (a, usd) => usage.report(db.getAgent(a.id), { cost: usd, session: 's' });

beforeEach(async () => {
  const d = db.open();
  d.exec('DELETE FROM usage; DELETE FROM ledger_recon; DROP TRIGGER IF EXISTS boom');
  withAccounts({ openrouter: { match: OR } });
  d.prepare("DELETE FROM subscriptions WHERE name = 'openrouter'").run();
  await poll(10); // the first poll sets the baseline
});

test('scales reported cost to the billed delta, split by reported cost', async () => {
  const a = agent(), b = agent();
  spend(a, 1);
  spend(b, 3);
  await poll(12); // billed $2 against $4 reported
  assert.equal(cost(a.id), 0.5);
  assert.equal(cost(b.id), 1.5);
  assert.equal(pending(), 0);
});

test('a report landing during the poll waits for the next one', async () => {
  const a = agent();
  spend(a, 1);
  const snap = rec.snapshot(); // the poll took this before reading /credits
  spend(a, 2); // +$1 lands before the bill is reconciled
  rec.reconcile(snap, 10.5); // billed $0.5 for the $1 snapshot
  assert.equal(cost(a.id), 1.5, '0.5 scaled, 1 still reported');
  assert.equal(pending(), 1);
  await poll(11); // billed another $0.5 for that $1
  assert.equal(cost(a.id), 1);
});

test('a bill before its report is carried to the next poll, once', async () => {
  const a = agent();
  await poll(11); // billed $1, nothing reported yet
  assert.equal(state().carry, 1);
  spend(a, 1.5);
  await poll(11); // no new bill; the carried $1 meets $1.5
  assert.equal(cost(a.id), 1);
  assert.equal(state().carry, 0);
  spend(a, 2.5);
  await poll(11); // no bill and no carry left: nothing scaled, the report stays pending
  assert.equal(cost(a.id), 2);
  assert.equal(pending(), 1);
});

test('a bill above the reported cost never raises the ledger, and its excess does not pile up', async () => {
  const a = agent();
  spend(a, 1);
  await poll(15); // $5 billed (another machine) against $1 reported
  assert.equal(cost(a.id), 1);
  assert.equal(state().carry, 4, 'the excess over what was reported');
  await poll(15); // the carry lasts one poll
  assert.equal(state().carry, 0);
});

test('a failed transaction scales nothing and moves no baseline; a retry scales once', async () => {
  const a = agent();
  spend(a, 4);
  const snap = rec.snapshot();
  // A trigger that aborts the write stands in for a crash between the statements.
  db.open().exec("CREATE TRIGGER boom BEFORE UPDATE OF unreconciled_usd ON usage BEGIN SELECT RAISE(ABORT, 'crash'); END");
  assert.throws(() => rec.reconcile(snap, 12), /crash/);
  assert.equal(cost(a.id), 4);
  assert.equal(pending(), 4);
  assert.equal(state().billed_used, 10);
  db.open().exec('DROP TRIGGER boom');
  rec.reconcile(snap, 12);
  assert.equal(cost(a.id), 2);
  rec.reconcile(rec.snapshot(), 12); // the same total again changes nothing
  assert.equal(cost(a.id), 2);
});

test('an account is an OpenRouter account by its match, not its name', async () => {
  withAccounts({ cheap: { match: OR } });
  const a = agent();
  spend(a, 2);
  assert.equal(db.open().prepare('SELECT account FROM usage WHERE agent_id = ?').get(a.id).account, 'cheap');
  await poll(11); // billed $1 against $2
  assert.equal(cost(a.id), 1);
});

test('decision costs are exact: out of the bill first, never scaled, and By model matches by_account', async () => {
  const a = agent();
  spend(a, 1);
  db.open().prepare("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd) VALUES ('stam', ?, 'openrouter', 'decide:x', 'openrouter-system', 0.2)").run(new Date().toISOString().slice(0, 10));
  db.addEvent('stam', 'decide', { purpose: 'decide:x', cost: 0.2, tokens_in: 1, tokens_out: 1 });
  rec.addExactPending(0.2);
  await poll(10.7); // billed $0.7: $0.2 decision, $0.5 for OpenCode's $1
  assert.equal(cost(a.id), 0.5);
  assert.equal(cost('stam'), 0.2);
  const s = usage.summary(14);
  const sum = (rows) => Math.round(rows.reduce((t, r) => t + r.cost_usd, 0) * 1e4) / 1e4;
  assert.equal(sum(s.by_model), 0.7);
  assert.equal(sum(s.by_model), sum(s.by_account.filter((r) => r.account === 'openrouter' || r.account === 'openrouter-system')));
  assert.equal(sum(s.by_model), sum(s.by_agent));
});

test('a zero or partial bill keeps the unmatched decision cost pending', async () => {
  rec.addExactPending(0.2);
  await poll(10); // no bill
  assert.equal(state().exact_pending, 0.2);
  await poll(10.1); // $0.1 of the $0.2 decision cost
  assert.ok(Math.abs(state().exact_pending - 0.1) < 1e-9);
  await poll(10.2);
  assert.ok(Math.abs(state().exact_pending) < 1e-9);
});

test('decision cost is matched against the carried bill too', async () => {
  const a = agent();
  await poll(11); // billed $1 with nothing reported: carried
  spend(a, 1);
  rec.addExactPending(0.3);
  await poll(11); // no new bill; the carry covers $0.3 of decision and $0.7 of OpenCode
  assert.equal(cost(a.id), 0.7);
  assert.ok(Math.abs(state().exact_pending) < 1e-9);
});

test('a decision landing between the snapshot and /credits is in this bill, even if spending stops', async () => {
  const a = agent();
  spend(a, 1);
  const snap = rec.snapshot();
  db.open().prepare("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd) VALUES ('stam', ?, 'openrouter', 'decide:x', 'openrouter-system', 0.2)").run(new Date().toISOString().slice(0, 10));
  rec.addExactPending(0.2);
  rec.reconcile(snap, 10.7); // billed $0.7: $0.2 decision, $0.5 for OpenCode's $1
  assert.ok(Math.abs(cost(a.id) + cost('stam') - 0.7) < 1e-9, 'the ledger totals the bill');
  assert.equal(state().exact_pending, 0);
});

test('a decision completing during the /key call is not read as part of the /credits bill', async () => {
  const a = agent();
  spend(a, 1);
  onKey = () => {
    db.open().prepare("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd) VALUES ('stam', ?, 'openrouter', 'decide:x', 'openrouter-system', 0.2)").run(new Date().toISOString().slice(0, 10));
    rec.addExactPending(0.2);
  };
  try {
    await poll(10.5); // billed $0.5, all of it OpenCode's; the decision is not in it yet
  } finally {
    onKey = null;
  }
  assert.equal(cost(a.id), 0.5);
  assert.equal(state().exact_pending, 0.2, 'waits for its own bill');
  await poll(10.7); // no more spending: the decision's $0.2 arrives
  assert.equal(cost(a.id), 0.5);
  assert.ok(Math.abs(state().exact_pending) < 1e-9);
  assert.ok(Math.abs(cost(a.id) + cost('stam') - 0.7) < 1e-9);
});

test('allocations read the billed column for a harness-only OpenRouter account', async () => {
  withAccounts({ openrouter: { match: { harness: 'opencode' } } });
  const alloc = await import('../src/allocations.ts');
  const a = agent();
  spend(a, 2);
  await poll(11); // billed $1
  assert.equal(alloc.paidSpend(a.id, 'openrouter', 'day'), 1);
});
