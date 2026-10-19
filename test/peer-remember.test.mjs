#!/usr/bin/env node
// Remembering a peer agent writes only a change (S-344, src/db.ts rememberPeerAgent): the same agent
// again writes nothing, a changed one writes once, and a forgotten one is written again. Counted with
// total_changes(), so the test doesn't time anything. Throwaway STAM_HOME: `node --test test/peer-remember.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

process.env.STAM_HOME = tempHome('stam-peer-remember-');
process.env.STAM_TMUX_SOCKET = `peer-remember-test-${process.pid}`;
const db = await import('../src/db.ts');
const writes = () => db.open().prepare('SELECT total_changes() AS n').get().n;
const peer = { id: 'p-1', name: 'remote', machine: 'storage' };

test('an unchanged peer agent is written once, however often it is remembered', () => {
  const before = writes();
  for (let i = 0; i < 100; i++) db.rememberPeerAgent(peer);
  assert.equal(writes() - before, 1);
});

test('a changed peer agent is written again', () => {
  const before = writes();
  db.rememberPeerAgent({ ...peer, lifecycle: 'archived' });
  db.rememberPeerAgent({ ...peer, lifecycle: 'archived' });
  assert.equal(writes() - before, 1);
});

test('a forgotten peer agent is written again when it is remembered', () => {
  db.forgetPeerAgent('p-1');
  const before = writes();
  db.rememberPeerAgent({ ...peer, lifecycle: 'archived' });
  assert.equal(writes() - before, 1);
  assert.equal(db.findPeerAgent('remote')?.id, 'p-1');
});
