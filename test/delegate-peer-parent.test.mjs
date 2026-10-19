#!/usr/bin/env node
// A delegate ask whose only reviewer is a peer-machine parent (S-432): a parent known to be archived is
// no reviewer, so the ask goes to the human.
// Throwaway STAM_HOME, no daemon, no peers, no models: `node --test test/delegate-peer-parent.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-delegate-peer-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `delegate-peer-test-${process.pid}`;
process.env.STAM_EMBEDDER = 'stub';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), JSON.stringify({ chiefOfStaff: null, humanMail: { when: 'important' } }));

let db, permissions;
const kid = (id, parent) => db.createAgent({ id, name: id, role: 'test', machine: 'x', harness: 'claude', model: 'claude-opus-5-5', effort: null, cwd: '/tmp', parent_id: parent, session_id: null });
before(async () => {
  db = await import('../src/db.ts');
  permissions = await import('../src/permissions.ts');
});
after(() => rmSync(home, { recursive: true, force: true }));

test('an archived peer parent is no reviewer: the ask is the human\'s, and the requester waits on the human', async () => {
  db.rememberPeerAgent({ id: 'peer-gone', name: 'peer-gone', machine: 'far', lifecycle: 'archived' });
  kid('kid-gone', 'peer-gone');
  const r = await permissions.requestPermission(db.getAgent('kid-gone'), 'Run it', 'needed', 'details', false, {}, 'delegate');
  assert.equal(r.audience, 'human');
  assert.deepEqual(db.listWaits('kid-gone').map((w) => w.kind), ['human']);
  assert.ok(db.permissionMailIds(r.id).length === 1, 'one mail, to the human');
});
