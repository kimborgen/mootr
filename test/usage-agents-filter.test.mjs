#!/usr/bin/env node
// Unit tests for usage.summary's agent-type filter (S-1752, src/agent-class.ts): by_day, by_model, by_agent,
// by_account, today and trees count only agents of the kept types, the per-type totals add up to the
// unfiltered one, and the account-wide fields and the unfiltered answer don't change. A throwaway
// STAM_HOME, no daemon: `node --test test/usage-agents-filter.test.mjs`.
//
// Seeded: C (cos, archived), A (assistant), I (intake), M (manager) with children W (developer) and R
// (reviewer), V (advisor), U (untyped), on two models; cost differs per agent so a wrong sum shows.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-usage-agents-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `usage-agents-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), JSON.stringify({ chiefOfStaff: 'C', cost: { accounts: { claude: { match: { harness: 'claude' } } } } }));

let db, usage, cls;
before(async () => {
  db = await import('../src/db.ts');
  usage = await import('../src/usage.ts');
  cls = await import('../src/agent-class.ts');
  seed();
});

const TYPES = { C: 'chief-of-staff', A: 'assistant', I: 'intake', M: 'manager', W: 'developer', R: 'reviewer', V: 'advisor', U: 'untyped' };
const COST = { C: 1, A: 2, I: 4, M: 8, W: 16, R: 32, V: 64, U: 128 };
const today = () => new Date().toISOString().slice(0, 10);
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

function seed() {
  const d = db.open();
  for (const t of ['usage', 'usage_samples', 'agent_parents', 'agents']) d.exec(`DELETE FROM ${t}`);
  const t = new Date().toISOString();
  const agent = (id, name, type, kind = null, parent = null) =>
    d
      .prepare('INSERT INTO agents (id, name, role, machine, harness, model, effort, cwd, parent_id, session_id, created_at, updated_at, type, kind) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?)')
      .run(id, name, 'test', 'x', 'claude', 'claude-opus-5-5', '/tmp', parent, t, t, type, kind);
  agent('C', 'cos', null);
  d.prepare("UPDATE agents SET lifecycle = 'archived' WHERE id = 'C'").run();
  agent('A', 'assistant', null, 'assistant');
  agent('I', 'intake', null);
  agent('M', 'mgr', 'manager');
  agent('W', 'dev', 'developer', null, 'M');
  agent('R', 'rev', 'reviewer', null, 'M');
  agent('V', 'adv', 'advisor');
  agent('U', 'misc', null);
  const ins = d.prepare('INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, tokens_in, tokens_out) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  for (const id of Object.keys(TYPES)) {
    // Two models by agent, today and yesterday; the fixture's cost per agent is a distinct power of two.
    ins.run(id, today(), 'claude', id < 'M' ? 'model-a' : 'model-b', 'claude', COST[id], COST[id], 1);
    ins.run(id, yesterday(), 'claude', id < 'M' ? 'model-b' : 'model-a', 'claude', COST[id], COST[id], 1);
  }
  usage.resetSnapshotMemo();
}

const sum = (rows, k = 'cost_usd') => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
const flat = (nodes) => nodes.flatMap((n) => [n, ...flat(n.children)]);
const keep = (...t) => new Set(t);
const typesPresent = Object.values(TYPES);

test('summary > without a filter the answer is the same as before', () => {
  const plain = usage.summary(14);
  assert.deepEqual(usage.summary(14, undefined, null), plain);
  assert.equal(plain.today.cost_usd, sum(Object.values(COST).map((cost_usd) => ({ cost_usd }))));
  assert.equal(plain.by_agent.length, 8);
});

test('summary > per-type totals add up to the unfiltered total', () => {
  const all = usage.summary(14);
  const per = typesPresent.map((t) => usage.summary(14, undefined, keep(t)));
  assert.equal(sum(per.map((s) => s.today)), all.today.cost_usd);
  assert.equal(sum(per.map((s) => s.today), 'tokens_in'), all.today.tokens_in);
  assert.equal(sum(per.flatMap((s) => s.by_day)), sum(all.by_day));
  assert.equal(sum(per.flatMap((s) => s.by_model)), sum(all.by_model));
  assert.equal(sum(per.flatMap((s) => s.by_agent)), sum(all.by_agent));
  assert.equal(sum(per.flatMap((s) => s.by_account)), sum(all.by_account));
  // The cost units add up too, per day.
  for (const day of all.by_day) {
    assert.equal(sum(per.flatMap((s) => s.by_day.filter((d) => d.day === day.day).map((d) => d.modes)), 'api'), day.modes.api);
  }
});

test('summary > a type keeps only its own agents, in every aggregate', () => {
  for (const [id, type] of Object.entries(TYPES)) {
    const s = usage.summary(14, undefined, keep(type));
    assert.deepEqual(s.by_agent.map((a) => a.type), [type], type);
    assert.equal(s.today.cost_usd, COST[id], type);
    assert.equal(sum(s.by_day), COST[id] * 2, type);
    assert.equal(sum(s.by_model), COST[id] * 2, type);
    assert.equal(s.by_model.length, 2, type); // two models over the two days
    assert.equal(s.by_agent[0].lifetime.cost_usd, COST[id] * 2, type);
    assert.equal(s.by_model[0].lifetime.cost_usd + s.by_model[1].lifetime.cost_usd, COST[id] * 2, type);
  }
  const two = usage.summary(14, undefined, keep('developer', 'chief-of-staff'));
  assert.equal(two.today.cost_usd, COST.W + COST.C);
});

test('summary > trees count only the kept agents', () => {
  const s = usage.summary(14, undefined, keep('developer'));
  const nodes = flat(s.trees);
  assert.deepEqual(nodes.map((n) => n.id).sort(), ['M', 'W']);
  const m = nodes.find((n) => n.id === 'M');
  assert.equal(m.cost_usd, COST.W * 2); // the manager's own spend isn't counted
  assert.deepEqual(m.children.map((c) => c.id), ['W']);
  assert.equal(usage.summary(14, undefined, keep('advisor')).trees.length, 1);
  const noneOfThem = usage.summary(14, undefined, new Set());
  assert.deepEqual(noneOfThem.trees, []);
  assert.equal(noneOfThem.today.cost_usd, null);
});

test('summary > accounts, subscriptions, allocations and the sample count stay account-wide', () => {
  const all = usage.summary(14);
  const some = usage.summary(14, undefined, keep('developer'));
  for (const k of ['note', 'display_mode', 'instructions', 'subscriptions', 'openrouter_reserve', 'accounts', 'allocations', 'blocked', 'sample_count']) {
    assert.deepEqual(some[k], all[k], k);
  }
});

test('parseAgentFilter > the type names of the Activity summary are the ones the filter takes', () => {
  assert.deepEqual([...cls.parseAgentFilter('developer,untyped')].sort(), ['developer', 'untyped']);
  assert.equal(cls.parseAgentFilter(''), null);
  assert.throws(() => cls.parseAgentFilter('nope'));
});

test('summary > echoes the applied filter and counts agents per type regardless of it', () => {
  assert.equal(usage.summary(14).filtered_agents, null);
  const some = usage.summary(14, undefined, keep('developer', 'manager'));
  assert.deepEqual(some.filtered_agents, ['developer', 'manager']);
  assert.deepEqual(some.agent_types, usage.summary(14).agent_types);
  assert.equal(some.agent_types.find((t) => t.type === 'reviewer').count, 1);
});
