#!/usr/bin/env node
// The deploy lock (S-1750, src/release-lock.ts): flock(1) on releases/.flock, held by the caller's own descriptor, plus
// the pid-file lock on releases/.lock that older releases take, which deploy, rollback, prune and the canary bisection's
// cleanup all take. Covered: two contenders, one of which gets it; release, then reacquire; a holder in another process
// that exits without releasing, and one SIGKILLed, free it; the lock stays held with no flock process left, and a flock
// child SIGKILLed while taking it leaves it free; old and new code exclude each other both ways; a dead-pid .lock, or
// an empty one over 5 s old, is taken over and a fresh empty one is held; no flock(1) rejects with its own message.
// Run with `node --test test/release-lock.test.mjs`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './tmphome.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const LOCK = join(ROOT, 'src/release-lock.ts');
const { tryLock, lockHolder } = await import(LOCK);

const work = tempDir('stam-release-lock-test-');
after(() => rmSync(work, { recursive: true, force: true }));

let n = 0;
const dir = () => {
  const d = join(work, `r${++n}`);
  mkdirSync(d, { recursive: true });
  return d;
};

// flock(1) itself, from outside, as another process would try it.
const flockFree = (d) => spawnSync('flock', ['-n', join(d, '.flock'), 'true']).status === 0;

// origin/main's deploy.ts lock() as it was before this change, verbatim but for the directory: older releases, pinned
// ones and stale worktrees still run it.
function oldLock(dir) {
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const file = join(dir, '.lock');
  for (let i = 0; i < 2; i++) {
    try {
      closeSync(openSync(file, 'wx'));
      writeFileSync(file, String(process.pid));
      return () => rmSync(file, { force: true });
    } catch {
      const pid = Number(readFileSync(file, 'utf8'));
      if (pid && alive(pid)) throw new Error(`another deploy is running (pid ${pid})`);
      rmSync(file, { force: true });
    }
  }
  throw new Error(`can't take ${file}`);
}

// The pid of a process that has exited.
function deadPid() {
  const r = spawnSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' });
  return Number(r.stdout.trim());
}

// A holder in its own process: takes the lock, prints `held`, then waits until killed or told to `exit` (without
// releasing). Resolves once it holds the lock.
async function holder(d) {
  const script = `const { tryLock } = await import(${JSON.stringify(pathToFileURL(LOCK).href)});
const u = await tryLock(${JSON.stringify(d)});
console.log(u ? 'held' : 'refused');
process.stdin.on('data', () => process.exit(0));`;
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = new Promise((done) => child.on('exit', done));
  const line = await new Promise((done) => child.stdout.once('data', (b) => done(String(b).trim())));
  assert.equal(line, 'held');
  return { child, exited };
}

test('two contenders: one gets the lock, the other is refused; release, then reacquire (S-1750)', async () => {
  const d = dir();
  const a = await tryLock(d);
  assert.ok(a);
  assert.equal(lockHolder(d), process.pid);
  assert.equal(await tryLock(d), undefined, 'a second taker, even in the same process, is refused');
  assert.equal(lockHolder(d), process.pid, "the refused taker leaves the holder's .lock");
  await a();
  assert.equal(lockHolder(d), undefined, '.lock goes on release');
  assert.ok(existsSync(join(d, '.flock')), '.flock stays: nothing deletes it');
  const again = await tryLock(d);
  assert.ok(again, 'free again after release');
  await again();
});

test('a holder that exits without releasing frees the lock (S-1750)', async () => {
  const d = dir();
  const h = await holder(d);
  assert.equal(await tryLock(d), undefined, 'held by the other process');
  h.child.stdin.write('exit\n');
  await h.exited;
  assert.equal(lockHolder(d), h.child.pid, 'its .lock is left behind with a dead pid');
  const u = await tryLock(d);
  assert.ok(u, 'the kernel freed the flock, and the dead pid is taken over');
  assert.equal(lockHolder(d), process.pid);
  await u();
});

test('a holder SIGKILLed frees the lock: the next acquire succeeds (S-1750)', async () => {
  const d = dir();
  const h = await holder(d);
  h.child.kill('SIGKILL');
  await h.exited;
  const u = await tryLock(d);
  assert.ok(u);
  await u();
});

test('the lock needs no child: it stays held after flock exits, and a flock SIGKILLed while taking it leaves it free (S-1750)', async () => {
  const d = dir();
  const u = await tryLock(d);
  assert.ok(u);
  const flocks = spawnSync('pgrep', ['-P', String(process.pid), '-x', 'flock'], { encoding: 'utf8' }).stdout.trim();
  assert.equal(flocks, '', 'no flock process of ours is left');
  assert.equal(flockFree(d), false, "held by this process's own descriptor");
  await u();
  assert.ok(flockFree(d));
  // A flock that takes the lock and is then SIGKILLed, before the caller sees it succeed.
  const killed = join(work, 'flock-killed');
  writeFileSync(killed, '#!/bin/sh\nflock "$@"\nkill -KILL $$\n');
  chmodSync(killed, 0o755);
  await assert.rejects(tryLock(d, { flock: killed }), /can't take the deploy lock: .* exited SIGKILL/);
  assert.ok(flockFree(d), 'the failed take closed its descriptor');
  assert.equal(lockHolder(d), undefined, 'and wrote no .lock');
});

test('old and new code exclude each other: a live old holder refuses new code, and a new holder refuses old code (S-1750)', async () => {
  const d = dir();
  // Old code holds it: a live pid in .lock.
  const sleeper = spawn('sleep', ['60'], { stdio: 'ignore' });
  after(() => sleeper.kill('SIGKILL'));
  writeFileSync(join(d, '.lock'), String(sleeper.pid));
  assert.equal(await tryLock(d), undefined, 'a live pid in .lock means held');
  assert.equal(lockHolder(d), sleeper.pid, 'the old holder is the one named');
  assert.ok(flockFree(d), 'the refused taker gave the flock back');
  rmSync(join(d, '.lock'));
  // Old code, in this very process, while new code holds it.
  const u = await tryLock(d);
  assert.ok(u);
  assert.throws(() => oldLock(d), new RegExp(`another deploy is running \\(pid ${process.pid}\\)`));
  await u();
  // And old code takes it once new code let go, and new code then waits for it.
  const old = oldLock(d);
  assert.equal(await tryLock(d), undefined);
  old();
  const again = await tryLock(d);
  assert.ok(again);
  await again();
});

test('a stale .lock, a dead pid or an empty file over 5 s old, is taken over; a fresh empty one is held (S-1750)', async () => {
  const d = dir();
  writeFileSync(join(d, '.lock'), String(deadPid()));
  const a = await tryLock(d);
  assert.ok(a, 'a dead pid is taken over');
  await a();
  // Fresh and empty: old code may be between its wx create and its pid write.
  writeFileSync(join(d, '.lock'), '');
  assert.equal(await tryLock(d), undefined, 'a fresh empty .lock is held');
  assert.ok(existsSync(join(d, '.lock')), 'and left in place');
  assert.ok(flockFree(d), 'the refused taker gave the flock back');
  const old = (Date.now() - 6000) / 1000;
  utimesSync(join(d, '.lock'), old, old);
  const b = await tryLock(d);
  assert.ok(b, 'an empty .lock older than 5 s is taken over');
  assert.equal(lockHolder(d), process.pid);
  await b();
});

test('a .lock that changes after it is read counts as held: a pid written into the empty file, or the file replaced (S-1750)', async () => {
  const d = dir();
  const sleeper = spawn('sleep', ['60'], { stdio: 'ignore' });
  after(() => sleeper.kill('SIGKILL'));
  const old = (Date.now() - 6000) / 1000;
  // Old code created it empty with wx long enough ago, and writes its pid right after the new caller read it empty.
  writeFileSync(join(d, '.lock'), '');
  utimesSync(join(d, '.lock'), old, old);
  const write = () => writeFileSync(join(d, '.lock'), String(sleeper.pid));
  assert.equal(await tryLock(d, { afterRead: write }), undefined, 'the pid written after the read means held');
  assert.equal(lockHolder(d), sleeper.pid, 'the live lock is left in place');
  assert.ok(flockFree(d));
  // A dead pid read, then old code removes it and takes the lock afresh: another file under the same name.
  writeFileSync(join(d, '.lock'), String(deadPid()));
  const replace = () => {
    rmSync(join(d, '.lock'));
    writeFileSync(join(d, '.lock'), String(sleeper.pid));
  };
  assert.equal(await tryLock(d, { afterRead: replace }), undefined, 'a replaced file means held');
  assert.equal(lockHolder(d), sleeper.pid);
  // Without a change in between, the same dead pid is taken over.
  writeFileSync(join(d, '.lock'), String(deadPid()));
  const u = await tryLock(d, { afterRead: () => {} });
  assert.ok(u);
  await u();
});

test('without flock(1) taking the lock rejects with its own message: it fails closed (S-1750)', async () => {
  const d = dir();
  await assert.rejects(tryLock(d, { flock: join(work, 'no-such-flock') }), /flock\(1\)\) is not available/);
  assert.equal(lockHolder(d), undefined, 'no holder is recorded');
});
