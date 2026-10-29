#!/usr/bin/env node
// The routed PR view (S-3107, src/pr-view.ts viewRouted): on a machine that isn't the ITSA home, the read goes to the home over the
// peer link. A fake home on loopback records each forwarded request and answers as the test sets. Checks: the caller's identity
// and the peer token are forwarded with the body, the home's refusals keep their HTTP status and message, and an unreachable home
// is a 502 that names it. Needs a listening socket, so it isn't a LIGHT test. Run with `node --test test/pr-view-routed-unit.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmphome.mjs';

const base = tempDir('stam-pr-view-routed-');
process.env.STAM_HOME = join(base, 'home');
// Nothing here talks to a daemon; drop pointers to the live one.
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

const HOME = 'home-peer';
const PEER_TOKEN = 'peer-token';
let viewRouted, PrViewError;
let peer;
// What the fake home answers next, and every request it got.
let peerNext = { status: 200, body: {} };
const seen = [];

before(async () => {
  peer = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      res.writeHead(peerNext.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(peerNext.body));
    });
  });
  await new Promise((done) => peer.listen(0, '127.0.0.1', done));
  // The settings make the fake home this machine's ITSA home, so the read is forwarded to it.
  mkdirSync(process.env.STAM_HOME, { recursive: true });
  writeFileSync(join(process.env.STAM_HOME, 'settings.json'), JSON.stringify({ itsa: { home: HOME }, peers: [{ name: HOME, url: `http://127.0.0.1:${peer.address().port}`, token: PEER_TOKEN }] }));
  ({ viewRouted, PrViewError } = await import('../src/pr-view.ts'));
});
after(() => {
  if (peer.listening) peer.close();
});

test('a peer forwards the read to the home with the caller\'s identity and its token, and returns the home\'s answer', async () => {
  seen.length = 0;
  peerNext = { status: 200, body: { number: 42, repo: 'example/stam', title: 'Add the PR view', files: [], checks: [] } };
  const v = await viewRouted({ pr: 42, by: 'agent-x' }, { agent: 'agent-x', boss: false });
  assert.equal(seen.length, 1, 'the home was asked once');
  const [s] = seen;
  assert.equal(s.method, 'POST');
  assert.equal(s.url, '/api/pr/view');
  assert.equal(s.headers.authorization, `Bearer ${PEER_TOKEN}`);
  assert.equal(s.headers['x-stam-local'], '1');
  assert.equal(s.headers['x-stam-agent'], 'agent-x', 'the caller\'s identity is forwarded');
  assert.equal(s.headers['x-stam-agent-boss'], undefined, 'no boss claim is forwarded for a plain agent');
  assert.deepEqual(s.body, { pr: 42, by: 'agent-x' });
  assert.deepEqual(v, peerNext.body);
});

test('the home\'s refusal keeps its HTTP status and message (404 unknown PR, 403 disallowed repo)', async () => {
  for (const [status, error] of [[404, 'PR #9 is not in example/stam'], [403, 'other/repo is not a repo of settings.itsa.repos']]) {
    seen.length = 0;
    peerNext = { status, body: { error } };
    await assert.rejects(viewRouted({ pr: 9, by: 'agent-x' }, { agent: 'agent-x' }), (e) => e instanceof PrViewError && e.status === status && e.message === error, String(status));
    assert.equal(seen.length, 1, 'the home was asked');
  }
});

test('an unreachable home is a 502 that names it, never a guessed answer', async () => {
  peer.closeAllConnections();
  await new Promise((done) => peer.close(done));
  await assert.rejects(viewRouted({ pr: 42, by: 'agent-x' }, { agent: 'agent-x' }), (e) => e instanceof PrViewError && e.status === 502 && e.message.includes(`ITSA home '${HOME}' is unreachable`), 'unreachable');
});
