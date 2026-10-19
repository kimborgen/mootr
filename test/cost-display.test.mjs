#!/usr/bin/env node
// Unit tests for the cost display (S-316, src/cost-display.ts and src/agent-costs.ts):
// conversions, the tree sum over a DAG, uncalibrated worth giving null, OpenRouter as paid $,
// and the setting's validation. Throwaway STAM_HOME, no daemon, no network:
// `node --test test/cost-display.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-cost-display-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `cost-display-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(
  join(home, 'settings.json'),
  JSON.stringify({
    cost: {
      subscriptionWarnPercent: [80, 95], dailyWarnUsd: null, global: null, onError: 'soft-stop',
      accounts: { claude: { match: { harness: 'claude' } }, openrouter: { match: { harness: 'opencode', model: 'openrouter/' } } },
      display: { mode: 'seven_day', prices: { claude: 200 } },
    },
  }),
);

let cd, ac, db, acct;
before(async () => {
  cd = await import('../src/cost-display.ts');
  ac = await import('../src/agent-costs.ts');
  db = await import('../src/db.ts');
  acct = await import('../src/accounts.ts');
});
after(() => rmSync(home, { recursive: true, force: true }));

// Weekly worth $1000 on claude, 5-hour worth $100; claude is a subscription, openrouter paid.
const ctx = (worth = { five_hour: 100, seven_day: 1000 }, price = { claude: 200 }) => ({
  kind: (a) => (a === 'openrouter' ? 'paid' : a === 'claude' ? 'subscription' : 'none'),
  worth: (a, w) => (a === 'claude' ? (worth?.[w] ?? null) : null),
  price: (a) => price[a] ?? null,
});

test('conversions > windows, subscription, and paid $ stay apart', () => {
  const m = cd.convert(new Map([['claude', 50], ['openrouter', 3], ['', 1]]), ctx());
  assert.equal(m.api, 54);
  assert.equal(m.five_hour, 50); // 100 x 50 / 100
  assert.equal(m.seven_day, 5); // 100 x 50 / 1000
  // 50 x 200 / (1000 x 30 / 7) = 2.3333...
  assert.ok(Math.abs(m.subscription - 2.3333333) < 1e-6);
  assert.equal(m.paid_usd, 3);
});

test('conversions > uncalibrated worth or no price gives null; paid stays', () => {
  const m = cd.convert(new Map([['claude', 10], ['openrouter', 2]]), ctx(null));
  assert.equal(m.five_hour, null);
  assert.equal(m.seven_day, null);
  assert.equal(m.subscription, null);
  assert.equal(m.paid_usd, 2);
  assert.equal(cd.convert(new Map([['claude', 10]]), ctx(undefined, {})).subscription, null);
  // The current-window share replaces the lifetime window conversion, and is null when unknown.
  assert.equal(cd.convert(new Map([['claude', 10]]), ctx(), { five_hour: 12.5, seven_day: null }).five_hour, 12.5);
  assert.equal(cd.convert(new Map([['claude', 10]]), ctx(), { five_hour: 12.5, seven_day: null }).seven_day, null);
  // An agent with no subscription spend has 0% even when the share is unknown.
  assert.equal(cd.convert(new Map([['openrouter', 1]]), ctx(), { five_hour: null, seven_day: null }).five_hour, 0);
});

const raw = (api, extra = {}) => ({ claude: { api, kind: 'subscription', worth_seven_day: 1000, five_hour: api, seven_day: api, ...extra } });
const treeOf = (ids, kids, own) => cd.treeSums(ids, kids, own, () => ({}), cd.addRaw);

test('tree sum > a shared grandchild counts once; each parent keeps its own subtree', () => {
  const own = new Map([['p', raw(1)], ['c1', raw(2)], ['c2', raw(4)], ['g', raw(8)], ['solo', raw(16)]]);
  const kids = new Map([['p', ['c1', 'c2']], ['c1', ['g']], ['c2', ['g']]]);
  const t = treeOf(['p', 'c1', 'c2', 'g', 'solo'], kids, own);
  const api = (id) => t.get(id).claude.api;
  assert.deepEqual(['p', 'c1', 'c2', 'g', 'solo'].map(api), [15, 10, 12, 8, 16]);
  own.get('g').claude.five_hour = null;
  assert.equal(treeOf(['p', 'c1', 'c2', 'g'], kids, own).get('p').claude.five_hour, null);
});

test('tree sum > 300-node chain with a shared leaf gives exact totals', () => {
  // n0 > n1 > ... > n299, and every node of the first half also parents the leaf.
  const ids = Array.from({ length: 300 }, (_, i) => `n${i}`).concat('leaf');
  const kids = new Map();
  for (let i = 0; i < 299; i++) kids.set(`n${i}`, [`n${i + 1}`]);
  for (let i = 0; i < 150; i++) kids.set(`n${i}`, [...kids.get(`n${i}`), 'leaf']);
  const own = new Map(ids.map((id) => [id, raw(1)]));
  const t = treeOf(ids, kids, own);
  assert.equal(t.get('n0').claude.api, 301, 'every node and the leaf once');
  assert.equal(t.get('n150').claude.api, 150, 'n150..n299, no leaf below');
  assert.equal(t.get('n149').claude.api, 152, 'n149..n299 plus the leaf');
});

test('raw to modes > prices come from the daemon converting', () => {
  const r = { claude: { api: 50, kind: 'subscription', worth_seven_day: 1000, five_hour: 7, seven_day: 3 }, openrouter: { api: 2, kind: 'paid', worth_seven_day: null, five_hour: 0, seven_day: 0 } };
  const a = cd.rawToModes(r, { claude: 200 });
  const b = cd.rawToModes(r, { claude: 100 });
  assert.equal(a.five_hour, 7);
  assert.equal(a.paid_usd, 2);
  assert.ok(Math.abs(a.subscription - 2 * b.subscription) < 1e-9, 'the subscription $ follows this daemon\'s price');
  assert.equal(cd.rawToModes(r, {}).subscription, null);
  // A peer's agent: its raw spend is converted with this daemon's prices and mode.
  const peer = ac.withOwnCost({ id: 'x', cost_raw: { own: r, tree: r } });
  assert.equal(peer.cost_raw, undefined);
  assert.equal(peer.cost.mode, 'seven_day');
  assert.ok(Math.abs(peer.cost.own.subscription - 50 * 200 / (1000 * 30 / 7)) < 1e-2);
  assert.equal(ac.withOwnCost({ id: 'old' }).cost, undefined);
});

test('agentCosts > seeded db: parent, two children, shared grandchild, OpenRouter as paid; per-account calibration', () => {
  ac.resetAgentCostsMemo();
  const mk = (id, parents) => {
    db.createAgent({ id, name: id, role: 'test', machine: 'x', harness: 'claude', model: 'test-a', effort: null, cwd: '/tmp', parent_id: parents[0] ?? null, session_id: null });
    for (const p of parents.slice(1)) db.addParent(id, p);
  };
  mk('dp', []); mk('dc1', ['dp']); mk('dc2', ['dp']); mk('dg', ['dc1', 'dc2']);
  const row = (id, account, cost) =>
    db.open().prepare('INSERT INTO usage (agent_id, day, harness, model, account, cost_usd) VALUES (?, ?, ?, ?, ?, ?)').run(id, '2026-10-13', 'claude', 'm', account, cost);
  row('dp', 'claude', 1); row('dc1', 'claude', 2); row('dc2', 'openrouter', 4); row('dg', 'claude', 8);
  const costs = ac.agentCosts(db.listAgents());
  const p = costs.get('dp');
  assert.equal(p.mode, 'seven_day');
  assert.equal(p.own.api, 1);
  assert.equal(p.tree.api, 15);
  assert.equal(p.tree.paid_usd, 4);
  assert.equal(costs.get('dc1').tree.api, 10);
  assert.equal(costs.get('dc2').tree.paid_usd, 4);
  // No readings: claude isn't calibrated. dp has no sample in the current window, so 0% (not null);
  // the paid-only agent shows 0%. The subscription $ needs the worth, so it is null.
  assert.equal(p.own.seven_day, 0);
  assert.equal(costs.get('dc2').own.seven_day, 0);
  assert.equal(p.tree.subscription, null);
  // dg has a sample in the current window on the uncalibrated account: unknown, not 0, and its trees too.
  db.open().prepare('INSERT INTO usage_samples (agent_id, account, harness, model, bucket, cost_usd) VALUES (?, ?, ?, ?, ?, ?)').run('dg', 'claude', 'claude', 'm', new Date().toISOString(), 1);
  ac.resetAgentCostsMemo();
  const after = ac.agentCosts(db.listAgents());
  assert.equal(after.get('dg').own.seven_day, null);
  assert.equal(after.get('dp').tree.seven_day, null);
  assert.equal(after.get('dp').own.seven_day, 0, 'an agent with no use in the window stays 0');
  assert.equal(after.get('dc2').tree.seven_day, null, 'dc2 has the shared grandchild below it');
});

test('agentCosts > a reparent shows at once, without resetting the memo', () => {
  const sum = () => ac.agentCosts(db.listAgents()).get('dc1').tree.api;
  const before = sum();
  db.open().prepare('INSERT INTO usage (agent_id, day, harness, model, account, cost_usd) VALUES (?, ?, ?, ?, ?, ?)').run('dc2', '2026-10-12', 'claude', 'm', 'openrouter', 100);
  assert.equal(sum(), before, 'within 30 s the spend comes from the memo');
  db.addParent('dc2', 'dc1');
  assert.equal(sum(), before + 104, 'dc2 (4 + 100) is now below dc1');
});

test('peer cost > a peer without cost_raw keeps its numbers, with this daemon\'s mode and no subscription $', () => {
  const legacy = { id: 'old', cost: { mode: 'api', own: { api: 1, five_hour: 2, seven_day: 3, subscription: 4, paid_usd: 5 }, tree: { api: 6, five_hour: 7, seven_day: 8, subscription: 9, paid_usd: 10 } } };
  const c = ac.withOwnCost(legacy).cost;
  assert.equal(c.mode, 'seven_day');
  assert.equal(c.own.subscription, null);
  assert.equal(c.tree.subscription, null);
  assert.equal(c.own.seven_day, 3);
  assert.equal(c.tree.api, 6);
});

test('setting > mode and prices are validated', () => {
  const base = { accounts: {}, onError: 'soft-stop' };
  assert.equal(acct.validate({ ...base, display: { mode: 'five_hour', prices: { claude: 100 } } }), null);
  assert.equal(acct.validate({ ...base }), null);
  assert.match(acct.validate({ ...base, display: { mode: 'euros' } }), /cost\.display\.mode/);
  assert.match(acct.validate({ ...base, display: { mode: 'api', prices: { claude: -1 } } }), /prices\.claude/);
  assert.match(acct.validate({ ...base, display: { mode: 'api', prices: [] } }), /prices/);
  assert.deepEqual(cd.costDisplay(), { mode: 'seven_day', prices: { claude: 200 } });
});
