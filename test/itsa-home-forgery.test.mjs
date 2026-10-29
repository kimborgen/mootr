#!/usr/bin/env node
// S-4178: a daemon that is itself the ITSA home refuses a move whose body carries relay_route from an agent's own token: only a
// peer's daemon relays the routing facts (daemon.ts proxy), so an agent can't claim to be exempt on its own home. Needs a listening
// socket and a spawned daemon, so it isn't a LIGHT test. Run with `node --test test/itsa-home-forgery.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempHome } from './tmphome.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const home = tempHome('stam-home-forgery-');
const TOKEN = 'ahome-forgery-token';
const port = 19000 + Math.floor(Math.random() * 1000);
process.env.STAM_HOME = home;
process.env.STAM_EMBEDDER = 'stub';
process.env.STAM_TMUX_SOCKET = `home-forgery-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

let daemon;
const base = `http://127.0.0.1:${port}`;

before(async () => {
  // The agent whose token makes the move: a row here, with its token hash.
  const db = await import('../src/db.ts');
  const { hashToken } = await import('../src/agent-token.ts');
  db.open();
  db.createAgent({ id: 'ahome', name: 'home-agent', role: 'x', machine: 'here', harness: 'opencode', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  db.setTokenHash('ahome', hashToken(TOKEN));
  db.close?.();
  writeFileSync(join(home, 'token'), 'home-forgery-shared\n');
  daemon = spawn(process.execPath, ['--no-warnings', join(root, 'src/cli.ts'), 'daemon', 'run'], {
    cwd: root,
    env: { ...process.env, STAM_HOME: home, STAM_PORT: String(port), STAM_MACHINE: 'here', STAM_EMBEDDER: 'stub', STAM_TMUX_SOCKET: process.env.STAM_TMUX_SOCKET },
    stdio: 'ignore',
  });
  for (let i = 0; i < 200; i++) {
    try {
      await fetch(`${base}/api/health`);
      return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the daemon never answered /api/health');
});

after(() => {
  daemon?.kill();
  rmSync(home, { recursive: true, force: true });
});

test('an agent’s move to the home with relay_route in its own body is refused, not routed by it', async () => {
  const res = await fetch(`${base}/api/itsas/S-1`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'needs_input', relay_route: { exempt: true, parent: 'forged-parent' } }),
  });
  const text = await res.text();
  assert.equal(res.status, 403, text);
  assert.match(text, /set only by stam/);
});
