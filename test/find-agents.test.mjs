#!/usr/bin/env node
// S-875: `find_agents` without a query lists the live agents (active, paused and shut down) and
// leaves archived ones out. A query leaves archived ones out too, unless it is exactly an agent's
// id or name. `state` overrides both. Each agent carries its type. A fake daemon on loopback
// answers the agent list, filtering `q` as the real search does; no harness, no models, no
// network: `node --test test/find-agents.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-find-agents-');
process.env.STAM_HOME = home;
process.env.STAM_EMBEDDER = 'stub';
for (const k of ['STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

const self = 'agent-finder';
const agents = [
  { id: 'agent-live', name: 'live-dev', role: 'developer', type: 'developer', lifecycle: 'active', activity: 'idle', machine: 'testbox', harness: 'claude-code' },
  { id: 'agent-paused', name: 'paused-dev', role: 'developer', type: 'developer', lifecycle: 'paused', activity: 'idle', machine: 'testbox', harness: 'claude-code' },
  { id: 'agent-stopped', name: 'stopped-dev', role: 'developer', type: 'developer', lifecycle: 'shut_down', activity: 'idle', machine: 'testbox', harness: 'claude-code' },
  { id: 'agent-old', name: 'old-dev', role: 'developer', type: 'reviewer', lifecycle: 'archived', activity: 'idle', machine: 'testbox', harness: 'codex' },
];

const { listFilter } = await import('../src/agent-public.ts');
// The daemon's search: `q` matches the id or a name or role containing it, as db.searchAgents does, and `state` and
// `ids` pick the lifecycles as the route does (S-3816). With `filtering` off it is an older daemon that lists them all.
let filtering = true;
const asked = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  asked.push(url.searchParams);
  const q = url.searchParams.get('q');
  const found = q ? agents.filter((a) => a.id === q || a.name.includes(q) || a.role.includes(q)) : agents;
  const list = filtering ? found.filter(listFilter(url.searchParams.get('state'), url.searchParams.get('ids'))) : found;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(list));
});
let mcp;
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.STAM_URL = `http://127.0.0.1:${server.address().port}`;
  mcp = await import('../src/mcp.ts');
});
after(() => server.close());

async function find(args) {
  const out = await mcp.callTool('find_agents', { self, ...args });
  return JSON.parse(out.content[0].text);
}

test('a no-query listing omits an archived agent and keeps paused and shut-down ones', async () => {
  const list = await find({});
  assert.deepEqual(list.map((a) => a.name), ['live-dev', 'paused-dev', 'stopped-dev']);
});

test('state "all" includes an archived agent', async () => {
  const list = await find({ state: 'all' });
  assert.deepEqual(list.map((a) => a.name), ['live-dev', 'paused-dev', 'stopped-dev', 'old-dev']);
});

test('state "archived" lists only the archived agents', async () => {
  const list = await find({ state: 'archived' });
  assert.deepEqual(list.map((a) => a.name), ['old-dev']);
});

test('an exact-name query finds an archived agent', async () => {
  const list = await find({ query: 'old-dev' });
  assert.deepEqual(list.map((a) => a.name), ['old-dev']);
});

test('a role-substring query omits an archived agent', async () => {
  const list = await find({ query: 'developer' });
  assert.deepEqual(list.map((a) => a.name), ['live-dev', 'paused-dev', 'stopped-dev']);
});

test('state "all" with a role-substring query includes the archived agent', async () => {
  const list = await find({ query: 'developer', state: 'all' });
  assert.deepEqual(list.map((a) => a.name), ['live-dev', 'paused-dev', 'stopped-dev', 'old-dev']);
});

test('each agent carries its type, or null', async () => {
  const list = await find({ state: 'all' });
  assert.deepEqual(list.map((a) => a.type), ['developer', 'developer', 'developer', 'reviewer']);
  agents.push({ id: 'agent-untyped', name: 'untyped', role: 'helper', type: null, lifecycle: 'active', activity: 'idle', machine: 'testbox', harness: 'claude-code' });
  try {
    const untyped = (await find({ query: 'untyped' }))[0];
    assert.equal(untyped.type, null);
  } finally {
    agents.pop();
  }
});

test('the daemon is asked for only what is listed, and a daemon that lists all gives the same answer (S-3816)', async () => {
  await find({});
  assert.equal(asked.at(-1).get('state'), 'live,stopped');
  await find({ query: 'old-dev' });
  assert.equal(asked.at(-1).get('ids'), 'old-dev');
  filtering = false;
  try {
    for (const args of [{}, { query: 'old-dev' }, { query: 'developer' }, { state: 'archived' }]) {
      filtering = true;
      const want = (await find(args)).map((a) => a.name);
      filtering = false;
      assert.deepEqual((await find(args)).map((a) => a.name), want, JSON.stringify(args));
    }
  } finally {
    filtering = true;
  }
});
