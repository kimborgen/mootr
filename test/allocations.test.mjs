#!/usr/bin/env node
// Unit tests for build step 10 of docs/cost-policy.md: per-tree allocations, who may set
// them, the overlap warning, and the 80% and 100% notices with dedup. Runs against a
// throwaway STAM_HOME with no daemon, no network, and no models:
// `node --test test/allocations.test.mjs`.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-allocations-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `allocations-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

function writeSettings(over = {}) {
  const base = {
    chiefOfStaff: 'cos',
    humanMail: { when: 'necessary' },
    cost: {
      subscriptionWarnPercent: [80, 95],
      instructions: 'Never spend extra credits.',
      accounts: {
        claude: { match: { harness: 'claude' } },
        openrouter: { match: { harness: 'opencode', model: 'openrouter/' }, subscription: false },
      },
    },
  };
  writeFileSync(
    join(home, 'settings.json'),
    JSON.stringify({ ...base, ...over, cost: { ...base.cost, ...(over.cost ?? {}) }, humanMail: { ...base.humanMail, ...(over.humanMail ?? {}) } }),
  );
}
writeSettings();

let db, alloc, costNotices, usage;
before(async () => {
  db = await import('../src/db.ts');
  alloc = await import('../src/allocations.ts');
  costNotices = await import('../src/cost-notices.ts');
  usage = await import('../src/usage.ts');
});
after(() => rmSync(home, { recursive: true, force: true }));

let n = 0;
function agent(name, fields = {}) {
  const id = `al-${++n}-${name}`;
  db.createAgent({ id, name, role: 'test', machine: 'x', harness: 'claude', model: 'test-a', effort: null, cwd: '/tmp', parent_id: null, session_id: null, ...fields });
  return db.getAgent(id);
}

const T0 = Date.parse('2026-10-11T10:00:00.000Z');
const MIN = 60_000;
// A window that reset 5 minutes before T0: its current period starts at T0 - 5 min.
const RESET = (T0 + 5 * 3_600_000 - 5 * MIN) / 1000;
const iso = (t) => new Date(t).toISOString();
const sorted = (ids) => [...ids].sort();

function reading(minute, used, resets = RESET, name = 'claude', window = 'five_hour') {
  db.open().prepare('INSERT INTO window_readings (name, window, at, used_percentage, resets_at) VALUES (?, ?, ?, ?, ?)').run(name, window, iso(T0 + minute * MIN + 30_000), used, resets);
}
// test-a is unregistered, so its weight is one per input token.
function sample(agentId, minute, tokens) {
  db.open().prepare('INSERT INTO usage_samples (agent_id, account, harness, model, bucket, tokens_in) VALUES (?, ?, ?, ?, ?, ?)').run(agentId, 'claude', 'claude', 'test-a', iso(T0 + minute * MIN), tokens);
}
function spend(agentId, usd, account = 'openrouter', harness = 'opencode', model = 'openrouter/x') {
  const day = new Date().toISOString().slice(0, 10);
  db.open()
    .prepare(`INSERT INTO usage (agent_id, day, harness, model, account, cost_usd) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (agent_id, day, account) DO UPDATE SET cost_usd = excluded.cost_usd`)
    .run(agentId, day, harness, model, account, usd);
}
const bodies = (box) => db.inbox(box, false, 50).map((m) => db.getMail(m.id)?.body ?? '');
// Mail is written asynchronously (sendMail awaits recipient resolution), so poll until the body lands.
const bodiesMatching = async (box, re) => {
  for (let i = 0; i < 100 && !re.test(bodies(box).join('\n')); i++) await new Promise((r) => setTimeout(r, 10));
  return bodies(box).join('\n');
};

beforeEach(() => {
  costNotices.notices(0); // creates cost_notices before it is cleared
  alloc.list(); // creates allocations before it is cleared
  const d = db.open();
  for (const t of ['allocations', 'cost_notices', 'blockers', 'agent_parents', 'agents', 'window_readings', 'usage_samples', 'usage', 'subscriptions', 'mail_recipients', 'mail', 'events']) d.exec(`DELETE FROM ${t}`);
});

test('permissions > the human and chief of staff set any tree, an agent only its own', () => {
  const cos = agent('cos');
  const cost = agent('cost', { parent_id: cos.id });
  const dev = agent('dev', { parent_id: cost.id });
  const other = agent('other');
  const win = { account: 'claude', kind: 'window', window: 'five_hour', percent: 10 };

  // The human (and the CLI, which speaks as the human) may set any tree.
  assert.ok(alloc.set({ tree: dev.id, ...win }, 'human').allocation);
  // The chief of staff may set any tree.
  assert.ok(alloc.set({ tree: other.id, ...win }, cos.id).allocation);
  // An agent may set its own tree (itself and its descendants)...
  assert.ok(alloc.set({ tree: dev.id, ...win }, cost.id).allocation, 'a manager sets a child tree');
  assert.ok(alloc.set({ tree: dev.id, ...win }, dev.id).allocation, 'an agent sets its own tree');
  // ...but not a tree outside it (an ancestor, or an unrelated tree).
  assert.throws(() => alloc.set({ tree: cost.id, ...win }, dev.id), /own tree/);
  assert.throws(() => alloc.set({ tree: other.id, ...win }, dev.id), /own tree/);
});

test('overlap > children past their parent tree\'s allocation warn, never refuse', () => {
  const cos = agent('cos');
  const root = agent('root', { parent_id: cos.id });
  const c1 = agent('c1', { parent_id: root.id });
  const c2 = agent('c2', { parent_id: root.id });
  const win = { account: 'claude', kind: 'window', window: 'five_hour' };

  assert.equal(alloc.set({ tree: root.id, ...win, percent: 50 }, cos.id).warning, null, 'no children yet');
  assert.equal(alloc.set({ tree: c1.id, ...win, percent: 30 }, cos.id).warning, null, '30 under 50');
  const over = alloc.set({ tree: c2.id, ...win, percent: 30 }, cos.id);
  assert.match(over.warning, /children add up to 60%/, 'the sum is past the parent allocation');
  assert.match(over.warning, /not refused/);
  // The allocation is still stored: a warning, not a refusal.
  assert.equal(alloc.list(root.id).length, 1);
  // A usd overlap is checked per period, the same way.
  const root2 = agent('root2', { parent_id: cos.id });
  const d1 = agent('d1', { parent_id: root2.id });
  const d2 = agent('d2', { parent_id: root2.id });
  const usd = { account: 'openrouter', kind: 'usd', period: 'day' };
  alloc.set({ tree: root2.id, ...usd, amount: 5 }, cos.id);
  alloc.set({ tree: d1.id, ...usd, amount: 3 }, cos.id);
  assert.match(alloc.set({ tree: d2.id, ...usd, amount: 3 }, cos.id).warning, /children add up to \$6/);
});

test('window > a notice at 80% and 100%, to the manager and the root, deduplicated per reset', async () => {
  const cos = agent('cos');
  const root = agent('root', { parent_id: cos.id });
  const dev = agent('dev', { parent_id: root.id });
  reading(0, 10);
  sample(dev.id, 5, 1000);
  reading(5, 14); // Δ 4, all dev's → the tree's share is 4%
  const a = alloc.set({ tree: root.id, account: 'claude', kind: 'window', window: 'five_hour', percent: 5 }, cos.id).allocation;

  const now1 = T0 + 6 * MIN;
  alloc.checkWindow('claude', 'five_hour', now1);
  let ns = costNotices.notices();
  assert.equal(ns.length, 1, '80% of 5 is 4');
  assert.equal(ns[0].kind, 'allocation');
  assert.equal(ns[0].window, 'five_hour');
  assert.deepEqual(sorted(ns[0].managers), sorted([cos.id, root.id]), "the tree's manager and the tree's root");
  const text = await bodiesMatching(cos.id, /80%/);
  assert.match(text, /80%/, 'the notice carries the percentage');
  assert.match(text, /Never spend extra credits\./, "the user's instructions are carried");
  assert.match(text, /reaches its allocation|at or past/i, 'a projection is included');

  alloc.checkWindow('claude', 'five_hour', now1 + 1000);
  assert.equal(costNotices.notices().length, 1, 'the same allocation, threshold and reset is not re-notified');

  // The tree grows to 8%: 160% of the 5% allocation, so the 100% notice fires.
  sample(dev.id, 10, 1000);
  reading(10, 18);
  alloc.checkWindow('claude', 'five_hour', T0 + 11 * MIN);
  ns = costNotices.notices();
  assert.equal(ns.length, 2, 'a higher threshold is its own notice');
  assert.match(await bodiesMatching(cos.id, /160%/), /160%/, 'the 100%-threshold notice');
  alloc.checkWindow('claude', 'five_hour', T0 + 11 * MIN + 1000);
  assert.equal(costNotices.notices().length, 2, 'deduplicated again');

  // A new window period re-arms both thresholds.
  db.open().exec('DELETE FROM window_readings');
  db.open().exec('DELETE FROM usage_samples');
  const RESET2 = RESET + 60; // the current period now starts a minute later
  reading(0, 10, RESET2);
  sample(dev.id, 5, 1000);
  reading(5, 14, RESET2);
  alloc.checkWindow('claude', 'five_hour', T0 + 6 * MIN);
  assert.equal(costNotices.notices().length, 3, 'a new reset re-arms the warning');
  assert.ok(a.id, 'the allocation keeps its id across the reset');
});

test('clear > removes an allocation and stops its notices', () => {
  const cos = agent('cos');
  const root = agent('root', { parent_id: cos.id });
  const dev = agent('dev', { parent_id: root.id });
  reading(0, 10);
  sample(dev.id, 5, 1000);
  reading(5, 14);
  alloc.set({ tree: root.id, account: 'claude', kind: 'window', window: 'five_hour', percent: 5 }, cos.id);
  assert.equal(alloc.list(root.id).length, 1);
  assert.equal(alloc.clear({ tree: root.id, account: 'claude', kind: 'window', window: 'five_hour' }, cos.id), 1);
  assert.equal(alloc.list(root.id).length, 0);
  alloc.checkWindow('claude', 'five_hour', T0 + 6 * MIN);
  assert.equal(costNotices.notices().length, 0, 'a cleared allocation raises no notice');
});

test('usd > a paid-spend allocation at 80% and 100% of its period', async () => {
  const cos = agent('cos');
  const root = agent('root', { parent_id: cos.id });
  const dev = agent('dev', { parent_id: root.id, harness: 'opencode', model: 'openrouter/deepseek/deepseek-v4.1-flash' });
  spend(dev.id, 3);
  const now = Date.now();
  const a = alloc.set({ tree: root.id, account: 'openrouter', kind: 'usd', amount: 3.5, period: 'day', note: 'experiment' }, cos.id).allocation;
  assert.equal(a.kind, 'usd');
  assert.equal(a.amount, 3.5);

  alloc.checkUsd('openrouter', now);
  let ns = costNotices.notices();
  assert.equal(ns.length, 1, '3 of 3.5 is about 86%');
  assert.equal(ns[0].kind, 'allocation');
  assert.deepEqual(sorted(ns[0].managers), sorted([cos.id, root.id]));
  alloc.checkUsd('openrouter', now);
  assert.equal(costNotices.notices().length, 1, 'deduplicated within the day');

  spend(dev.id, 4); // over the allocation
  alloc.checkUsd('openrouter', now);
  ns = costNotices.notices();
  assert.equal(ns.length, 2);
  assert.match(await bodiesMatching(cos.id, /11\d%/), /11\d%/, 'the over-allocation notice');
});

test('visibility > usage_info and summary show allocations with their current use', () => {
  const cos = agent('cos');
  const root = agent('root', { parent_id: cos.id });
  const dev = agent('dev', { parent_id: root.id });
  reading(0, 10);
  sample(dev.id, 5, 1000);
  reading(5, 14);
  alloc.set({ tree: root.id, account: 'claude', kind: 'window', window: 'five_hour', percent: 10 }, cos.id);
  const s = usage.summary(7, root.id);
  assert.equal(s.allocations.length, 1);
  assert.equal(s.allocations[0].used, 4);
  assert.equal(s.allocations[0].used_percent, 40);
  assert.equal(s.allocations[0].root, 'root');
  assert.equal(s.tree.allocations.length, 1, "the tree view carries the tree's allocations");
  const v = alloc.view(root.id);
  assert.equal(v[0].used, 4);
  assert.equal(v[0].projection.estimate, true);
});
