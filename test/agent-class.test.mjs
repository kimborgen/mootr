#!/usr/bin/env node
// Unit tests for the agent types (S-1444, S-1491, src/agent-class.ts): the type of each agent, the older preset and
// `+class,-class` mapping, and the summary's filter with its cache key. A throwaway STAM_HOME, no daemon:
// `node --test test/agent-class.test.mjs`.
//
// Seeded: C (cos, archived), A (assistant), I (intake, untyped), M (manager) with children W (developer) and R
// (reviewer), V (advisor), U (untyped); each has 100 s of model time and $1 of usage, so the filter's effect
// reads as the agents counted.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-agent-class-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `agent-class-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), JSON.stringify({ chiefOfStaff: 'C', cost: { accounts: { claude: { match: { harness: 'claude' } } } } }));

let db, summary, cls, usage;
before(async () => {
  db = await import('../src/db.ts');
  summary = await import('../src/activity-summary.ts');
  cls = await import('../src/agent-class.ts');
  usage = await import('../src/usage.ts');
  const types = await import('../src/agent-types.ts');
  REG = Object.keys(types.agentTypes());
  REVIEWERS = types.reviewerTypes().sort();
  assert.ok(REG.includes('manager') && REG.includes('developer') && REVIEWERS.length >= 2, 'the shipped registry');
});

const T0 = Date.parse('2026-10-11T10:00:00.000Z');
const NOW = T0 + 10 * 3_600_000;
const at = (s) => new Date(T0 + s * 1000).toISOString();

function seed() {
  const d = db.open();
  for (const t of ['activity_items', 'activity_cursors', 'usage', 'usage_samples', 'itsa_events', 'itsa_participants', 'itsa_links', 'itsas', 'agent_parents', 'agents']) d.exec(`DELETE FROM ${t}`);
  const agent = (id, name, type, kind = null, parent = null) =>
    d
      .prepare('INSERT INTO agents (id, name, role, machine, harness, model, effort, cwd, parent_id, session_id, created_at, updated_at, type, kind) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?)')
      .run(id, name, 'test', 'x', 'claude', 'claude-opus-5-5', '/tmp', parent, at(-3600), at(-3600), type, kind);
  agent('C', 'cos', null);
  d.prepare("UPDATE agents SET lifecycle = 'archived' WHERE id = 'C'").run();
  agent('A', 'assistant', null, 'assistant');
  agent('I', 'intake', null);
  agent('M', 'mgr', 'manager');
  agent('W', 'dev', 'developer', null, 'M');
  agent('R', 'rev', 'reviewer', null, 'M');
  agent('V', 'adv', 'advisor');
  agent('U', 'misc', null);
  let seq = 0;
  for (const id of ['C', 'A', 'I', 'M', 'W', 'R', 'V', 'U']) {
    d.prepare('INSERT INTO usage (agent_id, day, harness, model, account, cost_usd) VALUES (?, ?, ?, ?, ?, ?)').run(id, at(0).slice(0, 10), 'claude', 'm', 'claude', 1);
    d.prepare('INSERT INTO activity_items (agent_id, seq, turn, kind, name, start, "end", summary, wait_kind, raw_cost_usd, est_cost_usd, tokens_in, tokens_out, category) VALUES (?, ?, 1, ?, NULL, ?, ?, NULL, ?, 1, 1, 0, 0, ?)').run(
      id, ++seq, 'model', at(0), at(100), 'model.generate', 'produce.edit',
    );
  }
  summary.resetSummary();
}

const get = (agents, extra = {}) => summary.activitySummary({ days: 1, now: NOW, agents, ...extra });
const keep = (s) => (s === null ? null : [...s].sort());

let REG, REVIEWERS;

test('typeOf: the registry type, or the role of an untyped agent', () => {
  const a = (name, type, kind = null, id = name) => ({ id, name, type, kind });
  assert.equal(cls.typeOf(a('boss', null, null, 'C'), 'C'), 'chief-of-staff', 'the configured id, whatever its type');
  assert.equal(cls.typeOf(a('x', 'manager', null, 'C'), 'C'), 'chief-of-staff', 'cos wins over type');
  assert.equal(cls.typeOf(a('cos', 'manager', null, 'a4qux'), 'cos'), 'chief-of-staff', 'the setting may be the name');
  assert.equal(cls.typeOf(a('an', null, 'assistant'), 'C'), 'assistant');
  assert.equal(cls.typeOf(a('intake', null), 'C'), 'intake');
  assert.equal(cls.typeOf(a('intake', 'developer'), 'C'), 'developer', 'a typed agent named intake is not the intake agent');
  for (const t of REG) assert.equal(cls.typeOf(a('t', t), null), t, t);
  assert.equal(cls.typeOf(a('t', null), null), 'untyped');
  assert.equal(cls.typeOf(a('t', 'gone-type'), null), 'untyped', 'a type the registry no longer has');
});

test('parseAgentFilter: type lists, and the older presets and +/- lists', () => {
  assert.equal(cls.parseAgentFilter(null), null);
  assert.equal(cls.parseAgentFilter(''), null);
  assert.equal(cls.parseAgentFilter('all'), null);
  assert.deepEqual(keep(cls.parseAgentFilter('developer,manager')), ['developer', 'manager']);
  assert.deepEqual(keep(cls.parseAgentFilter(`untyped,chief-of-staff,${REVIEWERS[0]}`)), [REVIEWERS[0], 'chief-of-staff', 'untyped'].sort());
  // Old links.
  const work = keep(cls.parseAgentFilter('work'));
  assert.ok(work.includes('developer') && work.includes('untyped') && REG.every((t) => work.includes(t)));
  assert.ok(!work.includes('chief-of-staff') && !work.includes('assistant') && !work.includes('intake'));
  assert.deepEqual(keep(cls.parseAgentFilter('managers')), ['coordinator', 'manager']);
  assert.deepEqual(keep(cls.parseAgentFilter('developers')), ['developer']);
  assert.deepEqual(keep(cls.parseAgentFilter('non-managers')), work.filter((t) => t !== 'manager' && t !== 'coordinator'));
  assert.deepEqual(keep(cls.parseAgentFilter('-cos,-assistant,-intake')), work);
  assert.deepEqual(keep(cls.parseAgentFilter('+manager,+developer')), ['coordinator', 'developer', 'manager']);
  assert.deepEqual(keep(cls.parseAgentFilter('+reviewer')), REVIEWERS);
  assert.deepEqual(keep(cls.parseAgentFilter('+cos')), ['chief-of-staff']);
  assert.equal(cls.filterKey(cls.parseAgentFilter('+cos,-cos')), 'none');
  assert.equal(cls.filterKey(null), '');
  assert.equal(cls.filterKey(cls.parseAgentFilter('manager,developer')), 'developer,manager', 'sorted');
  assert.deepEqual(keep(cls.parseAgentFilter('cos')), ['cos'], 'a registry type since S-2142');
  for (const bad of ['nope', '+nope', 'developer,x', '+cos,x']) assert.throws(() => cls.parseAgentFilter(bad), /agents must be/, bad);
});

test('the summary lists the types present with counts, before the filter', async () => {
  seed();
  const all = await get(null);
  assert.equal(all.clock.total_s, 800);
  assert.equal(all.filter.agents, 'all');
  assert.equal(all.agents, 8);
  assert.deepEqual(all.filter.types, [
    { type: 'advisor', count: 1 }, { type: 'assistant', count: 1 }, { type: 'chief-of-staff', count: 1 }, { type: 'developer', count: 1 },
    { type: 'intake', count: 1 }, { type: 'manager', count: 1 }, { type: 'reviewer', count: 1 }, { type: 'untyped', count: 1 },
  ]);
  const dev = await get('developer,manager');
  assert.equal(dev.clock.total_s, 200);
  assert.equal(dev.agents, 2);
  assert.equal(dev.tiles.cost.cost_usd, 2);
  assert.equal(dev.filter.agents, 'developer,manager');
  assert.equal(dev.filter.types.length, 8, 'the list is the same under a filter, so the control keeps its buttons');
});

test('by_type and by_model carry the kept agents\' cost', async () => {
  seed();
  const all = await get(null);
  assert.equal(all.by_type.length, 8);
  assert.ok(all.by_type.every((t) => t.count === 1 && t.cost_usd === 1 && t.working_s === 100 && t.modes.api === 1));
  assert.deepEqual(all.by_model.map((m) => [m.model, m.count, m.cost_usd]), [['claude · claude-opus-5-5', 8, 8]]);
  const two = await get('developer,manager');
  assert.deepEqual(two.by_type.map((t) => t.type), ['developer', 'manager']);
  assert.equal(two.by_type.reduce((n, t) => n + t.cost_usd, 0), two.tiles.cost.cost_usd, 'the rows sum to the cost tile');
});

test('the filter keeps the types asked for, and old links keep their meaning', async () => {
  seed();
  assert.equal((await get('untyped')).clock.total_s, 100);
  assert.equal((await get('chief-of-staff,assistant,intake')).clock.total_s, 300, 'the archived cos, the assistant and intake');
  assert.equal((await get('work')).clock.total_s, 500, 'U, V, M, W, R');
  assert.equal((await get('managers')).clock.total_s, 100);
  assert.equal((await get('developers')).clock.total_s, 100);
  assert.equal((await get('non-managers')).clock.total_s, 400);
  assert.equal((await get('-cos')).clock.total_s, 700);
  await assert.rejects(get('bogus'), (e) => e.status === 400);
});

test('the archived chief of staff is the chief-of-staff type in the summary and in by_agent', async () => {
  seed();
  assert.equal(db.getAgent('C').lifecycle, 'archived');
  const only = await get('chief-of-staff');
  assert.equal(only.agents, 1, 'the archived cos is counted for its type');
  assert.equal(only.tiles.cost.cost_usd, 1);
  assert.equal((await get('work')).agents, 5);
  const rows = Object.fromEntries(usage.summary(60).by_agent.map((r) => [r.agent_id, r.type]));
  assert.deepEqual(rows, { C: 'chief-of-staff', A: 'assistant', I: 'intake', M: 'manager', W: 'developer', R: 'reviewer', V: 'advisor', U: 'untyped' });
});

test('the cache key includes the filter', async () => {
  seed();
  const a = await get('manager');
  const b = await get('developer');
  const c = await get(null);
  assert.equal(a.agents, 1);
  assert.equal(b.agents, 1);
  assert.equal(c.agents, 8);
  assert.equal(await get('manager'), a, 'the same filter hits the cache');
  assert.equal(await get('manager,developer'), await get('developer,manager'), 'an equal list in another order hits too');
  assert.equal(await get('managers'), await get('manager,coordinator'), 'an old preset and its list share one entry');
});
