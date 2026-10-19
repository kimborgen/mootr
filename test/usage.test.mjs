#!/usr/bin/env node
// Unit tests for usage.report and usage.summary: cumulative per-session reports are
// summed into the four token columns, a restart (a drop) counts the new numbers in full,
// and a baseline written before the cache columns existed still works. Runs against a
// throwaway STAM_HOME with no daemon, no network, and no models: `node --test test/usage.test.mjs`.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-usage-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `usage-test-${process.pid}`;
// Nothing here talks to a daemon; drop a parent agent's pointers to the live one anyway.
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let db, usage, adapters;
before(async () => {
  db = await import('../src/db.ts');
  usage = await import('../src/usage.ts');
  ({ adapters } = await import('../src/adapters/index.ts'));
});
after(() => rmSync(home, { recursive: true, force: true }));

let n = 0;
function agent() {
  return agentOf('opencode');
}
function agentOf(harness, model = 'test/model') {
  const id = `u-agent-${++n}`;
  db.createAgent({ id, name: `usage-${n}`, role: 'test', machine: 'x', harness, model, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  return db.getAgent(id);
}
const row = (id) => db.open().prepare('SELECT * FROM usage WHERE agent_id = ?').get(id);

beforeEach(() => db.open().exec('DELETE FROM usage'));

test('report > sums the four token kinds from cumulative reports', () => {
  const a = agent();
  usage.report(a, { cost: 1, tokensIn: 10, tokensOut: 20, tokensCacheRead: 30, tokensCacheWrite: 40 });
  usage.report(db.getAgent(a.id), { cost: 1.5, tokensIn: 15, tokensOut: 25, tokensCacheRead: 33, tokensCacheWrite: 44 });
  const r = row(a.id);
  assert.equal(r.cost_usd, 1.5); // 1 + 0.5
  assert.equal(r.tokens_in, 15);
  assert.equal(r.tokens_out, 25);
  assert.equal(r.tokens_cache_read, 33);
  assert.equal(r.tokens_cache_write, 44);
});

test('report > the same numbers again change nothing', () => {
  const a = agent();
  usage.report(a, { cost: 1, tokensIn: 10, tokensOut: 20, tokensCacheRead: 30, tokensCacheWrite: 40 });
  usage.report(db.getAgent(a.id), { cost: 1, tokensIn: 10, tokensOut: 20, tokensCacheRead: 30, tokensCacheWrite: 40 });
  const r = row(a.id);
  assert.equal(r.cost_usd, 1);
  assert.equal(r.tokens_in, 10);
  assert.equal(r.tokens_out, 20);
  assert.equal(r.tokens_cache_read, 30);
  assert.equal(r.tokens_cache_write, 40);
});

test('report > a restart counts the new numbers in full', () => {
  const a = agent();
  usage.report(a, { cost: 2, tokensIn: 100, tokensOut: 200, tokensCacheRead: 300, tokensCacheWrite: 400 });
  // The harness started counting again: every number dropped.
  usage.report(db.getAgent(a.id), { cost: 0.5, tokensIn: 5, tokensOut: 6, tokensCacheRead: 7, tokensCacheWrite: 8 });
  const r = row(a.id);
  assert.equal(r.cost_usd, 2.5);
  assert.equal(r.tokens_in, 105);
  assert.equal(r.tokens_out, 206);
  assert.equal(r.tokens_cache_read, 307);
  assert.equal(r.tokens_cache_write, 408);
});

test('report > an unversioned baseline is seeded, recording nothing', () => {
  const a = agent();
  // A baseline from before the per-counter format (and before the cache columns).
  db.updateAgent(a.id, { usage_last: JSON.stringify({ cost: 1, tin: 10, tout: 20 }) });
  usage.report(db.getAgent(a.id), { cost: 1, tokensIn: 10, tokensOut: 20, tokensCacheRead: 5, tokensCacheWrite: 6 });
  assert.equal(row(a.id), undefined); // the schema change is not a restart
  usage.report(db.getAgent(a.id), { cost: 2, tokensIn: 11, tokensOut: 21, tokensCacheRead: 7, tokensCacheWrite: 8 });
  const r = row(a.id);
  assert.equal(r.cost_usd, 1);
  assert.equal(r.tokens_in, 1);
  assert.equal(r.tokens_out, 1);
  assert.equal(r.tokens_cache_read, 2);
  assert.equal(r.tokens_cache_write, 2);
});

test('report > a drop in one counter restarts only that counter', () => {
  const a = agent();
  usage.report(a, { cost: 2, tokensIn: 100, tokensOut: 200, tokensCacheRead: 300, tokensCacheWrite: 400 });
  // Claude's statusline cost restarts after a compaction relaunch; the transcript keeps growing.
  usage.report(db.getAgent(a.id), { cost: 0.5, tokensIn: 150, tokensOut: 210, tokensCacheRead: 310, tokensCacheWrite: 410 });
  const r = row(a.id);
  assert.equal(r.cost_usd, 2.5); // 2 + 0.5, the cost reset counts in full
  assert.equal(r.tokens_in, 150); // 100 + 50, not reset
  assert.equal(r.tokens_out, 210);
  assert.equal(r.tokens_cache_read, 310);
  assert.equal(r.tokens_cache_write, 410);
});

test('report > a counter that is not reported keeps its baseline', () => {
  const a = agent();
  usage.report(a, { cost: 1, tokensIn: 10, tokensOut: 20, tokensCacheRead: 30, tokensCacheWrite: 40 });
  // The transcript was briefly unavailable: only cost came through.
  usage.report(db.getAgent(a.id), { cost: 2 });
  usage.report(db.getAgent(a.id), { cost: 3, tokensIn: 12, tokensOut: 22, tokensCacheRead: 32, tokensCacheWrite: 42 });
  const r = row(a.id);
  assert.equal(r.cost_usd, 3);
  assert.equal(r.tokens_in, 12); // 10 + 2, not 10 + 12
  assert.equal(r.tokens_out, 22);
  assert.equal(r.tokens_cache_read, 32);
  assert.equal(r.tokens_cache_write, 42);
});

test('report > a new session id restarts the token counters, not cost', () => {
  const a = agent();
  usage.report(a, { cost: 2, tokensIn: 100, tokensOut: 200, tokensCacheRead: 300, tokensCacheWrite: 400, session: 's1' });
  // A new session whose totals are higher: the id, not a drop, is what restarts the tokens.
  usage.report(db.getAgent(a.id), { cost: 3, tokensIn: 150, tokensOut: 250, tokensCacheRead: 350, tokensCacheWrite: 450, session: 's2' });
  const r = row(a.id);
  assert.equal(r.cost_usd, 3); // 2 + 1, cost keeps its own line
  assert.equal(r.tokens_in, 250); // 100 + 150, the new session counts from zero
  assert.equal(r.tokens_out, 450);
  assert.equal(r.tokens_cache_read, 650);
  assert.equal(r.tokens_cache_write, 850);
});

test('summary > exposes both cache columns in every breakdown', () => {
  const a = agent();
  usage.report(a, { cost: 3, tokensIn: 1, tokensOut: 2, tokensCacheRead: 30, tokensCacheWrite: 40 });
  const s = usage.summary(14);
  for (const part of [s.today, s.by_day.at(-1), s.by_model[0], s.by_agent[0]]) {
    assert.equal(part.tokens_cache_read, 30);
    assert.equal(part.tokens_cache_write, 40);
  }
  assert.equal(s.by_agent[0].agent, a.name);
});

test('summary > days=1 is the calendar day: yesterday\'s rows are not in it', () => {
  const a = agent();
  usage.report(a, { cost: 3, tokensIn: 1, tokensOut: 2 });
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  db.open().prepare('INSERT INTO usage (agent_id, day, harness, model, cost_usd, tokens_in, tokens_out) SELECT agent_id, ?, harness, model, 5, 1, 1 FROM usage LIMIT 1').run(yesterday);
  assert.deepEqual(usage.summary(1).by_day.map((d) => d.cost_usd), [3]);
  assert.equal(usage.summary(2).by_day.length, 2);
});
test('summary > by_agent names the harness and model, with today and lifetime totals', () => {
  const a = agentOf('codex');
  usage.report(a, { tokensIn: 10, tokensOut: 20, tokensCacheRead: 30, tokensCacheWrite: 40 });
  const row = usage.summary(14).by_agent[0];
  assert.equal(row.agent, a.name);
  assert.equal(row.harness, 'codex');
  assert.equal(row.model, 'test/model');
  assert.equal(row.lifetime.tokens_in, 10);
  assert.equal(row.lifetime.cost_usd, null); // Codex reports no cost: missing, not 0
  assert.equal(row.today.tokens_cache_write, 40);
  assert.equal(row.today.cost_usd, null);
});

test('summary > by_model carries today and lifetime totals per harness and model', () => {
  const a = agentOf('codex');
  const yesterday = Date.now() - 86_400_000;
  usage.report(a, { tokensIn: 10, tokensOut: 20, tokensCacheRead: 30, tokensCacheWrite: 40 }, yesterday);
  usage.report(a, { tokensIn: 1, tokensOut: 2, tokensCacheRead: 3, tokensCacheWrite: 4 });
  const row = usage.summary(14).by_model.find((r) => r.harness === 'codex' && r.model === 'test/model');
  assert.equal(row.tokens_in, 11); // the period's total, as before
  assert.equal(row.today.tokens_in, 1);
  assert.equal(row.today.tokens_cache_write, 4);
  assert.equal(row.today.cost_usd, null); // Codex reports no cost: missing, not 0
  assert.equal(row.lifetime.tokens_in, 11);
  assert.equal(row.lifetime.tokens_out, 22);
  assert.equal(row.lifetime.cost_usd, null);
});

test('summary > by_model rows carry the per-kind API costs, on the row and on today and lifetime (S-1440)', async () => {
  const { kindCosts } = await import('../src/attribution.ts');
  const a = agentOf('claude', 'claude-opus-5-5');
  usage.report(a, { cost: 1, tokensIn: 1e6, tokensOut: 1e6, tokensCacheRead: 1e6, tokensCacheWrite: 1e6 });
  const priced = usage.summary(14).by_model.find((r) => r.model === 'claude-opus-5-5');
  const want = kindCosts('claude-opus-5-5', { tokens_in: 1e6, tokens_out: 1e6, tokens_cache_read: 1e6, tokens_cache_write: 1e6 });
  assert.ok(want.cost_in > 0 && want.cost_api_total > 0, 'the registry prices the model');
  for (const part of [priced, priced.today, priced.lifetime]) {
    for (const k of Object.keys(want)) assert.equal(part[k], want[k], k);
  }
  // A model with no price: every cost is null, never 0.
  usage.report(agentOf('opencode', 'fixture/no-price-model'), { tokensIn: 10, tokensOut: 5 });
  const bare = usage.summary(14).by_model.find((r) => r.model === 'fixture/no-price-model');
  for (const part of [bare, bare.today, bare.lifetime]) {
    for (const k of Object.keys(want)) assert.equal(part[k], null, k);
  }
});

test('agentUsage > splits today from lifetime and names the model', () => {
  const a = agentOf('claude');
  const yesterday = Date.now() - 86_400_000;
  usage.report(a, { cost: 1, tokensIn: 10, tokensOut: 20, tokensCacheRead: 30, tokensCacheWrite: 40 }, yesterday);
  usage.report(db.getAgent(a.id), { cost: 1.5, tokensIn: 15, tokensOut: 25, tokensCacheRead: 33, tokensCacheWrite: 44 });
  const u = usage.agentUsage(db.getAgent(a.id));
  assert.equal(u.harness, 'claude');
  assert.equal(u.model, 'test/model');
  assert.deepEqual(u.lifetime, { cost_usd: 1.5, tokens_in: 15, tokens_out: 25, tokens_cache_read: 33, tokens_cache_write: 44 });
  assert.deepEqual(u.today, { cost_usd: 0.5, tokens_in: 5, tokens_out: 5, tokens_cache_read: 3, tokens_cache_write: 4 });
});

test('agentUsage > a Codex agent reports tokens but its cost is missing, not 0', () => {
  const a = agentOf('codex');
  usage.report(a, { tokensIn: 10, tokensOut: 20, tokensCacheRead: 30, tokensCacheWrite: 40 });
  const u = usage.agentUsage(db.getAgent(a.id));
  assert.equal(u.lifetime.cost_usd, null);
  assert.equal(u.lifetime.tokens_in, 10);
  assert.equal(u.today.cost_usd, null);
  assert.equal(u.today.tokens_cache_write, 40);
});

test('agentUsage > an agent with no model turn yet reports nothing, not zeros', () => {
  const a = agentOf('claude');
  const none = { cost_usd: null, tokens_in: null, tokens_out: null, tokens_cache_read: null, tokens_cache_write: null };
  const u = usage.agentUsage(db.getAgent(a.id));
  assert.deepEqual(u.lifetime, none);
  assert.deepEqual(u.today, none);
  assert.equal(u.model, 'test/model');
});

test('agentUsage > names the model stam recorded when the agent has none of its own', () => {
  const a = agentOf('claude');
  usage.report(a, { cost: 1 });
  db.updateAgent(a.id, { model: null });
  assert.equal(usage.agentUsage(db.getAgent(a.id)).model, 'test/model');
});

test('claude > statusline tokens come from the transcript, each message counted once', () => {
  const file = join(home, `transcript-${++n}.jsonl`);
  const line = (id, u) => JSON.stringify({ type: 'assistant', message: { id, usage: u } }) + '\n';
  const usage1 = { input_tokens: 2, output_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 };
  writeFileSync(file, line('m1', usage1));
  const a = { id: 'a', transcript_path: file, harness: 'claude' };
  let f = adapters.claude.onStatusLine(a, { transcript_path: file, cost: { total_cost_usd: 1 } });
  assert.deepEqual([f.tokensIn, f.tokensOut, f.tokensCacheRead, f.tokensCacheWrite], [2, 10, 1000, 100]);
  // The same message id is written twice (streaming), then a second message is appended;
  // the parser reads only the new bytes and counts m1 once.
  appendFileSync(file, line('m1', usage1) + line('m2', { input_tokens: 3, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 2000 }));
  f = adapters.claude.onStatusLine(a, { transcript_path: file });
  assert.deepEqual([f.tokensIn, f.tokensOut, f.tokensCacheRead, f.tokensCacheWrite], [5, 15, 3000, 100]);
});

test('report > sessionCumulative ignores a lower same-session reading and never re-adds it', () => {
  const a = agent();
  const rep = (cost, tokensIn) => usage.report(db.getAgent(a.id), { cost, tokensIn, session: 's1', sessionCumulative: true });
  rep(2, 100);
  rep(1.5, 80); // an out-of-order read of an earlier state
  rep(2.25, 120); // the next real reading counts only its growth over 2
  const r = row(a.id);
  assert.equal(r.cost_usd, 2.25);
  assert.equal(r.tokens_in, 120);
});

test('report > sessionCumulative counts a new session id from zero, cost included', () => {
  const a = agent();
  usage.report(a, { cost: 2, session: 's1', sessionCumulative: true });
  usage.report(db.getAgent(a.id), { cost: 3, session: 's2', sessionCumulative: true });
  assert.equal(row(a.id).cost_usd, 5);
});
