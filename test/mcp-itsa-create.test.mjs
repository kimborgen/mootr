#!/usr/bin/env node
// itsa_create makes the creator a participant only through owning the ITSA (S-586): the daemon
// adds the owner, so the tool must not add the creator when it hands the ITSA on or leaves it
// ownerless. A fake daemon on loopback records the create. Free, no model.
// `node --test test/mcp-itsa-create.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-mcp-itsa-create-');
process.env.STAM_HOME = home;
for (const k of ['STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

const calls = [];
const daemon = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    calls.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : undefined });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ key: 'S-900', title: 'Make it', status: 'backlog', owner: null, id: 'x' }));
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

const self = 'agent-creator';
const post = () => calls.filter((c) => c.method === 'POST' && c.path === '/api/itsas');

test('a creator with no owner is not a participant', async () => {
  calls.length = 0;
  await mcp.callTool('itsa_create', { self, title: 'Make it' });
  assert.equal(post().length, 1);
  assert.deepEqual(post()[0].body.participants, []);
  assert.equal(post()[0].body.owner, undefined);
});

test('a creator that hands the ITSA to another owner is not a participant', async () => {
  calls.length = 0;
  await mcp.callTool('itsa_create', { self, title: 'Hand it on', owner: 'agent-other' });
  assert.equal(post()[0].body.owner, 'agent-other');
  assert.ok(!post()[0].body.participants.includes(self), 'the creator joined a ITSA it does not own');
});

test('a creator that owns the ITSA sends it as owner, and the daemon makes the owner a participant', async () => {
  calls.length = 0;
  await mcp.callTool('itsa_create', { self, title: 'Own it', owner: self });
  assert.equal(post()[0].body.owner, self);
  assert.deepEqual(post()[0].body.participants, [], 'the tool leaves the owner for the daemon to add');
});

test('listed participants still go through, and the creator is not added to them', async () => {
  calls.length = 0;
  await mcp.callTool('itsa_create', { self, title: 'Watchers', owner: 'agent-other', participants: ['agent-watch'] });
  assert.deepEqual(post()[0].body.participants, ['agent-watch']);
});
