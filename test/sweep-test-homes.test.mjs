#!/usr/bin/env node
// scripts/sweep-test-homes.mjs (S-428): an old, unused test home is removed; a new one, one a process
// uses (by cwd, or by STAM_HOME in its environment), one that isn't a matching directory, and
// anything under --dry-run stay. Real processes, started and killed here by pid; two folders of
// our own stand in for /tmp and the cache; no sleeps: `node --test test/sweep-test-homes.test.mjs`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { fileURLToPath } from 'node:url';
import { TMP_PATTERN, tmpPattern, testPrefixes } from '../scripts/sweep-test-homes.mjs';

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
const sweep = (...args) =>
  spawnSync(process.execPath, [SCRIPT, '--tmp', tmp, '--cache', cache, '--review', review, '--home-cache', homeCache, ...args], {
    encoding: 'utf8',
    env: { ...process.env, STAM_SWEEP_AGENTS: agentsFile },
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
  const r = spawnSync(process.execPath, [link, '--tmp', join(base, 'viasym'), '--cache', cache, '--dry-run'], { encoding: 'utf8' });
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
  for (const p of ['stam-budgets', 'stam-rules', 'stam-usage', 'stam-voice', 'stam-check-playwright-test']) {
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
    assert.deepEqual(testPrefixes(dir), ['stam-derived-four', 'stam-derived-one', 'stam-derived-two']);
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
  const r2 = spawnSync(process.execPath, [SCRIPT, '--tmp', tmp, '--cache', cache, '--review', linkRoot, '--home-cache', homeCache], { encoding: 'utf8', env: { ...process.env, STAM_SWEEP_AGENTS: agentsFile } });
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(existsSync(victim), 'a symlinked root must not be swept');
});
