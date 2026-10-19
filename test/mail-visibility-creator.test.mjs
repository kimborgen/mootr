#!/usr/bin/env node
// The creator of an ITSA keeps its rights after handing it on (S-586): it may still read and change
// the ITSA, though it isn't in its participant list and so gets no relays. An open board (retro) gives
// no such right to its creator. Throwaway STAM_HOME, no daemon, no network.
// Run with `node --test test/mail-visibility-creator.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-mail-visibility-creator-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `mail-visibility-creator-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

let db, itsa, vis;

before(async () => {
  db = await import('../src/db.ts');
  itsa = await import('../src/itsa.ts');
  vis = await import('../src/mail-visibility.ts');
  db.open();
  const agent = (id, name) => db.createAgent({ id, name, role: 'dev', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  agent('a1', 'alice');
  agent('a2', 'bob');
  agent('a3', 'carol');
});

after(() => {
  rmSync(home, { recursive: true, force: true });
});

test('a creator that hands the ITSA on keeps its rights but is not a participant', async () => {
  const x = await itsa.create({ title: 'Handed on', by: 'a1', owner: 'a2' });
  assert.ok(!itsa.participants(x.id).includes('a1'), 'the creator is in the participant list');
  assert.equal(vis.mayEditItsa('a1', x.id), true);
  assert.equal(vis.mayReadItsaThreads('a1', x.id), true);
  assert.equal(vis.mayEditItsa('a3', x.id), false, 'an unrelated agent may change the ITSA');
});

test('a creator with no owner keeps its rights too', async () => {
  const x = await itsa.create({ title: 'Ownerless', by: 'a1' });
  assert.equal(vis.mayEditItsa('a1', x.id), true);
});

test('on an open retro board the creator gets no edit right', async () => {
  const x = await itsa.create({ title: 'Retro item', by: 'a1', kind: 'retro', owner: 'a2' });
  assert.equal(vis.mayEditItsa('a1', x.id), false);
});
