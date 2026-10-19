#!/usr/bin/env node
// Waits Codex and OpenCode create (source 'hook', kind 'job'), from synthetic events: the
// Codex adapter's app-server notifications with a fake connection that answers its
// requests, and the OpenCode adapter's event stream with a fake OpenCode server for the
// reads it makes when it (re)connects. The event shapes are the ones codex 0.162.1 and
// opencode v2.0.26 sent live. Throwaway STAM_HOME, no daemon, no models.
// Run with `node --test test/waits-harness.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-waits-harness-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `waits-harness-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

// The fake OpenCode server: what GET /api/shell, /api/session?parentID=, and
// /api/session/active return.
const oc = { shells: [], children: [], active: {}, onChildren: null };
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let data = {};
  if (u.pathname === '/api/shell') data = oc.shells;
  else if (u.pathname === '/api/session/active') data = oc.active;
  else if (u.pathname === '/api/session') oc.onChildren?.(), (data = oc.children.filter((s) => s.parentID === u.searchParams.get('parentID')));
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ data }));
});

let db, codex, opencode;
const tick = () => new Promise((r) => setTimeout(r, 50));
const jobs = (id) => db.listWaits(id).map((w) => `${w.kind}:${w.source}:${w.target}`).sort().join(' ');
const activity = (id) => db.getAgent(id).activity;

before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.STAM_OPENCODE_PORT = String(server.address().port);
  db = await import('../src/db.ts');
  // The index first: adapters import each other through it (see codex-usage.test.mjs).
  await import('../src/adapters/index.ts');
  codex = await import('../src/adapters/codex.ts');
  opencode = await import('../src/adapters/opencode.ts');
  db.open();
  db.createAgent({ id: 'cx', name: 'cx', role: 'dev', machine: 'x', harness: 'codex', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: 'T' });
  db.createAgent({ id: 'oc', name: 'oc', role: 'dev', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: '/tmp/oc', parent_id: null, session_id: 'ses_main' });
  for (const id of ['cx', 'oc']) db.updateAgent(id, { lifecycle: 'active', activity: 'idle' });
});

after(() => {
  server.close();
  rmSync(home, { recursive: true, force: true });
});

// A Codex connection whose app-server answers from `app`.
const app = { terminals: [], threads: {}, onRead: null };
function conn() {
  const c = { next: 0, pending: new Map(), subscribed: true, ephemeral: new Set(), jobs: new Map(), ended: new Set(), reconciling: 0 };
  c.ws = {
    send(raw) {
      const m = JSON.parse(raw);
      const result =
        m.method === 'thread/backgroundTerminals/list' ? { data: app.terminals }
        : m.method === 'thread/loaded/list' ? { data: ['T', ...Object.keys(app.threads)] }
        : m.method === 'thread/read' ? (app.onRead?.(), 0) || { thread: app.threads[m.params.threadId] ?? { id: 'T', status: { type: 'idle' } } }
        : {};
      setImmediate(() => c.pending.get(m.id)?.resolve(result));
    },
  };
  return c;
}
const cmd = (id, status, command) => ({ type: 'commandExecution', id, status, command: `/bin/zsh -lc '${command}'`, commandActions: [{ type: 'unknown', command }], processId: '1' });
const sub = (kind, id) => ({ type: 'subAgentActivity', kind, agentThreadId: id, agentPath: '/root/sleeper' });

test('Codex: a background terminal and a sub-agent outliving the turn become job waits, each clearing as it ends', async () => {
  const c = conn();
  const n = (method, p) => codex.onNotification('cx', c, method, { threadId: 'T', ...p });
  db.updateAgent('cx', { activity: 'working' });
  n('item/started', { item: cmd('exec-bg', 'inProgress', 'sleep 30') });
  n('item/started', { item: cmd('exec-fg', 'inProgress', 'ls') });
  n('item/completed', { item: cmd('exec-fg', 'completed', 'ls') });
  n('item/started', { item: sub('started', 'S1') });
  app.terminals = [{ itemId: 'exec-bg', processId: '1', command: 'sleep 30' }];
  app.threads = { S1: { id: 'S1', parentThreadId: 'T', status: { type: 'active' } } };
  n('thread/status/changed', { status: { type: 'idle' } });
  assert.equal(activity('cx'), 'waiting');
  assert.equal(jobs('cx'), 'job:hook:S1 job:hook:exec-bg');
  assert.equal(db.listWaits('cx').find((w) => w.target === 'exec-bg').detail, 'background command "sleep 30"');
  await tick();
  assert.equal(jobs('cx'), 'job:hook:S1 job:hook:exec-bg', 'the app-server agrees');

  n('item/completed', { item: cmd('exec-bg', 'completed', 'sleep 30') });
  assert.equal(jobs('cx'), 'job:hook:S1');
  assert.equal(activity('cx'), 'waiting');
  n('item/completed', { item: sub('completed', 'S1') });
  assert.equal(activity('cx'), 'idle');
  assert.equal(jobs('cx'), '');
});

test("Codex: after a turn, work the app-server doesn't list any more is dropped", async () => {
  const c = conn();
  const n = (method, p) => codex.onNotification('cx', c, method, { threadId: 'T', ...p });
  db.updateAgent('cx', { activity: 'working' });
  n('item/started', { item: cmd('exec-lost', 'inProgress', 'make') });
  app.terminals = [];
  app.threads = {};
  n('thread/status/changed', { status: { type: 'idle' } });
  assert.equal(jobs('cx'), 'job:hook:exec-lost');
  await tick();
  assert.equal(jobs('cx'), '');
  assert.equal(activity('cx'), 'idle');
});

const ev = (type, data) => opencode.onEvent({ type, data });

test('OpenCode: background shells and sub-agents running when the execution ends become job waits; the completion turn clears them', () => {
  ev('session.execution.started', { sessionID: 'ses_main' });
  ev('shell.created', { info: { id: 'sh_bg', status: 'running', command: 'sleep 25', metadata: { sessionID: 'ses_main' } } });
  ev('shell.created', { info: { id: 'sh_fg', status: 'running', command: 'ls', metadata: { sessionID: 'ses_main' } } });
  ev('shell.exited', { id: 'sh_fg', exit: 0, status: 'exited' });
  ev('session.created', { sessionID: 'ses_child', parentID: 'ses_main', title: 'sleeper' });
  ev('session.execution.started', { sessionID: 'ses_child' });
  ev('shell.created', { info: { id: 'sh_child', status: 'running', command: 'sleep 40', metadata: { sessionID: 'ses_child' } } });
  ev('session.execution.succeeded', { sessionID: 'ses_main' });
  assert.equal(activity('oc'), 'waiting');
  assert.equal(jobs('oc'), 'job:hook:ses_child job:hook:sh_bg');
  assert.equal(db.getAgent('oc').activity_detail, 'waiting for background command "sleep 25" (+1 more)');

  // The shell ends: its wait stays until OpenCode's completion notice starts a turn.
  ev('shell.exited', { id: 'sh_bg', exit: 0, status: 'exited' });
  assert.equal(activity('oc'), 'waiting');
  ev('session.execution.started', { sessionID: 'ses_main' });
  assert.equal(activity('oc'), 'working');
  assert.equal(jobs('oc'), 'job:hook:ses_child');
  ev('session.execution.succeeded', { sessionID: 'ses_main' });
  assert.equal(jobs('oc'), 'job:hook:ses_child');

  ev('shell.exited', { id: 'sh_child', exit: 0, status: 'exited' });
  ev('session.execution.succeeded', { sessionID: 'ses_child' });
  ev('session.execution.started', { sessionID: 'ses_main' });
  ev('session.execution.succeeded', { sessionID: 'ses_main' });
  assert.equal(activity('oc'), 'idle');
  assert.equal(jobs('oc'), '');
});

test('OpenCode: connecting to the server reads what still runs, and drops waits for work a restarted server lost', async () => {
  oc.shells = [{ id: 'sh_seed', status: 'running', command: 'npm test', metadata: { sessionID: 'ses_main' } }];
  oc.children = [{ id: 'ses_kid', parentID: 'ses_main', title: 'helper' }];
  oc.active = { ses_kid: { type: 'running' } };
  await opencode.seedJobs();
  assert.equal(activity('oc'), 'waiting');
  assert.equal(jobs('oc'), 'job:hook:ses_kid job:hook:sh_seed');

  oc.shells = [];
  oc.active = {};
  await opencode.seedJobs();
  assert.equal(activity('oc'), 'idle');
  assert.equal(jobs('oc'), '');
});

test("Codex: a sub-agent's hooks (they carry agent_id) don't count as the agent's own", () => {
  const a = db.getAgent('cx');
  assert.deepEqual(codex.codex.onHook(a, { hook_event_name: 'PreToolUse', session_id: 'T', agent_id: 'S1', tool_name: 'Bash' }), {});
  assert.deepEqual(codex.codex.onHook(a, { hook_event_name: 'PostToolUse', session_id: 'T', agent_id: 'S1', tool_name: 'Bash' }), {});
  assert.equal(codex.codex.onHook(a, { hook_event_name: 'PreToolUse', session_id: 'T', tool_name: 'Bash' }).activity, 'working');
});

test("Codex: a job ending while a reconnect's reconcile is asking the app-server stays ended", async () => {
  const c = conn();
  const n = (method, p) => codex.onNotification('cx', c, method, { threadId: 'T', ...p });
  db.updateAgent('cx', { activity: 'working' });
  app.terminals = [{ itemId: 'exec-J', processId: '1', command: 'sleep 9' }];
  app.threads = { S9: { id: 'S9', parentThreadId: 'X', status: { type: 'idle' } } };
  app.onRead = () => {
    app.onRead = null;
    n('item/completed', { item: cmd('exec-J', 'completed', 'sleep 9') });
  };
  n('thread/status/changed', { status: { type: 'idle' } });
  await tick();
  assert.equal(jobs('cx'), '');
  assert.equal(activity('cx'), 'idle');
});

test("OpenCode: a child that finishes while the server is being read isn't revived by the read", async () => {
  oc.shells = [];
  oc.children = [{ id: 'ses_c', parentID: 'ses_main', title: 'late' }];
  oc.active = { ses_c: { type: 'running' } };
  oc.onChildren = () => {
    oc.onChildren = null;
    ev('session.execution.started', { sessionID: 'ses_c' });
    ev('session.execution.succeeded', { sessionID: 'ses_c' });
  };
  await opencode.seedJobs();
  assert.equal(jobs('oc'), '');
  assert.equal(activity('oc'), 'idle');
  ev('session.execution.started', { sessionID: 'ses_main' });
  ev('session.execution.succeeded', { sessionID: 'ses_main' });
  assert.equal(jobs('oc'), '', 'no wait comes back at the next turn');
});
