#!/usr/bin/env node
// Unit tests for who may act on an ITSA (S-1052): mail-visibility.ts's mayEditItsa, mayPostItsa and
// itsaRefusal, and itsa-owners.ts's mayAssign (the spawn path). The caller is an agent id (the daemon
// normalizes `by` to one before the check); a name never matches, so an owner or participant passes by
// id and a name standing in for an id is refused, even when a local agent carries that name. A
// participant of a feedback report or retro item (an open board) may post but not change it (S-480),
// and its refusal doesn't list it as one who may.
// Throwaway STAM_HOME, no daemon. Run with `node --test test/itsa-permission.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-itsa-perm-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `itsa-perm-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

let db, itsa, owners, visibility;
const agent = (id, name) => db.createAgent({ id, name, role: 'dev', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
const active = (id) => db.updateAgent(id, { lifecycle: 'active', activity: 'idle' });

before(async () => {
  db = await import('../src/db.ts');
  itsa = await import('../src/itsa.ts');
  owners = await import('../src/itsa-owners.ts');
  visibility = await import('../src/mail-visibility.ts');
  await import('../src/settings.ts');
  db.open();
  agent('own1', 'owner-one');
  agent('part1', 'part-one');
  agent('out1', 'outsider');
  // Named like another agent's id: id `out9` is "lone-agent", while agent `pp9` carries the name `out9`.
  agent('out9', 'lone-agent');
  agent('pp9', 'out9');
  for (const id of ['own1', 'part1', 'out1', 'out9', 'pp9']) active(id);
});
after(() => rmSync(home, { recursive: true, force: true }));

test('a participant of an ordinary ITSA may change it by id; a name is not an id', async () => {
  const x = await itsa.create({ title: 'Plain work', by: 'human', owner: 'owner-one', kind: 'issue', participants: ['part-one'] });
  assert.equal(visibility.mayEditItsa('part1', x.id), true, 'by id');
  assert.equal(visibility.mayEditItsa('part-one', x.id), false, 'by name');
});

test('an owner may change it by id; a name is not an id', async () => {
  const x = await itsa.create({ title: 'Owned work', by: 'human', owner: 'owner-one', kind: 'issue' });
  assert.equal(visibility.mayEditItsa('own1', x.id), true, 'by id');
  assert.equal(visibility.mayEditItsa('owner-one', x.id), false, 'by name');
});

test('a stranger is refused by id, and by name', async () => {
  const x = await itsa.create({ title: 'Closed to others', by: 'human', owner: 'owner-one', kind: 'issue' });
  assert.equal(visibility.mayEditItsa('out1', x.id), false, 'by id');
  assert.equal(visibility.mayEditItsa('outsider', x.id), false, 'by name');
  assert.equal(visibility.mayPostItsa('out1', x.id), false, 'post, by id');
});

test('an id that equals another agent\'s name is refused, even when that agent is a participant', async () => {
  const x = await itsa.create({ title: 'Collision', by: 'human', owner: 'owner-one', kind: 'issue', participants: ['pp9'] });
  assert.equal(visibility.mayEditItsa('pp9', x.id), true, 'the participant, by its id');
  assert.equal(visibility.mayEditItsa('out9', x.id), false, 'the id out9 is not a participant, whatever name agent pp9 carries');
});

test('a participant of a feedback report may post by id but not change it; its refusal omits it from who may', async () => {
  const x = await itsa.create({ title: 'Report', by: 'human', owner: 'owner-one', kind: 'feedback-report', participants: ['part-one'] });
  assert.equal(visibility.mayPostItsa('part1', x.id), true, 'post, by id');
  assert.equal(visibility.mayEditItsa('part1', x.id), false, 'change, by id');
  const why = visibility.itsaRefusal('part1', x.id, 'change');
  assert.match(why, /^part-one can't change/, why);
  assert.doesNotMatch(why, /\(.*part-one.*\)/, why);
  assert.match(why, /\(owner-one\)/, why);
});

test('the spawn path (mayAssign) passes an owner or participant by id and refuses a stranger', async () => {
  const x = await itsa.create({ title: 'Spawn target', by: 'human', owner: 'owner-one', kind: 'issue', participants: ['part-one'] });
  assert.doesNotThrow(() => owners.mayAssign(x.key, { agent: 'own1', boss: false }));
  assert.doesNotThrow(() => owners.mayAssign(x.key, { agent: 'part1', boss: false }));
  assert.throws(() => owners.mayAssign(x.key, { agent: 'out1', boss: false }), /outsider can't change/);
  assert.throws(() => owners.mayAssign(x.key, { agent: 'part-one', boss: false }), /part-one can't change/);
});

test('the spawn path refuses a feedback-report participant, and names no participant as may', async () => {
  const x = await itsa.create({ title: 'Spawn report', by: 'human', owner: 'owner-one', kind: 'feedback-report', participants: ['part-one'] });
  assert.throws(() => owners.mayAssign(x.key, { agent: 'part1', boss: false }), (e) => {
    assert.match(e.message, /part-one can't change/);
    assert.doesNotMatch(e.message, /\(.*part-one.*\)/);
    return true;
  });
});
