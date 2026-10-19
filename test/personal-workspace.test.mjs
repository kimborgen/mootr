#!/usr/bin/env node
// S-894: a spawn's `workspace` and `standing` options. The workspace name is validated, resolved
// to a folder under STAM_HOME/workspaces, made 0700 when it is missing and reused when it exists;
// archive keeps the folder and everything in it, so a respawned specialist adopts it. Runs against
// a throwaway STAM_HOME with no daemon and no model:
// `node --test test/personal-workspace.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-personal-workspace-');
const socket = `personal-workspace-test-${process.pid}`;
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = socket;
process.env.STAM_EMBEDDER = 'stub';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [] }));

let ws, db, lifecycle;
before(async () => {
  ws = await import('../src/workspace.ts');
  db = await import('../src/db.ts');
  lifecycle = await import('../src/lifecycle.ts');
  // A harness that never runs a turn, as starting-archive.test.mjs uses: archive completes at once.
  const { adapters } = await import('../src/adapters/index.ts');
  adapters.fake = {
    pushPrompt: async () => true,
    launch: async () => ({ argv: ['sleep', '600'], env: {} }),
    afterLaunch: async () => {},
    turnRunning: async () => false,
  };
});
after(() => {
  spawnSync('tmux', ['-L', socket, 'kill-server']);
});

test('a workspace name is lowercase letters, digits and dashes; true means the agent name', () => {
  assert.equal(ws.personalWorkspaceName(true, 'react-fixer'), 'react-fixer');
  assert.equal(ws.personalWorkspaceName('team-1', 'ignored'), 'team-1');
  for (const bad of ['React', 'has_underscore', 'a/b', 'a b', '-lead', '', 'x'.repeat(42)]) {
    assert.throws(() => ws.personalWorkspaceName(bad, 'agent'), /lowercase letters, digits, and dashes/, `accepted ${JSON.stringify(bad)}`);
  }
});

test('the workspace path is STAM_HOME/workspaces/NAME, absolute, and not a worktree', () => {
  assert.equal(ws.personalWorkspacePath('react-fixer'), join(home, 'workspaces', 'react-fixer'));
  assert.equal(ws.WORKSPACES_DIR, join(home, 'workspaces'));
});

test('the folder is made 0700 when missing and reused, keeping what is in it', () => {
  const path = ws.createPersonalWorkspace('react-fixer');
  assert.equal(path, join(home, 'workspaces', 'react-fixer'));
  assert.equal(statSync(path).mode & 0o777, 0o700, 'a fresh folder is private');
  writeFileSync(join(path, 'learnings.md'), '# kept\n');
  assert.equal(ws.createPersonalWorkspace('react-fixer'), path, 'the same folder is reused');
  assert.equal(readFileSync(join(path, 'learnings.md'), 'utf8'), '# kept\n');
});

// An agent row as spawnAgent writes it, with a personal workspace and standing set.
let n = 0;
function agent(name = `pw${++n}`, extra = {}) {
  const id = db.newAgentId();
  const cwd = join(home, `work-${id}`);
  mkdirSync(cwd);
  db.createAgent({ id, name, role: '', machine: 'test', harness: 'fake', model: null, effort: null, cwd, parent_id: null, session_id: `sess-${id}` });
  db.updateAgent(id, { workspace: JSON.stringify({ spec: { kind: 'dir', path: cwd }, cwd }), lifecycle: 'active', activity: 'idle', standing: 1, ...extra });
  return db.getAgent(id);
}

test('archive keeps the personal workspace folder and its files', async () => {
  const name = 'react-fixer';
  const path = ws.createPersonalWorkspace(ws.personalWorkspaceName(true, name));
  writeFileSync(join(path, 'notes.md'), '# learnings\n');
  mkdirSync(join(path, 'diagrams'));
  writeFileSync(join(path, 'diagrams', 'flow.md'), 'a flow\n');
  const a = agent(name, { personal_workspace: path });
  assert.equal(await lifecycle.archive(db.getAgent(a.id), true), 'done');
  const gone = db.getAgent(a.id);
  assert.equal(gone.lifecycle, 'archived');
  assert.equal(gone.personal_workspace, path, 'the row still names the folder');
  assert.ok(existsSync(path), 'the folder remains');
  assert.equal(readFileSync(join(path, 'notes.md'), 'utf8'), '# learnings\n');
  assert.equal(readFileSync(join(path, 'diagrams', 'flow.md'), 'utf8'), 'a flow\n');
});

test('a spawn with no workspace leaves personal_workspace null and standing 0', () => {
  const a = agent('plain', { personal_workspace: null, standing: 0 });
  assert.equal(a.personal_workspace, null);
  assert.equal(a.standing, 0);
});

test('agentsByRole matches role or name case-insensitively and lists standing agents first', () => {
  const rows = [
    { name: 'a-dev', role: 'React fixer', standing: 0 },
    { name: 'react-fixer', role: '', standing: 1 },
    { name: 'tester', role: 'Playwright tests', standing: 1 },
    { name: 'b-dev', role: 'REACT upgrades', standing: 0 },
  ];
  assert.deepEqual(db.agentsByRole(rows, 'react').map((a) => a.name), ['react-fixer', 'a-dev', 'b-dev']);
  assert.deepEqual(db.agentsByRole(rows, 'PLAYWRIGHT').map((a) => a.name), ['tester']);
  assert.deepEqual(db.agentsByRole(rows, 'nothing'), []);
  assert.deepEqual(db.agentsByRole(rows, '').map((a) => a.name), ['react-fixer', 'tester', 'a-dev', 'b-dev'], 'an empty role keeps all');
});
