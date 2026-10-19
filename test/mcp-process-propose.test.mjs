#!/usr/bin/env node
// The process_propose tool (S-1085): it posts the process, YAML, summary and base to the proposal route as the
// calling agent, answers the ITSA key and PR url, and shows a refusal readably. A fake daemon on loopback; free, no model.
// `node --test test/mcp-process-propose.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-mcp-process-propose-');
process.env.STAM_HOME = home;
for (const k of ['STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

const calls = [];
let reply = { status: 200, json: { key: 'S-901', id: 'x', pr: { number: 12, url: 'https://github.com/example/stam2/pull/12' }, branch: 'process/demo-1' } };
const daemon = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    calls.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : undefined });
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.json));
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

const self = 'agent-proposer';

test('a proposal goes to the process route as the calling agent, and answers the key and PR url', async () => {
  calls.length = 0;
  const r = await mcp.callTool('process_propose', { self, id: 'demo', yaml: 'process: demo\n', summary: 'Why', base: '' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, '/api/processes/demo/proposal');
  assert.deepEqual(calls[0].body, { yaml: 'process: demo\n', summary: 'Why', base: '', by: self });
  const out = JSON.stringify(r);
  assert.match(out, /S-901/);
  assert.match(out, /pull\/12/);
});

test('base is required, and a refusal reads as the daemon said it', async () => {
  calls.length = 0;
  await assert.rejects(mcp.callTool('process_propose', { self, id: 'demo', yaml: 'x', summary: 'Why' }), /base/);
  assert.equal(calls.length, 0);
  reply = { status: 409, json: { error: 'processes/demo.yaml on main changed after you opened the editor' } };
  await assert.rejects(mcp.callTool('process_propose', { self, id: 'demo', yaml: 'x', summary: 'Why', base: 'old' }), /changed after you opened/);
});
