#!/usr/bin/env node
// A compactor that doesn't take its /compact on stdin (S-2040). The pre-deploy canary's daemon died on
// an unhandled EPIPE: Claude's compact writes the command to the child's stdin, and a child that exits
// without reading it (as the canary's stub `claude` does) fails that write. The compaction must fail as
// a rejected promise, and the process must stay up. The instructions are larger than a pipe's buffer,
// so the write is still pending when the child exits and the EPIPE is certain. Runs against a throwaway
// STAM_HOME and tmux socket, with no daemon, no network and no models:
// `node --test test/compact-epipe.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-compact-epipe-');
const socket = `compact-epipe-test-${process.pid}`;
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = socket;
// Read at import: a compactor that exits at once without reading stdin.
const bin = join(home, 'claude');
writeFileSync(bin, '#!/bin/sh\nexit 1\n');
chmodSync(bin, 0o755);
process.env.STAM_CLAUDE_BIN = bin;
process.on('exit', () => spawnSync('tmux', ['-L', socket, 'kill-server']));

test('a compactor that exits without reading stdin fails the compaction without an uncaught EPIPE', async () => {
  const uncaught = [];
  const onUncaught = (e) => uncaught.push(e);
  process.on('uncaughtException', onUncaught);
  try {
    const { adapters } = await import('../src/adapters/index.ts');
    const agent = { id: 'epipe1', name: 'epipe1', harness: 'claude', session_id: '00000000-0000-0000-0000-000000000000', cwd: home, model: null };
    await assert.rejects(adapters.claude.compact(agent, 'x'.repeat(1 << 20), { op: 't' }));
    // An EPIPE on the stream is emitted after the spawn error: give it a turn of the loop to land.
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(uncaught.map((e) => e.code ?? e.message), []);
  } finally {
    process.off('uncaughtException', onUncaught);
  }
});
