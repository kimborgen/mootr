// The deploy check's scratch home is gone when check() returns, even when something the daemon
// started is still running and writes into the home late (S-2560).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './scrub-env.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const { check } = await import('../src/deploy.ts');
const { sweepCheckHomes, heldHomes, writeOwner, procStart, checkRoots, real } = await import('../scripts/check-homes.mjs');

// A release dir whose daemon answers the check and leaves a detached writer that outlives it.
// The writer waits for the home to be removed, then writes into it again; it records its pid and
// the daemon records STAM_EMBEDDER, both outside the home.
function fakeRelease(root, out) {
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'bin', 'stam'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(root, 'bin', 'stam'), 0o755);
  writeFileSync(
    join(root, 'src', 'cli.ts'),
    `import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const home = process.env.STAM_HOME;
writeFileSync(join(home, 'token'), 't');
writeFileSync(${JSON.stringify(join(out, 'home-parent'))}, home);
writeFileSync(${JSON.stringify(join(out, 'embedder-env'))}, process.env.STAM_EMBEDDER ?? '');
const writer = spawn('sh', ['-c', 'echo $$ > ${join(out, 'writer.pid')}; while [ -d "$STAM_HOME" ]; do sleep 0.05; done; mkdir -p "$STAM_HOME/embedder" && echo x > "$STAM_HOME/embedder/late"'], { stdio: 'ignore', detached: true });
writer.unref();
createServer((req, res) => res.end(req.url === '/api/health' ? '{"ok":true}' : '<html>')).listen(Number(process.env.STAM_PORT), '127.0.0.1');
`,
  );
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('check() leaves no stam-check home, even with a late writer running at kill time', async () => {
  const base = mkdtempSync(join(process.env.STAM_TEST_TMPDIR ?? tmpdir(), 'check-home-'));
  const prev = process.env.TMPDIR;
  const scratch = join(base, 'tmp');
  mkdirSync(scratch);
  process.env.TMPDIR = scratch;
  const prevRoot = process.env.STAM_CHECK_TMP;
  const checks = join(base, 'checks');
  process.env.STAM_CHECK_TMP = checks;
  try {
    const rel = join(base, 'release');
    fakeRelease(rel, base);
    await check(rel);
    const pid = Number(readFileSync(join(base, 'writer.pid'), 'utf8'));
    for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(pid), false, 'the late writer was killed');
    assert.deepEqual(readdirSync(scratch).filter((n) => n.startsWith('stam-check-')), []);
    assert.deepEqual(readdirSync(checks), [], 'the home was made under the check root and removed');
    assert.equal(dirname(readFileSync(join(base, 'home-parent'), 'utf8')), checks, 'the home was made under the check root');
    assert.equal(readFileSync(join(base, 'embedder-env'), 'utf8'), 'off');
  } finally {
    if (prevRoot === undefined) delete process.env.STAM_CHECK_TMP;
    else process.env.STAM_CHECK_TMP = prevRoot;
    if (prev === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prev;
    rmSync(base, { recursive: true, force: true });
  }
});

const HOUR = 3600_000;
const ago = (path, ms) => utimesSync(path, new Date(Date.now() - ms), new Date(Date.now() - ms));

// An old home in each root, a home a live child holds (by STAM_HOME, and by cwd), a fresh home, a symlink and
// a non-matching folder.
test('the sweep removes old unheld homes in both roots and keeps the rest', async () => {
  const base = mkdtempSync(join(process.env.STAM_TEST_TMPDIR ?? tmpdir(), 'sweep-home-'));
  const kids = [];
  try {
    const checks = join(base, 'checks');
    const tmp = join(base, 'tmp');
    mkdirSync(checks);
    mkdirSync(tmp);
    const make = (root, name, age) => {
      const d = join(root, name);
      mkdirSync(join(d, 'embedder'), { recursive: true });
      ago(d, age);
      return d;
    };
    const oldNew = make(checks, 'stam-check-old1', 2 * HOUR);
    const oldTmp = make(tmp, 'stam-check-old2', 2 * HOUR);
    const heldEnv = make(tmp, 'stam-check-heldenv', 2 * HOUR);
    const heldCwd = make(checks, 'stam-check-heldcwd', 2 * HOUR);
    const fresh = make(tmp, 'stam-check-fresh', 60_000);
    const other = make(tmp, 'other-old', 2 * HOUR);
    const target = make(base, 'target', 2 * HOUR);
    symlinkSync(target, join(tmp, 'stam-check-link'));
    const hold = (opts) => {
      const c = spawn('sleep', ['30'], { stdio: 'ignore', ...opts });
      kids.push(c);
      return c;
    };
    hold({ env: { ...process.env, STAM_HOME: heldEnv } });
    hold({ cwd: heldCwd });
    // Wait for each child to exist with its environment and cwd in place.
    for (const c of kids) for (let i = 0; i < 100 && !c.pid; i++) await new Promise((r) => setTimeout(r, 20));
    for (let i = 0; i < 100; i++) {
      try {
        if (readFileSync(`/proc/${kids[0].pid}/environ`, 'utf8').includes(heldEnv) && readFileSync(`/proc/${kids[1].pid}/stat`, 'utf8')) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 20));
    }
    const lines = [];
    const removed = sweepCheckHomes({ roots: [checks, tmp], log: (l) => lines.push(l) });
    assert.deepEqual(removed.sort(), [oldNew, oldTmp].sort());
    assert.equal(lines.length, 2);
    for (const h of [oldNew, oldTmp]) assert.equal(existsSync(h), false);
    for (const h of [heldEnv, heldCwd, fresh, other, target]) assert.equal(existsSync(h), true, h);
    assert.equal(existsSync(join(target, 'embedder')), true, 'a symlink is not followed');
    assert.equal(existsSync(join(tmp, 'stam-check-link')), true);
  } finally {
    for (const c of kids) c.kill('SIGKILL');
    rmSync(base, { recursive: true, force: true });
  }
});

test('check() sweeps old homes before it makes its own', async () => {
  const base = mkdtempSync(join(process.env.STAM_TEST_TMPDIR ?? tmpdir(), 'check-sweep-'));
  const prev = process.env.STAM_CHECK_TMP;
  const prevTmp = process.env.TMPDIR;
  const checks = join(base, 'checks');
  const scratch = join(base, 'tmp');
  mkdirSync(checks);
  mkdirSync(scratch);
  process.env.STAM_CHECK_TMP = checks;
  process.env.TMPDIR = scratch;
  try {
    const stale = [join(checks, 'stam-check-stale1'), join(scratch, 'stam-check-stale2')];
    for (const d of stale) {
      mkdirSync(d);
      ago(d, 2 * HOUR);
    }
    const rel = join(base, 'release');
    fakeRelease(rel, base);
    await check(rel);
    const pid = Number(readFileSync(join(base, 'writer.pid'), 'utf8'));
    for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    for (const d of stale) assert.equal(existsSync(d), false, d);
  } finally {
    if (prev === undefined) delete process.env.STAM_CHECK_TMP;
    else process.env.STAM_CHECK_TMP = prev;
    if (prevTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prevTmp;
    rmSync(base, { recursive: true, force: true });
  }
});

const mk = (root, name, age = 2 * HOUR) => {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  ago(d, age);
  return d;
};

test('the sweep keeps a home a live child holds open, and one under a symlinked or slash-ended root', async () => {
  const base = mkdtempSync(join(process.env.STAM_TEST_TMPDIR ?? tmpdir(), 'sweep-fd-'));
  let kid;
  try {
    mkdirSync(join(base, 'real'));
    symlinkSync(join(base, 'real'), join(base, 'link'));
    const heldFd = mk(join(base, 'real'), 'stam-check-fd');
    const gone = mk(join(base, 'real'), 'stam-check-gone');
    writeFileSync(join(heldFd, 'f'), 'x');
    ago(heldFd, 2 * HOUR); // creating f refreshed it
    const fd = openSync(join(heldFd, 'f'), 'r');
    kid = spawn('sleep', ['30'], { stdio: ['ignore', 'ignore', 'ignore', fd] });
    closeSync(fd);
    for (let i = 0; i < 100 && !kid.pid; i++) await new Promise((r) => setTimeout(r, 20));
    // Eligible but for the holder: old, and no marker.
    assert.ok(Date.now() - statSync(heldFd).mtimeMs > HOUR);
    const roots = [`${join(base, 'link')}/`];
    assert.deepEqual(sweepCheckHomes({ roots, log: () => {} }), [join(base, 'real', 'stam-check-gone')]);
    assert.equal(existsSync(heldFd), true, 'kept while the child holds a file open in it');
    assert.equal(existsSync(gone), false);
    kid.kill('SIGKILL');
    await new Promise((r) => kid.once('exit', r));
    assert.deepEqual(sweepCheckHomes({ roots, log: () => {} }), [join(base, 'real', 'stam-check-fd')]);
  } finally {
    kid?.kill('SIGKILL');
    rmSync(base, { recursive: true, force: true });
  }
});

test('the sweep keeps every home when a process of ours cannot be inspected, or the process list is unreadable', () => {
  if (process.getuid() === 0) return; // root reads everything
  const base = mkdtempSync(join(process.env.STAM_TEST_TMPDIR ?? tmpdir(), 'sweep-unsure-'));
  try {
    const root = join(base, 'root');
    const home = mk(root, 'stam-check-a');
    const proc = join(base, 'proc');
    mkdirSync(join(proc, '4242'), { recursive: true });
    mkdirSync(join(proc, '4242', 'environ')); // reading a folder fails with EISDIR, not ENOENT
    const lines = [];
    assert.deepEqual(sweepCheckHomes({ roots: [root], proc, log: (l) => lines.push(l) }), []);
    assert.equal(existsSync(home), true);
    assert.match(lines.join('\n'), /couldn't inspect 1 process.*EISDIR/);
    // A process that isn't readable by us (EACCES, like systemd --user) is skipped, not a block.
    const proc3 = join(base, 'proc3');
    mkdirSync(join(proc3, '4244'), { recursive: true });
    writeFileSync(join(proc3, '4244', 'environ'), `STAM_HOME=${home}\0`);
    chmodSync(join(proc3, '4244', 'environ'), 0);
    assert.deepEqual(heldHomes([home], proc3), { held: new Set(), unsure: [] });
    // A process that exits while it is read (no entries at all) holds nothing.
    const proc2 = join(base, 'proc2');
    mkdirSync(join(proc2, '4243'), { recursive: true });
    assert.deepEqual(sweepCheckHomes({ roots: [root], proc: proc2, log: () => {} }), [home]);
    // An unreadable process list.
    const mk2 = mk(root, 'stam-check-b');
    lines.length = 0;
    assert.deepEqual(sweepCheckHomes({ roots: [root], proc: join(base, 'nope'), log: (l) => lines.push(l) }), []);
    assert.equal(existsSync(mk2), true);
    assert.match(lines.join('\n'), /couldn't read the process list/);
    assert.throws(() => heldHomes([mk2], join(base, 'nope')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('node scripts/check-homes.mjs --sweep runs alone from another folder', () => {
  const base = mkdtempSync(join(process.env.STAM_TEST_TMPDIR ?? tmpdir(), 'sweep-cli-'));
  try {
    const root = join(base, 'checks');
    const old = mk(root, 'stam-check-old');
    const fresh = mk(root, 'stam-check-new', 1000);
    const script = new URL('../scripts/check-homes.mjs', import.meta.url).pathname;
    const r = spawnSync('node', [script, '--sweep'], { cwd: base, encoding: 'utf8', env: { ...process.env, STAM_CHECK_TMP: root, TMPDIR: join(base, 'none') } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /removed stale check home .*stam-check-old/);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(fresh), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('the sweep keeps an old home whose owner check still runs, and removes it once the owner is gone or reused', async () => {
  const base = mkdtempSync(join(process.env.STAM_TEST_TMPDIR ?? tmpdir(), 'sweep-owner-'));
  try {
    const root = join(base, 'root');
    const mine = mk(root, 'stam-check-mine');
    writeOwner(mine); // this process
    ago(mine, 2 * HOUR);
    const stale = mk(root, 'stam-check-stale');
    writeFileSync(join(stale, '.owner'), `${process.pid} 1\n`); // same pid, other start time: a reused pid
    ago(stale, 2 * HOUR);
    const dead = mk(root, 'stam-check-dead');
    const done = spawnSync('true');
    writeFileSync(join(dead, '.owner'), `${done.pid} 5\n`);
    ago(dead, 2 * HOUR);
    assert.ok(procStart(process.pid));
    assert.deepEqual(sweepCheckHomes({ roots: [root], log: () => {} }).sort(), [join(root, 'stam-check-dead'), join(root, 'stam-check-stale')].sort());
    assert.equal(existsSync(mine), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('check() marks its home with its owner while it runs', async () => {
  const base = mkdtempSync(join(process.env.STAM_TEST_TMPDIR ?? tmpdir(), 'check-owner-'));
  const prev = process.env.STAM_CHECK_TMP;
  process.env.STAM_CHECK_TMP = join(base, 'checks');
  try {
    const rel = join(base, 'release');
    fakeRelease(rel, base);
    const seen = join(base, 'owner-seen');
    // The daemon copies the marker out while it runs.
    writeFileSync(join(rel, 'src', 'cli.ts'), readFileSync(join(rel, 'src', 'cli.ts'), 'utf8').replace("writeFileSync(join(home, 'token'), 't');", `writeFileSync(join(home, 'token'), 't'); writeFileSync(${JSON.stringify(seen)}, readFileSync(join(home, '.owner'), 'utf8'));`).replace("import { writeFileSync } from 'node:fs';", "import { readFileSync, writeFileSync } from 'node:fs';"));
    await check(rel);
    const [pid, start] = readFileSync(seen, 'utf8').trim().split(' ');
    assert.equal(Number(pid), process.pid);
    assert.equal(start, procStart(process.pid));
  } finally {
    if (prev === undefined) delete process.env.STAM_CHECK_TMP;
    else process.env.STAM_CHECK_TMP = prev;
    rmSync(base, { recursive: true, force: true });
  }
});

test('an unreadable uid check keeps every home', () => {
  if (process.getuid() === 0) return;
  const base = mkdtempSync(join(process.env.STAM_TEST_TMPDIR ?? tmpdir(), 'sweep-stat-'));
  try {
    const root = join(base, 'root');
    const home = mk(root, 'stam-check-a');
    const proc = join(base, 'proc');
    mkdirSync(join(proc, '77', 'x'), { recursive: true });
    chmodSync(join(proc, '77'), 0); // stat of the folder works, but a 'no search' parent makes it fail below
    chmodSync(proc, 0o600); // the list is readable, the entries can't be stat-ed (EACCES)
    const lines = [];
    const out = sweepCheckHomes({ roots: [root], proc, log: (l) => lines.push(l) });
    chmodSync(proc, 0o700);
    chmodSync(join(proc, '77'), 0o700);
    assert.deepEqual(out, []);
    assert.equal(existsSync(home), true);
    assert.match(lines.join('\n'), /pid 77 stat: EACCES/);
  } finally {
    try {
      chmodSync(join(base, 'proc'), 0o700);
      chmodSync(join(base, 'proc', '77'), 0o700);
    } catch {}
    rmSync(base, { recursive: true, force: true });
  }
});

test('checkRoots normalizes a relative, slash-ended or symlinked STAM_CHECK_TMP', () => {
  const base = mkdtempSync(join(process.env.STAM_TEST_TMPDIR ?? tmpdir(), 'roots-'));
  const prev = process.env.STAM_CHECK_TMP;
  try {
    mkdirSync(join(base, 'real'));
    symlinkSync(join(base, 'real'), join(base, 'link'));
    for (const v of [`${join(base, 'link')}/`, join(base, 'real')]) {
      process.env.STAM_CHECK_TMP = v;
      assert.ok(checkRoots().includes(real(join(base, 'real'))), v);
      assert.ok(checkRoots().includes(real(dirname(join(v, 'stam-check-x')))), v);
    }
  } finally {
    if (prev === undefined) delete process.env.STAM_CHECK_TMP;
    else process.env.STAM_CHECK_TMP = prev;
    rmSync(base, { recursive: true, force: true });
  }
});

test('the sweep keeps an old home when its owner marker or the owner stat cannot be read, and removes one with no marker', () => {
  if (process.getuid() === 0) return;
  const base = mkdtempSync(join(process.env.STAM_TEST_TMPDIR ?? tmpdir(), 'sweep-marker-'));
  try {
    const root = join(base, 'root');
    const proc = join(base, 'proc');
    mkdirSync(join(proc, '99'), { recursive: true });
    // The owner's stat is a folder: EISDIR, not ENOENT.
    mkdirSync(join(proc, '99', 'stat'));
    const lines = [];
    const sweep = () => sweepCheckHomes({ roots: [root], proc, log: (l) => lines.push(l) });
    const garbage = mk(root, 'stam-check-garbage');
    writeFileSync(join(garbage, '.owner'), 'nonsense');
    ago(garbage, 2 * HOUR);
    const unreadable = mk(root, 'stam-check-unreadable');
    writeFileSync(join(unreadable, '.owner'), '99 5\n');
    chmodSync(join(unreadable, '.owner'), 0);
    ago(unreadable, 2 * HOUR);
    const dirMarker = mk(root, 'stam-check-dirmarker');
    mkdirSync(join(dirMarker, '.owner'));
    ago(dirMarker, 2 * HOUR);
    const eisdir = mk(root, 'stam-check-eisdir');
    writeFileSync(join(eisdir, '.owner'), '99 5\n');
    ago(eisdir, 2 * HOUR);
    const none = mk(root, 'stam-check-nomarker');
    assert.deepEqual(sweep(), [join(root, 'stam-check-nomarker')]);
    for (const h of [garbage, unreadable, dirMarker, eisdir]) assert.equal(existsSync(h), true, h);
    assert.equal(existsSync(none), false);
    assert.equal(lines.filter((l) => l.includes('kept stale check home')).length, 4);
    assert.match(lines.join('\n'), /owner 99 stat: EISDIR/);
    // The same owner with a readable stat is a start time that doesn't match: exited.
    rmSync(join(proc, '99', 'stat'), { recursive: true });
    writeFileSync(join(proc, '99', 'stat'), `99 (x) S ${Array.from({ length: 19 }, (_, i) => (i === 18 ? 777 : 0)).join(' ')}\n`);
    assert.deepEqual(sweep().sort(), [garbage, unreadable, dirMarker, eisdir].filter((h) => h === eisdir));
  } finally {
    try {
      chmodSync(join(base, 'root', 'stam-check-unreadable', '.owner'), 0o600);
    } catch {}
    rmSync(base, { recursive: true, force: true });
  }
});
