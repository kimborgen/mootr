#!/usr/bin/env node
// S-4236: the usage_info MCP tool answers compactly by default. The fixture is a busy system
// built by the production writers (usage.report, usage.reportSubscription): 40 trees of 10 agents
// with a week of hourly reports on two windows. No daemon, no network, no models:
// `node --test test/usage-compact.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

process.env.TZ = 'UTC';
const home = tempHome('stam-usage-compact-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `usage-compact-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(
  join(home, 'settings.json'),
  JSON.stringify({ cost: { subscriptionWarnPercent: [], dailyWarnUsd: null, global: null, onError: 'soft-stop', accounts: { claude: { match: { harness: 'claude' } } } } }),
);
writeFileSync(join(home, 'registry.json'), JSON.stringify({ prices: { 'test-a': { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } } }));

let usage, compact, scope, mcp, server;
let served = {};
let lastPath = '';
let full;
const HOUR = 3_600_000;
const TREES = 40;
const PER_TREE = 10;

before(async () => {
  // The MCP tool reads GET /api/usage from this stub; src/config.ts reads STAM_URL once, so it goes up first.
  server = createServer((req, res) => {
    lastPath = req.url;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(served));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.STAM_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.STAM_TOKEN = 'test';
  const db = await import('../src/db.ts');
  scope = await import('../src/usage-scope.ts');
  mcp = await import('../src/mcp.ts');
  usage = await import('../src/usage.ts');
  compact = await import('../src/usage-compact.ts');
  const now = Date.now();
  const start = now - 7 * 24 * HOUR;
  const agents = [];
  for (let t = 0; t < TREES; t++) {
    for (let i = 0; i < PER_TREE; i++) {
      const id = `uc-${t}-${i}`;
      db.createAgent({ id, name: `tree${t}-agent${i}`, role: 'test', machine: 'x', harness: 'claude', model: 'test-a', effort: null, cwd: '/tmp', parent_id: i === 0 ? null : `uc-${t}-0`, session_id: null });
      agents.push(db.getAgent(id));
    }
  }
  // A nested subtree: uc-0-1 has a child under the root uc-0-0.
  db.createAgent({ id: 'nest-a', name: 'nest-a', role: 'test', machine: 'x', harness: 'claude', model: 'test-a', effort: null, cwd: '/tmp', parent_id: 'uc-0-1', session_id: null });
  agents.push(db.getAgent('nest-a'));
  const cum = new Map();
  for (let h = 0; h < 7 * 24; h++) {
    const at = start + h * HOUR;
    for (const [n, a] of agents.entries()) {
      if ((n + h) % 3 !== 0) continue;
      const c = (cum.get(a.id) ?? 0) + 1000 + n;
      cum.set(a.id, c);
      usage.report(a, { cost: c / 1e4, tokensIn: c, tokensOut: c, tokensCacheRead: c, tokensCacheWrite: c, session: 's' }, at + (n % 50) * 60_000);
    }
    const pct = (h % 100) + 1;
    usage.reportSubscription('claude', { five_hour: { used_percentage: pct, resets_at: Math.floor((at + 5 * HOUR) / 1000) }, seven_day: { used_percentage: Math.min(99, Math.floor(h / 2)), resets_at: Math.floor((start + 7 * 24 * HOUR) / 1000) } }, at + 59 * 60_000);
  }
  full = usage.summary(7);
});
after(() => {
  server.close();
  rmSync(home, { recursive: true, force: true });
});

const size = (v) => JSON.stringify(v, null, 2).length;

test('usage_info > the default answer stays small on a busy system', () => {
  const small = compact.compactUsage(full);
  const fullSize = size(full);
  const smallSize = size(small);
  console.error(`full ${fullSize} bytes, compact ${smallSize} bytes`);
  assert.ok(fullSize > 100_000, `the fixture is realistic: the route answer is ${fullSize} bytes`);
  assert.ok(smallSize < 20_000, `compact answer is ${smallSize} bytes`);
  assert.ok(smallSize * 10 < fullSize);
});

test('usage_info > the compact answer keeps the planning fields and bounds the lists', () => {
  const small = compact.compactUsage(full);
  for (const k of ['instructions', 'subscriptions', 'accounts', 'allocations', 'trees', 'today', 'by_agent', 'omitted']) assert.ok(k in small, `${k} is kept`);
  const win = small.accounts[0].shares.five_hour;
  assert.ok('projection' in win, 'the window keeps its projection');
  assert.equal('by_agent' in win, false);
  assert.equal('history' in win, false);
  assert.equal(small.trees.length, compact.TOP);
  assert.equal(small.by_agent.length, compact.TOP);
  assert.equal(small.omitted.trees, TREES - compact.TOP);
  // The route answer is untouched, for the web UI and `stam usage`.
  assert.ok(full.trees.length === TREES && full.trees[0].children.length > 0);
});

const callUsage = async (args) => JSON.parse((await mcp.callTool('usage_info', args)).content[0].text);

test('usage_info > the caller\'s own tree is kept whatever its rank, with its direct children', () => {
  // nest-a sits under uc-0-1 under uc-0-0.
  const nested = compact.compactUsage(full, 'uc-0-1');
  assert.equal(nested.own_tree.id, 'uc-0-1');
  assert.deepEqual(nested.own_tree.children.map((c) => c.id), ['nest-a']);
  assert.ok('shares' in nested.own_tree && 'cost_usd' in nested.own_tree && nested.own_tree.children[0].subagents === 0);
  // The last root of the ranking is far outside the top five.
  const last = full.trees.at(-1);
  const outside = compact.compactUsage(full, last.id);
  assert.equal(outside.trees.some((t) => t.id === last.id), false, 'not among the top roots');
  assert.equal(outside.own_tree.id, last.id);
  assert.equal(outside.own_tree.subagents, last.children.length);
  assert.equal(outside.own_tree.children.length, Math.min(last.children.length, compact.TOP));
  assert.equal(outside.own_tree.omitted_children, Math.max(0, last.children.length - compact.TOP) || undefined);
  assert.equal(compact.compactUsage(full, 'nobody').own_tree, undefined);
  assert.equal(compact.compactUsage(full).own_tree, undefined);
});

test('usage_info > other_trees of a scoped window survives the compaction', () => {
  const visible = scope.visibleAgents('uc-3-2');
  const scoped = scope.scopeSummary(full, visible);
  const win = scoped.accounts[0].shares.five_hour;
  assert.ok(win.other_trees.percent > 0, 'the scoped window sums the hidden trees');
  const small = compact.compactUsage(scoped, 'uc-3-2');
  assert.deepEqual(small.accounts[0].shares.five_hour.other_trees, win.other_trees);
  assert.equal(small.own_tree.id, 'uc-3-2');
  assert.ok(small.trees.some((t) => t.id === 'other'), 'the collapsed "other" tree stays');
});

test('usage_info > the MCP tool answers compactly, with detail the whole answer', async () => {
  served = { ...full, machines: [{ machine: 'm1' }] };
  const small = await callUsage({ days: 3 });
  assert.equal(lastPath, '/api/usage?days=3');
  assert.ok('omitted' in small && small.trees.length === compact.TOP);
  assert.equal(small.see_also, 'For time and bottlenecks, call activity_info.');
  assert.deepEqual(small.machines, [{ machine: 'm1' }]);
  const whole = await callUsage({ detail: true });
  assert.equal('omitted' in whole, false);
  assert.equal(whole.trees.length, TREES);
  assert.equal(whole.see_also, 'For time and bottlenecks, call activity_info.');
  assert.ok('history' in whole.accounts[0].shares.five_hour);
  for (const d of [false, 'true', 1, undefined]) assert.ok('omitted' in (await callUsage({ detail: d })), `detail ${JSON.stringify(d)} stays compact`);
});

test('usage_info > the MCP tool keeps the caller\'s tree and passes tree and as through', async () => {
  const last = full.trees.at(-1).id;
  served = full;
  const small = await callUsage({ tree: 'uc-5-0', self: last });
  assert.equal(lastPath, `/api/usage?days=7&tree=uc-5-0&as=${last}`);
  assert.equal(small.own_tree.id, last);
});

test('usage_info > the answer stays small for the root of a large tree', () => {
  const share = { claude: { five_hour: { estimate: true, percent: 1 }, seven_day: { estimate: true, percent: 1 } } };
  const node = (id, cost, kids = []) => ({ id, name: id, cost_usd: cost, tokens: 5, shares: share, children: kids });
  const kids = Array.from({ length: 400 }, (_, i) => node(`k${i}`, i, [node(`g${i}`, 1), node(`h${i}`, 2)]));
  const big = { ...full, trees: [node('boss', 1000, kids), ...full.trees] };
  const small = compact.compactUsage(big, 'boss');
  assert.ok(size(small) < 20_000, `compact answer is ${size(small)} bytes`);
  assert.deepEqual(small.own_tree.children.map((c) => c.id), ['k399', 'k398', 'k397', 'k396', 'k395'], 'the dearest children');
  assert.equal(small.own_tree.omitted_children, 395);
  assert.equal(small.own_tree.subagents, 400);
  assert.equal(small.own_tree.children[0].subagents, 2);
  assert.deepEqual(compact.compactUsage(null), {});
});
