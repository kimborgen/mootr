#!/usr/bin/env node
// wait_for's parameter errors name the right parameter (S-302): on 'agent' without target says
// what target is; an unknown parameter (agent, from) is rejected by name, and never sent, so
// `from` is not read as the identity the request acts as. A fake daemon on loopback records the
// calls. Free, no model. `node --test test/mcp-wait-for.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-mcp-wait-for-');
process.env.STAM_HOME = home;
for (const k of ['STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

const calls = [];
const daemon = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    calls.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : undefined });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'w1', detail: 'reply from a96mw', until: null }));
  });
});
let mcp;
before(async () => {
  await new Promise((r) => daemon.listen(0, '127.0.0.1', r));
  process.env.STAM_URL = `http://127.0.0.1:${daemon.address().port}`;
  mcp = await import('../src/mcp.ts');
});
after(() => {
  daemon.close();
  rmSync(home, { recursive: true, force: true });
});

const self = 'agent-wait-for';

test("on 'agent' without target says target is needed, and makes no call", async () => {
  calls.length = 0;
  await assert.rejects(mcp.callTool('wait_for', { self, on: 'agent' }), { message: "wait_for on 'agent' needs target (an agent id or name)" });
  await assert.rejects(mcp.callTool('wait_for', { self, on: 'agent', note: 'x' }), { message: "wait_for on 'agent' needs target (an agent id or name)" });
  assert.equal(calls.length, 0);
});

test("an unknown 'agent' parameter is named, and says to use target; no call", async () => {
  calls.length = 0;
  await assert.rejects(mcp.callTool('wait_for', { self, on: 'agent', agent: 'cos' }), { message: /^wait_for has no parameter 'agent'; its parameters are on, target/ });
  assert.equal(calls.length, 0);
});

test("an unknown 'from' parameter is named, not read as the identity; no call", async () => {
  calls.length = 0;
  await assert.rejects(mcp.callTool('wait_for', { self, on: 'agent', target: 'a96mw', from: 'cos' }), { message: /^wait_for has no parameter 'from'/ });
  assert.equal(calls.length, 0);
});

test('several unknown parameters are all named', async () => {
  await assert.rejects(mcp.callTool('wait_for', { self, on: 'human', agent: 'x', from: 'y' }), { message: "wait_for has no parameter 'agent', 'from'; its parameters are on, target (the agent to wait for, an id or name), thread, filter, timeout_minutes, note" });
});

test("on 'agent' with target declares the wait; from is never sent to the daemon", async () => {
  calls.length = 0;
  await mcp.callTool('wait_for', { self, on: 'agent', target: 'a96mw', note: 'a reply', timeout_minutes: 5 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, `/api/agents/${self}/waits/declared`);
  assert.deepEqual(calls[0].body, { on: 'agent', target: 'a96mw', note: 'a reply', timeout_minutes: 5, by: self });
});
