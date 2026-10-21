#!/usr/bin/env node
// set-parent to an agent on another machine (S-2453), against stub peers:
//  - a name a peer knows is that peer's machine, so the refusal can say where the parent runs;
//  - a name no peer knows is no machine (the plain 'no agent' refusal);
//  - a peer that hangs, errors, or answers anything but the agent is no match, quickly, and the
//    lookup records nothing here (no peer agent row, no registry change);
//  - set-parent through the daemon's control refuses a parent on another machine with the way out,
//    and a refused list changes no parent, even when a local parent sits in the same list (S-2809);
//  - a peer that answers 200 with no agent id (`{}`) is no match, so the set-parent refusal is the
//    no-agent one, not the cross-machine one (S-2809).
// Throwaway STAM_HOME, no daemon: `node --test test/set-parent-remote.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-set-parent-remote-');
process.env.STAM_HOME = home;
process.env.STAM_MACHINE = 'here';
process.env.STAM_TMUX_SOCKET = `set-parent-remote-${process.pid}`;
process.env.STAM_EMBEDDER = 'stub';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

const listen = (handler) => new Promise((r) => { const s = createServer(handler); s.listen(0, '127.0.0.1', () => r(s)); });
const url = (s) => `http://127.0.0.1:${s.address().port}`;

// far knows agent `specialist-far`; odd answers 200 with no agent; hang never answers.
const far = await listen((req, res) => {
  if (req.url === '/api/agents/specialist-far') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'far-1', name: 'specialist-far', machine: 'far', lifecycle: 'active' }));
  res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"no agent"}');
});
const odd = await listen((_req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('<html>not json</html>'));
const hang = await listen(() => {});
// empty answers 200 with an empty object for `specialist-empty`: no agent id, so no match.
const empty = await listen((req, res) => {
  if (req.url === '/api/agents/specialist-empty') return res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"no agent"}');
});

let db, peers, daemon;
before(async () => {
  writeFileSync(join(home, 'settings.json'), JSON.stringify({
    chiefOfStaff: null,
    peers: [
      { name: 'far', url: url(far), token: 'x' },
      { name: 'odd', url: url(odd), token: 'x' },
      { name: 'hang', url: url(hang), token: 'x' },
      { name: 'empty', url: url(empty), token: 'x' },
    ],
  }));
  db = await import('../src/db.ts');
  peers = await import('../src/peers.ts');
  daemon = await import('../src/daemon.ts');
});
after(() => {
  hang.closeAllConnections();
  for (const s of [far, odd, hang, empty]) s.close();
  rmSync(home, { recursive: true, force: true });
});

// A local agent in the registry, with no workspace: set-parent only reads its id and name.
let made = 0;
function localAgent(name) {
  const id = db.newAgentId();
  db.createAgent({ id, name: `${name}-${++made}`, role: '', machine: 'here', harness: 'fake', model: null, effort: null, cwd: home, parent_id: null, session_id: `sess-${id}` });
  return db.getAgent(id);
}

test('a name a peer knows is that peer\'s machine', async () => {
  assert.equal(await peers.peerMachineOf('specialist-far'), 'far');
});

test('a name no peer knows is no machine: the plain no-agent refusal', async () => {
  assert.equal(await peers.peerMachineOf('nobody-anywhere'), undefined);
});

test('a peer that hangs or answers oddly is no match, quickly, and nothing is remembered', async () => {
  const started = Date.now();
  // The hanging peer runs into its own timeout; the odd one fails to parse. Neither may pass for a match.
  assert.equal(await peers.peerMachineOf('specialist-odd'), undefined);
  assert.equal(await peers.peerMachineOf('specialist-hang'), undefined);
  assert.ok(Date.now() - started < 10_000, 'bounded by the peer timeout, not by the peer');
  assert.equal(db.peerAgentById('far-1'), undefined, 'a lookup remembers no peer agent');
});

test('set-parent refuses a parent on another machine with the way out, and a refused list changes no parent', async () => {
  const boss = localAgent('boss');
  const child = localAgent('child');
  db.setParents(child.id, [boss.id]);
  // A local parent first in the list must not be written when a remote one later in it is refused.
  await assert.rejects(
    daemon.control(child, 'set-parent', { parent: [boss.id, 'specialist-far'] }),
    (e) => e.status === 409 && e.message.startsWith('specialist-far runs on far; cross-machine parents are unsupported. Name a parent on here'),
  );
  assert.deepEqual(db.parentsOf(db.getAgent(child.id)), [boss.id], 'the refused list left the parents as they were');

  const loner = localAgent('loner');
  await assert.rejects(
    daemon.control(loner, 'set-parent', { parent: 'specialist-far' }),
    (e) => e.status === 409 && e.message.includes('runs on far; cross-machine parents are unsupported'),
  );
  assert.deepEqual(db.parentsOf(db.getAgent(loner.id)), [], 'a refused remote parent wrote no parent row');
});

test('a peer that answers 200 with no agent id is no match: set-parent gets the no-agent refusal', async () => {
  assert.equal(await peers.peerMachineOf('specialist-empty'), undefined);
  const child = localAgent('stray');
  // control rewraps the lookup's 404 as a 409 with the same message; only the message is checked here.
  await assert.rejects(
    daemon.control(child, 'set-parent', { parent: 'specialist-empty' }),
    (e) => e.message === 'no agent specialist-empty',
  );
  assert.deepEqual(db.parentsOf(db.getAgent(child.id)), []);
});
