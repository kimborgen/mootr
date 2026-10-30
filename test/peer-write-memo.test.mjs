#!/usr/bin/env node
// The peer layer's write hook and the memo's partial answers (S-4356): a write this daemon sends a peer tells the
// listeners before it goes out and again once it settles, even when its answer never comes; a GET tells none; and a
// read that a down peer left partial is handed out but not kept. Runs against a throwaway STAM_HOME and a local HTTP
// server that stands in for the peer; no daemon, no network: `node --test test/peer-write-memo.test.mjs`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-peer-write-');
process.env.STAM_HOME = home;
process.env.STAM_PEER_PROBE_MS = '200';
process.env.STAM_PEER_CHECK_MS = '200';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

// The peer answers, unless `hanging` is set: then it holds every request, as a peer that applied a write and never replied.
let hanging = false;
// The answer to the human's decision and attention reads while `broken` is set: a status and body the peer gives instead.
let broken = null;
const held = [];
const answer = (req, res) => {
  if (res.destroyed) return;
  if (broken && /^\/api\/(mail\/decisions|itsas\/attention)/.test(req.url)) {
    res.writeHead(broken.status, { 'content-type': 'application/json' });
    return res.end(broken.body);
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(req.method === 'GET' && req.url !== '/api/health' ? '[{"id":"far"}]' : '{"ok":true}');
};
const server = createServer((req, res) => {
  if (hanging) held.push([req, res]);
  else answer(req, res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [{ name: 'far', url: `http://127.0.0.1:${server.address().port}`, token: 'test-peer-token' }] }));
const peers = await import('../src/peers.ts');
const { createHumanPeerMemo } = await import('../src/human-peer-memo.ts');
const far = () => peers.peerByName('far');

let told = 0;
peers.onPeerWrite(() => told++);

after(() => {
  server.closeAllConnections();
  server.close();
  rmSync(home, { recursive: true, force: true });
});

test('a GET tells no listener; a write tells it before it goes out and once it settles', async () => {
  await peers.peerCall(far(), 'GET', '/api/agents', undefined, 1000);
  assert.equal(told, 0);
  await peers.peerCall(far(), 'POST', '/api/mail', {}, 1000);
  assert.equal(told, 2);
});

test('a write whose answer never comes still tells the listeners once it gives up', async () => {
  hanging = true;
  const before = told;
  await assert.rejects(peers.peerCall(far(), 'POST', '/api/mail', {}, 100));
  assert.equal(told, before + 2);
  // The peer is marked down now; it stays down while it holds, so the next read is partial.
  const partial = await peers.fanOutReport('/api/agents');
  assert.deepEqual(partial, { rows: [], unreachable: true });
  // A memo wired the way the daemon wires its human memo keeps no partial answer.
  const memo = createHumanPeerMemo(5_000, (v) => !v.unreachable);
  let loads = 0;
  const load = () => (loads++, peers.fanOutReport('/api/agents'));
  assert.deepEqual(await memo.get('human', load, 0), { rows: [], unreachable: true });
  await memo.get('human', load, 1);
  assert.equal(loads, 2, 'the partial answer is asked again, not kept');
  hanging = false;
  for (const [req, res] of held.splice(0)) answer(req, res);
});

test('a non-200 or non-list answer is not kept as a complete one, and the recovered answer is', async () => {
  // The peer is down from the test above until a probe answers; wait for that before asking.
  for (let i = 0; i < 50 && (await peers.fanOutReport('/api/agents')).unreachable; i++) await new Promise((r) => setTimeout(r, 100));
  const path = '/api/mail/decisions';
  for (const bad of [{ status: 503, body: '{"error":"busy"}' }, { status: 200, body: '{"ok":true}' }]) {
    broken = bad;
    // The plain read keeps its old meaning: a peer that answered, whatever it said, is not unreachable.
    assert.deepEqual(await peers.fanOutReport(path), { rows: [], unreachable: false });
    assert.deepEqual(await peers.fanOutReport(path, undefined, true), { rows: [], unreachable: true });
    const memo = createHumanPeerMemo(5_000, (v) => !v.unreachable);
    let loads = 0;
    const load = () => (loads++, peers.fanOutReport(path, undefined, true));
    assert.deepEqual(await memo.get('human', load, 0), { rows: [], unreachable: true });
    await memo.get('human', load, 1);
    assert.equal(loads, 2, `a ${bad.status} answer is asked again, not kept`);
    broken = null;
    assert.deepEqual(await memo.get('human', load, 2), { rows: [{ id: 'far' }], unreachable: false });
    await memo.get('human', load, 3);
    assert.equal(loads, 3, 'the complete answer is kept');
  }
});
