#!/usr/bin/env node
// Unit tests for the activity summary (S-1009, src/activity-summary.ts): the clock's groups, the tiles,
// categories, bottlenecks, configs and trees from a small seeded story with exact numbers; the scopes;
// the digests' rebuild on a touch and on an ITSA change; and on the realistic-scale fixture
// (test/activity-fixture.mjs, 700 agents over 7 days) the longest synchronous slice and agreement
// with by=agent. A throwaway STAM_HOME, no daemon: `node --test test/activity-summary.test.mjs`.
//
// Seeded story, T0 = 10:00Z, now = T0 + 10 h, days = 1. M (manager, claude opus) is a root with child
// W (developer, claude haiku), whose child is V (developer, opencode); O (claude) is another root.
//   W: model.generate 600 s ($1, produce.edit), tool.test 300 s with a tool.short 60 s inside it (the
//      overlap splits, so 270 s and 30 s, verify.unit), tool.sleep 120 s, then gaps human.reply 900 s,
//      throttle.cost 600 s, agent.child 300 s.
//   V: model.generate 200 s ($0.50, understand.search), model.stall 50 s, gaps idle.none 400 s,
//      human.permission 100 s.
//   M: model.generate 100 s ($0.20, delegate.brief), gap agent.child 1000 s.
//   O: tool.contention 60 s, gaps human.prompt 240 s and one with no wait kind 30 s (idle).
//   X (claude, M's child) has usage but no items yet.
// Usage (the cost of record, unlike the items' est cost): W $2, V $0.50 (OpenRouter, paid), M $0.30,
// O $0.40, X $0.80; $4 in all.
// Groups: working 1200, friction 830 (W 120 + 600, V 50, O 60), others 1300, you 1240, idle 430;
// total 5000. I1 (S-1, W's issue, done at T0 + 9 h) has child I2 (S-2, V's, in progress).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';
import { settled } from './activity-settled.mjs';

const home = tempHome('stam-activity-summary-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `activity-summary-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(
  join(home, 'settings.json'),
  JSON.stringify({ cost: { accounts: { claude: { match: { harness: 'claude' } }, openrouter: { match: { harness: 'opencode' }, paid: true } } } }),
);

let db, summary, stats, changes;
before(async () => {
  db = await import('../src/db.ts');
  summary = await import('../src/activity-summary.ts');
  stats = await import('../src/activity-stats.ts');
  changes = await import('../src/activity-changes.ts');
});

const T0 = Date.parse('2026-10-11T10:00:00.000Z');
const NOW = T0 + 10 * 3_600_000;
const at = (s) => new Date(T0 + s * 1000).toISOString();

function seed() {
  const d = db.open();
  for (const t of ['activity_items', 'activity_cursors', 'usage', 'usage_samples', 'itsa_events', 'itsa_participants', 'itsa_links', 'itsas', 'agent_parents', 'agents']) d.exec(`DELETE FROM ${t}`);
  const agent = (id, parent, type, harness, model) =>
    d
      .prepare('INSERT INTO agents (id, name, role, machine, harness, model, effort, cwd, parent_id, session_id, created_at, updated_at, type) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?)')
      .run(id, id, 'test', 'x', harness, model, '/tmp', parent, at(-3600), at(-3600), type);
  agent('M', null, 'manager', 'claude', 'claude-opus-5-5');
  agent('W', 'M', 'developer', 'claude', 'claude-haiku-5-5');
  agent('V', 'W', 'developer', 'opencode', 'deepseek-v4');
  agent('O', null, 'developer', 'claude', 'claude-opus-5-5');
  agent('X', 'M', 'developer', 'claude', 'claude-opus-5-5');
  const usage = (a, account, cost) =>
    d.prepare('INSERT INTO usage (agent_id, day, harness, model, account, cost_usd) VALUES (?, ?, ?, ?, ?, ?)').run(a, at(0).slice(0, 10), account === 'openrouter' ? 'opencode' : 'claude', 'm', account, cost);
  usage('W', 'claude', 2);
  usage('V', 'openrouter', 0.5);
  usage('M', 'claude', 0.3);
  usage('O', 'claude', 0.4);
  usage('X', 'claude', 0.8);
  const seqs = new Map();
  const item = (a, kind, wait, from, secs, est = 0, cat = null) => {
    const seq = (seqs.get(a) ?? 0) + 1;
    seqs.set(a, seq);
    d.prepare('INSERT INTO activity_items (agent_id, seq, turn, kind, name, start, "end", summary, wait_kind, raw_cost_usd, est_cost_usd, tokens_in, tokens_out, category) VALUES (?, ?, 1, ?, NULL, ?, ?, NULL, ?, ?, ?, 0, 0, ?)').run(
      a, seq, kind, at(from), at(from + secs), wait, est, est, cat,
    );
  };
  item('W', 'model', 'model.generate', 0, 600, 1, 'produce.edit');
  item('W', 'tool', 'tool.test', 600, 300, 0, 'verify.unit');
  item('W', 'tool', 'tool.short', 700, 60, 0, 'verify.unit');
  item('W', 'tool', 'tool.sleep', 900, 120, 0, 'wait.sleep');
  item('W', 'gap', 'human.reply', 1020, 900);
  item('W', 'gap', 'throttle.cost', 1920, 600);
  item('W', 'gap', 'agent.child', 2520, 300);
  item('W', 'text', null, 2820, 10);
  item('V', 'model', 'model.generate', 0, 200, 0.5, 'understand.search');
  item('V', 'model', 'model.stall', 200, 50, 0, 'understand.search');
  item('V', 'gap', 'idle.none', 250, 400);
  item('V', 'gap', 'human.permission', 650, 100);
  item('M', 'model', 'model.generate', 0, 100, 0.2, 'delegate.brief');
  item('M', 'gap', 'agent.child', 100, 1000);
  item('O', 'tool', 'tool.contention', 0, 60, 0, 'wait.capacity');
  item('O', 'gap', 'human.prompt', 60, 240);
  item('O', 'gap', null, 300, 30);
  const itsa = (id, key, parent, status, owner, closed = null) =>
    d.prepare('INSERT INTO itsas (id, key, parent_id, kind, title, status, owner, created_by, created_at, updated_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, key, parent, 'issue', key, status, owner, 'M', at(-3600), at(-3600), closed,
    );
  const event = (id, ts, type, data) => d.prepare('INSERT INTO itsa_events (itsa_id, ts, actor, type, data) VALUES (?, ?, ?, ?, ?)').run(id, ts, 'M', type, JSON.stringify(data));
  itsa('I1', 'S-1', null, 'done', 'W', at(9 * 3600));
  event('I1', at(-3600), 'created', { key: 'S-1', status: 'in_progress' });
  event('I1', at(9 * 3600), 'status', { from: 'in_progress', to: 'done' });
  itsa('I2', 'S-2', 'I1', 'in_progress', 'V');
  event('I2', at(-3600), 'created', { key: 'S-2', status: 'in_progress' });
  summary.resetSummary();
}

const get = (scope, extra = {}) => settled({ days: 1, scope, now: NOW, ...extra });
const groupsSum = (c) => c.working_s + c.friction_s + c.others_s + c.you_s + c.idle_s;
// S-2 (V's, a child of S-1) closes at T0 + 8 h.
function closeS2(d) {
  d.prepare("UPDATE itsas SET status = 'done', closed_at = ?, updated_at = ? WHERE id = 'I2'").run(at(8 * 3600), at(8 * 3600));
  d.prepare('INSERT INTO itsa_events (itsa_id, ts, actor, type, data) VALUES (?, ?, ?, ?, ?)').run('I2', at(8 * 3600), 'V', 'status', JSON.stringify({ from: 'in_progress', to: 'done' }));
}

test('clock groups sum to the total, and friction is the same in tiles, clock and bottlenecks', async () => {
  seed();
  const s = await get();
  assert.deepEqual(
    { total: s.clock.total_s, working: s.clock.working_s, friction: s.clock.friction_s, others: s.clock.others_s, you: s.clock.you_s, idle: s.clock.idle_s },
    { total: 5000, working: 1200, friction: 830, others: 1300, you: 1240, idle: 430 },
  );
  assert.equal(groupsSum(s.clock), s.clock.total_s);
  assert.deepEqual(s.clock.groups.map((g) => g.key), ['working', 'friction', 'others', 'you', 'idle']);
  assert.deepEqual(s.clock.groups.find((g) => g.key === 'working').leaves, { 'model.generate': 900, 'tool.test': 270, 'tool.short': 30 });
  assert.deepEqual(s.clock.groups.find((g) => g.key === 'idle').leaves, { 'idle.none': 400, unknown: 30 });

  const friction = { 'tool.sleep': 120, 'throttle.cost': 600, 'model.stall': 50, 'tool.contention': 60 };
  assert.deepEqual(s.tiles.friction, { seconds: 830, parts: friction });
  assert.deepEqual(s.clock.groups.find((g) => g.key === 'friction').leaves, friction);
  const bf = s.bottlenecks.filter((b) => b.group === 'friction');
  assert.deepEqual(Object.fromEntries(bf.map((b) => [b.key, b.seconds])), friction);

  assert.deepEqual(s.tiles.you, { seconds: 1240, reply_s: 900, prompt_s: 240, permission_s: 100 });
  assert.equal(s.tiles.working_s, 1200);
  assert.equal(s.agents, 5, 'X counts for its cost');
  assert.deepEqual(s.tiles.working_by_day, [
    { day: '2026-10-10', working_s: 0 },
    { day: '2026-10-11', working_s: 1200 },
  ]);
});

test('bottlenecks name the agents hit, the top agents and the longest span', async () => {
  seed();
  const s = await get();
  assert.deepEqual(s.bottlenecks.map((b) => b.key), ['human.reply', 'throttle.cost', 'idle.none', 'tool.test', 'human.prompt', 'tool.sleep', 'human.permission', 'tool.contention', 'model.stall', 'unknown']);
  const t = s.bottlenecks.find((b) => b.key === 'throttle.cost');
  assert.deepEqual(t, { key: 'throttle.cost', label: 'Cost pause or rate limit', group: 'friction', seconds: 600, agents: 1, top: [{ id: 'W', name: 'W', seconds: 600 }], longest: { seconds: 600, agent: 'W', name: 'W', start: at(1920) } });
  assert.equal(s.bottlenecks.find((b) => b.key === 'tool.test').group, 'working');
  assert.ok(!s.bottlenecks.some((b) => b.key === 'agent.child'), 'waiting on a child is expected, not a bottleneck');
});

test('costs are the usage table\'s; categories cover working time, their cost scaled to it; modes are null where unknown', async () => {
  seed();
  const s = await get();
  // Items estimate $1.70 by category (produce $1, understand $0.50, delegate $0.20); scaled to $4.
  assert.deepEqual(
    s.working_by_category.map((c) => [c.key, c.seconds, c.cost_usd, c.estimated]),
    [
      ['produce', 600, 2.352941, true],
      ['verify', 300, 0, true],
      ['understand', 200, 1.176471, true],
      ['delegate', 100, 0.470588, true],
    ],
  );
  assert.equal(s.working_by_category.reduce((n, c) => n + c.seconds, 0), s.tiles.working_s);
  assert.ok(Math.abs(s.working_by_category.reduce((n, c) => n + c.cost_usd, 0) - 4) < 1e-5);
  assert.deepEqual(s.working_by_category[1].leaves, { 'verify.unit': 300 });
  // Claude is an uncalibrated subscription: its window and subscription modes are unknown, not zero.
  assert.equal(s.tiles.cost.cost_usd, 4);
  assert.equal(s.tiles.cost.modes.api, 4);
  assert.equal(s.tiles.cost.modes.paid_usd, 0.5);
  assert.equal(s.tiles.cost.modes.five_hour, null);
  assert.equal(s.tiles.cost.modes.seven_day, null);
  assert.equal(s.tiles.cost.modes.subscription, null);
  assert.equal(s.working_by_category[0].modes.five_hour, null);
  assert.equal(s.tiles.cost_per_working_hour.cost_usd, 12);
  assert.equal(s.tiles.cost_per_working_hour.modes.five_hour, null);
  // OpenRouter alone (V) is paid: every mode is known.
  const v = await get('agent:V');
  assert.deepEqual(v.tiles.cost.modes, { api: 0.5, five_hour: 0, seven_day: 0, subscription: 0, paid_usd: 0.5 });
  // An ITSA takes its agents' usage by the share attributed to it; X (no items) counts for its tree.
  assert.equal((await get('itsa:S-1')).tiles.cost.cost_usd, 2.5);
  assert.equal((await get('itsa:S-2')).tiles.cost.cost_usd, 0.5);
  assert.equal((await get('tree:M')).tiles.cost.cost_usd, 3.6);
});

test('scopes: a tree, an agent, an ITSA with its children, and a viewer', async () => {
  seed();
  assert.equal((await get('tree:M')).clock.total_s, 4670);
  assert.equal((await get('tree:W')).clock.total_s, 3570);
  const v = await get('agent:V');
  assert.equal(v.clock.total_s, 750);
  assert.deepEqual(v.scope, { kind: 'agent', id: 'V', name: 'V' });
  assert.equal((await get('itsa:S-1')).clock.total_s, 3570, 'S-1 counts its child S-2');
  const i2 = await get('itsa:S-2');
  assert.equal(i2.clock.total_s, 750);
  assert.deepEqual(i2.scope, { kind: 'itsa', id: 'I2', key: 'S-2' });
  for (const sc of ['tree:M', 'tree:W', 'agent:V', 'itsa:S-1']) {
    const s = await get(sc);
    assert.equal(groupsSum(s.clock), s.clock.total_s, sc);
  }
  // An agent's token sees its own and its ancestors' trees only.
  const scoped = await get(null, { visible: new Set(['M', 'W', 'V']), viewer: 'W' });
  assert.equal(scoped.clock.total_s, 4670);
  assert.deepEqual(scoped.trees.map((t) => t.id), ['M']);
  await assert.rejects(get('agent:nobody'), (e) => e.status === 404);
  await assert.rejects(get('itsa:S-99'), (e) => e.status === 404);
  await assert.rejects(get('team:M'), (e) => e.status === 400);
  await assert.rejects(summary.activitySummary({ days: 0 }), (e) => e.status === 400);
});

test('trees: roots with subtree totals and their direct children', async () => {
  seed();
  const s = await get();
  assert.deepEqual(s.trees.map((t) => [t.id, t.agents]), [['M', 4], ['O', 1]]);
  const m = s.trees[0];
  assert.deepEqual(
    { working: m.working_s, friction: m.friction_s, others: m.others_s, you: m.you_s, idle: m.idle_s, cost: m.cost_usd },
    { working: 1200, friction: 770, others: 1300, you: 1000, idle: 400, cost: 3.6 },
  );
  assert.deepEqual(m.children.map((c) => [c.id, c.agents, c.working_s, c.cost_usd]), [['W', 2, 1100, 2.5], ['X', 1, 0, 0.8]]);
  const t = await get('tree:W');
  assert.deepEqual(t.trees.map((x) => [x.id, x.agents, x.children.map((c) => c.id)]), [['W', 2, ['V']]]);
});

test('configs: closed work issues by model, type and both', async () => {
  seed();
  const s = await get();
  assert.equal(s.configs.n, 1);
  const [m] = s.configs.by_model;
  assert.equal(m.model, 'claude · claude-haiku-5-5');
  assert.equal(m.n, 1);
  assert.equal(m.working_s.median, 1020);
  assert.equal(m.waiting_s.median, 1800);
  assert.equal(m.cost_usd.median, 2);
  assert.equal(m.lead_s.median, 36000);
  assert.deepEqual(s.configs.by_type.map((x) => [x.type, x.n]), [['developer', 1]]);
  assert.deepEqual(s.configs.by_model_type.map((x) => [x.model, x.type, x.n]), [['claude · claude-haiku-5-5', 'developer', 1]]);
  // A scope without the issue's agents has none.
  assert.equal((await get('tree:O')).configs.n, 0);
});

test('configs: an agent viewer counts every closed issue its tree worked, not only the ITSAs it belongs to (S-1197)', async () => {
  seed();
  // V belongs to S-2 only; S-1 is W's. The tree scope V may read holds both agents' work, so S-1 counts.
  const asV = await get('tree:M', { viewer: 'V' });
  assert.equal(asV.configs.n, 1);
  assert.equal(asV.configs.n, (await get('tree:M')).configs.n);
  assert.equal((await get(undefined, { viewer: 'V' })).configs.n, 1);
});

test('configs under an itsa scope: its own closed issues and its children\'s, and a member viewer reads the same (S-1197)', async () => {
  seed();
  // S-1 is done and S-2, its child, is still open: S-1's scope counts one issue, S-2's none.
  assert.equal((await get('itsa:S-1')).configs.n, 1);
  assert.equal((await get('itsa:S-2')).configs.n, 0);
  closeS2(db.open());
  // Once S-2 closes, S-1's scope counts both (the child is in its subtree) and S-2's scope its own; V belongs to S-2.
  assert.equal((await get('itsa:S-1')).configs.n, 2);
  const i2 = await get('itsa:S-2');
  assert.equal(i2.configs.n, 1);
  assert.equal(i2.configs.by_model[0].model, 'opencode · deepseek-v4');
  assert.equal((await get('itsa:S-2', { viewer: 'V' })).configs.n, 1);
  assert.deepEqual((await get('itsa:S-2', { viewer: 'V' })).configs, i2.configs);
  // S-3 is a closed issue outside S-1's subtree that V also worked. V is a member of S-2's scope, so without the scope
  // filter in configsOf its S-3 time would count there (and in S-1's): the scope must leave it out.
  const d = db.open();
  d.prepare("INSERT INTO itsas (id, key, parent_id, kind, title, status, owner, created_by, created_at, updated_at, closed_at) VALUES ('I3', 'S-3', NULL, 'issue', 'S-3', 'done', 'V', 'M', ?, ?, ?)").run(at(-3600), at(7 * 3600), at(7 * 3600));
  d.prepare('INSERT INTO itsa_events (itsa_id, ts, actor, type, data) VALUES (?, ?, ?, ?, ?)').run('I3', at(-3600), 'M', 'created', JSON.stringify({ key: 'S-3', status: 'in_progress' }));
  d.prepare('INSERT INTO itsa_events (itsa_id, ts, actor, type, data) VALUES (?, ?, ?, ?, ?)').run('I3', at(7 * 3600), 'V', 'status', JSON.stringify({ from: 'in_progress', to: 'done' }));
  d.prepare("INSERT INTO itsa_participants (itsa_id, agent_id) VALUES ('I3', 'V')").run();
  summary.resetSummary();
  assert.equal((await get('itsa:S-2')).configs.n, 1, 'V is a member of S-2, but its S-3 is outside the scope');
  assert.equal((await get('itsa:S-1')).configs.n, 2, 'S-3 is outside S-1 too');
});

test('a touched agent and a changed ITSA rebuild only what changed', async () => {
  seed();
  assert.equal((await get()).clock.total_s, 5000);
  const d = db.open();
  d.prepare('INSERT INTO activity_items (agent_id, seq, turn, kind, start, "end", wait_kind) VALUES (?, 99, 2, ?, ?, ?, ?)').run('O', 'gap', at(400), at(500), 'human.reply');
  changes.touched('O');
  const s = await get();
  assert.equal(s.clock.total_s, 5100);
  assert.equal(summary.summaryMetrics().last_rebuilt, 1);

  // A touch from a time refolds only the hours from there on; the answer equals a whole rebuild.
  d.prepare('INSERT INTO activity_items (agent_id, seq, turn, kind, start, "end", wait_kind, est_cost_usd, category) VALUES (?, 100, 3, ?, ?, ?, ?, ?, ?)').run('W', 'tool', at(2 * 3600), at(2 * 3600 + 90), 'tool.test', 0.3, 'verify.unit');
  d.prepare('INSERT INTO activity_items (agent_id, seq, turn, kind, start, "end", wait_kind) VALUES (?, 101, 3, ?, ?, ?, ?)').run('W', 'tool', at(2 * 3600 + 30), at(2 * 3600 + 60), 'tool.short');
  changes.touched('W', T0 + 2 * 3600 * 1000);
  const partial = await get();
  summary.resetSummary();
  const whole = await get();
  assert.deepEqual(partial.clock, whole.clock);
  assert.deepEqual(partial.working_by_category, whole.working_by_category);
  assert.deepEqual(partial.bottlenecks, whole.bottlenecks);
  assert.equal(partial.clock.working_s, 1290);

  // S-2 closes: V's issue joins the configs, and only the agents linked to it are rebuilt.
  closeS2(d);
  const c = await get();
  assert.equal(c.configs.n, 2);
  assert.equal(summary.summaryMetrics().last_rebuilt, 1);
  // An ITSA row change with no event (here its kind) still drops the cached answer.
  d.prepare("UPDATE itsas SET kind = 'retro', updated_at = ? WHERE id = 'I1'").run(at(9.5 * 3600));
  assert.equal((await get()).configs.n, 1);
});

test('realistic scale: 700 agents over 7 days in short slices, agreeing with by=agent', async () => {
  const { seedScale } = await import('./activity-fixture.mjs');
  const f = seedScale(db, { agents: 700, days: 7 });
  summary.resetSummary();
  const t0 = performance.now();
  const s = await settled({ days: 7, now: f.now });
  const cold = performance.now() - t0;
  const t1 = performance.now();
  await summary.activitySummary({ days: 7, now: f.now });
  const warm = performance.now() - t1;
  const m = summary.summaryMetrics();
  console.log(`# ${f.agents} agents, ${f.items} items: cold ${Math.round(cold)} ms, warm ${Math.round(warm)} ms, merge ${m.last_merge_ms} ms, max slice ${m.max_slice_ms} ms at ${m.max_slice_at}`);
  // Timing bounds live in scripts/activity-bench.mjs, not here, so a slow machine can't fail the gate.
  assert.ok(m.slices > 1, 'the work ran in more than one slice');
  assert.equal(groupsSum(s.clock), s.clock.total_s);
  assert.equal(s.tiles.friction.seconds, s.clock.friction_s);
  assert.equal(s.bottlenecks.filter((b) => b.group === 'friction').reduce((n, b) => n + b.seconds, 0), Object.values(s.tiles.friction.parts).reduce((n, v) => n + v, 0));
  // The paged digests split concurrent time as by=agent does: the same clock, to rounding.
  const byAgent = stats.activityStats({ by: 'agent', days: 7, now: f.now });
  const clock = byAgent.rows.reduce((n, r) => n + (r.working_s ?? 0) + (r.waiting_s ?? 0), 0);
  assert.ok(Math.abs(clock - s.clock.total_s) <= byAgent.rows.length, `by=agent ${clock} s, summary ${s.clock.total_s} s`);
  assert.equal(s.trees.reduce((n, t) => n + t.agents, 0), s.agents);
  // The headline cost is the usage table's, as by=agent's cost_usd.
  const usd = byAgent.rows.reduce((n, r) => n + r.cost_usd, 0);
  assert.ok(Math.abs(usd - s.tiles.cost.cost_usd) < 1e-3, `by=agent $${usd}, summary $${s.tiles.cost.cost_usd}`);
  // A partial refold of a long-lived root (items reaching back across many pages) equals a whole one.
  const root = f.roots[0];
  changes.touched(root, f.now - 36 * 3_600_000);
  const partial = await settled({ days: 7, now: f.now, scope: `agent:${root}` });
  assert.equal(summary.summaryMetrics().last_rebuilt, 1);
  summary.resetSummary();
  const whole = await settled({ days: 7, now: f.now, scope: `agent:${root}` });
  assert.deepEqual(partial.clock, whole.clock);
  assert.deepEqual(partial.bottlenecks, whole.bottlenecks);
});

test('the attribution export sends only changed ITSA rows, and the peer\'s merge equals a full resend (S-1208)', () => {
  seed();
  const d = db.open();
  const ins = (id, key, stamp) =>
    d.prepare('INSERT INTO itsas (id, key, parent_id, kind, title, status, owner, created_by, created_at, updated_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, key, null, 'issue', key, 'todo', null, 'M', at(-3600), stamp, null);
  const touch = (id, stamp, status) => d.prepare('UPDATE itsas SET status = ?, updated_at = ? WHERE id = ?').run(status, stamp, id);
  d.prepare('UPDATE itsas SET updated_at = ? WHERE id = ?').run(at(-1000), 'I1');
  ins('I3', 'S-3', at(-900));
  const newest = (rows) => rows.reduce((m, x) => (x.updated_at > m ? x.updated_at : m), '');

  // A fresh peer holds nothing and gets every row, with no id list.
  const fresh = summary.attributionExport(null);
  assert.equal(fresh.itsas.length, 3);
  assert.equal(fresh.ids, undefined);
  let held = fresh.itsas;

  // A changed ITSA sends its row alone (and a new one), not the rest.
  touch('I2', at(-500), 'done');
  ins('I4', 'S-4', at(-400));
  let delta = summary.attributionExport(fresh.sig, -1, false, newest(held));
  // I3 is the newest row the peer held: an equal stamp may hide a later write, so it comes again.
  assert.deepEqual(delta.itsas.map((x) => x.id).sort(), ['I2', 'I3', 'I4']);
  held = summary.mergeRows(held, delta.itsas, delta.ids);
  const full = () => summary.attributionExport(null).itsas;
  const byId = (rows) => [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
  assert.deepEqual(byId(held), byId(full()));

  // A removed ITSA is dropped from the peer's rows.
  d.prepare('DELETE FROM itsas WHERE id = ?').run('I3');
  touch('I1', at(-300), 'done');
  delta = summary.attributionExport(delta.sig, -1, false, newest(held));
  assert.deepEqual(delta.itsas.map((x) => x.id).sort(), ['I1', 'I4']);
  held = summary.mergeRows(held, delta.itsas, delta.ids);
  assert.ok(!held.some((x) => x.id === 'I3'));
  assert.deepEqual(byId(held), byId(full()));
  assert.deepEqual(byId(held).map((x) => x.id), ['I1', 'I2', 'I4']);

  // A cursor past every row (a restored database) is not a baseline: all rows, no ids.
  const back = summary.attributionExport(null, -1, false, '9999-01-01T00:00:00.000Z');
  assert.equal(back.ids, undefined);
  assert.deepEqual(byId(back.itsas), byId(full()));
});
