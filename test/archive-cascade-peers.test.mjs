#!/usr/bin/env node
// S-1378: the archive cascade across machines. Peers are stub HTTP servers on loopback: the
// daemon's `archive` action fans the cascade out to each (one answers, one returns a 500, one is
// unreachable), a parent on another machine is told through its daemon's notice route, and a
// grandchild whose parent sits on another machine is reached on the next round. Throwaway
// STAM_HOME, fake harness, no models: `node --test test/archive-cascade-peers.test.mjs`.
import { test, before, after } from 'node:test';
import { killTmuxServer } from '../src/tmux-socket.ts';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-archive-cascade-peers-');
const socket = `archive-cascade-peers-test-${process.pid}`;
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = socket;
process.env.STAM_EMBEDDER = 'stub';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

// Records what each stub peer receives, and answers per its script.
const got = [];
const remoteBoss = { id: 'remote-boss', name: 'rboss', role: '', machine: 'elsewhere', harness: 'fake', lifecycle: 'active', activity: 'idle' };
function stub(name, scripts) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push({ peer: name, method: req.method, path: req.url, body: body ? JSON.parse(body) : undefined });
      const r = scripts(req) ?? { status: 404, data: {} };
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.data));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}
let reportReply = { archived: ['dev1'], archiving: [], kept: [], failed: [], ids: ['dev1-id'] };
const okPeer = await stub('ok', (req) => {
  if (req.url === '/api/archive-children') return { status: 200, data: reportReply };
  if (req.url === `/api/agents/${remoteBoss.id}`) return { status: 200, data: remoteBoss };
  if (req.url === `/api/agents/${remoteBoss.id}/notice`) return { status: 200, data: {} };
});
const badPeer = await stub('bad', (req) => (req.url === '/api/archive-children' ? { status: 500, data: { error: 'boom' } } : undefined));
const goneServer = await stub('gone', () => undefined);
const gonePort = goneServer.address().port;
await new Promise((r) => goneServer.close(r));
const url = (s) => `http://127.0.0.1:${s.address().port}`;
writeFileSync(
  join(home, 'settings.json'),
  JSON.stringify({ peers: [{ name: 'ok', url: url(okPeer), token: 'test-peer-token' }, { name: 'bad', url: url(badPeer), token: 'test-peer-token' }, { name: 'gone', url: `http://127.0.0.1:${gonePort}`, token: 'test-peer-token' }] }),
);

let db, lifecycle, daemon;
const turnAlive = new Set();
before(async () => {
  db = await import('../src/db.ts');
  lifecycle = await import('../src/lifecycle.ts');
  daemon = await import('../src/daemon.ts');
  const { adapters } = await import('../src/adapters/index.ts');
  adapters.fake = {
    pushPrompt: async () => true,
    launch: async () => ({ argv: ['sleep', '600'], env: {} }),
    afterLaunch: async () => {},
    turnRunning: async (a) => turnAlive.has(a.id),
  };
});
after(() => {
  killTmuxServer(socket);
  for (const s of [okPeer, badPeer]) s.closeAllConnections(), s.close();
  rmSync(home, { recursive: true, force: true });
});

let n = 0;
function agent({ parent = null, activity = 'idle', lifecycle: lc = 'active' } = {}) {
  const id = db.newAgentId();
  const cwd = join(home, `work-${id}`);
  mkdirSync(cwd);
  db.createAgent({ id, name: `p${++n}`, role: '', machine: 'test', harness: 'fake', model: null, effort: null, cwd, parent_id: parent, session_id: `sess-${id}` });
  db.updateAgent(id, { workspace: JSON.stringify({ spec: { kind: 'dir', path: cwd }, cwd }), lifecycle: lc, activity });
  return db.getAgent(id);
}

test("the archive action asks every peer: one answers, one fails with a 500, one is unreachable", async () => {
  got.length = 0;
  reportReply = { ...reportReply, ids: [] };
  const boss = agent();
  const mgr = agent({ parent: boss.id });
  const result = await daemon.control(db.getAgent(mgr.id), 'archive', {});
  reportReply = { ...reportReply, ids: ['dev1-id'] };
  const asked = got.filter((g) => g.path === '/api/archive-children');
  assert.deepEqual(asked.map((g) => g.peer).sort(), ['bad', 'ok']);
  assert.deepEqual(asked[0].body, { parents: [mgr.id], fallback: [boss.id] });
  assert.match(result, /also archived idle dev1 on ok/);
  assert.match(result, /children on bad \(status 500/);
  assert.match(result, /children on gone \(/);
  assert.equal(db.getAgent(mgr.id).lifecycle, 'archived', 'the local archive went through');
});

test("a grandchild on another machine than its parent is reached on the next round", async () => {
  got.length = 0;
  const boss = agent();
  const mgr = agent({ parent: boss.id });
  const k = agent({ parent: mgr.id });
  const result = await daemon.control(db.getAgent(mgr.id), 'archive', {});
  const rounds = got.filter((g) => g.peer === 'ok' && g.path === '/api/archive-children').map((g) => g.body.parents);
  assert.deepEqual(rounds[0], [mgr.id]);
  assert.ok(rounds[1].includes(k.id) && rounds[1].includes('dev1-id'), `round two follows the archived ids: ${JSON.stringify(rounds[1])}`);
  assert.equal(db.getAgent(k.id).lifecycle, 'archived');
  assert.match(result, new RegExp(`${k.name}`));
});

test("a peer cascade skips a parent that is a live agent here, and cascades one that is gone", async () => {
  const live = agent();
  const onLive = agent({ parent: live.id });
  const idle = agent({ parent: 'gone-elsewhere' });
  const rep = await lifecycle.cascadeForPeer([live.id, 'gone-elsewhere'], []);
  assert.equal(db.getAgent(onLive.id).lifecycle, 'active');
  assert.equal(db.getAgent(idle.id).lifecycle, 'archived');
  assert.deepEqual(rep.ids, [idle.id]);
});

// A dirty worktree makes the deadline archive fail for good.
let repos = 0;
async function dirtyWorktree(id) {
  const { createWorkspace } = await import('../src/workspace.ts');
  const { execFileSync } = await import('node:child_process');
  const repo = join(home, `repo-${++repos}`);
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');
  const ws = createWorkspace({ kind: 'worktree', repo }, `dirty-${repos}`);
  writeFileSync(join(ws.cwd, 'a.txt'), 'changed\n');
  db.updateAgent(id, { workspace: JSON.stringify(ws), cwd: ws.cwd });
}

test('a deadline failure with a parent on another machine is told to that machine', async () => {
  got.length = 0;
  const d = agent({ parent: remoteBoss.id });
  turnAlive.add(d.id);
  await dirtyWorktree(d.id);
  await lifecycle.archive(db.getAgent(d.id));
  await lifecycle.runDueArchives(Date.now() + 60 * 60_000);
  await new Promise((r) => setTimeout(r, 200));
  const note = got.find((g) => g.path === `/api/agents/${remoteBoss.id}/notice`);
  assert.ok(note, 'the remote parent was told');
  assert.match(note.body.text, /failed at its final-round deadline/);
  turnAlive.delete(d.id);
});

test('a deadline failure whose parent cannot be told goes to the chief of staff', async () => {
  const cos = agent();
  const { setSetting } = await import('../src/settings.ts');
  setSetting('chiefOfStaff', cos.name);
  const d = agent({ parent: 'forgotten-parent' });
  turnAlive.add(d.id);
  await dirtyWorktree(d.id);
  await lifecycle.archive(db.getAgent(d.id));
  const before = db.listEvents(cos.id, 500).filter((e) => e.type === 'notice:queued').length;
  await lifecycle.runDueArchives(Date.now() + 60 * 60_000);
  await new Promise((r) => setTimeout(r, 300));
  const notes = db.listEvents(cos.id, 500).filter((e) => e.type === 'notice:queued').slice(before);
  assert.ok(notes.some((e) => (e.data ?? '').includes('failed at its final-round deadline')), 'cos was told');
  turnAlive.delete(d.id);
});
