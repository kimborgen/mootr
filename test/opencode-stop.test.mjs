#!/usr/bin/env node
// Unit tests for the OpenCode adapter's stop: a session in the shared OpenCode server is
// interrupted on shutdown, switch and archive, retried until the server no longer lists it as
// active, and an error is raised when it still runs. A stub server stands in for OpenCode on
// its own port; no daemon, no model: `node --test test/opencode-stop.test.mjs`.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-opencode-stop-');
const port = 45000 + (process.pid % 10000);
const socket = `opencode-stop-test-${process.pid}`;
process.env.STAM_HOME = home;
process.env.STAM_OPENCODE_PORT = String(port);
process.env.STAM_TMUX_SOCKET = socket;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID']) delete process.env[k];

// The stub: a session is active until it has been interrupted `needed` times; 'never' keeps it.
const server = { active: new Set(), needed: 1, interrupts: [], sid: null, prompts: [] };
const stub = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const send = (data) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data }));
    };
    const body = raw ? JSON.parse(raw) : {};
    const m = req.url.match(/^\/api\/session\/([^/]+)\/interrupt$/);
    if (req.method === 'POST' && m) {
      server.interrupts.push(m[1]);
      const n = server.interrupts.filter((s) => s === m[1]).length;
      if (server.needed !== 'never' && n >= server.needed) server.active.delete(m[1]);
      return send({});
    }
    const p = req.url.match(/^\/api\/session\/([^/]+)\/prompt$/);
    if (req.method === 'POST' && p) {
      server.prompts.push({ sid: p[1], ...body });
      return send({});
    }
    if (req.method === 'GET' && req.url === '/api/session/active') {
      return send(Object.fromEntries([...server.active].map((s) => [s, { id: s }])));
    }
    if (req.method === 'GET' && req.url === '/openapi.json') return send({});
    res.writeHead(404);
    res.end();
  });
});

let db, lifecycle, opencode, tmux;
before(async () => {
  await new Promise((r) => stub.listen(port, '127.0.0.1', r));
  db = await import('../src/db.ts');
  lifecycle = await import('../src/lifecycle.ts');
  tmux = await import('../src/tmux.ts');
  ({ opencode } = await import('../src/adapters/opencode.ts'));
});
after(() => {
  stub.close();
  spawnSync('tmux', ['-L', socket, 'kill-server']);
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => {
  server.active = new Set(['ses_busy']);
  server.needed = 1;
  server.interrupts = [];
  server.prompts = [];
});

function agent(name, fields = {}) {
  const id = db.newAgentId();
  db.createAgent({ id, name, role: 'role', machine: 'test', harness: 'opencode', model: null, effort: null, cwd: home, parent_id: null, session_id: 'ses_busy', ...fields });
  db.updateAgent(id, { activity: 'working' });
  return db.getAgent(id);
}

test('interrupt confirms that the server no longer lists the session as active', async () => {
  assert.equal(await opencode.interrupt(agent('one')), true);
  assert.deepEqual(server.interrupts, ['ses_busy']);
  assert.equal(server.active.has('ses_busy'), false);
});

test('stop retries the interrupt until the session stops, then returns', async () => {
  server.needed = 3;
  await opencode.stop(agent('two'));
  assert.equal(server.interrupts.length, 3);
  assert.equal(server.active.has('ses_busy'), false);
});

test('stop throws when the session still runs after its attempts', async () => {
  server.needed = 'never';
  await assert.rejects(opencode.stop(agent('three')), /still runs/);
  assert.ok(server.interrupts.length >= 2, 'it retried');
});

test('shutting an OpenCode agent down interrupts its session in the shared server', async () => {
  server.active.add('ses_four');
  const a = agent('four', { session_id: 'ses_four' });
  await lifecycle.shutdown(a, true);
  assert.equal(db.getAgent(a.id).lifecycle, 'shut_down');
  // stopTurn runs in the background; wait for its confirmed interrupt.
  for (let i = 0; i < 100 && server.active.has('ses_four'); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(server.active.has('ses_four'), false);
  assert.ok(server.interrupts.length >= 1);
});

test('a delayed interrupt is settled before a resumed agent runs: no interrupt reaches the new turn', async () => {
  server.needed = 'never';
  server.active.add('ses_five');
  const a = agent('five', { session_id: 'ses_five' });
  await lifecycle.shutdown(a, true);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(server.interrupts.length, 1, 'the stop interrupted once while the agent was shut down');
  // A resume (or a failed switch's rollback) settles the stop first: it gives up before its next interrupt.
  const t0 = Date.now();
  await lifecycle.releaseTurnStop(db.getAgent(a.id));
  assert.ok(Date.now() - t0 < 4000, 'the release waits only for the stop to give up');
  const after = server.interrupts.length;
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal(server.interrupts.length, after, 'no interrupt after the agent runs again');
});

test('overlapping stops for one session share one loop, and archive waits for its confirmed stop', async () => {
  server.needed = 2;
  server.active.add('ses_six');
  const a = agent('six', { session_id: 'ses_six' });
  await lifecycle.shutdown(a, true);
  // Archive asks for the same session's stop again: it joins the one in flight.
  await lifecycle.archive(db.getAgent(a.id));
  assert.equal(db.getAgent(a.id).lifecycle, 'archived');
  assert.equal(server.interrupts.filter((x) => x === 'ses_six').length, 2, 'one loop: two interrupts in all');
  assert.equal(server.active.has('ses_six'), false);
});

test('archive refuses while the session still runs, and leaves the agent shut down', async () => {
  server.needed = 'never';
  server.active.add('ses_seven');
  const a = agent('seven', { session_id: 'ses_seven' });
  await lifecycle.shutdown(a, true);
  await assert.rejects(lifecycle.archive(db.getAgent(a.id)), /can't archive seven: its session still runs/);
  assert.equal(db.getAgent(a.id).lifecycle, 'shut_down');
});

test('a stop given up is not a confirmed stop, and a later shutdown gets its own loop', async () => {
  server.needed = 'never';
  server.active.add('ses_eight');
  const a = agent('eight', { session_id: 'ses_eight' });
  await lifecycle.shutdown(a, true);
  await new Promise((r) => setTimeout(r, 300));
  const waiting = lifecycle.awaitTurnStop(db.getAgent(a.id));
  await lifecycle.releaseTurnStop(db.getAgent(a.id));
  await assert.rejects(waiting, /resumed before its session stopped/);
  // Shut down again: a new loop interrupts and confirms.
  server.needed = 1;
  server.active.add('ses_eight');
  const before = server.interrupts.length;
  await lifecycle.shutdown(db.getAgent(a.id), true);
  await lifecycle.awaitTurnStop(db.getAgent(a.id));
  assert.ok(server.interrupts.length > before, 'the new shutdown interrupted');
  assert.equal(server.active.has('ses_eight'), false);
});

test('a resume is refused while an archive of the agent waits for its session to stop', async () => {
  server.needed = 'never';
  server.active.add('ses_nine');
  const a = agent('nine', { session_id: 'ses_nine' });
  await lifecycle.shutdown(a, true);
  const archiving = lifecycle.archive(db.getAgent(a.id));
  await new Promise((r) => setTimeout(r, 100));
  await assert.rejects(lifecycle.resume(db.getAgent(a.id)), /is being archived/);
  await assert.rejects(archiving, /can't archive nine: its session still runs/);
  assert.equal(db.getAgent(a.id).lifecycle, 'shut_down');
});

test('an idle OpenCode agent gets the archive wrap-up queued on its session, and archives on its next turn end (S-1043)', async () => {
  server.active = new Set(); // its session is idle: no turn to wait for
  const a = agent('ten', { session_id: 'ses_ten' });
  db.updateAgent(a.id, { activity: 'idle', workspace: JSON.stringify({ spec: { kind: 'dir', path: home }, cwd: home }) });
  tmux.newSession(a.id, home, {}, ['sleep', '600']);
  assert.equal(lifecycle.harnessRunning(db.getAgent(a.id)), true, 'a live pane, so the archive asks rather than runs at once');
  const r = await lifecycle.archive(db.getAgent(a.id), false);
  assert.match(r, /waiting for .* to finish its step/);
  assert.equal(db.getAgent(a.id).lifecycle, 'active', 'it is not archived before the final round');
  const queued = server.prompts.filter((p) => p.sid === 'ses_ten');
  assert.equal(queued.length, 1, 'the wrap-up went to the session through the server prompt API');
  assert.match(queued[0].text, /final: true/, 'and it is the archive wrap-up, with the final retro round');
  // Its next turn ends: the pending archive runs and interrupts the idle session.
  await lifecycle.onIdle(a.id);
  assert.equal(db.getAgent(a.id).lifecycle, 'archived');
  assert.ok(server.interrupts.includes('ses_ten'), 'the archive interrupted the session');
});
