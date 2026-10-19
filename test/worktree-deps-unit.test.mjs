#!/usr/bin/env node
// Worktree dependencies at spawn (S-1044, carry-over S-1051): a spawned worktree gets node_modules
// hard-linked from STAM_HOME/deps/KEY, the deploy's lock-keyed deps cache, so a developer or
// reviewer never npm ci per clone or symlink a stale live checkout. A hit links the cache's
// read-only files into fresh writable directories, converging an old writable cache to read-only
// once; a miss warms the cache in the background without blocking the spawn and links when it
// finishes; a folder without a lockfile is skipped; two concurrent misses don't collide, the loser
// dropping its tmp. Real git repos under a throwaway STAM_HOME, a fake npm, no daemon, no model,
// no network: `node --test test/worktree-deps-unit.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir, tempHome } from './tmphome.mjs';

const work = tempDir('stam-worktree-deps-');
after(() => rmSync(work, { recursive: true, force: true }));

const git = (...args) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'deps-test', GIT_AUTHOR_EMAIL: 'deps-test@stam.local', GIT_COMMITTER_NAME: 'deps-test', GIT_COMMITTER_EMAIL: 'deps-test@stam.local' },
  });

// A repo whose folders ('' for the root, 'web') each hold a package.json and package-lock.json.
// A folder may hold only a package.json, to prove a folder without a lockfile is skipped.
function repoWith(dir, folders, tag) {
  mkdirSync(dir, { recursive: true });
  git('init', '-q', '-b', 'main', dir);
  for (const f of folders) {
    const d = f ? join(dir, f) : dir;
    mkdirSync(d, { recursive: true });
    const name = `${tag}${f ? `-${f}` : ''}`;
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
    writeFileSync(join(d, 'package-lock.json'), JSON.stringify({ name, lockfileVersion: 3 }));
  }
  git('-C', dir, 'add', '-A');
  git('-C', dir, 'commit', '-q', '-m', 'base');
  return dir;
}

// config.ts and deploy.ts read STAM_HOME when they load, so it is set before the modules under
// test are imported. The fake npm is the warm's whole install: STAM_NPM points at it, so no
// network and no real npm, and it makes the node_modules the cache gets.
process.env.STAM_HOME = tempHome('stam-worktree-deps-home-');
delete process.env.STAM_DEPLOY_REPO;
const fakeNpm = join(work, 'fake-npm');
writeFileSync(fakeNpm, '#!/bin/sh\nmkdir -p node_modules\nprintf hi > node_modules/foo.txt\n');
chmodSync(fakeNpm, 0o755);
process.env.STAM_NPM = fakeNpm;

let ws, deploy;
before(async () => {
  ws = await import('../src/workspace.ts');
  deploy = await import('../src/deploy.ts');
});

// Fills a cache folder as a finished deploy fill would: node_modules/foo.txt and a .ready marker,
// with every file read-only and the directories writable.
function fillCache(dir, body) {
  const key = deploy.depsKey(dir, true);
  const cache = deploy.depsCachePath(key);
  mkdirSync(join(cache, 'node_modules'), { recursive: true });
  writeFileSync(join(cache, 'node_modules', 'foo.txt'), body);
  chmodSync(join(cache, 'node_modules', 'foo.txt'), 0o444);
  writeFileSync(join(cache, '.ready'), new Date().toISOString());
  return cache;
}

test('a cache hit links the worktree with hard links and leaves the cache untouched', () => {
  const repo = repoWith(join(work, 'hit-repo'), ['', 'web'], 'hit');
  const rootCache = fillCache(repo, 'root\n');
  const webCache = fillCache(join(repo, 'web'), 'web\n');
  const real = ws.createWorkspace({ kind: 'worktree', repo, branch: 'stam/hit' }, 'hit');
  try {
    assert.deepEqual(real.deps.map((d) => [d.dir, d.event]), [['.', 'deps:linked'], ['web', 'deps:linked']]);
    for (const [cache, body] of [[rootCache, 'root\n'], [webCache, 'web\n']]) {
      const rel = cache === rootCache ? '' : 'web';
      const linked = join(real.cwd, rel, 'node_modules', 'foo.txt');
      assert.ok(existsSync(linked), `${rel || '.'}/node_modules is linked`);
      assert.equal(statSync(linked).ino, statSync(join(cache, 'node_modules', 'foo.txt')).ino, 'linked by hard link');
      // A write through the link fails loudly and leaves the cache byte for byte.
      assert.throws(() => writeFileSync(linked, 'nope'), /EACCES|permission denied/i);
      assert.equal(readFileSync(join(cache, 'node_modules', 'foo.txt'), 'utf8'), body);
    }
    // Removing the worktree's node_modules leaves the cache intact: the directories are fresh,
    // only the files are shared.
    for (const rel of ['', 'web']) rmSync(join(real.cwd, rel, 'node_modules'), { recursive: true, force: true });
    for (const cache of [rootCache, webCache]) {
      assert.ok(existsSync(join(cache, 'node_modules', 'foo.txt')), 'the cache file stays');
      assert.ok(existsSync(join(cache, '.ready')), 'the cache marker stays');
    }
  } finally {
    ws.cleanupWorkspace(real, true);
  }
});

test('an old writable cache becomes read-only on its first link (S-1044)', () => {
  const repo = repoWith(join(work, 'old-cache-repo'), [''], 'oldcache');
  const key = deploy.depsKey(repo, true);
  const cache = deploy.depsCachePath(key);
  // A cache the old deploy filled: writable files, `.ready`, and no `.ro`.
  mkdirSync(join(cache, 'node_modules'), { recursive: true });
  writeFileSync(join(cache, 'node_modules', 'foo.txt'), 'old\n');
  writeFileSync(join(cache, '.ready'), new Date().toISOString());
  assert.notEqual(statSync(join(cache, 'node_modules', 'foo.txt')).mode & 0o200, 0, 'it starts writable');
  const real = ws.createWorkspace({ kind: 'worktree', repo, branch: 'stam/oldcache' }, 'oldcache');
  try {
    assert.equal(real.deps[0].event, 'deps:linked');
    assert.equal(statSync(join(cache, 'node_modules', 'foo.txt')).mode & 0o222, 0, 'the old cache is read-only now');
    assert.ok(existsSync(join(cache, '.ro2')), 'the .ro2 marker records it, so the walk runs once');
    assert.throws(() => writeFileSync(join(real.cwd, 'node_modules', 'foo.txt'), 'nope'), /EACCES|permission denied/i);
  } finally {
    ws.cleanupWorkspace(real, true);
  }
});

test('a link that cannot be made reports failure, so the spawn can log deps:failed (S-1044)', () => {
  const repo = repoWith(join(work, 'nolink-repo'), [''], 'nolink');
  const cache = fillCache(repo, 'x\n');
  // The destination sits under a regular file, so both cp -al and the copy fallback fail.
  const blocker = join(work, 'blocker');
  writeFileSync(blocker, 'x');
  assert.equal(deploy.linkDepsFrom(cache, join(blocker, 'node_modules')), false);
});

test('a cache miss warms in the background, does not block the spawn, and links when it finishes', async () => {
  const repo = repoWith(join(work, 'miss-repo'), [''], 'miss');
  const real = ws.createWorkspace({ kind: 'worktree', repo, branch: 'stam/miss' }, 'miss');
  try {
    assert.deepEqual(real.deps.map((d) => [d.dir, d.event]), [['.', 'deps:warming']]);
    assert.equal(existsSync(join(real.cwd, 'node_modules')), false, 'the spawn did not wait for the warm');
    const warm = await real.deps[0].warm();
    assert.equal(warm.linked, true, 'the warm reports that it linked, so the spawn can log deps:linked');
    const cache = deploy.depsCachePath(deploy.depsKey(repo, true));
    assert.ok(existsSync(join(cache, '.ready')), 'the cache is filled');
    const cached = join(cache, 'node_modules', 'foo.txt');
    assert.ok(existsSync(cached));
    assert.equal(statSync(cached).mode & 0o222, 0, 'cache files are read-only');
    assert.notEqual(statSync(join(cache, 'node_modules')).mode & 0o200, 0, 'cache directories stay writable');
    assert.ok(existsSync(join(cache, '.used')), 'the link marked the key used, for the prune window');
    const linked = join(real.cwd, 'node_modules', 'foo.txt');
    assert.ok(existsSync(linked), 'the warm linked the worktree when it finished');
    assert.equal(statSync(linked).ino, statSync(cached).ino);
  } finally {
    ws.cleanupWorkspace(real, true);
  }
});

test('a warm whose cache has no node_modules reports deps:failed (S-1044)', async () => {
  const repo = repoWith(join(work, 'warmfail-repo'), [''], 'warmfail');
  // A fake npm that exits cleanly but installs nothing, so the cache has a .ready and no
  // node_modules to link.
  const noDepsNpm = join(work, 'no-deps-npm');
  writeFileSync(noDepsNpm, '#!/bin/sh\nexit 0\n');
  chmodSync(noDepsNpm, 0o755);
  const old = process.env.STAM_NPM;
  process.env.STAM_NPM = noDepsNpm;
  let real;
  try {
    real = ws.createWorkspace({ kind: 'worktree', repo, branch: 'stam/warmfail' }, 'warmfail');
  } finally {
    process.env.STAM_NPM = old;
  }
  try {
    assert.equal(real.deps[0].event, 'deps:warming');
    const r = await real.deps[0].warm();
    assert.equal(r.linked, false, 'nothing to link, so the spawn logs deps:failed');
    assert.ok(existsSync(join(deploy.depsCachePath(r.key), '.ready')));
    assert.equal(existsSync(join(real.cwd, 'node_modules')), false);
  } finally {
    ws.cleanupWorkspace(real, true);
  }
});

test('a deploy fill (dev=false) makes the same read-only cache and a release links it', async () => {
  const repo = repoWith(join(work, 'deploy-repo'), [''], 'deploy');
  const key = await deploy.fillDeps(repo, false);
  const cache = deploy.depsCachePath(key);
  assert.ok(existsSync(join(cache, '.ready')));
  const cached = join(cache, 'node_modules', 'foo.txt');
  assert.equal(statSync(cached).mode & 0o222, 0, 'cache files are read-only');
  // A release links the same cache, as deploy's installDeps does, and loads it read-only.
  const release = join(work, 'release');
  mkdirSync(release, { recursive: true });
  assert.ok(deploy.linkDepsFrom(cache, join(release, 'node_modules')), 'the release links the cache');
  assert.equal(statSync(join(release, 'node_modules', 'foo.txt')).ino, statSync(cached).ino);
  assert.equal(readFileSync(join(release, 'node_modules', 'foo.txt'), 'utf8'), 'hi');
});

test('two concurrent misses each warm, the loser drops its tmp, and both link once', async () => {
  const repo = repoWith(join(work, 'race-repo'), [''], 'race');
  const a = ws.createWorkspace({ kind: 'worktree', repo, branch: 'stam/race-a' }, 'race-a');
  const b = ws.createWorkspace({ kind: 'worktree', repo, branch: 'stam/race-b' }, 'race-b');
  try {
    assert.equal(a.deps[0].event, 'deps:warming');
    assert.equal(b.deps[0].event, 'deps:warming');
    const results = await Promise.all([a.deps[0].warm(), b.deps[0].warm()]);
    assert.deepEqual(results.map((r) => r.linked), [true, true], 'both warms report a linked worktree');
    const cache = deploy.depsCachePath(deploy.depsKey(repo, true));
    assert.ok(existsSync(join(cache, '.ready')));
    assert.deepEqual(readdirSync(join(process.env.STAM_HOME, 'deps')).filter((n) => n.includes('.tmp-')), [], 'no tmp folder is left behind');
    for (const real of [a, b]) assert.ok(existsSync(join(real.cwd, 'node_modules', 'foo.txt')), `${real.cwd} is linked`);
  } finally {
    ws.cleanupWorkspace(a, true);
    ws.cleanupWorkspace(b, true);
  }
});

test('a folder without a lockfile is skipped', () => {
  const repo = repoWith(join(work, 'nolock-repo'), [''], 'nolock');
  // The root has a package.json but no package-lock.json, so there is nothing to key on.
  rmSync(join(repo, 'package-lock.json'));
  git('-C', repo, 'add', '-A');
  git('-C', repo, 'commit', '-q', '-m', 'no lock');
  const real = ws.createWorkspace({ kind: 'worktree', repo, branch: 'stam/nolock' }, 'nolock');
  try {
    assert.deepEqual(real.deps, []);
    assert.equal(existsSync(join(real.cwd, 'node_modules')), false);
  } finally {
    ws.cleanupWorkspace(real, true);
  }
});

test('converging a cache keeps exec bits and drops write bits (S-1051)', async () => {
  const repo = repoWith(join(work, 'exec-repo'), [''], 'exec');
  const bin = '#!/bin/sh\nmkdir -p node_modules/.bin\nprintf hi > node_modules/foo.txt\nprintf \'#!/bin/sh\\n\' > node_modules/tool.sh\nchmod 755 node_modules/tool.sh\n';
  const execNpm = join(work, 'exec-npm');
  writeFileSync(execNpm, bin);
  chmodSync(execNpm, 0o755);
  const old = process.env.STAM_NPM;
  process.env.STAM_NPM = execNpm;
  let key;
  try {
    key = await deploy.fillDeps(repo, true);
  } finally {
    process.env.STAM_NPM = old;
  }
  const tool = join(deploy.depsCachePath(key), 'node_modules', 'tool.sh');
  const mode = statSync(tool).mode;
  assert.equal(mode & 0o111, 0o111, 'the executable keeps its exec bits');
  assert.equal(mode & 0o222, 0, 'and loses its write bits');
  assert.equal(statSync(join(deploy.depsCachePath(key), 'node_modules', 'foo.txt')).mode & 0o222, 0);
});

test('a cache with .ro and no .ro2 was damaged by the old code: moved aside and refilled (S-1051)', async () => {
  const repo = repoWith(join(work, 'damaged-repo'), [''], 'damaged');
  const cache = fillCache(repo, 'damaged\n');
  writeFileSync(join(cache, '.ro'), 'x');
  const inode = statSync(join(cache, 'node_modules', 'foo.txt')).ino;
  assert.equal(deploy.retireDamagedCache(join(work, 'does-not-exist')), false, 'a missing cache is not damaged');
  const real = ws.createWorkspace({ kind: 'worktree', repo, branch: 'stam/damaged' }, 'damaged');
  try {
    assert.equal(real.deps[0].event, 'deps:warming', 'the damaged cache is a miss');
    const warm = await real.deps[0].warm();
    assert.equal(warm.linked, true);
    const aside = readdirSync(join(process.env.STAM_HOME, 'deps')).filter((n) => n.includes('.damaged-'));
    assert.equal(aside.length, 1, 'the old cache is moved aside');
    assert.equal(statSync(join(process.env.STAM_HOME, 'deps', aside[0], 'node_modules', 'foo.txt')).ino, inode);
    assert.ok(existsSync(join(cache, '.ro2')), 'the refill carries .ro2');
    assert.notEqual(statSync(join(cache, 'node_modules', 'foo.txt')).ino, inode, 'fresh inodes');
    assert.equal(readFileSync(join(real.cwd, 'node_modules', 'foo.txt'), 'utf8'), 'hi');
  } finally {
    ws.cleanupWorkspace(real, true);
  }
});

test('a fresh cache carries .ro and .ro2, and a cache with both keeps its exec bits (S-1051)', async () => {
  const repo = repoWith(join(work, 'both-repo'), [''], 'both');
  const execNpm = join(work, 'both-npm');
  writeFileSync(execNpm, '#!/bin/sh\nmkdir -p node_modules\nprintf "#!/bin/sh\\n" > node_modules/tool.sh\nchmod 755 node_modules/tool.sh\n');
  chmodSync(execNpm, 0o755);
  const old = process.env.STAM_NPM;
  process.env.STAM_NPM = execNpm;
  let key;
  try {
    key = await deploy.fillDeps(repo, true);
  } finally {
    process.env.STAM_NPM = old;
  }
  const cache = deploy.depsCachePath(key);
  // .ro keeps a daemon on the old code (which checks only .ro) from chmodding the cache again.
  assert.ok(existsSync(join(cache, '.ro')) && existsSync(join(cache, '.ro2')));
  const tool = join(cache, 'node_modules', 'tool.sh');
  const ino = statSync(tool).ino;
  deploy.ensureCacheReadOnly(cache);
  assert.equal(deploy.retireDamagedCache(cache), false, 'both markers: not damaged');
  assert.equal(statSync(tool).mode & 0o111, 0o111);
  assert.equal(statSync(tool).ino, ino);
  assert.deepEqual(readdirSync(join(process.env.STAM_HOME, 'deps')).filter((n) => n.startsWith(`${key}.damaged-`)), []);
});

test('retiring a damaged cache twice moves it once and never throws (S-1051)', () => {
  const repo = repoWith(join(work, 'twice-repo'), [''], 'twice');
  const cache = fillCache(repo, 'twice\n');
  writeFileSync(join(cache, '.ro'), 'x');
  assert.equal(deploy.retireDamagedCache(cache), true);
  assert.equal(deploy.retireDamagedCache(cache), false, 'already retired: ENOENT / no marker is fine');
  const key = deploy.depsKey(repo, true);
  assert.equal(readdirSync(join(process.env.STAM_HOME, 'deps')).filter((n) => n.startsWith(`${key}.damaged-`)).length, 1);
});

// A cache converged before the fix holds build output (`.tmp/x.tsbuildinfo`, 444) that a release
// linked, so the next `tsc -b` in that release failed with EACCES (S-1051).
function cacheWithBuildOutput(tag) {
  const repo = repoWith(join(work, `${tag}-repo`), [''], tag);
  const cache = fillCache(repo, `${tag}\n`);
  writeFileSync(join(cache, '.ro2'), 'x');
  for (const d of deploy.BUILD_OUTPUT_DIRS) {
    mkdirSync(join(cache, 'node_modules', d), { recursive: true });
    writeFileSync(join(cache, 'node_modules', d, 'x.tsbuildinfo'), 'stale');
    chmodSync(join(cache, 'node_modules', d, 'x.tsbuildinfo'), 0o444);
  }
  return cache;
}

test('converging a cache deletes stale build output, even with .ro2 already set (S-1051)', () => {
  const cache = cacheWithBuildOutput('conv');
  deploy.ensureCacheReadOnly(cache);
  for (const d of deploy.BUILD_OUTPUT_DIRS) assert.ok(!existsSync(join(cache, 'node_modules', d)), `${d} is gone`);
  assert.ok(existsSync(join(cache, 'node_modules', 'foo.txt')), 'real dependencies stay');
});

test('a linked target has no build output, and a build can write its tsbuildinfo (S-1051)', () => {
  const cache = cacheWithBuildOutput('lnk');
  const target = join(work, 'lnk-target', 'node_modules');
  mkdirSync(join(work, 'lnk-target'), { recursive: true });
  assert.ok(deploy.linkDepsFrom(cache, target));
  for (const d of deploy.BUILD_OUTPUT_DIRS) assert.ok(!existsSync(join(target, d)), `${d} not linked`);
  const info = join(target, '.tmp', 'tsconfig.app.tsbuildinfo');
  mkdirSync(join(target, '.tmp'), { recursive: true });
  writeFileSync(info, 'built');
  assert.equal(readFileSync(info, 'utf8'), 'built');
  assert.ok(existsSync(join(cache, 'node_modules', '.tmp', 'x.tsbuildinfo')), 'the cache copy is untouched by the link');
});

// S-1662: the spawn report, the lockfile check and the relink.
const lockWith = (name, pkgs) => JSON.stringify({ name, lockfileVersion: 3, packages: { '': { name }, ...Object.fromEntries(pkgs.map(([p, v]) => [`node_modules/${p}`, { version: v }])) } });
const hiddenWith = (pkgs) => JSON.stringify({ lockfileVersion: 3, packages: Object.fromEntries(pkgs.map(([p, v]) => [`node_modules/${p}`, { version: v }])) });

test('the spawn report names each folder as linked with its lockfile hash, or warming (S-1662)', () => {
  assert.equal(ws.depsReport(undefined), '');
  const line = ws.depsReport([
    { dir: '.', key: 'aaaa', event: 'deps:linked' },
    { dir: 'web', key: 'bbbb', event: 'deps:warming' },
  ]);
  assert.match(line, /linked: root \(lockfile aaaa\)/);
  assert.match(line, /warming: web/);
  assert.match(line, /stam deps relink/);
});

test('depsStatus flags a stale install and a symlink outside the worktree; relink fixes both (S-1662)', async () => {
  const repo = repoWith(join(work, 'relink-repo'), [''], 'relink');
  const lock = join(repo, 'package-lock.json');
  writeFileSync(lock, lockWith('relink', [['a', '1.0.0']]));
  const real = ws.createWorkspace({ kind: 'worktree', repo, branch: 'stam/relink' }, 'relink');
  try {
    const nm = join(real.cwd, 'node_modules');
    // The lockfile in the worktree is the committed one (no packages), the link a miss.
    await real.deps[0].warm?.();
    // A rebase pulled a new package into the lockfile; the install doesn't have it.
    writeFileSync(join(real.cwd, 'package-lock.json'), lockWith('relink', [['a', '1.0.0'], ['b', '2.0.0']]));
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, '.package-lock.json'), hiddenWith([['a', '1.0.0']]));
    const stale = ws.depsStatus(real.cwd);
    assert.equal(stale[0].state, 'stale');
    assert.match(stale[0].detail, /b/);
    assert.match(ws.depsWarning(real.cwd), /stam deps relink/);
    // A matching install is ok and silent.
    writeFileSync(join(nm, '.package-lock.json'), hiddenWith([['a', '1.0.0'], ['b', '2.0.0']]));
    assert.equal(ws.depsStatus(real.cwd)[0].state, 'ok');
    assert.equal(ws.depsWarning(real.cwd), '');
    assert.equal((await ws.relinkDeps(real.cwd))[0].event, 'ok', 'a matching install is left alone');
    // A symlink to a checkout outside the worktree is flagged.
    rmSync(nm, { recursive: true, force: true });
    const outside = join(work, 'live-node_modules');
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, nm);
    assert.equal(ws.depsStatus(real.cwd)[0].state, 'symlink');
    // Relink: the symlink goes, the cache (filled by the fake npm) links in, and the real dir is moved aside next time.
    const r = await ws.relinkDeps(real.cwd);
    assert.equal(r[0].event, 'deps:linked');
    assert.ok(!lstatSync(nm).isSymbolicLink(), 'a real directory replaced the symlink');
    assert.ok(existsSync(outside), 'the symlink target is untouched');
    const again = await ws.relinkDeps(real.cwd, true);
    assert.ok(again[0].aside && existsSync(again[0].aside), 'the old directory is moved aside');
    assert.ok(existsSync(join(nm, 'foo.txt')), 'the new link is in place');
  } finally {
    ws.cleanupWorkspace(real, true);
  }
});

test('optional and os-gated lockfile entries missing from the install still give ok (S-1662)', () => {
  const repo = repoWith(join(work, 'optional-repo'), [''], 'optional');
  const real = ws.createWorkspace({ kind: 'worktree', repo, branch: 'stam/optional' }, 'optional');
  try {
    const nm = join(real.cwd, 'node_modules');
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(real.cwd, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/a': { version: '1.0.0' }, 'node_modules/o': { version: '1.0.0', optional: true }, 'node_modules/w': { version: '1.0.0', os: ['win32'] } } }));
    writeFileSync(join(nm, '.package-lock.json'), hiddenWith([['a', '1.0.0']]));
    assert.equal(ws.depsStatus(real.cwd)[0].state, 'ok');
  } finally {
    ws.cleanupWorkspace(real, true);
  }
});

test('pr_open warns only for a stam worktree, and relink refuses the live checkout and foreign trees (S-1662)', () => {
  const repo = repoWith(join(work, 'refuse-repo'), [''], 'refuse');
  writeFileSync(join(repo, 'package-lock.json'), lockWith('refuse', [['a', '1.0.0']]));
  const real = ws.createWorkspace({ kind: 'worktree', repo, branch: 'stam/refuse' }, 'refuse');
  try {
    mkdirSync(join(real.cwd, 'node_modules'), { recursive: true });
    writeFileSync(join(real.cwd, 'node_modules', '.package-lock.json'), hiddenWith([]));
    writeFileSync(join(real.cwd, 'package-lock.json'), lockWith('refuse', [['a', '1.0.0']]));
    assert.match(ws.prOpenDepsWarning(real.cwd), /stam deps relink/, 'a stale stam worktree warns');
    assert.equal(ws.relinkRefusal(real.cwd), null);
    // The same staleness in a checkout outside STAM_HOME/worktrees: no warning, and relink needs --force.
    mkdirSync(join(repo, 'node_modules'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', '.package-lock.json'), hiddenWith([]));
    assert.equal(ws.prOpenDepsWarning(repo), '');
    assert.match(ws.relinkRefusal(repo), /not a stam worktree/);
    assert.equal(ws.relinkRefusal(repo, true), null);
    // The live deploy checkout is refused even with --force.
    const prev = process.env.STAM_DEPLOY_REPO;
    process.env.STAM_DEPLOY_REPO = repo;
    try {
      assert.match(ws.relinkRefusal(repo, true), /live deploy checkout/);
      assert.equal(ws.prOpenDepsWarning(repo), '');
    } finally {
      if (prev === undefined) delete process.env.STAM_DEPLOY_REPO;
      else process.env.STAM_DEPLOY_REPO = prev;
    }
  } finally {
    ws.cleanupWorkspace(real, true);
  }
});

test('a linked worktree is never the live deploy checkout, even when settings name it as stam2 (S-1863)', () => {
  const repo = repoWith(join(work, 'own-repo'), [''], 'own');
  const real = ws.createWorkspace({ kind: 'worktree', repo, branch: 'stam/own' }, 'own');
  const settingsFile = join(process.env.STAM_HOME, 'settings.json');
  try {
    // A CLI run from a worktree's own copy defaults itsa.repos.stam2 to that worktree.
    writeFileSync(settingsFile, JSON.stringify({ itsa: { repos: { stam2: real.cwd } } }));
    assert.equal(ws.liveCheckoutRefusal(real.cwd), null);
    assert.equal(ws.relinkRefusal(real.cwd), null);
    // A real checkout named the same way is still the live one, and still refused.
    writeFileSync(settingsFile, JSON.stringify({ itsa: { repos: { stam2: repo } } }));
    assert.match(ws.relinkRefusal(repo, true), /live deploy checkout/);
  } finally {
    rmSync(settingsFile, { force: true });
    ws.cleanupWorkspace(real, true);
  }
});

// Waits on state, not time: true once `check` holds, polling the event loop.
const until = async (check) => {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(check(), 'condition reached');
};

test('pr_open relinks a stale install by itself, and not in the live checkout or a foreign tree (S-1706)', async () => {
  const repo = repoWith(join(work, 'auto-repo'), [''], 'auto');
  writeFileSync(join(repo, 'package-lock.json'), lockWith('auto', [['a', '1.0.0']]));
  const real = ws.createWorkspace({ kind: 'worktree', repo, branch: 'stam/auto' }, 'auto');
  try {
    await real.deps[0].warm?.();
    const nm = join(real.cwd, 'node_modules');
    const stale = () => {
      // A merge changed the lockfile: the install lacks package b.
      writeFileSync(join(real.cwd, 'package-lock.json'), lockWith('auto', [['a', '1.0.0'], ['b', '2.0.0']]));
      rmSync(nm, { recursive: true, force: true });
      mkdirSync(nm, { recursive: true });
      writeFileSync(join(nm, '.package-lock.json'), hiddenWith([['a', '1.0.0']]));
      writeFileSync(join(nm, 'old.txt'), 'old');
    };
    stale();
    assert.equal(ws.depsStatus(real.cwd)[0].state, 'stale');
    // Foreign tree and live checkout: untouched, no note.
    assert.equal(await ws.prOpenDepsRelink(repo), '', 'a tree outside STAM_HOME/worktrees is left alone');
    const prev = process.env.STAM_DEPLOY_REPO;
    process.env.STAM_DEPLOY_REPO = real.cwd;
    try {
      assert.equal(await ws.prOpenDepsRelink(real.cwd), '', 'the live checkout is refused');
      assert.equal(ws.depsStatus(real.cwd)[0].state, 'stale', 'and nothing was relinked there');
    } finally {
      if (prev === undefined) delete process.env.STAM_DEPLOY_REPO;
      else process.env.STAM_DEPLOY_REPO = prev;
    }
    // A cache miss: the request returns at once, the old install stays until the fill is done, then the link lands.
    const note = await ws.prOpenDepsRelink(real.cwd);
    assert.match(note, /relink runs in the background/);
    assert.match(note, /rerun your tests/);
    // A second pr_open and a `stam deps relink` meanwhile join the running relink rather than racing its swap.
    const second = ws.prOpenDepsRelink(real.cwd);
    const direct = ws.relinkDeps(real.cwd, false, ['.']);
    assert.match(await second, /relink runs in the background/);
    assert.deepEqual((await direct).map((x) => x.event), ['deps:linked']);
    await until(() => existsSync(join(nm, 'foo.txt')));
    assert.ok(!existsSync(join(nm, 'old.txt')), 'the new install replaced the old');
    assert.equal(readdirSync(real.cwd).filter((f) => f.startsWith('node_modules.')).length, 1, 'one old install aside, no half-copied new one');
    assert.ok(!existsSync(join(nm, 'node_modules')), 'cp did not copy into an existing directory');
    // A cache hit (the fill above made it): relinked before the call returns.
    stale();
    assert.match(await ws.prOpenDepsRelink(real.cwd), /relinked it\. Rerun your tests/);
    assert.ok(existsSync(join(nm, 'foo.txt')), 'the cache was linked in');
    assert.equal(await ws.prOpenDepsRelink(real.cwd), '', 'nothing stale afterwards, so silent');
  } finally {
    ws.cleanupWorkspace(real, true);
  }
});

test('a failing relink leaves the old install, or the old symlink, in place; only the stale folders are touched (S-1706)', async () => {
  const repo = repoWith(join(work, 'fail-repo'), ['', 'web'], 'fail');
  const real = ws.createWorkspace({ kind: 'worktree', repo, branch: 'stam/fail' }, 'fail');
  const failNpm = join(work, 'fail-npm');
  writeFileSync(failNpm, '#!/bin/sh\nexit 1\n');
  chmodSync(failNpm, 0o755);
  const old = process.env.STAM_NPM;
  try {
    await Promise.all(real.deps.map((d) => d.warm?.()));
    const nm = join(real.cwd, 'node_modules');
    const web = join(real.cwd, 'web', 'node_modules');
    // Root: stale install. web: an install with no hidden lockfile (unknown), which must not be touched.
    writeFileSync(join(real.cwd, 'package-lock.json'), lockWith('fail', [['b', '2.0.0']]));
    rmSync(nm, { recursive: true, force: true });
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, '.package-lock.json'), hiddenWith([]));
    writeFileSync(join(nm, 'old.txt'), 'old');
    rmSync(web, { recursive: true, force: true });
    mkdirSync(web, { recursive: true });
    writeFileSync(join(web, 'mine.txt'), 'mine');
    assert.deepEqual(ws.depsStatus(real.cwd).map((s) => s.state), ['stale', 'unknown']);
    process.env.STAM_NPM = failNpm;
    const r = await ws.relinkDeps(real.cwd, false, ['.']);
    assert.deepEqual(r.map((x) => [x.dir, x.event]), [['.', 'deps:failed']], 'only the named folder is looked at');
    assert.ok(existsSync(join(nm, 'old.txt')), 'the failed relink left the old install');
    assert.ok(existsSync(join(web, 'mine.txt')), 'the unknown folder is untouched');
    assert.ok(!readdirSync(real.cwd).some((f) => f.startsWith('node_modules.old-')), 'nothing left aside');
    assert.match(await ws.prOpenDepsRelink(real.cwd), /does not match package-lock\.json/, 'the pr_open note falls back to the warning');
    // The symlink state: a failed relink keeps the link, a working one replaces it and leaves its target alone.
    rmSync(nm, { recursive: true, force: true });
    const outside = join(work, 'fail-outside');
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, nm);
    assert.equal(ws.depsStatus(real.cwd)[0].state, 'symlink');
    assert.equal((await ws.relinkDeps(real.cwd, false, ['.']))[0].event, 'deps:failed');
    assert.ok(lstatSync(nm).isSymbolicLink(), 'the symlink is back after a failed relink');
    process.env.STAM_NPM = old;
    assert.equal((await ws.relinkDeps(real.cwd, false, ['.']))[0].event, 'deps:linked');
    assert.ok(!lstatSync(nm).isSymbolicLink() && existsSync(join(nm, 'foo.txt')), 'a working relink replaces the symlink');
    assert.ok(existsSync(outside), 'the symlink target is untouched');
  } finally {
    process.env.STAM_NPM = old;
    ws.cleanupWorkspace(real, true);
  }
});
