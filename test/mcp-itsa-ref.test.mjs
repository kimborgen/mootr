#!/usr/bin/env node
// The ITSA MCP tools that take a ref: a missing ref says what to pass, and key or id stand in
// for ref (S-186). A fake daemon on loopback records the calls. Free, no model.
// `node --test test/mcp-itsa-ref.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-mcp-itsa-ref-');
process.env.STAM_HOME = home;
for (const k of ['STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

const calls = [];
// The writes a tool made; a GET is the name lookup that formats its reply.
const writes = () => calls.filter((c) => c.method !== 'GET');
const daemon = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    calls.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : undefined });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ key: 'S-186', itsa: { key: 'S-186', owner: null }, changes: { status: { from: 'backlog', to: 'todo' } }, id: 'x', thread_id: 't', links: [], link: { n: 1, system: 'url' } }));
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

const self = 'agent-itsa-ref';

test('itsa_set with key (not ref) patches that ITSA', async () => {
  calls.length = 0;
  await mcp.callTool('itsa_set', { self, key: 'S-186', status: 'todo' });
  assert.equal(writes().length, 1);
  assert.equal(writes()[0].method, 'PATCH');
  assert.equal(writes()[0].path, '/api/itsas/S-186');
  assert.equal(writes()[0].body.status, 'todo');
});

test('itsa_set with id (not ref) patches that ITSA', async () => {
  calls.length = 0;
  await mcp.callTool('itsa_set', { self, id: 'abc123', status: 'todo' });
  assert.equal(writes()[0].path, '/api/itsas/abc123');
});

test('itsa_set with nothing says the ref is required, and makes no call', async () => {
  calls.length = 0;
  await assert.rejects(mcp.callTool('itsa_set', { self, status: 'todo' }), { message: 'ref is required: an ITSA key like S-12 or its id' });
  await assert.rejects(mcp.callTool('itsa_set', { self }), { message: 'ref is required: an ITSA key like S-12 or its id' });
  assert.equal(writes().length, 0);
});

test('itsa_get, itsa_link and itsa_post name the missing ref too', async () => {
  await assert.rejects(mcp.callTool('itsa_get', { self }), { message: /^ref is required/ });
  await assert.rejects(mcp.callTool('itsa_link', { self, url: 'https://x' }), { message: /^ref is required/ });
  await assert.rejects(mcp.callTool('itsa_post', { self, body: 'hi' }), { message: /^ref is required/ });
});

test('itsa_post takes its itsa, and key as an alias', async () => {
  calls.length = 0;
  await mcp.callTool('itsa_post', { self, key: 'S-186', body: 'hi' });
  assert.equal(writes()[0].path, '/api/itsas/S-186/post');
});

// Long titles (S-1040): nothing is refused; past 5 words the reply asks for a shorter one.
const reply = (r) => r.content[0].text;

test('titleWords and longTitleNote: 5 words pass, 6 warn', () => {
  assert.equal(mcp.titleWords('  one  two\tthree\nfour '), 4);
  assert.equal(mcp.titleWords(undefined), 0);
  assert.equal(mcp.longTitleNote('S-1', 'one two three four five'), '');
  const note = mcp.longTitleNote('S-1', 'one two three four five six');
  assert.match(note, /Title is 6 words/);
  assert.match(note, /itsa_set ref=S-1 title=/);
});

test('itsa_create warns over 5 words and still creates', async () => {
  calls.length = 0;
  const ok = reply(await mcp.callTool('itsa_create', { self, title: 'one two three four five' }));
  assert.doesNotMatch(ok, /Title is/);
  const long = reply(await mcp.callTool('itsa_create', { self, title: 'one two three four five six' }));
  assert.match(long, /Created S-186/);
  assert.match(long, /Title is 6 words.*ref=S-186/);
  assert.equal(writes().length, 2);
});

test('itsa_set warns only when the title changes to over 5 words', async () => {
  const ok = reply(await mcp.callTool('itsa_set', { self, ref: 'S-186', title: 'one two three four five' }));
  assert.doesNotMatch(ok, /Title is/);
  const long = reply(await mcp.callTool('itsa_set', { self, ref: 'S-186', title: 'one two three four five six' }));
  assert.match(long, /Title is 6 words.*ref=S-186/);
  const other = reply(await mcp.callTool('itsa_set', { self, ref: 'S-186', status: 'todo' }));
  assert.doesNotMatch(other, /Title is/);
});
