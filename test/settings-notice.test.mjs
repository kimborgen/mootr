#!/usr/bin/env node
// A config notice is sent from system:cost with no agent running, once, and a retry on a cache-hit read
// sends nothing more (S-344, src/settings.ts and src/accounts.ts). Throwaway STAM_HOME, no daemon:
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

test('with no agent at all the notice goes out from system:cost, and a cache-hit read does not send it twice', async () => {
  assert.equal(db.listAgents().length, 0, 'no agent can stand in as the sender');
  s.settings();
  assert.equal(await settle(() => rejected() === 1), true, 'the notice is sent with no agent');
  assert.equal(db.open().prepare("SELECT from_id FROM mail WHERE subject = '[stam] Cost config rejected'").get().from_id, 'system:cost');
  // The file hasn't changed, so these reads are cache hits: the retry has nothing pending.
  s.settings();
  s.settings();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(rejected(), 1, 'the notice is not sent again');
});
