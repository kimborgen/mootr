#!/usr/bin/env node
// A visibility column that doesn't parse, or a field with a wrong type or value, fails closed (S-4003): it must never
// widen whom an agent may mail (reachable, checkCanMail) or which agents it sees (visibleTo, find_agents). A NULL column
// or a missing field keeps the open default. Each column is written with db.updateAgent, as set-visibility writes it,
// then corrupted with SQL. go/internal/db visibility_test.go holds the Go side and compares it with visibilityOf.
// Throwaway STAM_HOME, no daemon, no network: `node --test test/org-visibility.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-org-visibility-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `org-visibility-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

let db, org;
const OPEN = { reach: 'all', siblings: true, registry: true };
const CLOSED = { reach: 'parent', siblings: false, registry: false };

before(async () => {
  db = await import('../src/db.ts');
  org = await import('../src/org.ts');
  db.open();
  const agent = (id, parent) => db.createAgent({ id, name: id, role: 'dev', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: '/tmp', parent_id: parent, session_id: null });
  agent('boss', null);
  agent('kid', 'boss');
  agent('sib', 'boss');
  agent('other', null);
});

after(() => {
  rmSync(home, { recursive: true, force: true });
});

// kid's column as the writer leaves it, then overwritten with `col` (null for a NULL column).
function corrupt(col) {
  db.updateAgent('kid', { visibility: JSON.stringify({ reach: 'tree', siblings: true, registry: true }) });
  db.open().prepare('UPDATE agents SET visibility = ? WHERE id = ?').run(col, 'kid');
  return db.getAgent('kid');
}

const mayMail = (to) => {
  try {
    org.checkCanMail('kid', to);
    return true;
  } catch {
    return false;
  }
};
const sees = () => org.visibleTo('kid', ['boss', 'kid', 'sib', 'other'].map((id) => ({ id, parent_id: db.getAgent(id).parent_id }))).map((x) => x.id);

// The must-fail inputs: each one decoded open, or partly open, before S-4003.
test('a column that does not parse closes every field', () => {
  const a = corrupt('{"reach":"tree","registry":false');
  assert.deepEqual(org.visibilityOf(a), CLOSED);
  assert.deepEqual([...org.reachable(a)], ['boss']);
  assert.equal(mayMail('other'), false, 'kid may mail outside its parents');
  assert.equal(mayMail('sib'), false, 'kid may mail its sibling');
  assert.deepEqual(sees(), ['boss', 'kid']);
});

test('a reach that is not a string closes reach, and registry:false still holds', () => {
  const a = corrupt('{"reach":5,"registry":false}');
  assert.deepEqual(org.visibilityOf(a), { reach: 'parent', siblings: true, registry: false });
  assert.equal(mayMail('other'), false);
  assert.deepEqual(sees(), ['boss', 'kid']);
});

test('an unknown reach closes reach only', () => {
  const a = corrupt('{"reach":"bogus"}');
  assert.deepEqual(org.visibilityOf(a), { reach: 'parent', siblings: true, registry: true });
  assert.equal(mayMail('other'), false);
  assert.equal(mayMail('boss'), true, 'a parent stays reachable');
  assert.deepEqual(sees(), ['boss', 'kid', 'sib', 'other'], 'registry stays open');
});

test('a siblings flag that is not a boolean closes siblings only', () => {
  assert.deepEqual(org.visibilityOf(corrupt('{"siblings":"yes"}')), { reach: 'all', siblings: false, registry: true });
  const a = corrupt('{"reach":"tree","siblings":"yes"}');
  assert.deepEqual(org.visibilityOf(a), { reach: 'tree', siblings: false, registry: true });
  assert.equal(mayMail('sib'), false, 'kid may mail its sibling');
  assert.equal(mayMail('boss'), true);
});

test('other columns that are not an object, and null or numeric fields, fail closed', () => {
  for (const col of ['', 'null', '[]', '"all"', '{"reach":null,"siblings":null,"registry":null}']) assert.deepEqual(org.visibilityOf(corrupt(col)), CLOSED, col);
  assert.deepEqual(org.visibilityOf(corrupt('{"registry":1}')), { reach: 'all', siblings: true, registry: false });
});

// It passes against the code before S-4003 too.
test('a NULL column, missing fields and valid columns decode as before', () => {
  assert.deepEqual(org.visibilityOf(corrupt(null)), OPEN);
  assert.equal(mayMail('other'), true);
  assert.deepEqual(org.visibilityOf(corrupt('{}')), OPEN);
  assert.deepEqual(org.visibilityOf(corrupt('{"reach":"tree"}')), { reach: 'tree', siblings: true, registry: true });
  assert.equal(mayMail('sib'), true);
  assert.deepEqual(org.visibilityOf(corrupt('{"reach":"parent","siblings":true,"registry":false}')), { reach: 'parent', siblings: true, registry: false });
  // Before S-4003 the unknown field came back too; no caller reads it.
  const { reach, siblings, registry } = org.visibilityOf(corrupt('{"reach":"tree","siblings":false,"registry":true,"note":"x"}'));
  assert.deepEqual({ reach, siblings, registry }, { reach: 'tree', siblings: false, registry: true });
  assert.deepEqual(org.visibilityOf(corrupt('{"reach":"all","siblings":false,"registry":false}')), { reach: 'all', siblings: false, registry: false });
});
