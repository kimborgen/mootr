#!/usr/bin/env node
// S-912: archiving a reviewer removes its own ~/.cache/stam-review/<name> clone and nothing else.
// Throwaway HOME, no daemon: `node --test test/review-dir-cleanup.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, symlinkSync, chmodSync, readlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tempDir } from './tmphome.mjs';

const outer = tempDir('stam-review-dir-');
const home = join(outer, 'home');
mkdirSync(home);
process.env.STAM_HOME = home;
process.env.HOME = home;
const pt = await import('../src/proctree.ts');
const root = join(home, '.cache', 'stam-review');

const populate = (dir) => {
  mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'x', 'i.js'), '1');
};

test('reviewDirOf accepts one plain segment only', () => {
  assert.equal(pt.reviewDirOf('rev-a'), join(root, 'rev-a'));
  for (const bad of ['', '.', '..', '../x', 'a/b', '/etc', '.hidden']) assert.equal(pt.reviewDirOf(bad), null, bad);
});

test('archive removes the reviewer dir and leaves a sibling untouched', async () => {
  populate(join(root, 'rev-a'));
  populate(join(root, 'rev-b'));
  const msg = await pt.removeReviewDir({ id: 'a1', name: 'rev-a' }, [], root);
  assert.match(msg, /removed/);
  assert.equal(existsSync(join(root, 'rev-a')), false);
  assert.equal(existsSync(join(root, 'rev-b', 'node_modules', 'x', 'i.js')), true);
});

test('no review dir is a no-op; a symlink is refused and its target kept', async () => {
  assert.equal(await pt.removeReviewDir({ id: 'a2', name: 'none' }, [], root), 'no review dir');
  const target = join(home, 'elsewhere');
  populate(target);
  symlinkSync(target, join(root, 'rev-link'));
  assert.match(await pt.removeReviewDir({ id: 'a3', name: 'rev-link' }, [], root), /refused/);
  assert.equal(existsSync(join(target, 'node_modules')), true);
});

test('a read-only subdir is reported, not thrown; a live agent inside keeps the dir; a test home skips the real root', async () => {
  const ro = join(root, 'rev-ro');
  populate(ro);
  chmodSync(join(ro, 'node_modules'), 0o500);
  try {
    const msg = await pt.removeReviewDir({ id: 'a4', name: 'rev-ro' }, [], root);
    if (process.getuid?.() !== 0) assert.match(msg, /EACCES|permission/i);
  } finally {
    chmodSync(join(ro, 'node_modules'), 0o700);
  }
  populate(join(root, 'rev-live'));
  assert.match(await pt.removeReviewDir({ id: 'a5', name: 'rev-live' }, [join(root, 'rev-live', 'sub')], root), /live agent/);
  assert.equal(existsSync(join(root, 'rev-live')), true);
  writeFileSync(join(home, '.stam-test-home'), '');
  writeFileSync(join(outer, 'owner'), 'x');
  assert.equal(await pt.removeReviewDir({ id: 'a6', name: 'rev-live' }), 'no review dir', 'a test home without a root override does nothing');
  assert.equal(existsSync(join(root, 'rev-live')), true);
});

test('reviewTmpDirOf names a dot folder beside the clone, never an agent name', () => {
  assert.equal(pt.reviewTmpDirOf('rev-a'), join(root, '.tmp-rev-a'));
  assert.equal(pt.reviewDirOf('.tmp-rev-a'), null, 'a dot name is no agent clone');
  assert.equal(pt.reviewTmpDirOf('../x'), null);
});

test('archive removes the reviewer test folder and keeps a sibling', async () => {
  populate(join(root, '.tmp-rev-t'));
  populate(join(root, '.tmp-rev-u'));
  assert.match(await pt.removeReviewTmpDir({ id: 't1', name: 'rev-t' }, [], root), /removed/);
  assert.equal(existsSync(join(root, '.tmp-rev-t')), false);
  assert.equal(existsSync(join(root, '.tmp-rev-u', 'node_modules', 'x', 'i.js')), true);
  assert.equal(await pt.removeReviewTmpDir({ id: 't2', name: 'rev-t' }, [], root), 'no review tmp dir');
});

test('a live agent inside the reviewer test folder keeps it', async () => {
  const tmp = join(root, '.tmp-rev-live');
  populate(tmp);
  assert.match(await pt.removeReviewTmpDir({ id: 't3', name: 'rev-live' }, [join(tmp, 'sub')], root), /live agent/);
  assert.equal(existsSync(join(tmp, 'node_modules', 'x', 'i.js')), true);
});

// spawn returns before the child has its cwd, so the process scan could miss it (S-1394).
async function waitForCwd(pid, dir, capMs = 2000) {
  const end = Date.now() + capMs;
  for (;;) {
    try {
      if (readlinkSync(`/proc/${pid}/cwd`) === dir) return;
    } catch {}
    if (Date.now() >= end) throw new Error(`child ${pid} never reached cwd ${dir} within ${capMs} ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('a process using the reviewer test folder keeps it', async () => {
  const tmp = join(root, '.tmp-rev-busy');
  populate(tmp);
  // A clean env, so the child is an unrelated process and not a stam-* test home's (S-1441).
  const child = spawn('sleep', ['30'], { cwd: tmp, stdio: 'ignore', env: { PATH: process.env.PATH } });
  try {
    await waitForCwd(child.pid, tmp);
    assert.match(await pt.removeReviewTmpDir({ id: 't4', name: 'rev-busy' }, [], root), /process uses it/);
    assert.equal(existsSync(join(tmp, 'node_modules', 'x', 'i.js')), true);
  } finally {
    child.kill();
  }
});

test('a symlinked reviewer test folder is refused and its target kept', async () => {
  const target = join(home, 'elsewhere-tmp');
  populate(target);
  symlinkSync(target, join(root, '.tmp-rev-link'));
  assert.match(await pt.removeReviewTmpDir({ id: 't5', name: 'rev-link' }, [], root), /refused/);
  assert.equal(existsSync(join(target, 'node_modules')), true);
});

test('a spawn makes no test folder in a test home, or when the spec sets one', () => {
  const guard = join(outer, 'guard');
  const testRoot = join(guard, 'home');
  mkdirSync(testRoot, { recursive: true });
  writeFileSync(join(testRoot, '.stam-test-home'), '');
  writeFileSync(join(guard, 'owner'), 'x');
  assert.equal(pt.reviewTmpForSpawn('rev-g', {}, testRoot), null, 'a test home makes none');
  const plain = join(outer, 'plain-home');
  mkdirSync(plain);
  assert.equal(pt.reviewTmpForSpawn('rev-g', {}, plain), pt.reviewTmpDirOf('rev-g'), 'the live home makes one');
  assert.equal(pt.reviewTmpForSpawn('rev-g', { STAM_TEST_TMPDIR: '/x' }, plain), null, 'the spec wins');
});
