#!/usr/bin/env node
// A developer spawned on origin/stam/X continues that PR's branch (S-3113, src/workspace.ts): the worktree goes on
// stam/X at the base, refusing closed when the branch is held or a reset would lose commits; `branch` stacks a new one.
// Run with `node --test test/workspace-continue-pr.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmphome.mjs';

const base = tempDir('stam-continue-pr-');
process.env.STAM_HOME = join(base, 'home');
mkdirSync(process.env.STAM_HOME, { recursive: true });
const git = (cwd, args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
let createWorkspace, cleanupWorkspace, spawnWorkspaceSpec, repo, n = 0;

// A fresh PR branch on origin with one commit past main, fetched here; returns its name.
const prBranch = () => {
  const name = `stam/pr${++n}`;
  git(repo, ['checkout', '-q', '-b', `tmp${n}`, 'origin/main']);
  writeFileSync(join(repo, `f${n}.txt`), 'x');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', `pr ${n}`]);
  git(repo, ['push', '-q', 'origin', `HEAD:refs/heads/${name}`]);
  git(repo, ['checkout', '-q', '--detach', 'origin/main']);
  git(repo, ['branch', '-qD', `tmp${n}`]);
  git(repo, ['fetch', '-q', 'origin']);
  return name;
};
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
// Puts a git wrapper first on PATH that runs SNIPPET (shell) before the real git; returns the undo.
const wrap = (snippet) => {
  mkdirSync(join(base, 'bin'), { recursive: true });
  writeFileSync(join(base, 'bin', 'git'), `#!/bin/sh\n${snippet}\nexec ${realGit} "$@"\n`);
  chmodSync(join(base, 'bin', 'git'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${join(base, 'bin')}:${path}`;
  return () => {
    process.env.PATH = path;
    rmSync(join(base, 'bin', 'git'), { force: true });
  };
};
const sha = (ref) => git(repo, ['rev-parse', ref]);
const cont = (agent, extra = {}, name) => createWorkspace({ kind: 'worktree', repo, base: `origin/${name}`, ...extra }, agent);

before(async () => {
  git(base, ['init', '-q', '--bare', '-b', 'main', 'origin.git']);
  repo = join(base, 'repo');
  git(base, ['clone', '-q', join(base, 'origin.git'), 'repo']);
  writeFileSync(join(repo, 'a.txt'), 'x');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'base']);
  git(repo, ['push', '-q', 'origin', 'HEAD:main']);
  git(repo, ['fetch', '-q', 'origin']);
  git(repo, ['checkout', '-q', '--detach', 'origin/main']);
  ({ createWorkspace, cleanupWorkspace, spawnWorkspaceSpec } = await import('../src/workspace.ts'));
});
after(() => rmSync(base, { recursive: true, force: true }));

test('a base of origin/stam/X puts the worktree on stam/X at the base sha, and the record says so', () => {
  const pr = prBranch();
  const w = cont('a1', {}, pr);
  assert.equal(w.worktree.branch, pr);
  assert.equal(w.worktree.continues, true);
  assert.equal(w.baseUsed.continued, pr);
  assert.equal(git(w.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']), pr);
  assert.equal(sha(pr), sha(`origin/${pr}`));
  assert.equal(JSON.parse(JSON.stringify(w)).worktree.continues, true, 'survives the JSON the db stores');
});

test('a stale local stam/X that is an ancestor of the base is reset to it; an absent one is made', () => {
  const pr = prBranch();
  git(repo, ['branch', pr, 'origin/main']); // an ancestor of the base
  const w = cont('a2', {}, pr);
  assert.equal(sha(pr), sha(`origin/${pr}`));
  assert.equal(w.worktree.branch, pr);
});

test('refused: stam/X checked out in another live worktree (names the holder and the fix)', () => {
  const pr = prBranch();
  cont('h1', {}, pr);
  assert.throws(() => cont('h2', {}, pr), (e) => /checked out in .*-h1/.test(e.message) && /archive/.test(e.message) && /pass branch/.test(e.message));
});

test('refused: git itself refuses a second take of stam/X even when our own worktree check sees nothing', () => {
  const pr = prBranch();
  cont('r1', {}, pr);
  // A git wrapper that lists no worktrees: the check passes on a stale view, and `worktree add -B` must still refuse.
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  mkdirSync(join(base, 'bin'), { recursive: true });
  writeFileSync(join(base, 'bin', 'git'), `#!/bin/sh\ncase "$*" in *"worktree list"*) exit 0;; esac\nexec ${realGit} "$@"\n`);
  chmodSync(join(base, 'bin', 'git'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${join(base, 'bin')}:${path}`;
  try {
    assert.throws(() => cont('r2', {}, pr), /couldn't put the worktree on .*pass branch/);
  } finally {
    process.env.PATH = path;
  }
});

test('refused: a local stam/X with commits the base lacks would lose them', () => {
  const pr = prBranch();
  git(repo, ['checkout', '-q', '-b', 'scratch', `origin/${pr}`]);
  writeFileSync(join(repo, 'local.txt'), 'x');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'local only']);
  git(repo, ['checkout', '-q', '--detach', 'origin/main']);
  git(repo, ['branch', '-f', pr, 'scratch']);
  git(repo, ['branch', '-qD', 'scratch']);
  const tip = sha(pr);
  assert.throws(() => cont('l1', {}, pr), /not in .*would lose them/);
  assert.equal(sha(pr), tip, 'nothing was reset');
});

test('refused: a git inspection error other than "no such branch" fails closed', () => {
  const pr = prBranch();
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  mkdirSync(join(base, 'bin'), { recursive: true });
  writeFileSync(join(base, 'bin', 'git'), `#!/bin/sh\ncase "$*" in *"rev-parse --verify --quiet refs/heads/${pr}"*) exit 128;; esac\nexec ${realGit} "$@"\n`);
  chmodSync(join(base, 'bin', 'git'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${join(base, 'bin')}:${path}`;
  try {
    assert.throws(() => cont('e1', {}, pr), /couldn't check local/);
  } finally {
    process.env.PATH = path;
  }
});

test('an explicit branch, or "new", stacks a new branch on the PR instead', () => {
  const pr = prBranch();
  const named = cont('s1', { branch: 'stam/stack-one' }, pr);
  assert.equal(named.worktree.branch, 'stam/stack-one');
  assert.equal(named.worktree.continues, undefined);
  assert.equal(sha('stam/stack-one'), sha(`origin/${pr}`));
  const fresh = cont('s2', { branch: 'new' }, pr);
  assert.equal(fresh.worktree.branch, 'stam/s2');
  assert.equal(fresh.worktree.continues, undefined);
  // A held PR branch does not block a stacked spawn: it never takes the branch.
  const held = cont('s3', {}, pr);
  assert.equal(held.worktree.branch, pr);
  assert.equal(cont('s4', { branch: 'new' }, pr).worktree.branch, 'stam/s4');
});

test('no base, or a non-stam base, keeps the plain default and its reuse refusal (S-1419)', () => {
  assert.equal(createWorkspace({ kind: 'worktree', repo }, 'plain').worktree.branch, 'stam/plain');
  assert.equal(createWorkspace({ kind: 'worktree', repo, base: 'origin/main' }, 'plain2').worktree.branch, 'stam/plain2');
  git(repo, ['branch', 'stam/taken', 'origin/main']);
  assert.throws(() => createWorkspace({ kind: 'worktree', repo, base: 'origin/main' }, 'taken'), /already exists/);
});

test('archive never deletes the PR branch, even when the agent added nothing; a later ancestry check still works', () => {
  const pr = prBranch();
  const w = cont('c1', {}, pr);
  const msg = cleanupWorkspace(w, false, true);
  assert.match(msg, /kept: it is the branch of the PR/);
  assert.equal(sha(pr), sha(`origin/${pr}`), 'branch still there');
  git(repo, ['merge-base', '--is-ancestor', pr, `origin/${pr}`]);
  // The PR branch is free again for the next spawn.
  assert.equal(cont('c2', {}, pr).worktree.branch, pr);
});

test('a ref that moves to a non-descendant after the inspection is not overwritten: the spawn is refused and leaves no worktree', () => {
  const pr = prBranch();
  git(repo, ['branch', pr, 'origin/main']); // free, an ancestor of the base
  git(repo, ['checkout', '-q', '-b', 'extra', 'origin/main']);
  writeFileSync(join(repo, 'moved.txt'), 'x');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'lands in the window']);
  const moved = sha('extra');
  git(repo, ['checkout', '-q', '--detach', 'origin/main']);
  // A git wrapper that moves the branch just before the spawn takes it.
  const restore = wrap(`case "$*" in *"update-ref refs/heads/${pr} "*|*"worktree add "*" ${pr}") ${realGit} -C ${repo} update-ref refs/heads/${pr} ${moved};; esac`);
  try {
    assert.throws(() => cont('m1', {}, pr), /moved while the spawn was starting/);
  } finally {
    restore();
  }
  assert.equal(sha(pr), moved, 'the commit that landed in the window survives');
  assert.doesNotMatch(git(repo, ['worktree', 'list']), /-m1\b/, 'no half-made worktree is left');
});

test('a ref that advances to a descendant of the base in the gap is kept, and the spawn is refused with no worktree', () => {
  const pr = prBranch();
  git(repo, ['branch', pr, 'origin/main']);
  git(repo, ['checkout', '-q', '-b', 'ahead', `origin/${pr}`]);
  writeFileSync(join(repo, 'ahead.txt'), 'x');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'ahead of the base']);
  const ahead = sha('ahead');
  git(repo, ['checkout', '-q', '--detach', 'origin/main']);
  const restore = wrap(`case "$*" in *"worktree add "*" ${pr}") ${realGit} -C ${repo} update-ref refs/heads/${pr} ${ahead};; esac`);
  try {
    assert.throws(() => cont('d2', {}, pr), /moved while the spawn was starting/);
  } finally {
    restore();
  }
  assert.equal(sha(pr), ahead, 'the ref stays where it moved');
  assert.doesNotMatch(git(repo, ['worktree', 'list']), /-d2\b/, 'no worktree is left');
});

test('another worktree that takes the unchanged branch in the gap is left intact and the spawn is refused', () => {
  const pr = prBranch();
  git(repo, ['branch', pr, 'origin/main']);
  const a = sha(pr);
  const other = join(base, 'other-holder');
  const restore = wrap(`case "$*" in *"update-ref refs/heads/${pr} "*|*"worktree add "*" ${pr}") [ -d ${other} ] || ${realGit} -C ${repo} worktree add -q ${other} ${pr};; esac`);
  try {
    assert.throws(() => cont('g1', {}, pr), /couldn't put the worktree on/);
  } finally {
    restore();
  }
  assert.equal(git(other, ['rev-parse', 'HEAD']), a, 'the holder HEAD did not move');
  assert.equal(git(other, ['status', '--porcelain']), '', 'its index and files match its HEAD');
  assert.doesNotMatch(git(repo, ['worktree', 'list']), /-g1\b/, 'no half-made worktree is left');
});

test('a reviewer type with a stam/ base gets its own branch, even while the developer holds stam/X', () => {
  const pr = prBranch();
  const dev = cont('d1', {}, pr);
  assert.equal(dev.worktree.branch, pr);
  for (const type of [{ review: { members: [] } }]) {
    const spec = spawnWorkspaceSpec({ base: `origin/${pr}` }, type, repo);
    const rev = createWorkspace(spec, 'rev1');
    assert.equal(rev.worktree.branch, 'stam/rev1');
    assert.equal(rev.worktree.continues, undefined);
    assert.equal(sha('stam/rev1'), sha(`origin/${pr}`));
  }
  // A developer type without review still continues.
  assert.equal(spawnWorkspaceSpec({ base: `origin/${pr}` }, { worktree: true }, repo).branch, undefined);
});
