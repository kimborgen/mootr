#!/usr/bin/env node
// Name resolution for mail (S-288): a name means the exact id or name of an agent, here or on a
// peer. A live agent beats one that is shut down or archived, and two that still match are an
// error that lists them, not a guess. The shapes are the three agents of S-288: a shut-down local
// "agent-tokens", a shut-down "agent-tokens-t2" (never a match for "agent-tokens"), and the live
// "agent-tokens" on the peer "storage". Runs against a throwaway STAM_HOME and a local HTTP server
// that stands in for the peer; no daemon, no network: `node --test test/resolve-recipient.test.mjs`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-resolve-');
process.env.STAM_HOME = home;
process.env.STAM_MACHINE = 'alpha';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

// Peers: `storage` knows the live agent named agent-tokens (agrjy); `twin` knows none, and a
// stand-in that counts the requests it gets, so a local match can be shown to skip the peers.
const peerAgents = [{ id: 'agrjy', name: 'agent-tokens', machine: 'storage', role: 'Tokens', harness: 'claude-code', model: null, lifecycle: 'active' }];
let twinCalls = 0;
const fake = (agents, count) => createServer((req, res) => {
  count?.();
  const m = req.url.match(/^\/api\/agents\/([^/?]+)$/);
  const hit = m && agents.find((a) => a.id === decodeURIComponent(m[1]) || a.name === decodeURIComponent(m[1]));
  res.writeHead(hit ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(hit ?? { error: 'no agent' }));
});
const servers = [fake(peerAgents), fake([], () => twinCalls++)];
for (const sv of servers) await new Promise((r) => sv.listen(0, '127.0.0.1', r));
writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [
  { name: 'storage', url: `http://127.0.0.1:${servers[0].address().port}`, token: 'test-peer-token' },
  { name: 'twin', url: `http://127.0.0.1:${servers[1].address().port}`, token: 'test-peer-token' },
] }));

const db = await import('../src/db.ts');
const mail = await import('../src/mail.ts');
const peers = await import('../src/peers.ts');

// The local side, as in S-288: agent-tokens (addsg's predecessor, shut down) and agent-tokens-t2.
const local = (id, name, lifecycle) => {
  db.createAgent({ id, name, role: 'Tokens', machine: 'alpha', harness: 'claude-code', model: null, effort: null, cwd: home, parent_id: null, session_id: null });
  if (lifecycle !== 'active') db.updateAgent(id, { lifecycle });
};
local('a9mit', 'agent-tokens', 'shut_down');
local('addsg', 'agent-tokens-t2', 'shut_down');

after(() => {
  for (const sv of servers) { sv.closeAllConnections(); sv.close(); }
  rmSync(home, { recursive: true, force: true });
});

test('a live agent on a peer beats a shut-down local agent of the same name', async () => {
  const hit = await mail.resolveRecipient('agent-tokens');
  assert.equal(hit.agent.id, 'agrjy');
  assert.equal(hit.peer?.name, 'storage');
});

test('a name matches only exactly: a partial name finds nothing, and agent-tokens-t2 is never agent-tokens', async () => {
  assert.equal(await mail.resolveRecipient('agent-token'), 'absent');
  assert.equal((await mail.resolveRecipient('agent-tokens-t2')).agent.id, 'addsg');
});

test('a live agent alone wins over shut-down matches, and two shut-down matches are ambiguous', async () => {
  db.updateAgent('a9mit', { lifecycle: 'shut_down' });
  peerAgents[0].lifecycle = 'shut_down';
  await assert.rejects(mail.resolveRecipient('agent-tokens'), /matches more than one agent: agent-tokens \(a9mit, alpha, shut_down\), agent-tokens \(agrjy, storage, shut_down\)/);
  peerAgents[0].lifecycle = 'active';
  assert.equal((await mail.resolveRecipient('agent-tokens')).agent.id, 'agrjy');
});

test('an ambiguous name refuses the handshake with a 409 and the candidates', async () => {
  const refusal = peers.ambiguousRefusal(new peers.AmbiguousAgentError('agent-tokens matches more than one agent: x (a, m, active)'));
  assert.match(refusal, /^HTTP\/1\.1 409 Conflict\r\n/);
  assert.match(refusal, /x \(a, m, active\)$/);
  assert.equal(peers.ambiguousRefusal(new Error('other')), undefined);
});

test('a live local name wins without asking the peers', async () => {
  db.updateAgent('a9mit', { lifecycle: 'active' });
  twinCalls = 0;
  const hit = await mail.resolveRecipient('agent-tokens');
  assert.equal(hit.agent.id, 'a9mit');
  assert.equal(hit.peer, undefined);
  assert.equal(twinCalls, 0);
});

test('an exact id remembered from a peer is used without asking the peers', async () => {
  db.createAgent({ id: 'alocal2', name: 'other', role: 'Local', machine: 'alpha', harness: 'claude-code', model: null, effort: null, cwd: home, parent_id: null, session_id: null });
  db.rememberPeerAgent({ id: 'rmb1', name: 'remembered', machine: 'storage', lifecycle: 'active' });
  twinCalls = 0;
  const hit = await mail.resolveRecipient('rmb1');
  assert.equal(hit.agent.id, 'rmb1');
  assert.equal(hit.peer?.name, 'storage');
  assert.equal(twinCalls, 0);
});

test('an exact id names its agent even when it is shut down, over a peer agent of that name', async () => {
  db.updateAgent('a9mit', { lifecycle: 'shut_down' });
  peerAgents.push({ id: 'pk9', name: 'a9mit', machine: 'storage', role: 'Other', harness: 'claude-code', model: null, lifecycle: 'active' });
  const hit = await mail.resolveRecipient('a9mit');
  assert.equal(hit.agent.id, 'a9mit');
  assert.equal(hit.peer, undefined);
});

test('an exact peer id beats a local name match, even when the local agent is live', async () => {
  db.createAgent({ id: 'alocal', name: 'agrjy', role: 'Local', machine: 'alpha', harness: 'claude-code', model: null, effort: null, cwd: home, parent_id: null, session_id: null });
  db.rememberPeerAgent({ id: 'agrjy', name: 'agent-tokens', machine: 'storage', lifecycle: 'active' });
  peerAgents.splice(1);
  const hit = await mail.resolveRecipient('agrjy');
  assert.equal(hit.agent.id, 'agrjy');
  assert.equal(hit.peer?.name, 'storage');
  db.updateAgent('alocal', { lifecycle: 'archived' });
});

test('a remembered id is not used for a forwarded send, which resolves only here', async () => {
  db.updateAgent('a9mit', { lifecycle: 'shut_down' });
  assert.equal(await mail.resolveRecipient('rmb1', true), 'absent');
});

test('a remembered archived id is not used directly: the peers are asked, and refuse it when down', async () => {
  db.rememberPeerAgent({ id: 'rmbA', name: 'gone', machine: 'storage', lifecycle: 'archived' });
  twinCalls = 0;
  assert.equal(await mail.resolveRecipient('rmbA'), 'absent');
  assert.equal(twinCalls, 1);
});

test('an archived remembered id is not stood in for by a live local agent of that name', async () => {
  db.createAgent({ id: 'alocal3', name: 'rmbA', role: 'Local', machine: 'alpha', harness: 'claude-code', model: null, effort: null, cwd: home, parent_id: null, session_id: null });
  assert.equal(await mail.resolveRecipient('rmbA'), 'absent');
  db.updateAgent('alocal3', { lifecycle: 'archived' });
});

test('two live matches on peers fail with a 409-class error listing both candidates', async () => {
  db.updateAgent('a9mit', { lifecycle: 'shut_down' });
  peerAgents.push({ id: 'agrk2', name: 'agent-tokens', machine: 'twin', role: 'Tokens', harness: 'claude-code', model: null, lifecycle: 'active' });
  servers[1].removeAllListeners('request');
  servers[1].on('request', (req, res) => {
    const hit = peerAgents.find((a) => a.id === 'agrk2');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(hit));
  });
  await assert.rejects(mail.resolveRecipient('agent-tokens'), (e) => {
    assert.ok(e instanceof peers.AmbiguousAgentError);
    assert.match(e.message, /agent-tokens \(agrjy, storage, active\)/);
    assert.match(e.message, /agent-tokens \(agrk2, twin, active\)/);
    return true;
  });
});

test('an id an agent here and a remembered peer agent both have is redrawn, not drawn again (S-577)', () => {
  // 32 letters, one per low byte: [0,1,2,3] is aabcd, [4,5,6,7] aefgh, [8,9,10,11] aijkm.
  db.createAgent({ id: 'aabcd', name: 'local-drawn', role: 'Local', machine: 'alpha', harness: 'claude-code', model: null, effort: null, cwd: home, parent_id: null, session_id: null });
  db.rememberPeerAgent({ id: 'aefgh', name: 'peer-drawn', machine: 'storage', lifecycle: 'active' });
  // A first draw of the local agent's id and a second of the peer's are both redrawn.
  const draws = [Buffer.from([0, 1, 2, 3]), Buffer.from([4, 5, 6, 7]), Buffer.from([8, 9, 10, 11])];
  assert.equal(db.newAgentId(() => draws.shift()), 'aijkm');
  assert.equal(draws.length, 0);
  db.forgetPeerAgent('aefgh');
});

test('an id present locally and on a peer is refused, naming both, rather than resolved locally (S-577)', async () => {
  db.createAgent({ id: 'ac4ef', name: 'local-col', role: 'Local', machine: 'alpha', harness: 'claude-code', model: null, effort: null, cwd: home, parent_id: null, session_id: null });
  db.rememberPeerAgent({ id: 'ac4ef', name: 'rs-review2', machine: 'storage', lifecycle: 'active' });
  await assert.rejects(mail.resolveRecipient('ac4ef'), (e) => {
    assert.ok(e instanceof peers.AmbiguousAgentError);
    assert.match(e.message, /ac4ef matches an agent on more than one machine: local-col \(alpha\) and rs-review2 \(storage\); address it by name, not by id/);
    return true;
  });
});

test('a remembered row for this very machine is not a twin: an exact local id still resolves (S-577)', async () => {
  db.createAgent({ id: 'alcl1', name: 'local-here', role: 'Local', machine: 'alpha', harness: 'claude-code', model: null, effort: null, cwd: home, parent_id: null, session_id: null });
  db.rememberPeerAgent({ id: 'alcl1', name: 'local-here', machine: 'alpha', lifecycle: 'active' });
  const hit = await mail.resolveRecipient('alcl1');
  assert.equal(hit.agent.id, 'alcl1');
  assert.equal(hit.peer, undefined);
});

test('send_mail to a name sends to the live peer agent, not to the shut-down agent it forwards to', async () => {
  db.updateAgent('a9mit', { lifecycle: 'shut_down', forwarded_to: 'addsg' });
  peerAgents.splice(1);
  servers[1].removeAllListeners('request');
  servers[1].on('request', (req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"no"}');
  });
  db.createAgent({ id: 'sender1', name: 'sender1', role: 'Sender', machine: 'alpha', harness: 'claude-code', model: null, effort: null, cwd: home, parent_id: null, session_id: null });
  const posted = [];
  servers[0].removeAllListeners('request');
  servers[0].on('request', (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/api/mail') {
        posted.push(JSON.parse(body));
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id: 'm1', thread_id: 'm1', subject: 's', body: 'b', to: ['agrjy'], from_id: 'sender1' }));
      }
      const m = req.url.match(/^\/api\/agents\/([^/?]+)$/);
      const hit = m && peerAgents.find((a) => a.id === decodeURIComponent(m[1]) || a.name === decodeURIComponent(m[1]));
      res.writeHead(hit ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(hit ?? { error: 'no agent' }));
    });
  });
  await mail.sendMail({ from: 'sender1', to: ['agent-tokens'], subject: 's', body: 'b', new_thread: true });
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].to, ['agrjy']);
});

