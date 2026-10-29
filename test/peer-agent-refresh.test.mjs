#!/usr/bin/env node
// A home that misses a peer's agent asks again once before refusing (S-2927, S-3232, src/peers.ts
// findAgentPeerFresh, used by itsa.person). The peer here is a plain local HTTP server, not a daemon:
// its per-agent route hangs past the timeout once, which marks it down, then answers. No model:
// `node --test test/peer-agent-refresh.test.mjs`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-peer-agent-refresh-');
process.env.STAM_HOME = home;
process.env.STAM_MACHINE = 'refresh-home';
process.env.STAM_PEER_LOOKUP_MS = '300';
process.env.STAM_PEER_CHECK_MS = '200';
process.env.STAM_PEER_LOOKUP_RETRY_MS = '300';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

// mode 'hang-once': the first per-agent ask of aaxn8 never answers; 'mute': nothing answers, health included.
let mode = 'hang-once';
let hung = false;
const asked = []; // per-agent asks, by id
const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (mode === 'mute') return;
  if (req.url === '/api/health') {
    return res.end('{"ok":true}');
  }
  const id = decodeURIComponent(req.url.replace('/api/agents/', ''));
  asked.push(id);
  if (id === 'aaxn8') {
    if (mode === 'hang-once' && !hung) return void (hung = true);
    return res.end(JSON.stringify({ id, name: 'sweep-small-dev', machine: 'far' }));
  }
  res.statusCode = 404;
  res.end('{}');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [{ name: 'far', url: `http://127.0.0.1:${server.address().port}`, token: 'secret-far-token' }] }));
const itsa = await import('../src/itsa.ts');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const countOf = (id) => asked.filter((a) => a === id).length;

after(() => {
  server.closeAllConnections();
  server.close();
  rmSync(home, { recursive: true, force: true });
});

test('a lookup that times out once, which marks the peer down, gets its one retry and succeeds', async () => {
  assert.equal(await itsa.person('aaxn8'), 'aaxn8');
  assert.equal(countOf('aaxn8'), 2);
});

test('an id no peer returns is refused with the old error, no token, and costs one retry for a burst', async () => {
  await sleep(350);
  const r = await Promise.allSettled(Array.from({ length: 20 }, () => itsa.person('nobody1')));
  assert.ok(r.every((x) => x.status === 'rejected' && /^no agent nobody1 \(pass an agent id or name, or 'human'\)$/.test(x.reason.message) && !/secret/.test(x.reason.message)));
  assert.equal(countOf('nobody1'), 21, '20 first asks and one shared retry');
});

test('a peer that never answers gives the old error within a bounded time', async () => {
  await sleep(350);
  mode = 'mute';
  const t = Date.now();
  await assert.rejects(itsa.person('aaxn8x'), /no agent aaxn8x/);
  assert.ok(Date.now() - t < 3000, `refused in ${Date.now() - t} ms`);
});

test('a peer already down before the call gets no second probe', async () => {
  // Still mute, and marked down by the previous test: the first lookup probes it once (the probe
  // never answers), and the retry skips it.
  let asks = 0;
  server.on('request', (req) => void (req.url === '/api/health' && asks++));
  const t = Date.now();
  await assert.rejects(itsa.person('zzz9'), /no agent zzz9/);
  assert.equal(asks, 1, 'one probe, not two');
  assert.ok(Date.now() - t < 3000);
});
