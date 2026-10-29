#!/usr/bin/env node
// S-578: `--force` reaches the archive action through every path that carries it: the CLI's
// `stam archive AGENT --force`, the MCP agent_control tool, and the peer-forwarding transport
// a remote agent's request travels on. A fake daemon on loopback records each call; no harness,
// no models, no network: `node --test test/archive-force.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-archive-force-');
process.env.STAM_HOME = home;
process.env.STAM_EMBEDDER = 'stub';
for (const k of ['STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const self = 'agent-force';

// A fake daemon that records the calls it receives and answers as the archive route does.
const calls = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    calls.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : undefined });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ agent: { name: 'x', id: 'x' }, result: 'done' }));
  });
});
let url;
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
  process.env.STAM_URL = url;
});
after(() => server.close());

// Run the real CLI and wait for it, keeping this process's event loop free so the fake daemon can
// answer: spawnSync would block the loop and the child would time out.
function cli(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--no-warnings', join(ROOT, 'src', 'cli.ts'), ...args], {
      env: { ...process.env, STAM_URL: url },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

test('the CLI sends force:true for `stam archive AGENT --force`', async () => {
  calls.length = 0;
  const p = await cli(['archive', 'x', '--force']);
  assert.equal(p.code, 0, p.err);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, '/api/agents/x/archive');
  assert.equal(calls[0].body.force, true);
});

test('the CLI sends no force for a plain `stam archive AGENT`', async () => {
  calls.length = 0;
  const p = await cli(['archive', 'x']);
  assert.equal(p.code, 0, p.err);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].body.force, 'force is unset without --force');
});

test('the CLI sends discard:true for `stam archive AGENT --discard`, and force for --force (S-1043)', async () => {
  calls.length = 0;
  const p = await cli(['archive', 'x', '--discard']);
  assert.equal(p.code, 0, p.err);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.discard, true);
  assert.ok(!calls[0].body.force, 'discard alone does not set force');

  calls.length = 0;
  await cli(['archive', 'x', '--force']);
  assert.equal(calls[0].body.force, true);
  assert.ok(!calls[0].body.discard, 'force is sent as force; the daemon implies discard from it');
});

test('agent_control sends force:true for an archive with force', async () => {
  calls.length = 0;
  const mcp = await import('../src/mcp.ts');
  const out = await mcp.callTool('agent_control', { self, agent: 'x', action: 'archive', force: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/agents/x/archive');
  assert.equal(calls[0].body.force, true);
  assert.equal(calls[0].body.by, self);
  assert.match(out.content[0].text, /x: done/);
});

test('agent_control without force sends none', async () => {
  calls.length = 0;
  const mcp = await import('../src/mcp.ts');
  await mcp.callTool('agent_control', { self, agent: 'x', action: 'archive' });
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].body.force);
});

test('agent_control carries discard for an archive (S-1043)', async () => {
  calls.length = 0;
  const mcp = await import('../src/mcp.ts');
  await mcp.callTool('agent_control', { self, agent: 'x', action: 'archive', discard: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.discard, true);
  assert.ok(!calls[0].body.force, 'discard alone does not set force');
});

test('the peer-forwarding transport carries force through unchanged', async () => {
  calls.length = 0;
  const { peerCall } = await import('../src/peers.ts');
  const peer = { name: 'twin', url, token: 'test-peer-token', peerToken: 'pt' };
  // The daemon forwards a remote agent's request through peerCall with the route's body as it is.
  const r = await peerCall(peer, 'POST', '/api/agents/x/archive', { by: self, force: true });
  assert.equal(r.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.force, true);
  assert.equal(calls[0].body.by, self);
});

test('the CLI sends force_unpushed:true for --force-unpushed, and none otherwise (S-2201)', async () => {
  calls.length = 0;
  const p = await cli(['archive', 'x', '--force-unpushed']);
  assert.equal(p.code, 0, p.err);
  assert.equal(calls[0].body.force_unpushed, true);
  assert.ok(!calls[0].body.force && !calls[0].body.discard, 'it implies neither force nor discard');
  calls.length = 0;
  await cli(['archive', 'x', '--force', '--discard']);
  assert.ok(!calls[0].body.force_unpushed, 'force and discard do not set it');
});

test('agent_control carries force_unpushed for an archive (S-2201)', async () => {
  calls.length = 0;
  const mcp = await import('../src/mcp.ts');
  await mcp.callTool('agent_control', { self, agent: 'x', action: 'archive', force_unpushed: true });
  assert.equal(calls[0].body.force_unpushed, true);
  assert.ok(!calls[0].body.force && !calls[0].body.discard);
  calls.length = 0;
  await mcp.callTool('agent_control', { self, agent: 'x', action: 'archive', force: true, discard: true });
  assert.ok(!calls[0].body.force_unpushed);
});
