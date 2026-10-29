#!/usr/bin/env node
// Client tests for the answer-notice ack (S-3923): the hook client acks the notice rows its response carried only once the
// response is printed in full. Both clients run here, bin/stam-fast (the shell path) and src/cli.ts (the node path), each
// against a stub daemon that answers the hook with a response carrying one row and records every ack it gets. A stdout
// whose write fails (/dev/full: ENOSPC) must send no ack, and a printed one must. Daemon-free: the stub is this file's own
// server. Run with `node --test test/answer-notice-client.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, openSync, closeSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir, tempHome } from './tmphome.mjs';

const home = tempHome('stam-answer-notice-client-');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const AGENT = 'ag-client';
const ROW = 7;
const HOOK = `/api/hook/claude/${AGENT}`;
const ACK = `/api/notices/${AGENT}/ack/${ROW}`;

// The stub daemon: the hook answers with the text and the row; each request it gets is recorded by its path.
let seen = [];
const daemon = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seen.push(req.url);
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === HOOK) return res.end(JSON.stringify({ stdout: 'a denial\n', ack: [ROW] }));
    if (req.method === 'POST' && req.url === ACK) return res.end('{}');
    res.statusCode = 404;
    res.end('{}');
  });
});

let port;
before(async () => {
  await new Promise((r) => daemon.listen(0, '127.0.0.1', r));
  port = daemon.address().port;
});
after(() => {
  daemon.close();
});

// One hook run by a client, async so the stub daemon in this process can answer it. `stdout` is a path opened as the
// client's stdout ('/dev/full' fails every write); without it, stdout is a pipe that is read back. `env` adds variables,
// and `umask` runs the shell client under umask 022.
async function hook(client, stdout, { env: extra = {}, umask = false } = {}) {
  seen = [];
  const env = { ...process.env, STAM_URL: `http://127.0.0.1:${port}`, STAM_TOKEN: 'test-token', STAM_AGENT_ID: AGENT, STAM_HOME: home, ...extra };
  for (const k of ['MOOTR_URL', 'MOOTR_PORT', 'MOOTR_TOKEN', 'MOOTR_AGENT_ID', 'MOOTR_HOME', 'STAM_PORT']) delete env[k];
  const fd = stdout ? openSync(stdout, 'w') : 'pipe';
  const shell = umask ? ['sh', ['-c', 'umask 022; exec sh "$0" "$@"', `${ROOT}bin/stam-fast`, 'hook', 'claude']] : ['sh', [`${ROOT}bin/stam-fast`, 'hook', 'claude']];
  const [cmd, args] = client === 'stam-fast' ? shell : [process.execPath, [`${ROOT}src/cli.ts`, 'hook', 'claude']];
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { env, stdio: ['pipe', fd, 'pipe'] });
      let out = '';
      let err = '';
      child.stdout?.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (err += c));
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout: out, stderr: err, hooked: seen.includes(HOOK), acks: seen.filter((p) => p === ACK) }));
      child.stdin.end('{}');
    });
  } finally {
    if (stdout) closeSync(fd);
  }
}

test('stam-fast: a response printed in full is acked', async () => {
  const r = await hook('stam-fast');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.hooked, 'the hook reached the stub daemon');
  assert.equal(r.stdout, 'a denial\n');
  assert.deepEqual(r.acks, [ACK]);
});

test('stam-fast: a response whose print fails (full stdout) is not acked, so its row stays', async () => {
  const r = await hook('stam-fast', '/dev/full');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.hooked, 'the hook reached the stub daemon');
  assert.deepEqual(r.acks, []);
});

test('cli: a response printed in full is acked', async () => {
  const r = await hook('cli');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.hooked, 'the hook reached the stub daemon');
  assert.equal(r.stdout, 'a denial\n');
  assert.deepEqual(r.acks, [ACK]);
});

test('cli: a response whose print fails (full stdout) is not acked, so its row stays', async () => {
  const r = await hook('cli', '/dev/full');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.hooked, 'the hook reached the stub daemon');
  assert.deepEqual(r.acks, []);
});

// The printed text holds the notices, so its file is private: a fake `cat` logs the mode of each stam-hook file it is
// given (the printed one), under umask 022. The file is 0600 then, and the temp folder is empty after the hook exits.
test('stam-fast: the printed text is a private file (0600) under umask 022, and is removed on exit', async () => {
  const tmp = tempDir('stam-hook-tmp-');
  const fake = tempDir('stam-fake-cat-');
  const log = join(fake, 'modes.log');
  writeFileSync(join(fake, 'cat'), `#!/bin/sh\nfor a in "$@"; do case "$a" in *stam-hook.*) stat -c %a "$a" >> '${log}' ;; esac; done\nexec /bin/cat "$@"\n`, { mode: 0o755 });
  const r = await hook('stam-fast', undefined, { umask: true, env: { PATH: `${fake}:${process.env.PATH}`, TMPDIR: tmp } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.hooked, 'the hook reached the stub daemon');
  assert.deepEqual(r.acks, [ACK]);
  // The fake ran and logged the printed file's mode; a missing or empty log fails here, before the mode is compared.
  const modes = existsSync(log) ? readFileSync(log, 'utf8').trim() : '';
  assert.notEqual(modes, '', 'the fake cat logged no stam-hook file');
  assert.equal(modes, '600');
  assert.deepEqual(readdirSync(tmp), []);
});
