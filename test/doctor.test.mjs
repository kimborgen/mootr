#!/usr/bin/env node
// Unit test for `stam doctor` (S-2894): a fake PATH and a temp STAM_HOME, no daemon. A missing tool fails with its fix
// line, a free port passes, --json has the right shape, and the exit code follows the failures.
// `node --test test/doctor.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer as createHttp } from 'node:http';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmphome.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const tools = (dir, names) => {
  mkdirSync(dir, { recursive: true });
  for (const n of names) {
    writeFileSync(join(dir, n), '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, n), 0o755);
  }
};
const freePort = () =>
  new Promise((ok) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

// Runs the CLI with only the fake bin folder on PATH and node by absolute path, so nothing real is found.
async function run(names, args = [], extra = {}) {
  const tmp = tempDir('stam-test.doctor.');
  const bin = join(tmp, 'bin');
  tools(bin, names);
  const home = join(tmp, 'home');
  mkdirSync(home);
  const port = await freePort();
  const env = { PATH: bin, HOME: tmp, STAM_HOME: home, STAM_PORT: String(port), ...extra };
  const r = spawnSync(process.execPath, [join(ROOT, 'src/cli.ts'), 'doctor', ...args], { env, encoding: 'utf8' });
  return { ...r, port };
}

test('a missing tool fails with its fix line and exits 1', async () => {
  const r = await run(['git', 'claude']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^fail {2}tmux is not on PATH$/m);
  assert.match(r.stdout, /fix: install tmux/);
  assert.match(r.stdout, /^ok {4}git at /m);
  assert.match(r.stdout, /^warn {2}gh is not on PATH/m);
});

test('a free port and a writable home pass; all required present exits 0', async () => {
  const r = await run(['git', 'tmux', 'codex']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`^ok {4}port ${r.port} is free$`, 'm'));
  assert.match(r.stdout, /is writable$/m);
  assert.match(r.stdout, /harness installed: codex/);
});

test('no harness fails', async () => {
  const r = await run(['git', 'tmux']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^fail {2}no harness is installed/m);
});

test('--json has the report shape', async () => {
  const r = await run(['tmux'], ['--json']);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, false);
  assert.equal(r.status, 1);
  const ids = j.checks.map((c) => c.id);
  for (const id of ['node', 'tmux', 'git', 'harness', 'home', 'port']) assert.ok(ids.includes(id), id);
  const git = j.checks.find((c) => c.id === 'git');
  assert.equal(git.status, 'fail');
  assert.ok(git.fix);
  for (const c of j.checks) assert.ok(['ok', 'warn', 'fail'].includes(c.status));
});

test('a port held by something else fails', async () => {
  const held = createServer();
  await new Promise((ok) => held.listen(0, '127.0.0.1', ok));
  const port = held.address().port;
  try {
    const tmp = tempDir('stam-test.doctor.');
    const bin = join(tmp, 'bin');
    tools(bin, ['git', 'tmux', 'claude']);
    // spawnSync would block this process's event loop, so the held server could not answer the health probe.
    const out = await new Promise((ok) => {
      const c = spawn(process.execPath, [join(ROOT, 'src/cli.ts'), 'doctor'], { env: { PATH: bin, HOME: tmp, STAM_HOME: tmp, STAM_PORT: String(port) } });
      let stdout = '';
      c.stdout.on('data', (d) => (stdout += d));
      c.on('close', (code) => ok({ code, stdout }));
    });
    assert.equal(out.code, 1);
    assert.match(out.stdout, new RegExp(`fail {2}port ${port} is in use`));
  } finally {
    held.close();
  }
});

test('MOOTR_PORT wins over STAM_PORT', async () => {
  const mootr = await freePort();
  const r = await run(['git', 'tmux', 'claude'], [], { MOOTR_PORT: String(mootr) });
  assert.match(r.stdout, new RegExp(`port ${mootr} is free`));
});

// A stand-in daemon: /api/health and /api/onboarding answer only with the right bearer, as the real one does (401 else).
const TOKEN = 'doctor-test-token-not-a-secret';
async function stubDaemon() {
  const srv = createHttp((req, res) => {
    const authed = req.headers.authorization === `Bearer ${TOKEN}`;
    res.setHeader('content-type', 'application/json');
    if (!authed) return res.writeHead(401).end(JSON.stringify({ error: 'unauthorized' }));
    if (req.url === '/api/health') return res.end(JSON.stringify({ ok: true, release: 'test' }));
    if (req.url === '/api/onboarding') return res.end(JSON.stringify({ gaps: ['no repo is configured', 'no chief of staff is running'] }));
    res.writeHead(404).end('{}');
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  return srv;
}
const runAsync = (env, args = []) =>
  new Promise((ok) => {
    const c = spawn(process.execPath, [join(ROOT, 'src/cli.ts'), 'doctor', ...args], { env });
    let stdout = '';
    c.stdout.on('data', (d) => (stdout += d));
    c.on('close', (code) => ok({ code, stdout }));
  });

async function withStub(extraEnv, body) {
  const srv = await stubDaemon();
  const port = srv.address().port;
  try {
    const tmp = tempDir('stam-test.doctor.');
    const bin = join(tmp, 'bin');
    tools(bin, ['git', 'tmux', 'claude']);
    writeFileSync(join(tmp, 'token'), TOKEN);
    await body(await runAsync({ PATH: bin, HOME: tmp, STAM_HOME: tmp, STAM_PORT: String(port), ...extraEnv(port, await freePort()) }, ['--json']), port);
  } finally {
    srv.close();
  }
}

test('a live daemon is probed with the token: serving stam, its gaps as warnings, exit 0, no token printed', async () => {
  await withStub(() => ({}), (out, port) => {
    assert.equal(out.code, 0, out.stdout);
    assert.ok(!out.stdout.includes(TOKEN));
    const j = JSON.parse(out.stdout);
    assert.equal(j.ok, true);
    assert.deepEqual(j.checks.find((c) => c.id === 'port'), { id: 'port', status: 'ok', message: `port ${port} is serving stam` });
    const gaps = j.checks.filter((c) => c.id === 'onboarding');
    assert.deepEqual(gaps.map((c) => [c.status, c.message]), [['warn', 'no repo is configured'], ['warn', 'no chief of staff is running']]);
  });
});

test('a daemon that refuses the token is a warning, not a foreign port', async () => {
  const srv = await stubDaemon();
  try {
    const tmp = tempDir('stam-test.doctor.');
    const bin = join(tmp, 'bin');
    tools(bin, ['git', 'tmux', 'claude']);
    writeFileSync(join(tmp, 'token'), 'wrong');
    const out = await runAsync({ PATH: bin, HOME: tmp, STAM_HOME: tmp, STAM_PORT: String(srv.address().port) });
    assert.equal(out.code, 0, out.stdout);
    assert.match(out.stdout, /^warn {2}a daemon answers at .* refused this CLI's token$/m);
  } finally {
    srv.close();
  }
});

test('STAM_URL on another port is checked as that daemon, not as the local port', async () => {
  await withStub((stub, other) => ({ STAM_URL: `http://127.0.0.1:${stub}`, STAM_PORT: String(other) }), (out, port) => {
    assert.equal(out.code, 0, out.stdout);
    const j = JSON.parse(out.stdout);
    assert.equal(j.checks.find((c) => c.id === 'port').message, `the daemon at http://127.0.0.1:${port} is serving stam`);
  });
});
