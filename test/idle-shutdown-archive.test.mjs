#!/usr/bin/env node
// S-1393: the daemon archives a shut-down agent once it has been shut down for
// settings.archive.idleShutdownHours and owes nothing: no open ITSA it owns, not standing, cos or
// the assistant, and a worktree (if any) that is clean with its head in origin/main. A check git
// or the home can't make skips the agent. Throwaway STAM_HOME and tmux socket, no daemon, no models:
// `node --test test/idle-shutdown-archive.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-idle-shutdown-');
const socket = `idle-shutdown-test-${process.pid}`;
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = socket;
process.env.STAM_EMBEDDER = 'stub';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [] }));

const HOUR = 3_600_000;
let db, lifecycle, itsa, createWorkspace;
before(async () => {
  db = await import('../src/db.ts');
  lifecycle = await import('../src/lifecycle.ts');
  itsa = await import('../src/itsa.ts');
  ({ createWorkspace } = await import('../src/workspace.ts'));
});
after(() => {
  spawnSync('tmux', ['-L', socket, 'kill-server']);
  rmSync(home, { recursive: true, force: true });
});

let n = 0;
// A shut-down agent with no workspace unless `ws` is given. `kind`, `standing` and `pending`
// set the flags the sweep reads.
function agent({ ws = null, kind = null, standing = 0, pending = null, lifecycle = 'shut_down' } = {}) {
  const id = db.newAgentId();
  const cwd = ws?.cwd ?? join(home, `work-${id}`);
  if (!ws) mkdirSync(cwd);
  db.createAgent({ id, name: `s${++n}`, role: '', machine: 'test', harness: 'fake', model: null, effort: null, cwd, parent_id: null, session_id: `sess-${id}` });
  db.updateAgent(id, { workspace: ws ? JSON.stringify(ws) : null, lifecycle, activity: 'unknown', kind, standing, pending_action: pending });
  db.addEvent(id, 'shutdown', { detail: 'test' });
  return db.getAgent(id);
}

const later = (hours) => Date.now() + hours * HOUR;
const sweep = (hours = 13) => lifecycle.archiveIdleShutdowns(later(hours));

// A repo with one commit; origin/main points at it unless `origin` is false.
function repo({ origin = true } = {}) {
  const dir = join(home, `repo-${++n}`);
  mkdirSync(dir);
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  git('init', '-q');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');
  if (origin) git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  return dir;
}
function worktreeAgent(opts = {}) {
  const r = repo(opts);
  const ws = createWorkspace({ kind: 'worktree', repo: r }, `idle-${n}`);
  return { ws, a: agent({ ws }) };
}
function commitIn(path, msg) {
  execFileSync('git', ['-C', path, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--allow-empty', '-qm', msg], { stdio: 'pipe' });
}

test('a shut-down agent with nothing owed is archived once its shutdown is 12 hours old', async () => {
  const a = agent();
  assert.deepEqual(await lifecycle.archiveIdleShutdowns(later(11)), [], 'not before the 12 hours');
  assert.equal(db.getAgent(a.id).lifecycle, 'shut_down');
  assert.deepEqual(await sweep(), [a.name]);
  assert.equal(db.getAgent(a.id).lifecycle, 'archived');
  assert.equal(db.listEvents(a.id, 500).filter((e) => e.type === 'archive:idle-shutdown').length, 1);
});

test('an active agent, and one with a pending action, are not archived', async () => {
  const active = agent({ lifecycle: 'active' });
  const pending = agent({ pending: JSON.stringify({ type: 'recover' }) });
  await sweep();
  assert.equal(db.getAgent(active.id).lifecycle, 'active');
  assert.equal(db.getAgent(active.id).pending_action, null, 'no archive is queued for an active agent');
  assert.equal(db.listEvents(active.id, 50).filter((e) => e.type === 'archive:idle-shutdown').length, 0);
  assert.equal(db.getAgent(pending.id).lifecycle, 'shut_down');
  assert.equal(db.listEvents(pending.id, 50).filter((e) => e.type === 'archive:idle-shutdown').length, 0);
});

test('an agent that owns an open ITSA is kept; one whose ITSA is closed is archived', async () => {
  const owner = agent();
  const open = await itsa.create({ title: 'Open work', by: 'human', owner: owner.id, kind: 'issue' });
  assert.ok(open.key);
  await sweep();
  assert.equal(db.getAgent(owner.id).lifecycle, 'shut_down', 'an open owned ITSA keeps it');

  const closedOwner = agent();
  await itsa.create({ title: 'Done work', by: 'human', owner: closedOwner.id, kind: 'issue', status: 'done' });
  assert.deepEqual(await sweep(), [closedOwner.name]);
});

test('standing agents, the chief of staff and the assistant are kept', async () => {
  const standing = agent({ standing: 1 });
  const assistant = agent({ kind: 'assistant' });
  const cos = agent();
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [], chiefOfStaff: cos.name }));
  await sweep();
  assert.equal(db.getAgent(standing.id).lifecycle, 'shut_down');
  assert.equal(db.getAgent(assistant.id).lifecycle, 'shut_down');
  assert.equal(db.getAgent(cos.id).lifecycle, 'shut_down');
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [] }));
});

test('a worktree with uncommitted changes is kept', async () => {
  const { ws, a } = worktreeAgent();
  writeFileSync(join(ws.cwd, 'a.txt'), 'changed\n');
  await sweep();
  assert.equal(db.getAgent(a.id).lifecycle, 'shut_down');
});

test('a clean worktree whose branch has no commits of its own is archived', async () => {
  const { a } = worktreeAgent();
  assert.deepEqual(await sweep(), [a.name]);
  assert.equal(db.getAgent(a.id).lifecycle, 'archived');
});

test('a clean worktree with a commit origin/main lacks is kept; one whose commit is merged is archived', async () => {
  const { ws, a } = worktreeAgent();
  commitIn(ws.cwd, 'unmerged work');
  await sweep();
  assert.equal(db.getAgent(a.id).lifecycle, 'shut_down');

  const merged = worktreeAgent();
  commitIn(merged.ws.cwd, 'merged work');
  const mergedSha = execFileSync('git', ['-C', merged.ws.cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', merged.ws.worktree.repo, 'update-ref', 'refs/remotes/origin/main', mergedSha], { stdio: 'pipe' });
  assert.deepEqual(await sweep(), [merged.a.name]);
});

test('a check git cannot make skips the agent: no origin/main to compare with', async () => {
  const { a } = worktreeAgent({ origin: false });
  await sweep();
  assert.equal(db.getAgent(a.id).lifecycle, 'shut_down');
});

test('a pass checks at most IDLE_CHECKS_PER_PASS agents; the rest wait for the next pass', async () => {
  const batch = Array.from({ length: lifecycle.IDLE_CHECKS_PER_PASS + 2 }, () => agent());
  const first = await sweep();
  assert.equal(first.length, lifecycle.IDLE_CHECKS_PER_PASS);
  const second = await sweep();
  assert.equal(second.length, 2);
  for (const a of batch) assert.equal(db.getAgent(a.id).lifecycle, 'archived');
});

test('an ineligible agent is checked again an hour later, so a branch merged later is archived', async () => {
  const { ws, a } = worktreeAgent();
  writeFileSync(join(ws.cwd, 'a.txt'), 'changed\n');
  const t0 = later(13);
  assert.deepEqual(await lifecycle.archiveIdleShutdowns(t0), [], 'dirty, so kept');
  execFileSync('git', ['-C', ws.cwd, 'checkout', '--', 'a.txt'], { stdio: 'pipe' });
  assert.deepEqual(await lifecycle.archiveIdleShutdowns(t0 + 30 * 60_000), [], 'still skipped within the hour');
  assert.deepEqual(await lifecycle.archiveIdleShutdowns(t0 + 61 * 60_000), [a.name], 'checked again after the hour');
});

test('a stop after a resume is dated from that stop, not from an older shutdown event', async () => {
  const a = agent();
  // The first stop's shutdown event, dated 20 h before the second stop.
  const first = Date.parse(db.getAgent(a.id).updated_at) - 20 * HOUR;
  db.open().prepare("UPDATE events SET ts = ? WHERE agent_id = ? AND type = 'shutdown'").run(new Date(first).toISOString(), a.id);
  db.updateAgent(a.id, { lifecycle: 'active' });
  db.updateAgent(a.id, { lifecycle: 'shut_down', activity_detail: 'never started: no harness process' });
  const stopped = Date.parse(db.getAgent(a.id).updated_at);
  assert.deepEqual(await lifecycle.archiveIdleShutdowns(stopped + 11.5 * HOUR), [], 'counted from the new stop');
  assert.equal(db.getAgent(a.id).lifecycle, 'shut_down');
  assert.deepEqual(await lifecycle.archiveIdleShutdowns(stopped + 13 * HOUR), [a.name]);
});

// A fresh node process reads the same STAM_HOME, as a daemon does after a deploy restart.
function sweepInFreshProcess(at) {
  const lib = new URL('../src/lifecycle.ts', import.meta.url).href;
  const script = `const l = await import(${JSON.stringify(lib)}); console.log(JSON.stringify(await l.archiveIdleShutdowns(${at})));`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: process.env }).trim());
}

test('after a daemon restart the stop is dated from updated_at', () => {
  const a = agent();
  const stopped = Date.parse(db.getAgent(a.id).updated_at);
  assert.deepEqual(sweepInFreshProcess(stopped + 11 * HOUR), [], 'not yet 12 h');
  assert.deepEqual(sweepInFreshProcess(stopped + 13 * HOUR), [a.name]);
});

test('a pass probes at most IDLE_CHECKS_PER_PASS agents, each with a few git calls', async () => {
  // A git shim on PATH logs each call, then runs the real git.
  const shim = join(home, 'git-shim');
  mkdirSync(shim);
  const log = join(home, 'git-calls.log');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(shim, 'git'), `#!/bin/sh\necho "$@" >> ${log}\nexec ${realGit} "$@"\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim}:${oldPath}`;
  try {
    for (let i = 0; i < lifecycle.IDLE_CHECKS_PER_PASS + 2; i++) {
      const { ws } = worktreeAgent();
      writeFileSync(join(ws.cwd, 'a.txt'), 'changed\n');
    }
    const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
    const probes = () => calls().filter((c) => c.endsWith('status --porcelain')).length;
    const setup = calls().length;
    await lifecycle.archiveIdleShutdowns(later(13));
    assert.equal(probes(), lifecycle.IDLE_CHECKS_PER_PASS, 'the first pass probes the budget and no more');
    assert.ok(calls().length - setup <= lifecycle.IDLE_CHECKS_PER_PASS * 3, 'at most three git calls per probed agent');
    const before = probes();
    await lifecycle.archiveIdleShutdowns(later(13));
    assert.equal(probes() - before, 2, 'the next pass probes the agents still waiting');
  } finally {
    process.env.PATH = oldPath;
  }
});
