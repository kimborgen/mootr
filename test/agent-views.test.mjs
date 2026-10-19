#!/usr/bin/env node
// The human's per-agent default view (S-82) in src/db.ts: set, cleared with null, and gone
// when the agent is forgotten. Its own STAM_HOME; no daemon. `node --test test/agent-views.test.mjs`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-av-');
process.env.STAM_HOME = home;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
const db = await import('../src/db.ts');
after(() => rmSync(home, { recursive: true, force: true }));

const agent = (id) => db.createAgent({ id, name: id, role: 'dev', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });

test('a default view is set, changed, and cleared with null', () => {
  agent('av1');
  db.setAgentView('av1', 'conversation');
  assert.equal(db.agentViews().get('av1'), 'conversation');
  db.setAgentView('av1', 'terminal');
  assert.equal(db.agentViews().get('av1'), 'terminal');
  db.setAgentView('av1', null);
  assert.equal(db.agentViews().has('av1'), false);
});

test('forgetting an agent drops its default view', () => {
  agent('av2');
  db.setAgentView('av2', 'conversation');
  db.forgetAgent('av2');
  assert.equal(db.agentViews().has('av2'), false);
});
