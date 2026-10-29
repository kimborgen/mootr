#!/usr/bin/env node
// The open ask an agent or ITSA waits on, in the text an agent reads (S-3982): find_agents carries it as open_ask (its mail
// to open it in, and its kind), and itsa_get names it on an `open ask:` line. Neither carries the ask's text. A fake daemon
// on loopback answers the agent list and two ITSA views with the detail the daemon attaches (src/daemon.ts itsaWithAsk,
// askDetail). The detail is the mail and kind only, so no ask text can reach the text. No harness, no models, no network: `node --test test/ask-text.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-ask-text-');
process.env.STAM_HOME = home;
process.env.STAM_EMBEDDER = 'stub';
for (const k of ['STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

const self = 'agent-reader';
const base = { role: 'developer', type: 'developer', lifecycle: 'active', machine: 'testbox', harness: 'claude-code', created_at: '2026-10-25T09:00:00.000Z', updated_at: '2026-10-25T09:00:00.000Z' };
const agents = [
  { ...base, id: 'agent-asking', name: 'asking-dev', activity: 'waiting', open_ask: 'request:p1', open_ask_detail: { mail: 'm-ask-1', kind: 'Permission' } },
  { ...base, id: 'agent-free', name: 'free-dev', activity: 'idle', open_ask: null, open_ask_detail: null },
];
const itsaView = (key, status, owner, detail) => ({
  id: `id-${key}`, key, title: `Fixture ${key}`, summary: null, body: null, kind: 'issue', status, owner, parent_chain: [], participants: [], links: [], children: [],
  rollup: null, fields: {}, open_ask: detail ? `itsa:id-${key}` : null, open_ask_detail: detail, created_at: base.created_at, updated_at: base.updated_at,
});
const itsas = {
  'S-7': itsaView('S-7', 'needs_approval', 'agent-asking', { mail: 'm-itsa-1', kind: 'ITSA' }),
  'S-8': itsaView('S-8', 'in_progress', 'agent-free', null),
};

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let body;
  if (url.pathname === '/api/agents') body = agents;
  else if (url.pathname.startsWith('/api/itsas/')) body = itsas[decodeURIComponent(url.pathname.slice('/api/itsas/'.length))] ?? null;
  else if (url.pathname.startsWith('/api/mail/linked/')) body = [];
  else body = null;
  res.writeHead(body === null ? 404 : 200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body ?? { error: 'not found' }));
});
let mcp;
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.STAM_URL = `http://127.0.0.1:${server.address().port}`;
  mcp = await import('../src/mcp.ts');
});
after(() => server.close());

test('find_agents carries the open ask of a blocked agent: its mail and kind', async () => {
  const out = await mcp.callTool('find_agents', { self });
  const list = JSON.parse(out.content[0].text);
  const asking = list.find((a) => a.name === 'asking-dev');
  assert.deepEqual(asking.open_ask, { mail: 'm-ask-1', kind: 'Permission' });
});

test('find_agents adds no open_ask to an agent with no open ask, and keeps its other fields', async () => {
  const out = await mcp.callTool('find_agents', { self });
  const free = JSON.parse(out.content[0].text).find((a) => a.name === 'free-dev');
  assert.equal('open_ask' in free, false);
  assert.equal(free.state, 'idle');
  assert.equal(free.role, 'developer');
});

test('itsa_get names the open ask on an open ask line, after the owner line', async () => {
  const out = await mcp.callTool('itsa_get', { self, ref: 'S-7' });
  const lines = out.content[0].text.split('\n');
  const at = lines.findIndex((l) => l.startsWith('open ask: '));
  assert.equal(lines[at], 'open ask: m-itsa-1 · ITSA');
  assert.ok(lines[at - 1].startsWith('owner: '), 'it sits after the owner line');
});

test('itsa_get has no open ask line when the ITSA holds no open ask', async () => {
  const out = await mcp.callTool('itsa_get', { self, ref: 'S-8' });
  assert.equal(out.content[0].text.includes('open ask'), false);
  assert.ok(out.content[0].text.startsWith('S-8 "Fixture S-8" [in_progress]'), 'the existing first line is unchanged');
});
