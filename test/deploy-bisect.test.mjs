#!/usr/bin/env node
// The canary bisection (S-1750, scripts/canary-bisect.mjs), synthetic only: the canary is a scripted function, or for
// the CLI a shell command (STAM_BISECT_CANARY_CMD) that answers per sha, and mail and gh only record. Covered: the first
// bad merge is found in about log2(N) steps, each fail rerun once; a step whose rerun passes, a step that errors, and
// a candidate whose fail doesn't reproduce are inconclusive; a step past its timeout is inconclusive; the CLI mails
// the result, comments on the bad PR, writes it back to its job file, and stops at its total deadline or once the hold
// is removed. Run with `node --test test/deploy-bisect.test.mjs`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmphome.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const BISECT = join(ROOT, 'scripts/canary-bisect.mjs');
const { bisect, removeBuilt } = await import(BISECT);
const { tryLock, lockHolder } = await import(join(ROOT, 'src/release-lock.ts'));

const work = tempDir('stam-deploy-bisect-test-');
after(() => rmSync(work, { recursive: true, force: true }));

// N merges, oldest first, with made-up shas and PR numbers 100 up.
const range = (n) => Array.from({ length: n }, (_, i) => ({ sha: `${String(i).padStart(2, '0')}`.repeat(20), pr: { number: 100 + i } }));

// A canary that fails every merge from `bad` on, recording each sha it was asked about. `override(sha, call)` can
// answer a run instead.
function scripted(merges, bad, override = () => undefined) {
  const calls = [];
  const run = async (sha) => {
    calls.push(sha);
    const got = override(sha, calls.filter((s) => s === sha).length);
    if (got) return got;
    const i = merges.findIndex((m) => m.sha === sha);
    return i >= bad ? { verdict: 'fail', reasons: [`stalls on ${sha.slice(0, 4)}`] } : { verdict: 'pass', reasons: [] };
  };
  return { run, calls };
}

test('the first bad merge of 63 is found in 8 steps: the candidate rerun, 6 midpoints, and the merge before the bad one again (S-1750)', async () => {
  const merges = range(63);
  const { run, calls } = scripted(merges, 40);
  const r = await bisect(merges, run);
  assert.equal(r.result, 'found');
  assert.equal(r.merge.pr.number, 140);
  assert.deepEqual(r.reasons, [`stalls on ${merges[40].sha.slice(0, 4)}`]);
  assert.equal(r.before.pr.number, 139, 'the merge before it');
  assert.equal(r.steps.length, 8, 'the candidate rerun, log2(63) midpoints, then the merge before the bad one again');
  for (const s of r.steps.slice(1, -1)) assert.deepEqual(s.runs, s.runs[0] === 'pass' ? ['pass'] : ['fail', 'fail'], 'a fail is rerun, a pass is not');
  assert.deepEqual(r.steps.at(-1), { sha: merges[39].sha, pr: 139, runs: ['pass'], reasons: [] });
  assert.ok(calls.length <= 14);
});

test('a candidate whose only bad merge is itself is named, and a bad first merge is named too (S-1750)', async () => {
  const merges = range(5);
  assert.equal((await bisect(merges, scripted(merges, 4).run)).merge.pr.number, 104);
  const first = await bisect(merges, scripted(merges, 0).run);
  assert.equal(first.merge.pr.number, 100);
  assert.equal(first.before, null, 'before the first merge is the live release, which no step runs');
});

test('a merge before the bad one that fails on its rerun is flaky: inconclusive (S-1750)', async () => {
  const merges = range(8);
  // Merge 4 on fails; merge 3 passes as a midpoint, then fails when it is run again before 4 is named.
  const { run } = scripted(merges, 4, (sha, n) => (sha === merges[3].sha && n === 2 ? { verdict: 'fail', reasons: ['x'] } : undefined));
  const r = await bisect(merges, run);
  assert.equal(r.result, 'inconclusive');
  assert.match(r.why, /passed, then failed: it is flaky there/);
});

test('a step whose rerun passes is flaky: inconclusive, with the steps tried (S-1750)', async () => {
  const merges = range(8);
  // The first midpoint (index 3) fails, then passes on its rerun.
  const { run } = scripted(merges, 2, (sha, n) => (sha === merges[3].sha && n === 2 ? { verdict: 'pass', reasons: [] } : undefined));
  const r = await bisect(merges, run);
  assert.equal(r.result, 'inconclusive');
  assert.match(r.why, /failed, then passed: it is flaky/);
  assert.deepEqual(r.steps.at(-1).runs, ['fail', 'pass']);
});

test("a step that returns an error is inconclusive, never read as good or bad (S-1750)", async () => {
  const merges = range(8);
  const { run } = scripted(merges, 2, (sha) => (sha === merges[3].sha ? { verdict: 'error', reasons: ['the db copy failed: timed out after 120 s'] } : undefined));
  const r = await bisect(merges, run);
  assert.equal(r.result, 'inconclusive');
  assert.match(r.why, /couldn't run: the db copy failed/);
});

test("a candidate whose fail doesn't reproduce stops before any midpoint (S-1750)", async () => {
  const merges = range(8);
  const { run, calls } = scripted(merges, 99);
  const r = await bisect(merges, run);
  assert.equal(r.result, 'inconclusive');
  assert.match(r.why, /didn't reproduce/);
  assert.deepEqual(calls, [merges[7].sha]);
});

test('a step past its own timeout is aborted and inconclusive (S-1750)', async () => {
  const merges = range(4);
  let aborted = false;
  const hang = (sha, signal) =>
    new Promise((done) => signal.addEventListener('abort', () => ((aborted = true), done({ verdict: 'error', reasons: ['canceled'] })), { once: true }));
  const r = await bisect(merges, hang, { stepMs: 50 });
  assert.ok(aborted, 'the canary got the abort');
  assert.equal(r.result, 'inconclusive');
  assert.match(r.why, /timed out after 0 s/);
});

test('a removed hold stops the bisection before its next step (S-1750)', async () => {
  const merges = range(8);
  let held = true;
  const { run, calls } = scripted(merges, 2, () => ((held = false), undefined));
  const r = await bisect(merges, run, { held: () => held });
  assert.equal(r.result, 'inconclusive');
  assert.match(r.why, /hold was removed/);
  assert.equal(calls.length, 1);
});

// The CLI's world: a home with the hold and the job file, mail and gh that record.
function setup(name, n) {
  const dir = join(work, name);
  const home = join(dir, 'home');
  const bin = join(dir, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(home, 'deploy-hold'), 'held\n');
  // Live's release as current, an older one as previous; the build seam adds one per sha it builds.
  for (const [name, link] of [['live000000', 'current'], ['old0000000', 'previous']]) {
    mkdirSync(join(home, 'releases', name), { recursive: true });
    writeFileSync(join(home, 'releases', name, '.release.json'), JSON.stringify({ commit: name }));
    symlinkSync(name, join(home, 'releases', link));
  }
  const merges = range(n).map((m) => ({ ...m, pr: { ...m.pr, body: `ITSA: S-${m.pr.number}\n` } }));
  const file = join(home, 'deploy-bisect.json');
  writeFileSync(file, JSON.stringify({ release: merges.at(-1).sha.slice(0, 10), good: 'f'.repeat(40), merges, state: 'queued' }));
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\n[ "$1 $2" = "pr comment" ] || exit 1\nprintf '%s\\n' "$3" >> '${dir}/comments'\nexit 0\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  return { dir, home, file, merges, bin };
}

// The CLI's env. The canary command and the mail command reach it through the job file's `env`, as the watcher's
// settings do (systemd-run passes no env on), so a test that passes passes only through the job.
function cliEnv(w, canaryCmd, extra = {}) {
  const job = JSON.parse(readFileSync(w.file, 'utf8'));
  job.env = {
    STAM_BISECT_CANARY_CMD: canaryCmd,
    STAM_DEPLOY_MAIL_CMD: `echo "$DEPLOY_MAIL_SUBJECT" >> '${w.dir}/mails'; printf '%s\\n---\\n' "$DEPLOY_MAIL_BODY" >> '${w.dir}/mails.body'`,
    ...extra,
  };
  writeFileSync(w.file, JSON.stringify(job));
  return { ...process.env, PATH: `${w.bin}:${process.env.PATH}`, STAM_HOME: w.home, STAM_DEPLOY_REPO: w.dir };
}

function results(w, r) {
  const read = (f) => (existsSync(join(w.dir, f)) ? readFileSync(join(w.dir, f), 'utf8') : '');
  return { ...r, mails: read('mails').trim().split('\n').filter(Boolean), body: read('mails.body'), comments: read('comments').trim().split('\n').filter(Boolean), job: JSON.parse(readFileSync(w.file, 'utf8')) };
}

function runCli(w, canaryCmd, extra = {}) {
  return results(w, spawnSync(process.execPath, ['--no-warnings', BISECT, w.file], { env: cliEnv(w, canaryCmd, extra), encoding: 'utf8', timeout: 60_000 }));
}

// A canary seam that "builds" its sha's release as stam deploy --build-only does, reporting whether it created the
// folder or found it there, then runs `verdict`.
const building = (verdict) =>
  `d="$STAM_HOME/releases/b-$CANARY_SHA"; if [ -e "$d/.release.json" ]; then echo "build-only: reused b-$CANARY_SHA"; else mkdir -p "$d"; printf '{"commit":"%s"}' "$CANARY_SHA" > "$d/.release.json"; echo "build-only: created b-$CANARY_SHA"; fi; ${verdict}`;
const SPLIT_AT_3 = 'case "$CANARY_SHA" in 03*|04*|05*) echo "canary: fail: x"; exit 1 ;; esac; echo "canary: pass"';
const releaseDir = (w, i) => join(w.home, 'releases', `b-${w.merges[i].sha}`);

test('the CLI mails the first bad PR, comments on it alone, and writes the result to its job file (S-1750)', () => {
  const w = setup('cli-found', 6);
  // Merges 3 on (shas 03.., 04.., 05..) fail.
  const r = runCli(w, 'case "$CANARY_SHA" in 03*|04*|05*) echo "canary: fail: stalls added up to 9120 ms"; exit 1 ;; esac; echo "canary: pass"');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.mails, [`deploy of ${w.merges[5].sha.slice(0, 10)} held: canary bisection names PR #103`]);
  assert.match(r.body, /names the first bad merge: PR #103/);
  assert.match(r.body, /Canary: stalls added up to 9120 ms/);
  assert.match(r.body, /PR #102: pass/);
  assert.match(r.body, /the merge before it \(0202020202, PR #102\) passed twice/);
  assert.deepEqual(r.comments, ['103']);
  assert.equal(r.job.state, 'done');
  assert.equal(r.job.outcome.merge.pr.number, 103);
});

test('a first merge that is bad is named against the live release, which never ran as a step (S-1750)', () => {
  const w = setup('cli-first', 4);
  const r = runCli(w, 'echo "canary: fail: stalls"; exit 1');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.comments, ['100']);
  assert.match(r.body, /the merge before it is the live release, ffffffffff, which every canary run compares against/);
  assert.doesNotMatch(r.body, /passed twice/);
});

test('the CLI removes the release folders its steps built, and spares current, previous, the candidate and others (S-1750)', () => {
  const w = setup('cli-releases', 6);
  const rel = join(w.home, 'releases');
  // The candidate's release, built by the watcher's canary before the bisection; and one a manual deploy made.
  for (const name of [w.merges[5].sha.slice(0, 10), 'manual0000']) {
    mkdirSync(join(rel, name), { recursive: true });
    writeFileSync(join(rel, name, '.release.json'), JSON.stringify({ commit: name }));
  }
  // A release of merge 2 that was there before the bisection: its build reports it reused, so it stays.
  mkdirSync(releaseDir(w, 2), { recursive: true });
  writeFileSync(join(releaseDir(w, 2), '.release.json'), JSON.stringify({ commit: w.merges[2].sha }));
  const r = runCli(w, building(SPLIT_AT_3));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /removed the releases it built: b-/);
  // .flock stays as the file flock(1) locks; releases/.lock goes with the lock.
  assert.deepEqual(readdirSync(rel).sort(), ['.flock', w.merges[5].sha.slice(0, 10), `b-${w.merges[2].sha}`, 'current', 'live000000', 'manual0000', 'old0000000', 'previous'].sort());
  assert.equal(lockHolder(rel), undefined, 'the deploy lock is given back');
});

test('with the deploy lock held, the CLI removes nothing and leaves its releases to prune (S-1750)', async () => {
  const w = setup('cli-locked', 6);
  // This test process holds the deploy lock, as a running stam deploy would.
  const unlock = await tryLock(join(w.home, 'releases'));
  assert.ok(unlock);
  try {
    const r = runCli(w, building(SPLIT_AT_3));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /the deploy lock is held, so the releases it built are left to prune: b-/);
    assert.ok(existsSync(releaseDir(w, 5)) && existsSync(releaseDir(w, 3)));
    assert.equal(lockHolder(join(w.home, 'releases')), process.pid, "the deploy's lock is untouched");
  } finally {
    await unlock();
  }
});

test('a release current moved to during the bisection is never removed (S-1750)', () => {
  const w = setup('cli-current-moved', 6);
  // Merge 3's build is then made current, as a manual deploy of that sha would.
  const r = runCli(w, building(`case "$CANARY_SHA" in 03*) ln -sfn "b-$CANARY_SHA" "$STAM_HOME/releases/current" ;; esac; ${SPLIT_AT_3}`));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(releaseDir(w, 3), '.release.json')), 'current stays');
  assert.ok(!existsSync(releaseDir(w, 5)), 'the others it built go');
});

test("the candidate's release is kept even when a step's build reports it created (S-1750)", () => {
  const w = setup('cli-keep-candidate', 6);
  const candidate = w.merges[5].sha.slice(0, 10);
  // The tip's rerun "builds" the candidate's own release name, as a real build of that sha would.
  const tip = w.merges[5].sha;
  const r = runCli(w, `if [ "$CANARY_SHA" = ${tip} ]; then mkdir -p "$STAM_HOME/releases/${candidate}/src"; echo "build-only: created ${candidate}"; fi; ${building(SPLIT_AT_3)}`);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(w.home, 'releases', candidate)), 'kept: the deploy after the hold is lifted needs it');
});

test('a folder a process still runs from is spared, and the lock is free before the recursive delete (S-1750)', async () => {
  const w = setup('remove-in-use', 2);
  const c = { releases: join(w.home, 'releases') };
  for (const name of ['a0a0a0a0a0', 'b1b1b1b1b1']) mkdirSync(join(c.releases, name, 'src'), { recursive: true });
  const user = spawn('sleep', ['30'], { cwd: join(c.releases, 'a0a0a0a0a0'), stdio: 'ignore' });
  try {
    const cwdOf = () => {
      try {
        return readlinkSync(`/proc/${user.pid}/cwd`);
      } catch {
        return '';
      }
    };
    for (let i = 0; i < 100 && !cwdOf().endsWith('a0a0a0a0a0'); i++) await new Promise((d) => setTimeout(d, 20));
    const locked = [];
    const free = [];
    // At the delete, the lock was already given back: no holder recorded, and flock(1) itself takes it at once.
    const removed = await removeBuilt(c, ['a0a0a0a0a0', 'b1b1b1b1b1'], [], (dir) => {
      locked.push(dir);
      free.push(lockHolder(c.releases) === undefined && spawnSync('flock', ['-n', join(c.releases, '.flock'), 'true']).status === 0);
      rmSync(dir, { recursive: true, force: true });
    });
    assert.deepEqual(removed, ['b1b1b1b1b1']);
    assert.ok(existsSync(join(c.releases, 'a0a0a0a0a0')), 'the folder in use stays');
    assert.equal(locked.length, 1);
    assert.deepEqual(free, [true]);
  } finally {
    user.kill('SIGKILL');
  }
});

test('a removal killed halfway leaves only a hidden .build folder: no release under the name for build() to reuse (S-1750)', async () => {
  const w = setup('remove-interrupted', 2);
  const c = { releases: join(w.home, 'releases') };
  const name = 'a1b2c3d4e5';
  mkdirSync(join(c.releases, name, 'src'), { recursive: true });
  writeFileSync(join(c.releases, name, '.release.json'), '{}');
  await assert.rejects(removeBuilt(c, [name], [], () => {
    throw new Error('killed mid-delete');
  }));
  assert.ok(!existsSync(join(c.releases, name)), 'nothing is left under the release name, so its sha builds afresh');
  const hidden = readdirSync(c.releases).filter((n) => n.startsWith('.build-'));
  assert.deepEqual(hidden, [`.build-${name}-${process.pid}`]);
  // src/deploy.ts prune() sweeps these, by the same pattern, once the pid is gone.
  assert.match(hidden[0], /^\.build-\w+-(\d+)$/);
  const again = await tryLock(c.releases);
  assert.ok(again, 'the lock was given back before the delete threw');
  await again();
});

test('a SIGTERM mid-step stops the canary, reports the bisection canceled, and removes what it built (S-1750)', async () => {
  const w = setup('cli-sigterm', 6);
  const env = cliEnv(w, building(`echo started >> '${w.dir}/started'; exec sleep 30`));
  const child = spawn(process.execPath, ['--no-warnings', BISECT, w.file], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));
  const code = new Promise((done) => child.on('exit', (c) => done(c)));
  for (let i = 0; i < 200 && !existsSync(join(w.dir, 'started')); i++) await new Promise((d) => setTimeout(d, 50));
  // The watcher removes the hold, then sends SIGTERM while a step runs.
  rmSync(join(w.home, 'deploy-hold'));
  child.kill('SIGTERM');
  assert.equal(await code, 1);
  const r = results(w, { stdout });
  assert.match(r.body, /inconclusive: canceled \(SIGTERM\)/);
  assert.match(r.body, /The hold was removed, so the watcher has moved on/);
  assert.doesNotMatch(r.body, /still holds/);
  assert.equal(r.job.state, 'done');
  assert.ok(!readdirSync(join(w.home, 'releases')).some((n) => n.startsWith('b-')), "the step's release went");
});

test('the CLI reports an inconclusive bisection with its steps, and comments on no PR (S-1750)', () => {
  const w = setup('cli-error', 6);
  const r = runCli(w, 'case "$CANARY_SHA" in 05*) echo "canary: fail: x"; exit 1 ;; esac; echo "canary: error: the build exited 1"; exit 2');
  assert.equal(r.status, 1);
  assert.deepEqual(r.mails, [`deploy of ${w.merges[5].sha.slice(0, 10)} held: canary bisection inconclusive`]);
  assert.match(r.body, /couldn't run: the build exited 1/);
  assert.match(r.body, /PR #105: fail/);
  assert.deepEqual(r.comments, []);
});

test('the CLI stops at its total deadline: the canary is killed, and the mail says it timed out (S-1750)', () => {
  const w = setup('cli-timeout', 6);
  const t0 = Date.now();
  const r = runCli(w, 'sleep 30', { STAM_DEPLOY_BISECT_TIMEOUT_MS: '500' });
  assert.ok(Date.now() - t0 < 20_000, 'it did not wait for the canary');
  assert.equal(r.status, 1);
  assert.match(r.body, /inconclusive: timed out after 1 s/);
  assert.equal(r.job.state, 'done');
});
