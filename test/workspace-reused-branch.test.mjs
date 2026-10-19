#!/usr/bin/env node
// A new agent named like an old one must not get the old one's stam/NAME branch (S-1419, src/workspace.ts).
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
  (await import('../src/settings.ts')).setSetting('peers', [{ name: 'storage', url: 'http://storage:7878', token: 't' }]);
  ({ createWorkspace } = await import('../src/workspace.ts'));
});
after(() => rmSync(base, { recursive: true, force: true }));

test('a stam/NAME known here as a remote-tracking ref refuses the spawn, with no network call; a free name and an explicit branch pass', () => {
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
    assert.throws(() => createWorkspace({ kind: 'worktree', repo }, 'onorigin'), /stam\/onorigin already exists/);
    assert.throws(() => createWorkspace({ kind: 'worktree', repo }, 'onstorage'), /stam\/onstorage already exists/);
    assert.equal(createWorkspace({ kind: 'worktree', repo }, 'fresh').worktree.branch, 'stam/fresh');
    assert.equal(createWorkspace({ kind: 'worktree', repo, branch: 'stam/onorigin-2' }, 'onorigin').worktree.branch, 'stam/onorigin-2');
  } finally {
    process.env.PATH = path;
  }
  const calls = readFileSync(log, 'utf8');
  assert.ok(calls.includes('for-each-ref'), 'the wrapper saw the check');
  assert.doesNotMatch(calls, /ls-remote|fetch|pull|push/, 'no network git at spawn');
});
