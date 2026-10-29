#!/usr/bin/env node
// GET /api/agents reads full rows only for the agents it lists (S-3840): the live rows come from an indexed query, the
// cost roll-up from id and parent links alone. Throwaway STAM_HOME, no daemon. `node --test test/live-list.test.mjs`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { tempHome } from './tmphome.mjs';

process.env.STAM_HOME = tempHome('stam-live-list-');
delete process.env.STAM_TOKEN;

let db, costs;
before(async () => {
  db = await import('../src/db.ts');
  costs = await import('../src/agent-costs.ts');
});

function seed(name, parent_id = null) {
  return db.createAgent({ id: `id-${name}`, name, role: '', machine: 'm1', harness: 'claude-code', model: null, effort: null, cwd: '/tmp/x', parent_id, session_id: null }).id;
}
const names = (rows) => rows.map((a) => a.name);

test('listAgentsExceptArchived follows every lifecycle change and lists named archived agents', () => {
  const a = seed('a');
  const b = seed('b');
  const c = seed('c');
  assert.deepEqual(names(db.listAgentsExceptArchived()), ['a', 'b', 'c']);
  db.updateAgent(b, { lifecycle: 'archived' });
  assert.deepEqual(names(db.listAgentsExceptArchived()), ['a', 'c'], 'archive leaves the set');
  db.updateAgent(c, { lifecycle: 'shut_down' });
  assert.deepEqual(names(db.listAgentsExceptArchived()), ['a', 'c'], 'a stopped agent stays');
  assert.deepEqual(names(db.listAgentsExceptArchived([b])), ['a', 'b', 'c'], 'an archived agent by id');
  assert.deepEqual(names(db.listAgentsExceptArchived(['b'])), ['a', 'b', 'c'], 'an archived agent by name');
  db.updateAgent(b, { lifecycle: 'active' });
  assert.deepEqual(names(db.listAgentsExceptArchived()), ['a', 'b', 'c'], 'resume returns it');
  const d = seed('d');
  assert.deepEqual(names(db.listAgentsExceptArchived()), ['a', 'b', 'c', 'd'], 'a spawn joins it');
  assert.equal(db.listAgentsExceptArchived().length, db.listAgents().filter((x) => x.lifecycle !== 'archived').length);
  assert.ok(a && d);
});

test('the tree cost counts an archived child when the roll-up reads links only', () => {
  const p = seed('parent');
  const k = seed('kid', p);
  db.updateAgent(k, { lifecycle: 'archived' });
  for (const [id, cost] of [[p, 1], [k, 2]]) {
    db.open().prepare("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, tokens_in, tokens_out) VALUES (?, '2026-10-24', 'claude-code', 'm', 'acct', ?, 0, 0)").run(id, cost);
  }
  costs.resetAgentCostsMemo();
  const fromRows = costs.agentRaw(db.listAgents());
  costs.resetAgentCostsMemo();
  const fromLinks = costs.agentRaw(db.agentLinks());
  assert.deepEqual(fromLinks.get(p), fromRows.get(p));
  assert.equal(fromLinks.get(p).tree.acct.api, 3, 'the archived child is in the parent tree');
  assert.equal(fromLinks.get(p).own.acct.api, 1);
});

test('listWithRaw returns costs for every listed row, including an agent created just before the read (snapshot)', () => {
  costs.resetAgentCostsMemo();
  const first = costs.listWithRaw(() => db.listAgentsExceptArchived());
  assert.ok(!(first instanceof Promise), 'one synchronous step: nothing can spawn between the two reads');
  const late = seed('late');
  const second = costs.listWithRaw(() => db.listAgentsExceptArchived());
  assert.ok(second.listed.some((a) => a.id === late));
  for (const a of second.listed) assert.ok(second.raws.get(a.id), `${a.name} has a roll-up`);
});
