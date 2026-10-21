// scripts/go-parity-nightly.mjs (S-2297): the summary, the unit files, the leftover sweep, the lock, and a whole run
// against a stub repo (no Go, no daemon).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { OWNER, summarize, summaryLine, sweepLeftovers, unitTexts } from '../scripts/go-parity-nightly.mjs';
import { tempDir } from './tmphome.mjs';

const SCRIPT = new URL('../scripts/go-parity-nightly.mjs', import.meta.url).pathname;
// A name ending in `-n` is a test with no daemon (n/a); the others start one.
const doc = (tests) => ({ run_at: 'then', tests: Object.fromEntries(Object.entries(tests).map(([n, status]) => [n, { module: 'm', status, kind: 'e2e', daemon: !n.endsWith('-n') }])) });

test('summarize counts the passes of the tests that start a daemon, the n/a ones apart, the change and the newly failing tests', () => {
  const prev = doc({ a: 'pass', b: 'pass', c: 'fail', d: 'pass', 'x-n': 'pass' });
  const next = doc({ a: 'pass', b: 'fail', c: 'pass', d: 'skip', e: 'fail', 'x-n': 'pass', 'y-n': 'pass' });
  assert.deepEqual(summarize(prev, next), { pass: 2, total: 5, skip: 1, na: 2, delta: -1, first: false, newlyFailing: ['b'] });
  assert.deepEqual(summarize(null, next), { pass: 2, total: 5, skip: 1, na: 2, delta: null, first: true, newlyFailing: [] });
  // A previous file written before the daemon flags gives no delta, not a wrong one.
  const old = { tests: { a: { module: 'm', status: 'pass' } } };
  assert.equal(summarize(old, next).delta, null);
  assert.equal(summarize(old, next).first, false);
});

test('summaryLine is one line with the sha, the daemon e2e counts and the change, and says when there is no result', () => {
  const ok = { state: 'ok', go_sha: '0123456789abcdef', pass: 7, total: 9, skip: 0, na: 300, delta: 2, first: false, newlyFailing: ['x', 'y'] };
  assert.equal(summaryLine(ok), 'Nightly Go parity (main 01234567): 7 of 9 daemon e2e tests pass (+2 since last night, 300 n/a); newly failing: x, y.');
  assert.match(summaryLine({ ...ok, delta: null, first: true, newlyFailing: [] }), /\(first run, 300 n\/a\); none newly failing\.$/);
  assert.match(summaryLine({ ...ok, delta: null, skip: 2, newlyFailing: [] }), /\(no earlier count, 2 skipped, 300 n\/a\)/);
  assert.match(summaryLine({ state: 'build-failed', go_sha: 'abcdef012345', why: 'go/build.sh failed' }), /no result, go\/build\.sh failed\.$/);
  assert.ok(!summaryLine({ ...ok, newlyFailing: Array.from({ length: 12 }, (_, i) => `t${i}`) }).includes('\n'));
});

test('the timer is nightly, persistent across a missed night, and the service is bounded', () => {
  const { service, timer } = unitTexts({ node: '/n/node', script: '/r/current/scripts/go-parity-nightly.mjs', path: '/n:/usr/bin' });
  assert.match(timer, /OnCalendar=\*-\*-\* 03:30:00/);
  assert.match(timer, /Persistent=true/);
  assert.match(timer, /WantedBy=timers\.target/);
  assert.match(service, /Type=oneshot/);
  assert.match(service, /TimeoutStartSec=5h/);
  assert.match(service, /ExecStart=\/n\/node --no-warnings \/r\/current\/scripts\/go-parity-nightly\.mjs/);
  assert.ok(!/KillMode=process/.test(service), 'the default control-group kill stops a leaked daemon');
});

test('--install writes the two units to the named folder and enables nothing', () => {
  const dir = tempDir('gpn-units-');
  const r = spawnSync(process.execPath, ['--no-warnings', SCRIPT, '--install'], { env: { ...process.env, STAM_GO_PARITY_UNIT_DIR: dir }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(dir, 'stam-go-parity.service')) && existsSync(join(dir, 'stam-go-parity.timer')));
  assert.match(r.stdout, /not enabled/);
});

test('sweepLeftovers removes the homes of a dead run and keeps a live run and other owners', () => {
  const tmp = tempDir('gpn-sweep-');
  const mk = (name, agent, pid) => {
    mkdirSync(join(tmp, name, 'main'), { recursive: true });
    writeFileSync(join(tmp, name, 'owner'), `agent=${agent}\npid=${pid}\n`);
  };
  mk(`stam-test.${OWNER}.dead`, OWNER, 2147483646);
  mk(`stam-test.${OWNER}.live`, OWNER, process.pid);
  mk('stam-test.someone.dead', 'someone', 2147483646);
  const removed = sweepLeftovers(tmp);
  assert.deepEqual(removed, [`stam-test.${OWNER}.dead`]);
  assert.ok(existsSync(join(tmp, `stam-test.${OWNER}.live`)) && existsSync(join(tmp, 'stam-test.someone.dead')));
});

// A stub origin: a repo whose go/build.sh, scripts/test-slot.sh and scripts/go-parity.mjs are stubs, so a run needs no Go.
function stubOrigin(results, root = tempDir('gpn-origin-')) {
  const files = {
    'go/build.sh': '#!/bin/sh\nexit 0\n',
    'scripts/test-slot.sh': '#!/bin/sh\nexec "$@"\n',
    'scripts/go-parity.mjs': `import { writeFileSync } from 'node:fs';
const file = process.argv[process.argv.indexOf('--file') + 1];
const tests = ${JSON.stringify(results)};
writeFileSync(file, JSON.stringify({ run_at: 'now', tests: Object.fromEntries(Object.entries(tests).map(([n, s]) => [n, { module: 'm', status: s, kind: 'e2e', daemon: !n.endsWith('-n') }])) }));
`,
    'docs/migration/parity.json': '{"tests":{}}\n',
  };
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  const g = (...a) => assert.equal(spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' }).status, 0);
  if (!existsSync(join(root, '.git'))) g('init', '-q', '-b', 'main');
  g('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'stub', '--allow-empty');
  return root;
}

function runNightly(env, origin, dir) {
  return spawnSync(process.execPath, ['--no-warnings', SCRIPT], {
    env: { ...process.env, STAM_GO_PARITY_ANYHOST: '1', STAM_GO_PARITY_DIR: dir, STAM_GO_PARITY_REPO: origin, STAM_GO_PARITY_TESTTMP: join(dir, 'tt'), STAM_GO_PARITY_POST_CMD: 'printf "%s\\n" "$PARITY_NOTE" >>"$PARITY_OUT"', ...env },
    encoding: 'utf8',
  });
}

test('a run writes parity.json and last-run.json, posts the line, and the next night reports the change; no secret reaches them', () => {
  const dir = tempDir('gpn-run-');
  const posted = join(dir, 'posted.txt');
  const secret = 'sk-test-secret-value';
  const env = { PARITY_OUT: posted, OPENROUTER_API_KEY: secret, STAM_TOKEN: secret };
  const origin = stubOrigin({ a: 'pass', b: 'pass', c: 'fail' });
  const night1 = runNightly(env, origin, dir);
  assert.equal(night1.status, 0, night1.stderr);
  const last1 = JSON.parse(readFileSync(join(dir, 'last-run.json'), 'utf8'));
  assert.equal(last1.state, 'ok');
  assert.equal(`${last1.pass}/${last1.total}`, '2/3');
  assert.equal(last1.delta, null);
  // The second night: b fails, c passes.
  const night2 = runNightly(env, stubOrigin({ a: 'pass', b: 'fail', c: 'pass' }, origin), dir);
  assert.equal(night2.status, 0, night2.stderr);
  const last2 = JSON.parse(readFileSync(join(dir, 'last-run.json'), 'utf8'));
  assert.deepEqual({ pass: last2.pass, delta: last2.delta, newlyFailing: last2.newlyFailing }, { pass: 2, delta: 0, newlyFailing: ['b'] });
  assert.equal(readFileSync(posted, 'utf8').trim().split('\n').length, 2);
  assert.match(readFileSync(posted, "utf8"), /2 of 3 daemon e2e tests pass \(\+0 since last night, 0 n\/a\); newly failing: b\./);
  for (const f of ['parity.json', 'parity.prev.json', 'last-run.json', 'posted.txt']) assert.ok(!readFileSync(join(dir, f), 'utf8').includes(secret), f);
  assert.ok(!existsSync(join(dir, 'tmp')), 'the scratch folder is removed');
});

test('a failing build leaves a build-failed result and a no-result line', () => {
  const dir = tempDir('gpn-build-');
  const origin = stubOrigin({ a: 'pass' });
  writeFileSync(join(origin, 'go/build.sh'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(origin, 'go/build.sh'), 0o755);
  spawnSync('git', ['-C', origin, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qam', 'break'], { encoding: 'utf8' });
  const r = runNightly({ PARITY_OUT: join(dir, 'posted.txt') }, origin, dir);
  assert.equal(r.status, 1);
  const last = JSON.parse(readFileSync(join(dir, 'last-run.json'), 'utf8'));
  assert.equal(last.state, 'build-failed');
  assert.match(last.summary, /no result, go\/build\.sh failed\.$/);
});

test('a second run while one holds the lock is refused and changes nothing', () => {
  const dir = tempDir('gpn-lock-');
  mkdirSync(dir, { recursive: true });
  // Hold the lock from a child that sleeps; its process group is stopped at the end.
  const holder = spawn('flock', ['-n', join(dir, 'lock'), 'sleep', '30'], { detached: true, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50 && spawnSync('flock', ['-n', join(dir, 'lock'), 'true']).status === 0; i++) spawnSync('sleep', ['0.1']);
    const r = runNightly({ PARITY_OUT: join(dir, 'posted.txt') }, stubOrigin({ a: 'pass' }), dir);
    assert.equal(r.status, 75);
    assert.match(r.stderr, /another run holds the lock; refused/);
    assert.ok(!existsSync(join(dir, 'last-run.json')) && !existsSync(join(dir, 'repo')));
  } finally {
    process.kill(-holder.pid, 'SIGKILL');
  }
});

test('go-seed-db.mjs creates stam.db with the TS schema, so a Go daemon finds one (S-2297)', () => {
  const home = tempDir('gpn-seed-');
  const r = spawnSync(process.execPath, ['--no-warnings', new URL('./go-seed-db.mjs', import.meta.url).pathname], { env: { ...process.env, STAM_HOME: home }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(home, 'stam.db')));
});

test('go-seed-db.mjs refuses the default (live) home and creates nothing there', () => {
  const fakeHome = tempDir('gpn-live-');
  const r = spawnSync(process.execPath, ['--no-warnings', new URL('./go-seed-db.mjs', import.meta.url).pathname], { env: { ...process.env, HOME: fakeHome, STAM_HOME: join(fakeHome, '.local/share/stam') }, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refusing the live home/);
  assert.ok(!existsSync(join(fakeHome, '.local/share/stam')));
});

test('night 1 reports a first run even when the committed parity.json carries a run_at and passes', () => {
  const dir = tempDir('gpn-first-');
  const origin = stubOrigin({ a: 'pass', b: 'pass' });
  writeFileSync(join(origin, 'docs/migration/parity.json'), JSON.stringify({ run_at: 'then', tests: { a: { module: 'm', status: 'pass' } } }));
  spawnSync('git', ['-C', origin, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qam', 'seed'], { encoding: 'utf8' });
  const r = runNightly({ PARITY_OUT: join(dir, 'posted.txt') }, origin, dir);
  assert.equal(r.status, 0, r.stderr);
  const last = JSON.parse(readFileSync(join(dir, 'last-run.json'), 'utf8'));
  assert.equal(last.delta, null);
  assert.match(last.summary, /first run/);
});

test('the script runs when started through a symlink, as the unit starts it from releases/current', () => {
  const dir = tempDir('gpn-link-');
  const link = join(dir, 'current.mjs');
  symlinkSync(SCRIPT, link);
  const r = spawnSync(process.execPath, ['--no-warnings', link, '--status'], { env: { ...process.env, STAM_GO_PARITY_DIR: dir }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'no run yet');
});
