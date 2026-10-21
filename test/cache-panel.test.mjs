#!/usr/bin/env node
// Settings › Prompt caching's agents (S-2239): each live agent on this machine with its latest
// detected cache window (`cache:ttl`, S-2236) and the account it bills to, paid or not; archived
// agents and other machines' rows are left out, and a peer that doesn't answer is named offline.
// Throwaway STAM_HOME, no daemon: `node --test test/cache-panel.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-cache-panel-');
process.env.STAM_HOME = home;
process.env.STAM_MACHINE = 'test-storage';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), JSON.stringify({
  // A peer nothing listens on: it comes back offline.
  peers: [{ name: 'test-far', url: 'http://127.0.0.1:9', token: 'test-token' }],
  cost: { accounts: { 'test-max': { match: { harness: 'claude', model: 'claude-opus' } }, 'test-api': { match: { harness: 'claude', model: 'claude-haiku' }, paid: true } } },
}));

let db, panel;
before(async () => {
  db = await import('../src/db.ts');
  panel = await import('../src/cache-panel.ts');
});
after(() => rmSync(home, { recursive: true, force: true }));

function agent(name, { lifecycle = 'active', ...o } = {}) {
  const id = db.newAgentId();
  db.createAgent({ id, name, role: '', machine: 'test-storage', harness: 'claude', model: 'claude-opus-5-5', effort: null, cwd: home, parent_id: null, session_id: null, ...o });
  db.updateAgent(id, { lifecycle });
  return id;
}

test('each live agent here, with its latest window and account', async () => {
  const fine = agent('t-fine');
  const spilled = agent('t-spilled');
  const api = agent('t-api', { model: 'claude-haiku-5-5' });
  agent('t-new');
  agent('t-codex', { harness: 'codex', model: 'gpt-6.1-sol' });
  const gone = agent('t-gone', { lifecycle: 'archived' });
  agent('t-there', { machine: 'test-other' });
  db.addEvent(fine, 'cache:ttl', { ttl: '5m' });
  db.addEvent(fine, 'cache:ttl', { ttl: '1h' });
  db.addEvent(spilled, 'cache:ttl', { ttl: '5m' });
  db.addEvent(api, 'cache:ttl', { ttl: '5m' });
  db.addEvent(gone, 'cache:ttl', { ttl: '5m' });

  const rows = Object.fromEntries(panel.localCacheAgents().map((r) => [r.name, r]));
  assert.deepEqual(Object.keys(rows).sort(), ['t-api', 't-codex', 't-fine', 't-new', 't-spilled']);
  assert.equal(rows['t-fine'].ttl, '1h', 'the latest window wins');
  assert.ok(rows['t-fine'].ttl_at);
  assert.equal(rows['t-spilled'].ttl, '5m');
  assert.deepEqual([rows['t-spilled'].account, rows['t-spilled'].paid], ['test-max', false]);
  assert.deepEqual([rows['t-api'].account, rows['t-api'].paid], ['test-api', true]);
  assert.deepEqual([rows['t-new'].ttl, rows['t-new'].ttl_at], [null, null]);
  assert.equal(rows['t-codex'].account, null);
  assert.equal(rows['t-fine'].machine, 'test-storage');

  const all = await panel.cacheAgents();
  assert.deepEqual(all.offline, ['test-far']);
  assert.deepEqual(all.outdated, []);
  assert.equal(all.agents.length, 5);
  const local = await panel.cacheAgents(true);
  assert.deepEqual(local.offline, [], "a peer's own request doesn't fan out");
});

test('a peer without the route is outdated, not offline', async () => {
  // A peer on an older release: it answers, but 404 for the route.
  const server = createServer((_req, res) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"not found"}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { settings, setSetting } = await import('../src/settings.ts');
    setSetting('peers', [...settings().peers, { name: 'test-old', url: `http://127.0.0.1:${server.address().port}`, token: 'test-token' }]);
    const all = await panel.cacheAgents();
    assert.deepEqual(all.outdated, ['test-old']);
    assert.deepEqual(all.offline, ['test-far']);
  } finally {
    server.close();
  }
});
