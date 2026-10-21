#!/usr/bin/env node
// scripts/sweep-test-homes.mjs (S-428): an old, unused test home is removed; a new one, one a process
// uses (by cwd, or by STAM_HOME in its environment), one that isn't a matching directory, and
// anything under --dry-run stay. Real processes, started and killed here by pid; two folders of
// our own stand in for /tmp and the cache; no sleeps: `node --test test/sweep-test-homes.test.mjs`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import './scrub-env.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdirSync, symlinkSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { fileURLToPath } from 'node:url';
import { readdirSync as readdirSyncNames } from 'node:fs';
import { TMP_PATTERN, tmpPattern, testPrefixes, pruneDepsCache, pruneBackups, pruneCaches, claimedPaths, currentKeys, inUse, pidsOf } from '../scripts/sweep-test-homes.mjs';
import { GONE, NODEPS, linkLocked, linkLockedAsync, tryExclusive } from '../scripts/deps-lock.mjs';
// '../scripts/sweep-test-homes.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/sweep-test-homes.mjs', import.meta.url));
const base = mkdtempSync(join(tmpdir(), 'stam-sweep-unit-'));
const tmp = join(base, 'tmp');
const cache = join(base, 'cache');
mkdirSync(tmp);
mkdirSync(cache);
const started = [];
after(() => {
  for (const p of started) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {}
  }
  rmSync(base, { recursive: true, force: true });
});

const old = new Date(Date.now() - 5 * 3600_000);
function home(root, name, age = old) {
  const d = join(root, name);
  mkdirSync(d);
  writeFileSync(join(d, 'stam.db'), 'x');
  utimesSync(join(d, 'stam.db'), age, age);
  utimesSync(d, age, age);
  return d;
}
async function holder(opts) {
  const c = spawn('sh', ['-c', 'while :; do sleep 1; done'], { stdio: 'ignore', detached: true, ...opts });
  started.push(c.pid);
  c.unref();
  // Wait until /proc shows the shell, not the node fork.
  while (!readFileSync(`/proc/${c.pid}/cmdline`, 'utf8').startsWith('sh')) await new Promise((r) => setImmediate(r));
  return c.pid;
}
const review = join(base, 'review');
const homeCache = join(base, 'homecache');
mkdirSync(review);
mkdirSync(homeCache);
const agentsFile = join(base, 'agents.json');
writeFileSync(agentsFile, '[]');
// The cache pruning of S-1965 reads these three; the tests name folders of their own, never the real ones.
// The sweeps scan only the processes this test started (never the host's others), so a host process that can't be
// read can't change a result; a '1' keeps the list from being empty, which would mean every process.
const pids = () => started.join(',') || '1';
const cacheEnv = { STAM_HOME: join(base, 'stamhome'), STAM_GATE_DEPS: join(base, 'gatedeps'), STAM_SWEEP_MAIN: join(base, 'nomain') };
const sweep = (...args) =>
  spawnSync(process.execPath, [SCRIPT, '--tmp', tmp, '--cache', cache, '--review', review, '--home-cache', homeCache, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...cacheEnv, STAM_SWEEP_PIDS: pids(), STAM_SWEEP_AGENTS: agentsFile },
  });

test('removes only an old, unused, matching test home; --dry-run removes nothing', async () => {
  const gone = home(tmp, 'stam-budgets-aaaaaa');
  const goneCache = home(cache, 'stam-test.user.bbbb');
  const fresh = home(tmp, 'stam-rules-cccccc', new Date());
  const byCwd = home(tmp, 'stam-usage-dddddd');
  const byEnv = home(tmp, 'stam-voice-eeeeee');
  const unrelated = home(tmp, 'other-ffff');
  const foreign = [home(tmp, 'stam-check-daemon.abcdef'), home(tmp, 'stam-my-project'), home(tmp, 'stam-budgets-notrandom')];
  const notMatching = home(cache, 'keepme-gggg');
  const file = join(tmp, 'stam-file.lock');
  writeFileSync(file, '');
  utimesSync(file, old, old);
  await holder({ cwd: byCwd });
  await holder({ env: { ...process.env, STAM_HOME: byEnv } });

  const dry = sweep('--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /would remove .*stam-budgets-aaaaaa/);
  assert.match(dry.stdout, /would remove .*stam-test\.user\.bbbb/);
  assert.match(dry.stdout, /kept .*stam-usage-dddddd \(a process uses it\)/);
  assert.match(dry.stdout, /kept .*stam-voice-eeeeee \(a process uses it\)/);
  assert.match(dry.stdout, /kept .*stam-rules-cccccc \(newer than 2 h\)/);
  for (const d of [gone, goneCache, fresh, byCwd, byEnv, unrelated, notMatching]) assert.ok(existsSync(d), `${d} survives a dry run`);

  const real = sweep();
  assert.equal(real.status, 0, real.stderr);
  assert.ok(!existsSync(gone) && !existsSync(goneCache), 'old unused homes are removed');
  for (const d of [fresh, byCwd, byEnv, unrelated, notMatching, file, ...foreign]) assert.ok(existsSync(d), `${d} stays`);

  // --hours 0 makes the fresh one old; it is unused, so it goes.
  sweep('--hours', '0');
  assert.ok(!existsSync(fresh), 'with --hours 0 a fresh unused home is removed');
  assert.ok(existsSync(byCwd) && existsSync(byEnv), 'a used home stays whatever its age');
});

test('runs when started through a symlink to the script', () => {
  mkdirSync(join(base, 'viasym'));
  home(join(base, 'viasym'), 'stam-budgets-zzzzzz');
  const link = join(base, 'sweep-link.mjs');
  symlinkSync(SCRIPT, link);
  const r = spawnSync(process.execPath, [link, '--tmp', join(base, 'viasym'), '--cache', cache, '--dry-run'], { encoding: 'utf8', env: { ...process.env, ...cacheEnv, STAM_SWEEP_PIDS: pids(), STAM_SWEEP_AGENTS: agentsFile } });
  assert.match(r.stdout, /would remove .*stam-budgets-zzzzzz/);
});

test('--install writes the unit files (and, outside a test dir, enables the timer)', () => {
  const dir = join(base, 'units');
  const fakeHome = join(base, 'home');
  mkdirSync(fakeHome);
  const install = () => spawnSync(process.execPath, [SCRIPT, '--install'], { encoding: 'utf8', env: { ...process.env, HOME: fakeHome, STAM_SWEEP_UNIT_DIR: dir } });
  const service = () => readFileSync(join(dir, 'stam-sweep-test-homes.service'), 'utf8');
  const r = install();
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(join(dir, 'stam-sweep-test-homes.timer'), 'utf8'), /OnCalendar=hourly/);
  // No deployed copy: the unit runs this script. A user unit's PATH lacks node and ~/.local/bin (where stam is).
  assert.match(service(), new RegExp(`ExecStart=.* ${SCRIPT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  const pathLine = service().split('\n').find((l) => l.startsWith('Environment=PATH='));
  assert.ok(pathLine.includes(dirname(process.execPath)) && pathLine.includes(join(fakeHome, '.local/bin')), pathLine);
  // The main checkout's copy wins over the script's own path; the deployed release's wins over both.
  const main = join(fakeHome, 'projects/stam2/scripts');
  mkdirSync(main, { recursive: true });
  writeFileSync(join(main, 'sweep-test-homes.mjs'), '');
  install();
  assert.ok(service().includes(`${join(main, 'sweep-test-homes.mjs')}\n`), service());
  const rel = join(fakeHome, '.local/share/stam/releases/current/scripts');
  mkdirSync(rel, { recursive: true });
  writeFileSync(join(rel, 'sweep-test-homes.mjs'), '');
  install();
  assert.ok(service().includes(`${join(rel, 'sweep-test-homes.mjs')}\n`), service());
});

// The sweep's prefix set is derived from the tests' own sources (S-775), so a test that makes a new
// kind of folder is swept with no list to keep in step. These prove the derivation reads test/*.mjs,
// that every prefix it finds is swept, and that the pattern still refuses anything a real home could
// look like.
test('the prefixes a test gives its temporary folder are swept, with no hand list', () => {
  const prefixes = testPrefixes();
  assert.ok(prefixes.length > 0, 'the derivation found no test prefixes');
  // A few a test makes, including one the old hand list had gone stale on.
  for (const p of ['stam-budgets', 'stam-rules', 'stam-usage', 'stam-voice', 'stam-check-playwright-test', 'stam-cv', 'stam-nr']) {
    assert.ok(prefixes.includes(p), `${p} is not derived from the tests`);
  }
  for (const p of prefixes) {
    assert.match(p, /^stam-.+/, `${p} is not a stam- prefix`);
    assert.ok(TMP_PATTERN.test(`${p}-AbC123`), `${p} with a random suffix is not swept`);
  }
  assert.deepEqual(prefixes, [...prefixes].sort(), 'the derived list is sorted and unique');
});

test('the derivation reads real temp calls, never comments, strings, or computed arguments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stam-tmphome-check-'));
  try {
    writeFileSync(join(dir, 'a.test.mjs'), [
      "const home = tempHome('stam-derived-one-');",
      "const work = mkdtempSync(join(tmpdir(), 'stam-derived-two-'));",
      "const made = tempDir('stam-derived-four-');",
      "const outside = tempDirOutside('stam-derived-five-');",
      "const outsideComputed = tempDirOutside(name);",
      "const withOutside = tempHome('stam-derived-six-', tempDirOutside);",
      "const computedSecond = tempHome('stam-derived-seven-', pick);",
      "// const commented = tempHome('stam-commented-');",
      "/* const block = mkdtempSync(join(tmpdir(), 'stam-block-')); */",
      `const inString = "tempHome('stam-in-string-')";`,
      "const inTemplate = `tempHome('stam-in-template-')`;",
      'const dynamic = mkdtempSync(join(tmpdir(), name));',
      "const concat = tempHome('stam-concat-' + suffix);",
      "const escaped = tempHome('stam-escape-\\n');",
      "const templated = mkdtempSync(join(tmpdir(), `stam-derived-three-${i}-`));",
      "const regexed = /tempHome('stam-in-regex-')/;",
      "const wrong = tempHome('not-stam-');",
      "const bare = tempHome('stam-');",
      "const unrelated = mkdtempSync(join(tmpdir(), 'other-four-'));",
    ].join('\n'));
    writeFileSync(join(dir, 'not-a-test.txt'), "tempHome('stam-derived-notread-')");
    assert.deepEqual(testPrefixes(dir), ['stam-derived-five', 'stam-derived-four', 'stam-derived-one', 'stam-derived-six', 'stam-derived-two']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the pattern sweeps a known prefix only with the anchored random suffix', () => {
  const p = tmpPattern(['stam-budgets']);
  for (const name of ['stam-budgets-abcdef', 'stam-budgets-123-AbC123']) assert.ok(p.test(name), `${name} should be swept`);
  for (const name of [
    'stam',
    'stam-test',
    'stam-test-logs',
    'stam-check-daemon.abcdef', // a daemon home, not a test's 6-char suffix
    'stam-my-project',
    'stam-personal-home-abcdef', // a prefix no test makes is not in a controlled set
    'stam-budgets-notrandom',
    'stam-budgets-abcde', // 5 chars, not the anchored 6
    'stam-budgets-abcdefg', // 7 chars
    'stam-budgets-abcde.', // a dot where the suffix ends
    '-123456',
    '123456',
  ]) {
    assert.ok(!p.test(name), `${name} must not be swept`);
  }
  for (const name of ['stam-test.owner.bbbb', 'stam-test-logs.AbC123', 'stam-ui-shots.AbC123']) assert.ok(p.test(name), `${name} is a named test folder and should be swept`);
});

test('an unreadable test folder sweeps nothing', () => {
  assert.deepEqual(testPrefixes(join(base, 'no-such-tests')), []);
});

// The derivation yielding nothing must narrow the sweep to the named test folders, never widen it to a
// bare suffix: with no prefixes the pattern keeps the sweep's hands off whatever it cannot name.
test('no derived prefixes leaves only the named test folders sweepable', () => {
  const none = tmpPattern([]);
  for (const name of ['-123456', '123456', 'stam', 'stam-my-project', 'stam-budgets-abcdef']) {
    assert.ok(!none.test(name), `${name} must not be swept with no derived prefixes`);
  }
  assert.ok(none.test('stam-test.owner.bbbb'), 'a lib.sh test folder is still swept');
  assert.ok(none.test('stam-test-logs.AbC123'), 'a run.sh log folder is still swept');
});

// S-1235: review clones and non-standard review homes, judged like test homes plus the live agents.
const older = new Date(Date.now() - 7 * 3600_000);
test('review leftovers: old unused ones go; new, used, named-by-an-agent, worktrees handled; protected folders stay', async () => {
  const gone = [home(review, 'pr478', older), home(review, '.tmp-quick-t2', older), home(cache, 'rev271', older), home(homeCache, 'review-262-2', older)];
  const fresh = home(review, 'pr489', new Date());
  const byCwd = home(review, 'pr407', older);
  const named = home(review, 'lanes-476', older);
  const namedByPath = home(cache, 'pr198', older);
  const lookalike = home(review, 'pr4781', older); // not named by an agent that names pr478
  const keepDotGit = home(review, '.git', older);
  const protectedDirs = ['stam-gate-deps', 'ms-playwright', 'uv'].map((n) => home(homeCache, n, older));
  const outside = home(homeCache, 'claude', older);
  const holderPid = await holder({ cwd: byCwd });
  assert.ok(holderPid);
  writeFileSync(agentsFile, JSON.stringify([{ name: 'rev', first_prompt: 'check lanes-476 please' }, { cwd: namedByPath }]));

  const dry = sweep('--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  for (const d of [...gone, lookalike]) assert.match(dry.stdout, new RegExp(`would remove ${d.replace(/[.]/g, '\\.')} `));
  for (const d of [fresh, byCwd, named, namedByPath, keepDotGit, ...protectedDirs, outside]) assert.ok(existsSync(d) && !dry.stdout.includes(`remove ${d} `), d);
  assert.match(dry.stdout, /kept .*lanes-476 \(a live agent names it\)/);
  assert.ok([...gone, lookalike].every(existsSync), 'dry run removed nothing');

  const real = sweep();
  assert.equal(real.status, 0, real.stderr);
  for (const d of [...gone, lookalike]) assert.ok(!existsSync(d), `${d} should be gone`);
  for (const d of [fresh, byCwd, named, namedByPath, keepDotGit, ...protectedDirs, outside]) assert.ok(existsSync(d), `${d} should stay`);
});

test('review leftovers: a worktree goes by git worktree remove; unreadable agents keep everything', () => {
  const repo = join(base, 'repo');
  mkdirSync(repo);
  const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
  const wt = join(review, 'wt-branch-1');
  assert.equal(git('worktree', 'add', '-q', '-b', 'wtb', wt).status, 0);
  for (const e of ['.git', 'README', '']) { try { utimesSync(join(wt, e), older, older); } catch {} };
  writeFileSync(agentsFile, '{not json');
  const kept = sweep();
  assert.match(kept.stdout, /kept .*wt-branch-1 \(live agents unreadable\)/);
  assert.ok(existsSync(wt));
  writeFileSync(agentsFile, '[]');
  const real = sweep();
  assert.match(real.stdout, /removed .*wt-branch-1/);
  assert.ok(!existsSync(wt));
  assert.ok(!git('worktree', 'list').stdout.includes('wt-branch-1'), 'git no longer lists the worktree');
});

test('review leftovers: a fresh edit deep in an old clone keeps it; a symlinked root is not swept', () => {
  const clone = home(review, 'deep-edit-1', older);
  mkdirSync(join(clone, 'src'));
  writeFileSync(join(clone, 'src', 'live.js'), 'x');
  utimesSync(join(clone, 'src'), older, older);
  utimesSync(join(clone, 'stam.db'), older, older);
  utimesSync(clone, older, older); // mkdir/writeFile refreshed it; only src/live.js is new
  const r = sweep();
  assert.match(r.stdout, /kept .*deep-edit-1 \(newer than 6 h\)/);
  assert.ok(existsSync(clone));

  const elsewhere = join(base, 'elsewhere');
  mkdirSync(elsewhere);
  const victim = home(elsewhere, 'pr999', older);
  const linkRoot = join(base, 'link-review');
  symlinkSync(elsewhere, linkRoot);
  const r2 = spawnSync(process.execPath, [SCRIPT, '--tmp', tmp, '--cache', cache, '--review', linkRoot, '--home-cache', homeCache], { encoding: 'utf8', env: { ...process.env, ...cacheEnv, STAM_SWEEP_PIDS: pids(), STAM_SWEEP_AGENTS: agentsFile } });
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(existsSync(victim), 'a symlinked root must not be swept');
});

// S-1965: deps caches and database backups. Entry names are 16 hex digits; hard links stand in for a
// worktree's `cp -al` copy.
function depsEntry(root, key, ageMin, { linkTo } = {}) {
  const d = join(root, key);
  mkdirSync(join(d, 'node_modules'), { recursive: true });
  writeFileSync(join(d, 'node_modules', '.package-lock.json'), '{}');
  writeFileSync(join(d, '.ready'), 'x');
  if (linkTo) linkSync(join(d, 'node_modules', '.package-lock.json'), linkTo);
  const t = new Date(Date.now() - ageMin * 60_000);
  for (const p of [join(d, '.ready'), d]) utimesSync(p, t, t);
  return d;
}

test('pruneDepsCache keeps an entry a worktree links, main\'s keys and the newest 3 unused; removes the rest', () => {
  const root = join(base, 'deps1');
  mkdirSync(root);
  const wt = join(base, 'wt-lock.json');
  const linked = depsEntry(root, 'a000000000000001', 9000, { linkTo: wt });
  const current = depsEntry(root, 'a000000000000002', 9000);
  const unused = [1, 2, 3, 4, 5].map((i) => depsEntry(root, `b00000000000000${i}`, i * 10));
  const res = pruneDepsCache(root, { keys: new Set(['a000000000000002']), claims: [] });
  assert.ok(existsSync(linked) && existsSync(current), 'in use and current entries stay');
  assert.deepEqual(unused.map((p) => existsSync(p)), [true, true, true, false, false]);
  assert.equal(res.filter((r) => r.action === 'remove').length, 2);
  // A dry run removes nothing.
  const root2 = join(base, 'deps2');
  mkdirSync(root2);
  const e = [1, 2, 3, 4].map((i) => depsEntry(root2, `c00000000000000${i}`, i));
  pruneDepsCache(root2, { claims: [], dryRun: true });
  assert.ok(e.every((p) => existsSync(p)));
});

test('pruneDepsCache skips a ramp-old entry a live process has its cwd in, and non-key names', async () => {
  const root = join(base, 'deps3');
  mkdirSync(root);
  const busy = depsEntry(root, 'd000000000000001', 99999);
  const fillers = [1, 2, 3].map((i) => depsEntry(root, `d00000000000000${i + 1}`, i));
  mkdirSync(join(root, 'e000000000000009.tmp-1'));
  const pid = await holder({ cwd: busy });
  const claims = claimedPaths('/proc', [String(pid)]);
  assert.equal(claims.unreadable, false, 'the scan of the test\'s own process reads cleanly');
  assert.ok(claims.some((c) => c === busy), 'and it sees the cwd');
  const res = pruneDepsCache(root, { claims });
  process.kill(pid, 'SIGKILL');
  assert.ok(existsSync(busy), 'a process cwd inside keeps the entry');
  assert.ok(fillers.every((p) => existsSync(p)));
  assert.ok(existsSync(join(root, 'e000000000000009.tmp-1')));
  assert.match(res.find((r) => r.path === busy).why, /process/);
});

test('pruneBackups keeps the newest 2 stam.db.bak-* and nothing else is touched', () => {
  const h = join(base, 'bakhome');
  mkdirSync(h);
  const mk = (n, ageMin) => {
    const p = join(h, n);
    writeFileSync(p, 'x');
    const t = new Date(Date.now() - ageMin * 60_000);
    utimesSync(p, t, t);
    return p;
  };
  const b = [mk('stam.db.bak-2026-10-16-before-a', 30), mk('stam.db.bak-2026-10-17-before-b', 20), mk('stam.db.bak-2026-10-18-before-c', 10)];
  const db = mk('stam.db', 99);
  pruneBackups(h, { claims: [] });
  assert.deepEqual(b.map((p) => existsSync(p)), [false, true, true]);
  assert.ok(existsSync(db));
});

test('pruneCaches works from the named roots only and never reaches uv or bai2', () => {
  const home2 = join(base, 'pc-home');
  const gate = join(base, 'pc-gate');
  const uv = join(base, 'pc-uv');
  mkdirSync(join(home2, 'deps'), { recursive: true });
  mkdirSync(gate);
  mkdirSync(uv);
  const g = [1, 2, 3, 4].map((i) => depsEntry(gate, `f00000000000000${i}`, i));
  const d = [1, 2, 3, 4].map((i) => depsEntry(join(home2, 'deps'), `f00000000000000${i}`, i));
  writeFileSync(join(uv, 'cache'), 'x');
  const { results } = pruneCaches({ env: { STAM_HOME: home2, STAM_GATE_DEPS: gate, STAM_SWEEP_MAIN: join(base, 'nomain') }, claims: [] });
  assert.equal(results.filter((r) => r.action === 'remove').length, 2);
  assert.ok(!existsSync(g[3]) && !existsSync(d[3]) && existsSync(g[0]) && existsSync(uv));
});

test('currentKeys names the dev and non-dev keys for the root and web lockfiles', () => {
  const m = join(base, 'mainrepo');
  mkdirSync(join(m, 'web'), { recursive: true });
  for (const d of [m, join(m, 'web')]) {
    writeFileSync(join(d, 'package.json'), '{}');
    writeFileSync(join(d, 'package-lock.json'), '{}');
  }
  const k = currentKeys(m);
  assert.ok(k.size >= 3 && [...k].every((x) => /^[0-9a-f]{16}$/.test(x)));
});

test('a project folder under ~/projects named like a review clone is never touched', () => {
  const fakeHome = join(base, 'fakehome');
  const proj = join(fakeHome, 'projects', 'review-dashboard');
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, 'a.txt'), 'x');
  const ancient = new Date(Date.now() - 400 * 3600_000);
  utimesSync(join(proj, 'a.txt'), ancient, ancient);
  utimesSync(proj, ancient, ancient);
  const r = spawnSync(process.execPath, [SCRIPT, '--tmp', tmp, '--cache', cache, '--home-cache', homeCache], { encoding: 'utf8', env: { ...process.env, ...cacheEnv, STAM_SWEEP_PIDS: pids(), HOME: fakeHome, XDG_CACHE_HOME: join(base, 'xdg'), STAM_SWEEP_AGENTS: agentsFile } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(proj));
});

test('a consumer holding the cache lock makes the pruner skip; once it lets go, the prune runs', async () => {
  const root = join(base, 'deps-lock');
  mkdirSync(root);
  const e = [1, 2, 3, 4].map((i) => depsEntry(root, `a10000000000000${i}`, i));
  // A consumer mid-link: a real flock -s holder, as linkLocked's cp would be.
  const holderProc = spawn('sh', ['-c', 'exec 9>>"$1"; flock -s 9; exec sleep 60', 'sh', join(root, '.prune.lock')], { stdio: 'ignore' });
  started.push(holderProc.pid);
  // Wait until the shared lock is held: an exclusive try fails.
  for (let i = 0; i < 200 && (() => { const l = tryExclusive(root); l?.release(); return l; })(); i++) await new Promise((r) => setTimeout(r, 25));
  const busy = pruneDepsCache(root, { claims: [] });
  assert.ok(e.every((p) => existsSync(p)), 'nothing is removed while a consumer holds the lock');
  assert.match(busy[0].why, /lock is busy/);
  holderProc.kill('SIGKILL');
  await new Promise((r) => holderProc.on('close', r));
  const res = pruneDepsCache(root, { claims: [] });
  assert.equal(res.filter((r) => r.action === 'remove').length, 1);
  assert.ok(!existsSync(e[3]));
  assert.deepEqual(readdirSyncNames(root).filter((n) => n.startsWith('.pruned-')), [], 'set-aside victims are deleted');
});

test('linkLocked copies inside the lock when the hard link fails, and the pruner can\'t land meanwhile', () => {
  const root = join(base, 'deps-copy');
  mkdirSync(root);
  const d = depsEntry(root, 'a40000000000001a', 1);
  const target = join(base, 'copied-nm');
  const was = process.env.STAM_DEPS_LINK;
  process.env.STAM_DEPS_LINK = 'false';
  try {
    assert.equal(linkLocked(root, d, target), 0);
  } finally {
    if (was === undefined) delete process.env.STAM_DEPS_LINK;
    else process.env.STAM_DEPS_LINK = was;
  }
  assert.ok(existsSync(join(target, '.package-lock.json')));
});

test('linkLocked links a present entry and returns GONE for one removed before the lock', () => {
  const root = join(base, 'deps-link');
  mkdirSync(root);
  const d = depsEntry(root, 'a20000000000001a', 1);
  const target = join(base, 'linked-nm');
  assert.equal(linkLocked(root, d, target), 0);
  assert.ok(existsSync(join(target, '.package-lock.json')));
  rmSync(d, { recursive: true, force: true });
  assert.equal(linkLocked(root, d, join(base, 'linked-nm2')), GONE);
});

// A fake /proc entry for this user's process: stat names its comm and state.
function fakeProc(root, pid, { comm = 'worker', state = 'S', environ = 'A=b', uid = process.getuid() } = {}) {
  const d = join(root, String(pid));
  mkdirSync(d, { recursive: true });
  symlinkSync('/', join(d, 'cwd'));
  mkdirSync(join(d, 'fd'));
  writeFileSync(join(d, 'stat'), `${pid} (${comm}) ${state} 1 1 1`);
  writeFileSync(join(d, 'status'), `Name:\t${comm}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
  writeFileSync(join(d, 'environ'), environ);
  writeFileSync(join(d, 'cmdline'), 'x');
  return d;
}

test('claimedPaths: a same-user process whose environ or cmdline can\'t be read is unknown, unless it is a zombie or a known opaque one', () => {
  if (process.getuid() === 0) return;
  const mk = (name, build) => {
    const root = join(base, name);
    mkdirSync(root);
    build(root);
    return claimedPaths(root).unreadable;
  };
  // environ unreadable (PR_SET_DUMPABLE=0 looks like this): unknown, so everything is kept.
  assert.equal(mk('fp-environ', (r) => chmodSync(fakeProc(r, 11) + '/environ', 0)), true);
  assert.equal(mk('fp-cmdline', (r) => chmodSync(fakeProc(r, 12) + '/cmdline', 0)), true);
  // The same denial from ssh-agent, systemd or (sd-pam) is expected, and a zombie holds nothing.
  assert.equal(mk('fp-agent', (r) => chmodSync(fakeProc(r, 13, { comm: 'ssh-agent' }) + '/environ', 0)), false);
  assert.equal(mk('fp-sdpam', (r) => chmodSync(fakeProc(r, 14, { comm: '(sd-pam)' }) + '/environ', 0)), false);
  assert.equal(mk('fp-zombie', (r) => chmodSync(fakeProc(r, 15, { state: 'Z' }) + '/environ', 0)), false);
  // The uid comes from status, not from who owns /proc/PID (root for an undumpable process): a process whose status
  // names another uid is not a user; one whose status names this user is, whoever owns its directory.
  assert.equal(mk('fp-otheruid', (r) => chmodSync(fakeProc(r, 17, { uid: process.getuid() + 1 }) + '/environ', 0)), false);
  assert.equal(mk('fp-ouruid', (r) => chmodSync(fakeProc(r, 18) + '/environ', 0)), true);
  // A status that can't be read leaves the process unknown (counted as ours); one that is gone is not a user.
  assert.equal(mk('fp-nostatus-read', (r) => { const d = fakeProc(r, 19); chmodSync(d + '/environ', 0); chmodSync(d + '/status', 0); }), true);
  assert.equal(mk('fp-nostatus-gone', (r) => { const d = fakeProc(r, 20); chmodSync(d + '/environ', 0); rmSync(d + '/status'); }), false);
  // A process that can't be named (no stat) and can't be read is unknown too.
  assert.equal(mk('fp-nostat', (r) => { const d = fakeProc(r, 16); chmodSync(d + '/environ', 0); rmSync(d + '/stat'); }), true);
});

test('fail safe: an entry whose link count can\'t be read stays, and unreadable process state keeps everything', () => {
  if (process.getuid() === 0) return;
  const root = join(base, 'deps-fs');
  mkdirSync(root);
  const unknown = depsEntry(root, 'a30000000000001a', 9999);
  chmodSync(join(unknown, 'node_modules'), 0);
  const extra = [1, 2, 3, 4].map((i) => depsEntry(root, `a3000000000000${i}b`, i));
  try {
    pruneDepsCache(root, { claims: [] });
  } finally {
    chmodSync(join(unknown, 'node_modules'), 0o755);
  }
  assert.ok(existsSync(unknown), 'a stat error is "in use"');
  assert.ok(!existsSync(extra[3]));
  // A process of ours with an unreadable cwd: every path counts as used.
  const proc = join(base, 'fakeproc');
  mkdirSync(join(proc, '4242'), { recursive: true });
  writeFileSync(join(proc, '4242', 'cwd'), 'not a link');
  writeFileSync(join(proc, '4242', 'status'), `Uid:\t${process.getuid()}\t0\t0\t0\n`);
  const claims = claimedPaths(proc);
  assert.equal(claims.unreadable, true);
  assert.equal(inUse('/anywhere/else', claims), true);
  assert.equal(claimedPaths(join(base, 'no-such-proc')).unreadable, true);
  const fine = join(base, 'fakeproc-ok');
  mkdirSync(join(fine, '4243'), { recursive: true });
  assert.equal(claimedPaths(fine).unreadable, false);
});

test('the classification is inside the lock: an entry removed while a pruner holds the lock reads GONE, not a false success', async () => {
  const root = join(base, 'deps-race');
  mkdirSync(root);
  const d = depsEntry(root, 'a50000000000001a', 1);
  const pruner = tryExclusive(root);
  assert.ok(pruner, 'this test is the pruner');
  // The consumer starts its link (it waits for the shared lock); the pruner removes the entry; the consumer then runs.
  const link = linkLockedAsync(root, d, join(base, 'race-nm'));
  await new Promise((r) => setTimeout(r, 200));
  rmSync(d, { recursive: true, force: true });
  pruner.release();
  assert.equal(await link, GONE);
  assert.equal(existsSync(join(base, 'race-nm')), false);
  // The same wait with the entry replaced by a no-dependencies fill reads NODEPS.
  const e = join(root, 'a50000000000002a');
  const pruner2 = tryExclusive(root);
  const link2 = linkLockedAsync(root, e, join(base, 'race-nm2'));
  await new Promise((r) => setTimeout(r, 200));
  mkdirSync(e);
  writeFileSync(join(e, '.ready'), 'x');
  pruner2.release();
  assert.equal(await link2, NODEPS);
});

test('STAM_SWEEP_PIDS: only a full comma list of positive integers filters; anything else scans every process and warns', () => {
  const warn = console.error;
  const seen = [];
  console.error = (m) => seen.push(m);
  try {
    assert.equal(pidsOf({}), null);
    assert.deepEqual(pidsOf({ STAM_SWEEP_PIDS: '12,345' }), ['12', '345']);
    assert.deepEqual(pidsOf({ STAM_SWEEP_PIDS: '7' }), ['7']);
    const bads = ['', ',', ' ', '12, 34', '12,', ',12', 'garbage', '0', '12,0', '-3', '1.5', '31\n', '4194305', '99999999999999999999', '12,4194305', '012', '+12'];
    for (const bad of bads) {
      assert.equal(pidsOf({ STAM_SWEEP_PIDS: bad }), null, JSON.stringify(bad));
    }
    assert.equal(seen.length, bads.length, 'each bad value warns');
    assert.deepEqual(pidsOf({ STAM_SWEEP_PIDS: '4194304' }), ['4194304'], 'the ceiling itself is a valid pid');
  } finally {
    console.error = warn;
  }
});

test('a malformed STAM_SWEEP_PIDS still sees the processes: a folder a fake process holds is kept', () => {
  for (const [i, bad] of ['', ',', ' ', 'garbage', '12, 34', '0', '99999999999999999999', '31\n'].entries()) {
    const t = join(base, `badpids-tmp-${i}`);
    mkdirSync(t);
    const held = home(t, 'stam-budgets-yyyyyy');
    const procRoot = join(base, `badpids-proc-${i}`);
    mkdirSync(procRoot);
    const d = fakeProc(procRoot, 31);
    rmSync(join(d, 'cwd'));
    symlinkSync(held, join(d, 'cwd'));
    const r = spawnSync(process.execPath, [SCRIPT, '--tmp', t, '--cache', join(base, `badpids-cache-${i}`), '--review', join(base, `badpids-review-${i}`), '--home-cache', join(base, `badpids-hc-${i}`)], { encoding: 'utf8', env: { ...process.env, ...cacheEnv, STAM_SWEEP_PROC: procRoot, STAM_SWEEP_PIDS: bad, STAM_SWEEP_AGENTS: agentsFile } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(held), `kept with STAM_SWEEP_PIDS=${JSON.stringify(bad)}`);
    assert.match(r.stdout, /kept .*stam-budgets-yyyyyy \(a process uses it\)/);
    assert.match(r.stderr, /not a comma list of pids/);
  }
});
