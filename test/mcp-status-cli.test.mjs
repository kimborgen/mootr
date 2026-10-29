#!/usr/bin/env node
// `stam mcp status` prints a peer's local grant as a local login on this machine, not as not logged in (S-3178).
// A stub daemon answers the status route with fixed rows; no login or provider is contacted.
// Run with `node --test test/mcp-status-cli.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmphome.mjs';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

const PAGE = {
  servers: [
    { name: 'gh', type: 'gh', logged_in: true, expires_at: null },
    { name: 'remote', type: 'oauth', logged_in: false, expires_at: null, local_grant: true },
    { name: 'slack', type: 'oauth', logged_in: false, expires_at: null },
  ],
  home: { name: 'home-box', reachable: true },
};

test('stam mcp status marks a local grant as a local login on this machine', async () => {
  const server = createServer((req, res) => {
    res.writeHead(req.method === 'GET' && req.url === '/api/mcp/status' ? 200 : 500, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/api/mcp/status' ? PAGE : { error: 'stub' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const home = tempDir('stam-mcp-status-cli-');
  const env = { ...process.env, STAM_HOME: home, STAM_URL: `http://127.0.0.1:${server.address().port}`, STAM_TOKEN: 'test' };
  const out = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', CLI, 'mcp', 'status'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.on('data', (c) => (text += c));
    child.stderr.on('data', (c) => (text += c));
    child.on('error', reject);
    child.on('close', () => resolve(text));
  });
  server.close();
  rmSync(home, { recursive: true, force: true });
  const lines = out.split('\n');
  const line = (name) => lines.find((l) => l.startsWith(name.padEnd(16)));
  assert.match(line('remote'), /local login on this machine/, 'the local grant is marked');
  assert.doesNotMatch(line('remote'), /not logged in/, 'the local grant is not a plain logout');
  assert.match(line('slack'), /not logged in/, 'a row with no grant keeps the plain line');
  assert.match(line('gh'), /logged in/);
  assert.doesNotMatch(line('gh'), /not logged in/);
});
