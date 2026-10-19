#!/usr/bin/env node
// ring_submit refuses a parameter it doesn't know (a `body` for `text`) and a submission with no
// findings text, at the MCP tool and at the ring itself (S-1919). A fake daemon on loopback records
// the calls; the ring check runs with a throwaway STAM_HOME. Free, no model.
// `node --test test/mcp-ring-submit.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-mcp-ring-submit-');
process.env.STAM_HOME = home;
for (const k of ['STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

const calls = [];
const daemon = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    calls.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : undefined });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ result: 'Submitted. Waiting for the other members.' }));
  });
});
let mcp;
let ring;
before(async () => {
  await new Promise((r) => daemon.listen(0, '127.0.0.1', r));
  process.env.STAM_URL = `http://127.0.0.1:${daemon.address().port}`;
  mcp = await import('../src/mcp.ts');
  ring = await import('../src/ring.ts');
});
after(() => {
  daemon.close();
  rmSync(home, { recursive: true, force: true });
});

const self = 'agent-ring-submit';
const base = { self, ring: 'rev-613e', agree: false, verdict: 'request_changes' };
const BLANK = { message: 'text is required: your findings for the ring, as a non-empty string' };

test('a body for text is refused, names text, and makes no call', async () => {
  calls.length = 0;
  await assert.rejects(mcp.callTool('ring_submit', { ...base, body: 'Two findings.' }), { message: 'ring_submit has no parameter body: put your findings in text' });
  assert.equal(calls.length, 0);
});

test('a missing, empty or blank text is refused and makes no call', async () => {
  calls.length = 0;
  await assert.rejects(mcp.callTool('ring_submit', { ...base }), BLANK);
  await assert.rejects(mcp.callTool('ring_submit', { ...base, text: '' }), BLANK);
  await assert.rejects(mcp.callTool('ring_submit', { ...base, text: ' \n\t ' }), BLANK);
  await assert.rejects(mcp.callTool('ring_submit', { ...base, text: 42 }), BLANK);
  assert.equal(calls.length, 0);
});

test('a submission with text posts it to the ring and returns the daemon result', async () => {
  calls.length = 0;
  const out = await mcp.callTool('ring_submit', { ...base, text: 'Finding 1: the cap is off by one.' });
  assert.equal(out.content[0].text, 'Submitted. Waiting for the other members.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, '/api/rings/rev-613e/submit');
  assert.deepEqual(calls[0].body, { by: self, text: 'Finding 1: the cap is off by one.', agree: false, verdict: 'request_changes' });
});

test('the ring refuses blank text before it looks the ring up', () => {
  assert.throws(() => ring.submit('no-such-ring', 'agent', '  ', false), BLANK);
  assert.throws(() => ring.submit('no-such-ring', 'agent', '', true), BLANK);
});
