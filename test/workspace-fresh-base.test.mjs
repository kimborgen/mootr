#!/usr/bin/env node
// A worktree with no base is cut from a freshly fetched origin/main, else HEAD, recorded (S-1666, src/workspace.ts).
// Run with `node --test test/workspace-fresh-base.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmphome.mjs';

const base = tempDir('stam-fresh-base-');
process.env.STAM_HOME = join(base, 'home');
mkdirSync(process.env.STAM_HOME, { recursive: true });
const git = (cwd, args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
let ws, repo, other, stale, fresh;

before(async () => {
  git(base, ['init', '-q', '--bare', '-b', 'main', 'origin.git']);
  repo = join(base, 'repo');
  other = join(base, 'other');
  git(base, ['clone', '-q', join(base, 'origin.git'), 'repo']);
  writeFileSync(join(repo, 'a.txt'), 'x');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'old']);
  git(repo, ['push', '-q', 'origin', 'HEAD:main']);
  stale = git(repo, ['rev-parse', 'HEAD']);
  // Another clone advances origin/main; `repo` (the live checkout) never pulls.
  git(base, ['clone', '-q', join(base, 'origin.git'), 'other']);
  writeFileSync(join(other, 'b.txt'), 'y');
  git(other, ['add', '.']);
  git(other, ['commit', '-qm', 'new']);
  git(other, ['push', '-q', 'origin', 'HEAD:main']);
  fresh = git(other, ['rev-parse', 'HEAD']);
  ws = await import('../src/workspace.ts');
});
after(() => rmSync(base, { recursive: true, force: true }));

const head = (w) => git(w.cwd, ['rev-parse', 'HEAD']);

test('no base: the branch starts at the fetched origin/main, not the checkout HEAD, and it is recorded', async () => {
  const w = await ws.createWorkspaceFetched({ kind: 'worktree', repo }, 'fresh-ok');
  assert.equal(head(w), fresh);
  assert.notEqual(head(w), stale);
  assert.deepEqual(w.baseUsed, { ref: 'origin/main', sha: fresh, fetch: 'ok', defaulted: true });
  assert.equal(w.worktree.base, undefined, 'no stacked-PR base is claimed');
});

test('a failing fetch falls back to the local origin/main ref, else HEAD, and records the failure', async () => {
  // The live checkout's remote-tracking ref is newer than its HEAD: the fallback must use it.
  git(repo, ['fetch', '-q', 'origin']);
  const tracked = git(repo, ['rev-parse', 'refs/remotes/origin/main']);
  assert.notEqual(tracked, stale);
  git(repo, ['remote', 'set-url', 'origin', join(base, 'gone.git')]);
  const w = await ws.createWorkspaceFetched({ kind: 'worktree', repo }, 'fresh-fail');
  assert.equal(head(w), tracked);
  assert.equal(w.baseUsed.ref, 'origin/main');
  assert.equal(w.baseUsed.fetch, 'failed');
  assert.equal(w.baseUsed.defaulted, true);
  assert.ok(w.baseUsed.error);
  // With no tracking ref at all, HEAD.
  git(repo, ['update-ref', '-d', 'refs/remotes/origin/main']);
  const h = await ws.createWorkspaceFetched({ kind: 'worktree', repo }, 'fresh-fail-head');
  assert.equal(head(h), stale);
  assert.equal(h.baseUsed.ref, 'HEAD');
  assert.equal(h.baseUsed.fetch, 'failed');
  git(repo, ['remote', 'set-url', 'origin', join(base, 'origin.git')]);
});

test('concurrent spawns share one in-flight fetch', async () => {
  // A git wrapper first on PATH logs every command and runs the real git.
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const log = join(base, 'git-calls.log');
  mkdirSync(join(base, 'bin'), { recursive: true });
  writeFileSync(join(base, 'bin', 'git'), `#!/bin/sh\necho "$@" >> ${log}\nexec ${realGit} "$@"\n`);
  chmodSync(join(base, 'bin', 'git'), 0o755);
  writeFileSync(log, '');
  const path = process.env.PATH;
  process.env.PATH = `${join(base, 'bin')}:${path}`;
  try {
    const [a, b, c] = await Promise.all([ws.prefetchBase(repo), ws.prefetchBase(repo), ws.prefetchBase(repo)]);
    assert.ok(a.ok && b.ok && c.ok);
  } finally {
    process.env.PATH = path;
  }
  assert.equal(readFileSync(log, 'utf8').split('\n').filter((l) => / fetch /.test(l)).length, 1, 'one git fetch for three spawns');
});

test('a hanging remote is cut off at the deadline, grandchildren killed, and falls back', async () => {
  process.env.STAM_FETCH_TIMEOUT_MS = '1500';
  process.env.GIT_SSH_COMMAND = 'sh -c "sleep 60" --';
  git(repo, ['remote', 'set-url', 'origin', 'ssh://nowhere.invalid/x.git']);
  try {
    const t = Date.now();
    const w = await ws.createWorkspaceFetched({ kind: 'worktree', repo }, 'fresh-hang');
    assert.ok(Date.now() - t < 10_000, 'returned near the deadline, not after the 60 s sleep');
    assert.equal(w.baseUsed.fetch, 'failed');
    assert.match(w.baseUsed.error, /timed out/);
  } finally {
    delete process.env.STAM_FETCH_TIMEOUT_MS;
    delete process.env.GIT_SSH_COMMAND;
    git(repo, ['remote', 'set-url', 'origin', join(base, 'origin.git')]);
  }
});

test('a repo with no origin remote is cut from HEAD with nothing fetched or recorded', async () => {
  const solo = join(base, 'solo');
  git(base, ['init', '-q', '-b', 'main', 'solo']);
  writeFileSync(join(solo, 'a.txt'), 'x');
  git(solo, ['add', '.']);
  git(solo, ['commit', '-qm', 'c']);
  const w = await ws.createWorkspaceFetched({ kind: 'worktree', repo: solo }, 'solo-wt');
  assert.equal(head(w), git(solo, ['rev-parse', 'HEAD']));
  assert.equal(w.baseUsed, undefined);
});

test('an explicit base is fetched once, async, and recorded', async () => {
  git(other, ['push', '-q', 'origin', 'HEAD:refs/heads/stam/stk']);
  const w = await ws.createWorkspaceFetched({ kind: 'worktree', repo, base: 'origin/stam/stk' }, 'fresh-stk');
  assert.equal(head(w), fresh);
  assert.deepEqual(w.baseUsed, { ref: 'origin/stam/stk', sha: fresh, fetch: 'ok', continued: 'stam/stk' });
  assert.equal(w.worktree.base, 'origin/stam/stk');
});
