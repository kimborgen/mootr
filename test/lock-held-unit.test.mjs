#!/usr/bin/env node
// The /proc/locks lock probe (S-3144, scripts/lock-held.mjs): it sees a lock a child flock holds, never takes one, matches the
// device as well as the inode, skips waiter lines, and reports a missing file as free. Fake /proc/locks text covers the shapes
// no single test machine produces. Run with `node --test test/lock-held-unit.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmphome.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const { lockHeld } = await import(join(ROOT, 'scripts/lock-held.mjs'));

// The device and inode of PATH as /proc/locks prints them (glibc major/minor split, hex).
function devIno(path) {
  const st = statSync(path, { bigint: true });
  const major = ((st.dev >> 8n) & 0xfffn) | ((st.dev >> 32n) & ~0xfffn);
  const minor = (st.dev & 0xffn) | ((st.dev >> 12n) & ~0xffn);
  return { major, minor, ino: st.ino };
}
const line = (kind, major, minor, ino, { waiter = false } = {}) =>
  `1: ${waiter ? '-> ' : ''}${kind} ADVISORY  WRITE 4242 ${major.toString(16).padStart(2, '0')}:${minor.toString(16).padStart(2, '0')}:${ino} 0 EOF\n`;

function lockFile(name) {
  const f = join(tempDir(`stam-lockheld-${name}-`), 'x.lock');
  writeFileSync(f, '');
  return f;
}

test('a lock a child flock holds is seen, and is free once the child ends', async () => {
  const f = lockFile('real');
  assert.equal(lockHeld(f), false, 'nobody holds it yet');
  const child = spawn('flock', ['-o', f, 'sh', '-c', 'echo held; exec cat'], { stdio: ['pipe', 'pipe', 'ignore'] });
  await new Promise((done) => child.stdout.once('data', done));
  assert.equal(lockHeld(f), true);
  // Reading never takes it: a flock -n taker still succeeds after any number of probes, once the holder is gone.
  child.stdin.end();
  await new Promise((done) => child.on('exit', done));
  assert.equal(lockHeld(f), false);
  assert.equal(spawnSync('flock', ['-n', '-E', '75', f, 'true']).status, 0);
});

test('the same inode on another device is not this lock', () => {
  const f = lockFile('dev');
  const { major, minor, ino } = devIno(f);
  assert.equal(lockHeld(f, { readLocks: () => line('FLOCK', major, minor + 1n, ino) }), false, 'other minor');
  assert.equal(lockHeld(f, { readLocks: () => line('FLOCK', major + 1n, minor, ino) }), false, 'other major');
  assert.equal(lockHeld(f, { readLocks: () => line('FLOCK', major, minor, ino + 1n) }), false, 'other inode');
  assert.equal(lockHeld(f, { readLocks: () => line('FLOCK', major, minor, ino) }), true, 'the right one');
});

test('a waiter line, a POSIX lock and a malformed line are no holder', () => {
  const f = lockFile('shapes');
  const { major, minor, ino } = devIno(f);
  assert.equal(lockHeld(f, { readLocks: () => line('FLOCK', major, minor, ino, { waiter: true }) }), false, 'a waiter');
  assert.equal(lockHeld(f, { readLocks: () => line('POSIX', major, minor, ino) }), false, 'POSIX');
  assert.equal(lockHeld(f, { readLocks: () => 'garbage\n\n1: FLOCK ADVISORY WRITE 1 nonsense 0 EOF\n' }), false);
  const text = line('POSIX', 1n, 1n, 1n) + line('FLOCK', major, minor, ino, { waiter: true }) + line('FLOCK', major, minor, ino);
  assert.equal(lockHeld(f, { readLocks: () => text }), true, 'a live line among others');
});

test('a missing lock file is free, and an unreadable table throws', () => {
  const f = join(tempDir('stam-lockheld-missing-'), 'nope.lock');
  assert.equal(lockHeld(f, { readLocks: () => { throw new Error('should not be read'); } }), false);
  const g = lockFile('unreadable');
  assert.throws(() => lockHeld(g, { readLocks: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } }), /EACCES/);
});
