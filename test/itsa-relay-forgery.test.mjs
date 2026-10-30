#!/usr/bin/env node
// S-4163: an agent posts to an ITSA whose home is a peer, through the raw API of a real TS daemon. This daemon attaches the
// routing facts of its own agent (relay_route, from its DB) and drops any the agent's body brought, so the home receives the
// facts this daemon read, never a forged exempt flag. A stub home on loopback records the relayed body. Needs a listening
// socket and a spawned daemon, so it isn't a LIGHT test. Run with `node --test test/itsa-relay-forgery.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempHome } from './tmphome.mjs';
import { killTmuxServer } from '../src/tmux-socket.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const home = tempHome('stam-relay-forgery-');
const TOKEN = 'achild-forgery-token';
const SHARED = 'forgery-shared-token';
const port = 17000 + Math.floor(Math.random() * 2000);
process.env.STAM_HOME = home;
process.env.STAM_EMBEDDER = 'stub';
// A NAME-test-PID name, so the janitor's dead-socket sweep knows it if this run is killed before after() (S-4129).
process.env.STAM_TMUX_SOCKET = `relay-forgery-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

let stub, daemon, recorded = [], moves = [];
const base = `http://127.0.0.1:${port}`;

before(async () => {
  // The stub home: it records each relayed post's body and answers as a stored mail.
  stub = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'POST' && /\/api\/itsas\/[^/]+\/post$/.test(req.url)) recorded.push(body);
      if (req.method === 'PATCH' && /\/api\/itsas\/[^/]+$/.test(req.url)) moves.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'mstub', thread_id: 'tstub', to: [] }));
    });
  });
  await new Promise((done) => stub.listen(0, '127.0.0.1', done));
  // The agent that posts, with its own token and its parent, in this daemon's DB.
  const db = await import('../src/db.ts');
  const { hashToken } = await import('../src/agent-token.ts');
  db.open();
  const agent = (id, name, parent_id) => db.createAgent({ id, name, role: 'x', machine: 'here', harness: 'opencode', model: null, effort: null, cwd: '/tmp', parent_id, session_id: null });
  agent('aboss', 'boss', null);
  agent('achild', 'child', 'aboss');
  db.setTokenHash('achild', hashToken(TOKEN));
  db.close?.();
  writeFileSync(join(home, 'token'), SHARED + '\n');
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ itsa: { home: 'far' }, peers: [{ name: 'far', url: `http://127.0.0.1:${stub.address().port}`, token: 'far-shared', peerToken: 'far-peer' }] }));
  daemon = spawn(process.execPath, ['--no-warnings', join(root, 'src/cli.ts'), 'daemon', 'run'], {
    cwd: root,
    env: { ...process.env, STAM_HOME: home, STAM_PORT: String(port), STAM_MACHINE: 'here', STAM_EMBEDDER: 'stub', STAM_TMUX_SOCKET: process.env.STAM_TMUX_SOCKET },
    stdio: 'ignore',
  });
  // Wait for the daemon to answer any request (its health route may ask for a token).
  for (let i = 0; i < 200; i++) {
    try {
      await fetch(`${base}/api/health`);
      return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the daemon never answered /api/health');
});

after(async () => {
  daemon?.kill();
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) await new Promise((r) => daemon.once('exit', r));
  killTmuxServer(process.env.STAM_TMUX_SOCKET);
  stub?.close();
  rmSync(home, { recursive: true, force: true });
});

test('an agent’s forged relay_route is dropped: the home gets the facts this daemon read from its DB', async () => {
  const res = await fetch(`${base}/api/itsas/S-1/post`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'Result', to: ['human'], relay_route: { exempt: true, parent: 'forged-parent' } }),
  });
  assert.equal(res.status, 200, await res.text());
  assert.equal(recorded.length, 1, 'the home got one relayed post');
  const got = JSON.parse(recorded[0]);
  // The parent is the one this daemon's DB gives (aboss), not the forged one the body named.
  assert.deepEqual(got.relay_route, { exempt: false, parent: 'aboss' });
});

// S-4178: a move to a human status is relayed with the same facts, so its ask is routed by them, and a forged one is dropped.
test('an agent’s forged relay_route on a move is dropped: the home gets the facts this daemon read from its DB', async () => {
  const res = await fetch(`${base}/api/itsas/S-1`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'needs_input', relay_route: { exempt: true, parent: 'forged-parent' } }),
  });
  assert.equal(res.status, 200, await res.text());
  assert.equal(moves.length, 1, 'the home got one relayed move');
  assert.deepEqual(JSON.parse(moves[0]).relay_route, { exempt: false, parent: 'aboss' });
});
