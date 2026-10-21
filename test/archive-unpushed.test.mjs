#!/usr/bin/env node
// S-2201: an archive removes the agent's worktree and keeps only the local branch, so it refuses while that
// branch holds commits no remote-tracking ref reaches. A pushed branch, a missing branch and
// `force_unpushed` pass; a pending archive that runs at its deadline refuses the same way and tells its
// parent; a git failure refuses. Real git repos under a throwaway STAM_HOME, no daemon, no models:
// `node --test test/archive-unpushed.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-archive-unpushed-');
const socket = `archive-unpushed-test-${process.pid}`;
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = socket;
process.env.STAM_EMBEDDER = 'stub';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [] }));

let db, lifecycle, workspace, daemon;
before(async () => {
  db = await import('../src/db.ts');
  lifecycle = await import('../src/lifecycle.ts');
  workspace = await import('../src/workspace.ts');
  daemon = await import('../src/daemon.ts');
});
after(() => {
  spawnSync('tmux', ['-L', socket, 'kill-server']); // also ends the sessions the tests start
  rmSync(home, { recursive: true, force: true });
});

let n = 0;
const g = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();

// A shut-down agent in a fresh worktree of a one-commit repo.
// A real tmux session on the test socket named like the agent: a guard that ran after quitHarness would kill it.
function liveSession(id) {
  execFileSync('tmux', ['-L', socket, 'new-session', '-d', '-s', id, 'sleep 600']);
}
const alive = (id) => spawnSync('tmux', ['-L', socket, 'has-session', '-t', id]).status === 0;
const quitEvents = (id) => db.listEvents(id, 500).filter((e) => e.type === 'shutdown' || e.type === 'archive');
const events = (id, type) => db.listEvents(id, 500).filter((e) => e.type === type);
const tick = () => new Promise((r) => setTimeout(r, 50));

// `remote: false` makes a local-only repo with nothing to push to.
function worktreeAgent(extra = {}) {
  const dir = join(home, `repo-${++n}`);
  mkdirSync(dir);
  g(dir, 'init', '-q');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  g(dir, 'add', '.');
  g(dir, 'commit', '-qm', 'init');
  if (extra.remote !== false) g(dir, 'remote', 'add', 'origin', dir);
  g(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const ws = workspace.createWorkspace({ kind: 'worktree', repo: dir }, `unpushed-${n}`);
  const id = db.newAgentId();
  db.createAgent({ id, name: `u${n}`, role: '', machine: 'test', harness: 'fake', model: null, effort: null, cwd: ws.cwd, parent_id: extra.parent ?? null, session_id: `sess-${id}` });
  db.updateAgent(id, { workspace: JSON.stringify(ws), lifecycle: 'shut_down', activity: 'unknown', ...extra.row });
  return { ws, repo: dir, a: db.getAgent(id) };
}
const commit = (ws, msg = 'work') => { g(ws.cwd, 'commit', '--allow-empty', '-qm', msg); return g(ws.cwd, 'rev-parse', 'HEAD'); };

test('unpushed commits refuse the archive, naming branch, count and head', async () => {
  const { ws, a } = worktreeAgent();
  commit(ws, 'one');
  const head = commit(ws, 'two');
  await assert.rejects(lifecycle.archive(a), (e) => {
    assert.match(e.message, new RegExp(`branch ${ws.worktree.branch} has 2 commits not on any remote \\(head ${head}\\)`));
    assert.match(e.message, /pr_open/);
    assert.match(e.message, /force_unpushed/);
    assert.doesNotMatch(e.message, /Commit or discard its changes/, 'the dirty-tree hint does not apply');
    return true;
  });
  assert.equal(db.getAgent(a.id).lifecycle, 'shut_down');
  assert.ok(existsSync(ws.cwd), 'the worktree stays');
});

test('a pushed branch archives, and the worktree goes', async () => {
  const { ws, repo, a } = worktreeAgent();
  const head = commit(ws);
  g(repo, 'update-ref', `refs/remotes/origin/${ws.worktree.branch}`, head);
  await lifecycle.archive(a);
  assert.equal(db.getAgent(a.id).lifecycle, 'archived');
  assert.ok(!existsSync(ws.cwd));
});

test('a branch with no commits of its own archives; a storage tracking ref counts as pushed', async () => {
  const fresh = worktreeAgent();
  await lifecycle.archive(fresh.a);
  assert.equal(db.getAgent(fresh.a.id).lifecycle, 'archived');
  const onStorage = worktreeAgent();
  const head = commit(onStorage.ws);
  g(onStorage.repo, 'update-ref', `refs/remotes/storage/${onStorage.ws.worktree.branch}`, head);
  await lifecycle.archive(onStorage.a);
  assert.equal(db.getAgent(onStorage.a.id).lifecycle, 'archived');
});

test('force_unpushed archives and keeps the local branch; discard and force alone do not override', async () => {
  const { ws, repo, a } = worktreeAgent();
  const head = commit(ws);
  await assert.rejects(lifecycle.archive(a, false, true), /not on any remote/);
  await assert.rejects(lifecycle.archive(a, true), /not on any remote/);
  await lifecycle.archive(a, false, false, true);
  assert.equal(db.getAgent(a.id).lifecycle, 'archived');
  assert.ok(!existsSync(ws.cwd));
  assert.equal(g(repo, 'rev-parse', ws.worktree.branch), head, 'the branch keeps the commit');
});

test('the cascade passes force_unpushed to the named agent only; a child with unpushed commits is kept', async () => {
  const parent = worktreeAgent();
  commit(parent.ws);
  const child = worktreeAgent({ parent: parent.a.id });
  commit(child.ws);
  await lifecycle.archiveCascade(db.getAgent(parent.a.id), false, undefined, undefined, true);
  assert.equal(db.getAgent(parent.a.id).lifecycle, 'archived');
  assert.equal(db.getAgent(child.a.id).lifecycle, 'shut_down', 'the child is not archived');
  assert.ok(existsSync(child.ws.cwd));
});

test('a pending archive past its deadline refuses, clears, records and tells the parent', async () => {
  const boss = worktreeAgent();
  db.updateAgent(boss.a.id, { lifecycle: 'active' });
  const { ws, a } = worktreeAgent({ parent: boss.a.id });
  commit(ws);
  db.updateAgent(a.id, { pending_action: JSON.stringify({ type: 'archive', at: Date.now() - 1000 }) });
  liveSession(a.id);
  await lifecycle.runDueArchives(Date.now(), [db.getAgent(a.id)]);
  const cur = db.getAgent(a.id);
  assert.ok(alive(a.id), 'the harness session is still up');
  assert.equal(quitEvents(a.id).length, 0, 'no quit or archive event');
  assert.equal(cur.lifecycle, 'shut_down');
  assert.equal(cur.pending_action, null, 'no retry loop');
  assert.match(cur.activity_detail, /archive failed: .*not on any remote/);
  assert.ok(db.listEvents(a.id, 50).some((e) => e.type === 'archive:failed' && /not on any remote/.test(e.error ?? JSON.stringify(e))));
  assert.ok(existsSync(ws.cwd));
  await tick();
  assert.ok(events(boss.a.id, 'notice:queued').some((e) => /archive of u\d+ failed at its final-round deadline: can't archive u\d+: branch /.test(e.data ?? '')), 'the parent was told');
});

test('a pending archive with forceUnpushed goes through', async () => {
  const { ws, a } = worktreeAgent();
  commit(ws);
  db.updateAgent(a.id, { pending_action: JSON.stringify({ type: 'archive', at: Date.now() - 1000, forceUnpushed: true }) });
  await lifecycle.runDueArchives(Date.now(), [db.getAgent(a.id)]);
  assert.equal(db.getAgent(a.id).lifecycle, 'archived');
});

test('a git failure refuses instead of passing', () => {
  assert.throws(() => workspace.unpushedRefusal(['--git-dir', join(home, 'no-such-dir')], 'stam/x'), /couldn't check whether stam\/x is pushed/);
  // A missing branch is not a failure: nothing is left behind.
  const { ws, repo } = worktreeAgent();
  assert.equal(workspace.unpushedRefusal(['-C', repo], 'stam/missing'), null);
  assert.equal(workspace.unpushedRefusal(['-C', repo], ws.worktree.branch), null);
});

test('the preflight refuses a live agent at once: it keeps running, nothing is asked of it', async () => {
  const { ws, a } = worktreeAgent();
  commit(ws);
  db.updateAgent(a.id, { lifecycle: 'active', activity: 'idle' });
  liveSession(a.id);
  await assert.rejects(lifecycle.archive(db.getAgent(a.id)), /not on any remote/);
  const cur = db.getAgent(a.id);
  assert.equal(cur.lifecycle, 'active');
  assert.ok(alive(a.id), 'the harness session is still up');
  assert.equal(quitEvents(a.id).length, 0, 'no quit or archive event');
  assert.equal(cur.pending_action, null, 'no pending archive is stored');
  assert.equal(events(a.id, 'prompt:sent').length, 0, 'no final round was asked for');
  assert.ok(existsSync(ws.cwd));
  // The same agent archives once the override is given (its session ended first, so it archives at once).
  spawnSync('tmux', ['-L', socket, 'kill-session', '-t', a.id]);
  db.updateAgent(a.id, { lifecycle: 'shut_down' });
  await lifecycle.archive(db.getAgent(a.id), false, false, true);
  assert.equal(db.getAgent(a.id).lifecycle, 'archived');
});

test('a pending archive at a turn end refuses before stopping the harness, records and tells the parent', async () => {
  const boss = worktreeAgent();
  db.updateAgent(boss.a.id, { lifecycle: 'active' });
  const { ws, a } = worktreeAgent({ parent: boss.a.id });
  commit(ws);
  db.updateAgent(a.id, { lifecycle: 'active', activity: 'idle', pending_action: JSON.stringify({ type: 'archive' }) });
  liveSession(a.id);
  await lifecycle.onIdle(a.id);
  const cur = db.getAgent(a.id);
  assert.ok(alive(a.id), 'the harness session is still up');
  assert.equal(quitEvents(a.id).length, 0, 'no quit or archive event');
  assert.ok(events(a.id, 'notice:queued').some((e) => /Your archive was refused: can't archive u\d+: branch /.test(e.data ?? '')), 'the agent itself was told');
  assert.equal(cur.lifecycle, 'active', 'still running, not half-archived');
  assert.equal(cur.pending_action, null);
  assert.match(cur.activity_detail, /archive failed: .*not on any remote/);
  assert.equal(events(a.id, 'archive:failed').length, 1);
  await tick();
  assert.ok(events(boss.a.id, 'notice:queued').some((e) => /archive of u\d+ failed when its turn ended: can't archive u\d+: branch /.test(e.data ?? '')), 'the parent was told');
});

test('a pending archive on a dead harness refuses, records and tells the parent', async () => {
  const boss = worktreeAgent();
  db.updateAgent(boss.a.id, { lifecycle: 'active' });
  const { ws, a } = worktreeAgent({ parent: boss.a.id });
  commit(ws);
  db.updateAgent(a.id, { lifecycle: 'active', pending_action: JSON.stringify({ type: 'archive', force: true }) });
  await lifecycle.runPendingOnDead(db.getAgent(a.id));
  assert.equal(db.getAgent(a.id).lifecycle, 'active');
  assert.equal(events(a.id, 'archive:failed').length, 1);
  await tick();
  assert.ok(events(boss.a.id, 'notice:queued').some((e) => /archive of u\d+ failed because its harness is gone: can't archive u\d+: branch /.test(e.data ?? '')), 'the parent was told');
});

test('a repo with no remote has nothing to push to: the archive passes', async () => {
  const { ws, repo, a } = worktreeAgent({ remote: false });
  const head = commit(ws);
  assert.equal(workspace.unpushedRefusal(['-C', repo], ws.worktree.branch), null);
  await lifecycle.archive(a);
  assert.equal(db.getAgent(a.id).lifecycle, 'archived');
  assert.equal(g(repo, 'rev-parse', ws.worktree.branch), head);
});

test('the archive route passes force_unpushed to the archive', async () => {
  const { ws, a } = worktreeAgent();
  commit(ws);
  await assert.rejects(daemon.control(db.getAgent(a.id), 'archive', { by: 'x', force: true, discard: true }), /not on any remote/);
  assert.equal(await daemon.control(db.getAgent(a.id), 'archive', { by: 'x', force_unpushed: true }), 'done');
  assert.equal(db.getAgent(a.id).lifecycle, 'archived');
});
