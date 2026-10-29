#!/usr/bin/env node
// A new agent named like an old one must not get the old one's stam/NAME branch: it gets a free -2, -3 suffix (S-1419, S-3486, src/workspace.ts).
// Run with `node --test test/workspace-reused-branch.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmphome.mjs';

const base = tempDir('stam-reused-branch-');
process.env.STAM_HOME = join(base, 'home');
mkdirSync(process.env.STAM_HOME, { recursive: true });
const git = (cwd, args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
let createWorkspace, repo;

before(async () => {
  mkdirSync(join(base, 'bin'), { recursive: true });
  git(base, ['init', '-q', '--bare', '-b', 'main', 'origin.git']);
  git(base, ['init', '-q', '--bare', '-b', 'main', 'storage.git']);
  repo = join(base, 'repo');
  git(base, ['clone', '-q', join(base, 'origin.git'), 'repo']);
  git(repo, ['remote', 'add', 'storage', join(base, 'storage.git')]);
  writeFileSync(join(repo, 'a.txt'), 'x');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'base']);
  git(repo, ['push', '-q', 'origin', 'HEAD:main']);
  (await import('../src/settings.ts')).setSetting('peers', [{ name: 'storage', url: 'http://peer.example.com:7878', token: 'test-peer-token' }]);
  ({ createWorkspace } = await import('../src/workspace.ts'));
});
after(() => rmSync(base, { recursive: true, force: true }));

test('a stam/NAME known here as a remote-tracking ref gets a free suffix, with no network call; a free name and an explicit branch are untouched', () => {
  git(repo, ['push', '-q', 'origin', 'HEAD:refs/heads/stam/onorigin']);
  git(repo, ['fetch', '-q', 'origin']);
  git(repo, ['update-ref', 'refs/remotes/storage/stam/onstorage', 'HEAD']);
  // storage points nowhere: any ls-remote or fetch against it would fail or hang.
  git(repo, ['remote', 'set-url', 'storage', 'ssh://127.0.0.1:9/nowhere.git']);
  // A git wrapper first on PATH logs every command and runs the real git; the fixture above is set up before it.
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const log = join(base, 'git-calls.log');
  writeFileSync(join(base, 'bin', 'git'), `#!/bin/sh\necho "$@" >> ${log}\nexec ${realGit} "$@"\n`);
  chmodSync(join(base, 'bin', 'git'), 0o755);
  writeFileSync(log, '');
  const path = process.env.PATH;
  process.env.PATH = `${join(base, 'bin')}:${path}`;
  try {
    assert.equal(createWorkspace({ kind: 'worktree', repo }, 'onorigin').worktree.branch, 'stam/onorigin-2');
    assert.equal(createWorkspace({ kind: 'worktree', repo }, 'onstorage').worktree.branch, 'stam/onstorage-2');
    assert.equal(createWorkspace({ kind: 'worktree', repo }, 'fresh').worktree.branch, 'stam/fresh');
    // An explicit branch is taken as given, even a name that exists here.
    assert.equal(createWorkspace({ kind: 'worktree', repo, branch: 'stam/onorigin' }, 'other').worktree.branch, 'stam/onorigin');
  } finally {
    process.env.PATH = path;
  }
  const calls = readFileSync(log, 'utf8');
  assert.ok(calls.includes('for-each-ref'), 'the wrapper saw the check');
  assert.doesNotMatch(calls, /ls-remote|fetch|pull|push/, 'no network git at spawn');
});

test('a storage remote under another name (box2) is checked as the storage remote, through its peer', () => {
  const st = (name) => git(repo, ['remote']).split('\n').includes(name);
  git(repo, ['remote', 'remove', 'storage']);
  git(base, ['init', '-q', '--bare', '-b', 'main', 'box2.git']);
  git(repo, ['remote', 'add', 'box2', join(base, 'box2.git')]);
  assert.ok(st('box2') && !st('storage'));
  git(repo, ['update-ref', 'refs/remotes/box2/stam/onbox2', 'HEAD']);
  return import('../src/settings.ts').then(({ setSetting }) => {
    setSetting('peers', [{ name: 'box2', url: 'http://box2.example.com:7878', token: 'test-peer-token' }]);
    assert.equal(createWorkspace({ kind: 'worktree', repo }, 'onbox2').worktree.branch, 'stam/onbox2-2');
    assert.equal(createWorkspace({ kind: 'worktree', repo }, 'fresh2').worktree.branch, 'stam/fresh2');
  });
});

test('-2 taken as well gets -3, and the worktree reports the suffix (S-3486)', () => {
  git(repo, ['update-ref', 'refs/remotes/origin/stam/twice', 'HEAD']);
  git(repo, ['update-ref', 'refs/remotes/origin/stam/twice-2', 'HEAD']);
  const ws = createWorkspace({ kind: 'worktree', repo }, 'twice');
  assert.equal(ws.worktree.branch, 'stam/twice-3');
  assert.equal(ws.worktree.suffixed, true);
  assert.equal(git(ws.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']), 'stam/twice-3', 'the worktree is on the stored branch');
  assert.equal(createWorkspace({ kind: 'worktree', repo }, 'untaken').worktree.suffixed, undefined);
});

test('a name that exists only on the fake origin (a list from ls-remote) gets a suffix (S-3486)', () => {
  const ws = createWorkspace({ kind: 'worktree', repo }, 'ghonly', undefined, ['stam/ghonly', 'stam/ghonly-2']);
  assert.equal(ws.worktree.branch, 'stam/ghonly-3');
});

test('createWorkspaceFetched asks origin for the name, and an unreachable origin falls back to the local refs (S-3486)', async () => {
  const { createWorkspaceFetched } = await import('../src/workspace.ts');
  git(repo, ['push', '-q', 'origin', 'HEAD:refs/heads/stam/remoteonly']);
  // origin has it, this checkout never fetched it (the push's own tracking ref is dropped).
  git(repo, ['update-ref', '-d', 'refs/remotes/origin/stam/remoteonly']);
  assert.equal(git(repo, ['for-each-ref', 'refs/remotes/origin/stam/remoteonly']), '');
  assert.equal((await createWorkspaceFetched({ kind: 'worktree', repo }, 'remoteonly')).worktree.branch, 'stam/remoteonly-2');
  // branch "new" asks for the default name too (a stacked PR), so origin is asked for it as well (S-3486).
  git(repo, ['push', '-q', 'origin', 'HEAD:refs/heads/stam/newonly']);
  git(repo, ['update-ref', '-d', 'refs/remotes/origin/stam/newonly']);
  assert.equal((await createWorkspaceFetched({ kind: 'worktree', repo, branch: 'new' }, 'newonly')).worktree.branch, 'stam/newonly-2');
  // An explicit branch is not asked about.
  assert.equal((await createWorkspaceFetched({ kind: 'worktree', repo, branch: 'stam/newonly' }, 'x')).worktree.branch, 'stam/newonly');
  git(repo, ['remote', 'set-url', 'origin', join(base, 'gone.git')]);
  assert.equal((await createWorkspaceFetched({ kind: 'worktree', repo }, 'whenstopped')).worktree.branch, 'stam/whenstopped');
});
