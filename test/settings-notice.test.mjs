#!/usr/bin/env node
// A config notice waits for a sender and is sent on a later read, even when that read is a cache hit
// (S-344, src/settings.ts and src/accounts.ts). Throwaway STAM_HOME, no daemon:
// `node --test test/settings-notice.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-settings-notice-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `settings-notice-test-${process.pid}`;
writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [], cost: { onError: 'not-a-real-action' } }, null, 2));
const db = await import('../src/db.ts');
const s = await import('../src/settings.ts');

const rejected = () => db.open().prepare("SELECT COUNT(*) AS n FROM mail WHERE subject = '[stam] Cost config rejected'").get().n;
const settle = async (check) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 50));
  return check();
};

test('with no sender the notice waits; a read after an agent appears sends it, though the file is unchanged', async () => {
  s.settings();
  assert.equal(rejected(), 0, 'no sender yet, so nothing is sent');
  db.createAgent({ id: 'sender-1', name: 'sender', role: '', machine: 'test', harness: 'claude', model: null, effort: null, cwd: '', parent_id: null, session_id: null });
  // The file hasn't changed, so this read is a cache hit: the retry still runs.
  s.settings();
  assert.equal(await settle(() => rejected() === 1), true, 'the notice is sent on a cache-hit read');
});
