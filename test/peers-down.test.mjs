#!/usr/bin/env node
// Unit tests for skipping a peer that is down (S-231): the request that finds it down pays
// its timeout once, later requests skip it at once, and a probe in the background lets it
// back in. Runs against a throwaway STAM_HOME and a local HTTP server that stands in for the
// peer; no daemon, no network: `node --test test/peers-down.test.mjs`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-peers-down-');
process.env.STAM_HOME = home;
process.env.STAM_PEER_PROBE_MS = '200';
process.env.STAM_PEER_CHECK_MS = '200';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

// The peer: hangs while `up` is false, like a machine that is off, and answers once it is true.
// Requests held while it is down are answered when it comes up.
let up = false;
let probes = 0;
// How long a real call (not /api/health) takes to answer once the peer is up.
let slowMs = 0;
const held = [];
const answer = (req, res) => {
  if (res.destroyed) return;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(req.url === '/api/health' ? '{"ok":true}' : '[{"id":"far"}]');
};
const server = createServer((req, res) => {
  if (req.url === '/api/health') probes++;
  if (up) (req.url === '/api/health' ? answer : (r, s) => setTimeout(() => answer(r, s), slowMs))(req, res);
  else held.push([req, res]);
});
const wake = () => {
  up = true;
  for (const [req, res] of held.splice(0)) answer(req, res);
};
await new Promise((r) => server.listen(0, '127.0.0.1', r));
writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [{ name: 'far', url: `http://127.0.0.1:${server.address().port}`, token: 't' }] }));
const peers = await import('../src/peers.ts');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timed = async (f) => {
  const t = Date.now();
  const v = await f();
  return { v, ms: Date.now() - t };
};

after(() => {
  server.closeAllConnections();
  server.close();
  rmSync(home, { recursive: true, force: true });
});

test('a down peer costs one timeout, then requests skip it until a probe reaches it', async () => {
  await assert.rejects(peers.peerCall(peers.peerByName('far'), 'GET', '/api/agents', undefined, 200));
  // Marked down: skipped at once, before and after the retry time; no request waits on it.
  let r = await timed(() => peers.fanOut('/api/agents'));
  assert.deepEqual(r.v, []);
  assert.ok(r.ms < 100, `skipped in ${r.ms} ms`);
  await sleep(300);
  r = await timed(() => peers.fanOut('/api/agents'));
  assert.deepEqual(r.v, []);
  assert.ok(r.ms < 100, `skipped after the retry time in ${r.ms} ms`);
  for (let i = 0; i < 50 && !probes; i++) await sleep(20);
  assert.equal(probes, 1, 'the request past the retry time starts one probe');
  // Back up: the next probe lets it in, and lists include it again.
  wake();
  let got = [];
  for (let i = 0; i < 50 && !got.length; i++) {
    await sleep(100);
    got = await peers.fanOut('/api/agents');
  }
  assert.deepEqual(got, [{ id: 'far' }]);
});

test('a direct call to a down peer probes it first, so a slow call after it comes back still succeeds', async () => {
  const far = peers.peerByName('far');
  up = false;
  await assert.rejects(peers.peerCall(far, 'GET', '/api/agents', undefined, 200));
  // Still down: the probe finds no answer, and the call fails at once with the probe's timeout.
  let r = await timed(() => peers.peerCall(far, 'GET', '/api/agents', undefined, 200).catch((e) => e));
  assert.match(r.v.message, /far is unreachable/);
  assert.ok(r.ms < 1000, `refused in ${r.ms} ms`);
  // The peer is back and slow, 3 s into a 5 s call, right after it was marked down: the probe
  // clears it and the real call runs with its full timeout.
  up = true;
  slowMs = 3000;
  r = await timed(() => peers.peerCall(far, 'GET', '/api/agents', undefined, 5000));
  assert.equal(r.v.status, 200);
  assert.deepEqual(r.v.data, [{ id: 'far' }]);
  assert.ok(r.ms >= 3000, `answered in ${r.ms} ms`);
  slowMs = 0;
  assert.deepEqual(await peers.fanOut('/api/agents'), [{ id: 'far' }]);
});
