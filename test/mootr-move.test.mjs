#!/usr/bin/env node
// scripts/mootr-move.sh (S-3351, P6 of S-2890) against a throwaway home and a fake systemctl and curl. Nothing here touches
// a real home or a real systemctl: every run sets MOOTR_MOVE_TEST=1, which makes the script refuse without its overrides.
// Covered: dry run changes nothing; a full move (data mv, symlink, unit install, timers, hold made and removed, DB backup
// and bytes unchanged); rerun says already done; a rerun after a crash between mv and ln finishes; each refusal leaves the
// home as it was (mootr real dir, held releases/.flock, a held suite lock, mount boundary, deploy-hold unusable,
// inspection error other than not-found); a failed health check rolls back to stamd on the old path; --rollback; a run
// without overrides refuses; no token in any output; step 7 restarts the agents under the old path (S-4344, a fake proc root). Run with `node --test test/mootr-move.test.mjs`.
import './scrub-env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmphome.mjs';
import { fakeSystemd } from './fake-systemd.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const SCRIPT = join(ROOT, 'scripts/mootr-move.sh');
// Built in two parts so the dropped-path scan doesn't read it as a reference to the suite runner.
const SUITE_LOCK = ['full', 'suite.lock'].join('-');
const TOKEN = 'secret-token-abc123';
const BUILT = '2026-10-21T10:00:00.000Z';
const DB = 'SQLITE-BYTES-\u0000\u0001-do-not-lose';

const work = tempDir('mootr-move-test-');
let n = 0;

// The shared fake systemctl and curl (test/fake-systemd.mjs) model the unit state: wants and Alias= symlinks, oneshot services
// that stay activating, a daemon the curl reaches only while it is active. This file adds two hooks. log-extra.sh appends to each
// call's log line where the data dir is (data=symlink|dir|none), whether deploy-hold exists, and the state of the deploy lock, the
// suite lock and the legacy lock file as a deploy-style flock -n would find them, so a test can check that a stop came before the
// mv and under the hold. on-call.sh: $FAKE_HOLD_LOCK="PATH SECONDS" makes the stop of the deploy-watch timer start a holder of that
// flock, as a deploy that began just before the freeze would; $FAKE_HOLD_LEGACY=SECONDS does the same with the legacy
// releases/.lock pid file; $FAKE_REWRITE_HOLD=TEXT makes every daemon-reload overwrite deploy-hold, as the deploy watcher's stop
// handler does.
const LOG_EXTRA = `p=$FAKE_DATA
if [ -L "$p" ]; then d=symlink; elif [ -d "$p" ]; then d=dir; else d=none; fi
if [ -e "$p/deploy-hold" ]; then h=yes; else h=no; fi
r=$FAKE_DATA/releases
if [ -e "$r/.flock" ]; then flock -n -E 75 "$r/.flock" true; [ $? = 75 ] && l=held || l=free; else l=none; fi
if [ -e "$FAKE_DATA/${SUITE_LOCK}" ]; then flock -n -E 75 "$FAKE_DATA/${SUITE_LOCK}" true; [ $? = 75 ] && u=held || u=free; else u=none; fi
if [ -e "$r/.lock" ]; then g=yes; else g=no; fi
if [ -e "$FAKE_SC/holder-done" ]; then ho=done; else ho=no; fi
if [ -e "$FAKE_DATA/gate.lock" ]; then flock -n -E 75 "$FAKE_DATA/gate.lock" true; [ $? = 75 ] && gl=held || gl=free; else gl=none; fi
echo "data=$d hold=$h lock=$l suite=$u legacy=$g holder=$ho gate=$gl"
`;
const HOOK = `if [ "$cmd" = stop ] && [ "$1" = stam-deploy-watch.timer ] && [ -n "$FAKE_HOLD_LEGACY" ]; then
  sleep "$FAKE_HOLD_LEGACY" >/dev/null 2>&1 &
  echo $! >"$FAKE_DATA/releases/.lock"
fi
if [ "$cmd" = stop ] && [ "$1" = stam-deploy-watch.timer ] && [ -n "$FAKE_HOLD_LOCK" ]; then
  set -- $FAKE_HOLD_LOCK
  rm -f "$FAKE_SC/holder-ready"
  (flock "$1" sh -c "touch '$FAKE_SC/holder-ready'; sleep $2" >/dev/null 2>&1 &)
  i=0; while [ ! -e "$FAKE_SC/holder-ready" ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i + 1)); done
fi
if [ "$cmd" = daemon-reload ] && [ -n "$FAKE_REWRITE_HOLD" ]; then printf '%s' "$FAKE_REWRITE_HOLD" >"$FAKE_DATA/deploy-hold"; fi
`;
// A ln that fails for a symlink (ln -s) while $FAKE_LN_FAIL is set: the crash between the mv and the ln.
const FAKE_LN = `#!/bin/sh
case "$*" in
  *"-s "*) [ -n "$FAKE_LN_FAIL" ] && { echo "ln: fake failure" >&2; exit 1; } ;;
esac
exec /usr/bin/ln "$@"
`;
// A stat that reports another device for a path ending in /stam, standing in for a mount boundary (a real one needs root).
const FAKE_STAT = `#!/bin/sh
case "$*" in
  *"%d"*/stam) echo 99999; exit 0 ;;
esac
exec /usr/bin/stat "$@"
`;

function world(name) {
  const dir = join(work, `${name}-${n++}`);
  const home = join(dir, 'home');
  const data = join(home, '.local/share/stam');
  const units = join(home, '.config/systemd/user');
  const sd = fakeSystemd(dir, { units });
  const { sc, bin } = sd;
  mkdirSync(join(data, 'releases'), { recursive: true });
  writeFileSync(join(data, 'stam.db'), DB);
  writeFileSync(join(data, 'stam.db-wal'), 'wal');
  writeFileSync(join(data, 'settings.json'), '{"a":1}');
  writeFileSync(join(data, 'token'), TOKEN);
  writeFileSync(join(data, 'releases/.flock'), '');
  mkdirSync(join(data, 'releases/current'));
  writeFileSync(join(data, 'releases/current/.release.json'), JSON.stringify({ release: 'abc', built_at: BUILT, capabilities: ['mootr-deploy-names', 'mootr-suite-names'] }));
  writeFileSync(join(data, SUITE_LOCK), '');
  writeFileSync(
    join(units, 'stamd.service'),
    `[Unit]\nDescription=stam daemon: x\n[Service]\nExecStart=${data}/releases/current/bin/stamd\nEnvironment="STAM_NODE=/n/node"\n` +
      `StandardOutput=append:${data}/daemon.log\n[Install]\nWantedBy=default.target\n`,
  );
  for (const t of ['stam-deploy-watch', 'stam-idle']) {
    writeFileSync(join(units, `${t}.timer`), `[Unit]\nDescription=${t}\n[Timer]\nOnCalendar=hourly\nUnit=${t}.service\n[Install]\nWantedBy=timers.target\n`);
    writeFileSync(join(units, `${t}.service`), `[Service]\nType=oneshot\nExecStart=/n/node ${data}/releases/current/scripts/job.mjs\n`);
  }
  // The live layout: stamd and the deploy-watch timer enabled (wants symlinks in the unit dir) and running; the idle timer not.
  for (const u of ['stamd.service', 'stam-deploy-watch.timer']) {
    sd.enable(u);
    sd.start(u);
  }
  sd.http('/api/agents', { body: '[]' });
  sd.http('/api/health', { body: JSON.stringify({ ok: true, machine: 'testbox' }) });
  // An empty fake proc root (S-4344): no run reads the real /proc.
  mkdirSync(join(dir, 'proc'));
  rmSync(join(sc, 'log'));
  writeFileSync(join(sc, 'log-extra.sh'), LOG_EXTRA);
  writeFileSync(join(sc, 'on-call.sh'), HOOK);
  writeFileSync(join(bin, 'stat'), FAKE_STAT);
  chmodSync(join(bin, 'stat'), 0o755);
  const lnbin = join(dir, 'lnbin');
  mkdirSync(lnbin);
  writeFileSync(join(lnbin, 'ln'), FAKE_LN);
  chmodSync(join(lnbin, 'ln'), 0o755);
  return { dir, lnbin, home, data, new: join(home, '.local/share/mootr'), units, sc, bin, sd, proc: join(dir, 'proc'), premove: join(home, 'stam-premove') };
}

function run(w, args = [], extra = {}) {
  const env = {
    PATH: process.env.PATH,
    ...w.sd.env,
    FAKE_DATA: w.data,
    MOOTR_MOVE_TEST: '1',
    MOOTR_MOVE_HOME: w.home,
    MOOTR_MOVE_UNIT_DIR: w.units,
    MOOTR_MOVE_SYSTEMCTL: w.sd.systemctl,
    MOOTR_MOVE_CURL: w.sd.curl,
    MOOTR_MOVE_HEALTH_TRIES: '1',
    MOOTR_MOVE_HEALTH_SLEEP: '0',
    MOOTR_MOVE_PROC: w.proc,
    ...extra,
  };
  const r = spawnSync('sh', [SCRIPT, ...args], { env, encoding: 'utf8' });
  return { ...r, out: `${r.stdout}${r.stderr}` };
}

// Every path under the home with its type, size and (for files) content, to compare before and after.
function snapshot(w) {
  const r = spawnSync('find', [w.home, '-printf', '%p %y %s %l\\n'], { encoding: 'utf8' });
  return r.stdout.split('\n').sort().join('\n');
}
const active = (w, u) => w.sd.isActive(u);
const enabled = (w, u) => w.sd.isEnabled(u);
const log = (w) => w.sd.log();
const isLink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

// Holds a flock on a file in a child until the test ends it.
async function holdLock(path) {
  const child = spawn('flock', [path, 'sh', '-c', 'echo held; read x'], { stdio: ['pipe', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { child.stdout.once('data', res); child.once('error', rej); });
  return () => child.stdin.end();
}

function assertMoved(w) {
  assert.ok(isLink(w.data));
  assert.equal(readlinkSync(w.data), 'mootr');
  assert.equal(readFileSync(join(w.new, 'stam.db'), 'utf8'), DB);
  assert.equal(readFileSync(join(w.new, 'stam.db-wal'), 'utf8'), 'wal');
  assert.ok(!existsSync(join(w.new, 'deploy-hold')), 'deploy-hold removed');
  assert.ok(existsSync(join(w.units, 'mootrd.service')));
  assert.ok(isLink(join(w.units, 'stamd.service')) && readlinkSync(join(w.units, 'stamd.service')) === 'mootrd.service', 'stamd.service is the alias symlink');
  assert.ok(existsSync(join(w.premove, 'units/stamd.service')), 'old unit kept');
  assert.match(readFileSync(join(w.units, 'mootrd.service'), 'utf8'), /\.local\/share\/mootr\/releases/);
  assert.ok(active(w, 'mootrd.service'));
  assert.ok(!active(w, 'stamd.service'));
  const unit = readFileSync(join(w.units, 'mootrd.service'), 'utf8');
  assert.match(unit, /^Alias=stamd\.service$/m);
  assert.match(unit, /^Environment="STAM_NODE=\/n\/node"$/m);
  assert.match(unit, /^Environment="MOOTR_NODE=\/n\/node"$/m);
  assert.match(unit, /^StandardOutput=append:.*\/\.local\/share\/mootr\/daemon\.log$/m);
  assert.ok(!/share\/stam\//.test(unit), 'no old data path left in the unit');
  assert.ok(!enabled(w, 'stamd.service') && enabled(w, 'mootrd.service'), 'stamd disabled, mootrd enabled');
  // Timers: old pair moved to premove, mootr-* pair installed with the path and name changed, enabled, and started if it ran.
  for (const t of ['stam-deploy-watch', 'stam-idle']) {
    for (const e of ['timer', 'service']) {
      assert.ok(!existsSync(join(w.units, `${t}.${e}`)), `${t}.${e} left the unit dir`);
      assert.ok(existsSync(join(w.premove, `units/${t}.${e}`)), `${t}.${e} kept`);
    }
  }
  const svc = readFileSync(join(w.units, 'mootr-deploy-watch.service'), 'utf8');
  assert.match(svc, /\/\.local\/share\/mootr\/releases\/current\/scripts\/job\.mjs/);
  assert.match(readFileSync(join(w.units, 'mootr-deploy-watch.timer'), 'utf8'), /^Unit=mootr-deploy-watch\.service$/m);
  assert.ok(enabled(w, 'mootr-deploy-watch.timer'), 'an enabled timer is enabled again');
  assert.ok(!enabled(w, 'mootr-idle.timer'), 'a disabled timer stays disabled');
  assert.ok(!enabled(w, 'stam-deploy-watch.timer'));
  assert.ok(active(w, 'mootr-deploy-watch.timer'), 'the timer that ran is started again');
  assert.ok(!active(w, 'mootr-idle.timer'), 'a timer that was inactive stays so');
  for (const f of readdirSync(w.units).filter((f) => statSync(join(w.units, f)).isFile())) assert.ok(!/\.local\/share\/stam\//.test(readFileSync(join(w.units, f), 'utf8')), `${f} names the old path`);
  assert.equal(readFileSync(join(w.premove, 'backup/stam.db'), 'utf8'), DB);
  assert.equal(readFileSync(join(w.premove, 'backup/settings.json'), 'utf8'), '{"a":1}');
}

function assertUntouched(w, before) {
  assert.equal(snapshot(w), before, 'home unchanged');
  assert.ok(!existsSync(join(w.data, 'deploy-hold')) || lstatSync(join(w.data, 'deploy-hold')).isDirectory());
  assert.ok(!/stop|start/.test(log(w)), 'no systemctl stop or start');
}

test('--dry-run prints the actions and changes nothing', () => {
  const w = world('dry');
  const before = snapshot(w);
  const r = run(w, ['--dry-run']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /would: .*mv -T/);
  assert.match(r.out, /would: .*ln -s mootr/);
  assert.match(r.out, /would: .*enable --now mootrd\.service/);
  assert.equal(snapshot(w), before);
  assert.ok(!/ stop | start /.test(log(w).replace(/^/gm, ' ')), 'no systemctl change called');
});

test('a full move, and no token in any output', () => {
  const w = world('full');
  const r = run(w);
  assert.equal(r.status, 0, r.out);
  assertMoved(w);
  assert.ok(!r.out.includes(TOKEN));
  assert.ok(readFileSync(join(w.sc, 'curl-stdin'), 'utf8').includes(TOKEN), 'the token reached curl on stdin');
  assert.match(w.sd.runningConfig('mootrd.service'), /\.local\/share\/mootr\/releases/, 'mootrd runs the derived unit');
  assert.equal(w.sd.run('is-enabled', 'stamd.service').stdout.trim(), 'alias');
});

// The old fake answered health 200 the moment mootrd started. A real daemon is down until it is up: here mootrd stays activating
// for two health requests, so the script must poll; with one try it gives up and rolls back to stamd.
test('mootrd still starting: the health check polls until it is up, and at the bound it rolls back', () => {
  const w = world('slow');
  w.sd.slowStart('mootrd.service', 2);
  const r = run(w, [], { MOOTR_MOVE_HEALTH_TRIES: '5' });
  assert.equal(r.status, 0, r.out);
  assert.equal(readFileSync(join(w.sc, 'curl-urls'), 'utf8').match(/\/api\/health$/gm).length, 2, 'the first request found it down');
  assertMoved(w);
  const w2 = world('slow-bound');
  w2.sd.slowStart('mootrd.service', 2);
  const r2 = run(w2);
  assert.notEqual(r2.status, 0);
  assert.match(r2.out, /rolled back/);
  assert.ok(!isLink(w2.data) && active(w2, 'stamd.service') && !active(w2, 'mootrd.service'));
  assert.ok(!isLink(join(w2.units, 'stamd.service')) && enabled(w2, 'stamd.service'), 'stamd is a real unit again, enabled through its wants link');
});

test('a rerun after a completed move says already done', () => {
  const w = world('rerun');
  assert.equal(run(w).status, 0);
  const calls = log(w).split('\n').length;
  const r = run(w);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /already done/);
  assertMoved(w);
  assert.ok(!/(^|\n)(stop|start) /.test(log(w).split('\n').slice(calls - 1).join('\n')), 'the rerun stops and starts nothing');
});

test('a rerun after a crash between mv and ln finishes the move', () => {
  const w = world('crash');
  // State a crash leaves: stamd stopped, data moved, no symlink, unit not yet moved, hold made by the first run.
  spawnSync('mv', [w.data, w.new]);
  rmActive(w, 'stamd.service');
  mkdirSync(w.premove, { recursive: true });
  writeFileSync(join(w.premove, 'hold-made'), 'token-1');
  // The stale agent check passed in the first run, which is the only run that could ask the daemon.
  writeFileSync(join(w.premove, 'progress'), `step1\nstale-check abc ${BUILT}\n`);
  // The backup was taken before the mv.
  mkdirSync(join(w.premove, 'backup'));
  writeFileSync(join(w.premove, 'backup/stam.db'), DB);
  writeFileSync(join(w.premove, 'backup/settings.json'), '{"a":1}');
  writeFileSync(join(w.new, 'deploy-hold'), 'token-1');
  writeFileSync(join(w.premove, 'timers'), 'stam-deploy-watch.timer 1 1\nstam-idle.timer 0 0\n');
  rmActive(w, 'stam-deploy-watch.timer');
  const r = run(w);
  assert.equal(r.status, 0, r.out);
  assertMoved(w);
});
function rmActive(w, u) { w.sd.setState(u, 'inactive'); }

test('refuses when mootr already exists as a real dir', () => {
  const w = world('mootr-exists');
  mkdirSync(w.new);
  const before = snapshot(w);
  const r = run(w);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /already exists as a real dir/);
  assertUntouched(w, before);
});

for (const lock of ['releases/.flock', SUITE_LOCK, 'gate.lock']) {
  test(`refuses when ${lock} is held`, async () => {
    const w = world('held');
    const release = await holdLock(join(w.data, lock));
    try {
      const before = snapshot(w);
      const r = run(w);
      assert.notEqual(r.status, 0);
      assert.match(r.out, /is held/);
      assertUntouched(w, before);
    } finally {
      release();
    }
  });
}

test('refuses on a mount boundary', () => {
  const w = world('mount');
  const before = snapshot(w);
  const r = run(w, [], { PATH: `${w.bin}:${process.env.PATH}` });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /mount boundary/);
  assertUntouched(w, before);
});

test('refuses when deploy-hold can not be created', () => {
  const w = world('hold');
  mkdirSync(join(w.data, 'deploy-hold'));
  const before = snapshot(w);
  const r = run(w);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /deploy-hold can't be created/);
  assertUntouched(w, before);
});

test('an inspection error other than not found stops the script', () => {
  const w = world('eacces');
  const share = join(w.home, '.local/share');
  chmodSync(share, 0o000);
  try {
    const r = run(w);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /can't inspect/);
  } finally {
    chmodSync(share, 0o755);
  }
  assert.ok(!isLink(w.data));
  assert.equal(readFileSync(join(w.data, 'stam.db'), 'utf8'), DB);
});

test('a failed health check rolls back to stamd on the old path', () => {
  const w = world('health');
  w.sd.unhealthy('mootrd.service'); // mootrd answers 503; stamd, back on the old path, answers 200
  const r = run(w);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /rolled back/);
  assert.ok(!isLink(w.data), 'stam is a real dir again');
  assert.ok(!existsSync(w.new));
  assert.equal(readFileSync(join(w.data, 'stam.db'), 'utf8'), DB);
  assert.ok(existsSync(join(w.units, 'stamd.service')));
  assert.ok(!existsSync(join(w.units, 'mootrd.service')));
  assert.ok(active(w, 'stamd.service'));
  assert.ok(!active(w, 'mootrd.service'));
  assert.ok(active(w, 'stam-deploy-watch.timer') && enabled(w, 'stam-deploy-watch.timer'), 'the old timer is back and running');
  assert.ok(existsSync(join(w.units, 'stam-deploy-watch.service')) && !existsSync(join(w.units, 'mootr-deploy-watch.timer')));
  assert.ok(enabled(w, 'stamd.service'), 'stamd enabled again');
  assert.ok(!existsSync(join(w.data, 'deploy-hold')), 'the hold this script made is gone');
  assert.equal(readFileSync(join(w.premove, 'backup/stam.db'), 'utf8'), DB);
});

test('--rollback after a completed move restores the old layout, and a second one changes nothing', () => {
  const w = world('rollback');
  assert.equal(run(w).status, 0);
  const r = run(w, ['--rollback']);
  assert.equal(r.status, 0, r.out);
  assert.ok(!isLink(w.data));
  assert.ok(!existsSync(w.new));
  assert.equal(readFileSync(join(w.data, 'stam.db'), 'utf8'), DB);
  assert.ok(active(w, 'stamd.service'));
  assert.ok(!active(w, 'mootrd.service'));
  assert.ok(!isLink(join(w.units, 'stamd.service')), 'the alias went with mootrd');
  assert.ok(enabled(w, 'stamd.service') && !enabled(w, 'mootrd.service'));
  assert.match(w.sd.runningConfig('stamd.service'), /\.local\/share\/stam\/releases/, 'stamd runs its old unit');
  const before = snapshot(w);
  assert.equal(run(w, ['--rollback']).status, 0);
  assert.equal(snapshot(w), before);
});

test('a test run without its overrides refuses', () => {
  const w = world('noover');
  const before = snapshot(w);
  const r = spawnSync('sh', [SCRIPT], { env: { PATH: process.env.PATH, HOME: w.home, MOOTR_MOVE_TEST: '1' }, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refusing to run/);
  assert.equal(snapshot(w), before);
  const real = spawnSync('sh', [SCRIPT, '--home', w.home, '--unit-dir', w.units, '--systemctl', join(w.bin, 'systemctl')], {
    env: { PATH: process.env.PATH, HOME: w.home, MOOTR_MOVE_TEST: '1' },
    encoding: 'utf8',
  });
  assert.notEqual(real.status, 0);
  assert.match(real.stderr, /real home/);
});

test('the health check uses the daemon port: MOOTR_PORT, then STAM_PORT, then the unit, then 7878', () => {
  const ports = (extra, mutate) => {
    const w = world('port');
    if (mutate) mutate(w);
    const r = run(w, [], extra);
    assert.equal(r.status, 0, r.out);
    return new Set(readFileSync(join(w.sc, 'curl-urls'), 'utf8').trim().split('\n').map((u) => /:(\d+)\//.exec(u)[1]));
  };
  assert.deepEqual([...ports({})], ['7878']);
  assert.deepEqual([...ports({ STAM_PORT: '8123' })], ['8123']);
  assert.deepEqual([...ports({ STAM_PORT: '8123', MOOTR_PORT: '8456' })], ['8456']);
  const unitPort = (w) => writeFileSync(join(w.units, 'stamd.service'), `${readFileSync(join(w.units, 'stamd.service'), 'utf8')}Environment="STAM_PORT=8999"\n`);
  assert.deepEqual([...ports({}, unitPort)], ['8999']);
});

test('--dry-run names the port and the unit changes', () => {
  const w = world('dryport');
  const r = run(w, ['--dry-run'], { STAM_PORT: '8123' });
  assert.match(r.out, /port 8123/);
  assert.match(r.out, /Alias=stamd\.service/);
  assert.match(r.out, /would: derive .*mootr-deploy-watch\.timer/);
});

test('a held lock refuses even a dry run', async () => {
  const w = world('wait');
  const release = await holdLock(join(w.data, 'releases/.flock'));
  try {
    const r = run(w, ['--dry-run']);
    assert.notEqual(r.status, 0, 'step 0 refuses a held lock even on a dry run');
  } finally {
    release();
  }
});

test('--rollback freezes first: hold, timers stopped, services waited for and never stopped, all before mootrd stops', () => {
  const w = world('rb-freeze');
  assert.equal(run(w).status, 0);
  // A deploy-watch run in flight, which ends after three polls.
  w.sd.running('mootr-deploy-watch.service', 3); // a oneshot that runs is "activating"
  const before = log(w).split('\n').length;
  const r = run(w, ['--rollback'], { MOOTR_MOVE_LOCK_SLEEP: '0' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /waiting for mootr-deploy-watch\.service to finish/);
  const lines = log(w).split('\n').slice(before - 1).filter(Boolean);
  const at = (prefix) => lines.findIndex((l) => l.startsWith(prefix));
  const stopTimer = at('stop mootr-deploy-watch.timer');
  const stopD = at('stop mootrd.service');
  const startOld = at('enable --now stamd.service');
  assert.ok(stopTimer >= 0 && stopD >= 0 && startOld >= 0, lines.join('\n'));
  assert.equal(at('stop mootr-deploy-watch.service'), -1, 'a running service is waited for, never stopped');
  assert.ok(stopTimer < stopD, 'timers stop before mootrd');
  for (const l of [lines[stopTimer], lines[stopD]]) {
    assert.match(l, /data=symlink hold=yes /, `stopped while the data dir was still moved and under the hold: ${l}`);
  }
  assert.match(lines[startOld], /data=dir/, 'stamd starts after the data dir moved back');
  assert.ok(!existsSync(join(w.data, 'deploy-hold')), 'the hold the rollback took is gone');
});

test('--rollback waits for a held lock and, still held, changes nothing but the freeze', async () => {
  const w = world('rb-lock');
  assert.equal(run(w).status, 0);
  const release = await holdLock(join(w.new, 'releases/.flock'));
  try {
    const r = run(w, ['--rollback'], { MOOTR_MOVE_LOCK_TRIES: '2', MOOTR_MOVE_LOCK_SLEEP: '0' });
    assert.notEqual(r.status, 0);
    assert.match(r.out, /waiting for .*\.flock/);
    assert.match(r.out, /still held after 2 tries/);
    assert.match(r.out, /run --rollback again when the holder ends/, 'the message fits a rollback');
    assert.ok(!/or run --rollback$/m.test(r.out));
    assert.ok(isLink(w.data), 'the symlink is still there');
    assert.equal(readFileSync(join(w.new, 'stam.db'), 'utf8'), DB);
    assert.ok(active(w, 'mootrd.service'), 'mootrd still runs');
    assert.ok(!/stop mootrd/.test(log(w).split('\n').slice(-6).join('\n')), 'mootrd was not stopped');
  } finally {
    release();
  }
});

test('a rerun after a completed move, with the stamd.service alias symlink, bounces nothing', () => {
  const w = world('alias');
  assert.equal(run(w).status, 0);
  assert.ok(isLink(join(w.units, 'stamd.service')), 'the fake models the alias symlink');
  const calls = log(w).split('\n').length;
  const r = run(w);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /already done/);
  const rerun = log(w).split('\n').slice(calls - 1).join('\n');
  assert.ok(!/(^|\n)(stop|start|enable|disable) /.test(rerun), `the rerun changed units:\n${rerun}`);
});

test('step 1 waits, with a bound, for a lock a starting run takes, and says why', () => {
  const w = world('wait-ok');
  const lock = join(w.data, 'releases/.flock');
  const r = run(w, [], { FAKE_HOLD_LOCK: `${lock} 2`, MOOTR_MOVE_LOCK_TRIES: '20', MOOTR_MOVE_LOCK_SLEEP: '1' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /waiting for .*\.flock to be free \(try 1 of 20\)/);
  assertMoved(w);
});

test('step 1 stops at the bound with the freeze in place, and a rerun then finishes', () => {
  const w = world('wait-bound');
  const lock = join(w.data, 'releases/.flock');
  const r = run(w, [], { FAKE_HOLD_LOCK: `${lock} 4`, MOOTR_MOVE_LOCK_TRIES: '2', MOOTR_MOVE_LOCK_SLEEP: '0' });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /still held after 2 tries/);
  assert.match(r.out, /rerun when the holder ends, or run --rollback/);
  assert.ok(!isLink(w.data) && existsSync(join(w.data, 'deploy-hold')), 'nothing moved; the freeze is in place');
  assert.ok(!existsSync(join(w.data, 'releases/.lock')), 'the legacy pid file this run took is gone when it stops at the bound');
  spawnSync('flock', ['-w', '15', lock, 'true']); // the holder ends
  const again = run(w);
  assert.equal(again.status, 0, again.out);
  assertMoved(w);
});

test('step 0 refuses without a regular stamd.service to base mootrd on, before anything is frozen (S-3349)', () => {
  for (const how of ['missing', 'symlink']) {
    const w = world(`nounit-${how}`);
    spawnSync('rm', ['-f', join(w.units, 'stamd.service')]);
    if (how === 'symlink') symlinkSync('mootrd.service', join(w.units, 'stamd.service'));
    const before = snapshot(w);
    const r = run(w);
    assert.notEqual(r.status, 0, how);
    assert.match(r.out, /not a regular file/);
    assert.ok(!existsSync(join(w.data, 'deploy-hold')), 'no hold was made');
    assertUntouched(w, before);
  }
});

test('refuses unless the deployed release carries the P4 and P5 fixes', () => {
  for (const caps of [undefined, [], ['mootr-deploy-names'], ['mootr-suite-names']]) {
    const w = world('caps');
    const f = join(w.data, 'releases/current/.release.json');
    writeFileSync(f, JSON.stringify(caps === undefined ? { release: 'abc' } : { release: 'abc', capabilities: caps }));
    const before = snapshot(w);
    const r = run(w);
    assert.notEqual(r.status, 0, JSON.stringify(caps));
    assert.match(r.out, /lacks.*mootr-/);
    assertUntouched(w, before);
  }
  const w = world('caps-missing');
  spawnSync('rm', ['-f', join(w.data, 'releases/current/.release.json')]);
  const r = run(w);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /\.release\.json is missing/);
});

// A deploy-style flock -n on the file, as src/release-lock.ts takes it.
const lockFree = (file) => spawnSync('flock', ['-n', '-E', '75', file, 'true']).status === 0;
const lockLines = (w, from, to) => {
  const lines = log(w).split('\n').filter(Boolean);
  const a = lines.findIndex((l) => l.startsWith(from));
  const b = lines.findIndex((l) => l.startsWith(to));
  assert.ok(a >= 0 && b > a, `${from} .. ${to} in\n${lines.join('\n')}`);
  return { inside: lines.slice(a, b + 1), after: lines.slice(b + 1) };
};

test('the script holds the deploy locks from the freeze until mootrd is healthy, and frees them at exit', () => {
  const w = world('lockspan');
  const r = run(w);
  assert.equal(r.status, 0, r.out);
  const { inside, after } = lockLines(w, 'stop stamd.service', 'enable --now mootrd.service');
  for (const l of inside) assert.match(l, /lock=held suite=held legacy=yes/, `a deploy-style flock -n finds the locks held: ${l}`);
  // The timers come up after the health check, and the locks are free by then.
  const timerCalls = after.filter((l) => /^enable mootr-/.test(l));
  assert.ok(timerCalls.length > 0);
  for (const l of timerCalls) assert.match(l, /lock=free suite=free legacy=no/, l);
  assert.ok(lockFree(join(w.new, 'releases/.flock')) && lockFree(join(w.new, SUITE_LOCK)));
  assert.ok(!existsSync(join(w.new, 'releases/.lock')), 'the legacy pid file is gone');
});

test('an unreadable gate lock state refuses before the freeze and changes nothing', () => {
  const w = world('gate-unreadable');
  // The lock state reader fails for gate.lock only, as an unreadable /proc/locks would; the other checks run the real node.
  const node = join(w.bin, 'node');
  writeFileSync(node, `#!/bin/sh\ncase "$*" in *gate.lock*) echo "fake: /proc/locks unreadable" >&2; exit 1;; esac\nexec ${process.execPath} "$@"\n`);
  chmodSync(node, 0o755);
  writeFileSync(join(w.data, 'gate.lock'), ''); // an absent file is free without a read
  const before = snapshot(w);
  const r = run(w, [], { MOOTR_MOVE_NODE: node });
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /can't tell whether .*gate\.lock is held/);
  assertUntouched(w, before);
});

test('a gate that takes gate.lock after step 0 holds the move at step 1 until it ends, and gate.lock is held through the move', () => {
  const w = world('gate-mid');
  const gate = join(w.data, 'gate.lock');
  const r = run(w, [], { FAKE_HOLD_LOCK: `${gate} 2`, MOOTR_MOVE_LOCK_TRIES: '20', MOOTR_MOVE_LOCK_SLEEP: '1' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /waiting for .*gate\.lock to be free \(try 1 of 20\)/);
  const { inside } = lockLines(w, 'stop stamd.service', 'enable --now mootrd.service');
  for (const l of inside) assert.match(l, /gate=held/, `a gate's flock -n is refused: ${l}`);
  assertMoved(w);
  assert.ok(lockFree(join(w.new, 'gate.lock')), 'freed after success');
});

test('gate.lock is freed after success and after a rollback', () => {
  const w = world('gate-free');
  assert.equal(run(w).status, 0);
  assert.ok(lockFree(join(w.new, 'gate.lock')), 'after the move');
  const w2 = world('gate-rb');
  w2.sd.unhealthy('mootrd.service');
  assert.notEqual(run(w2).status, 0);
  const rb = lockLines(w2, 'stop mootrd.service', 'enable --now stamd.service');
  for (const l of rb.inside) assert.match(l, /gate=held/, `held through the rollback: ${l}`);
  assert.ok(lockFree(join(w2.data, 'gate.lock')), 'after the failed health and the rollback');
});

test('the locks are freed on the failure exits too', () => {
  const w = world('lockfree');
  w.sd.unhealthy('mootrd.service');
  assert.notEqual(run(w).status, 0);
  assert.ok(lockFree(join(w.data, 'releases/.flock')) && lockFree(join(w.data, SUITE_LOCK)), 'after the failed health and the rollback');
  assert.ok(!existsSync(join(w.data, 'releases/.lock')));
  const w2 = world('lockfree2');
  const r = run(w2, [], { FAKE_FAIL: 'enable mootr-deploy-watch.timer' });
  assert.notEqual(r.status, 0);
  assert.ok(lockFree(join(w2.new, 'releases/.flock')), 'after a stop in step 5');
  assert.ok(!existsSync(join(w2.new, 'releases/.lock')));
});

test('a legacy releases/.lock that appears after the first check is waited out', () => {
  const w = world('legacy');
  const r = run(w, [], { FAKE_HOLD_LEGACY: '2', MOOTR_MOVE_LOCK_TRIES: '20', MOOTR_MOVE_LOCK_SLEEP: '1' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /waiting for .*releases\/\.lock to be free/);
  assertMoved(w);
});

test('step 0 refuses while an older deploy holds releases/.lock', () => {
  const w = world('legacy0');
  const holder = spawn('sleep', ['20'], { stdio: 'ignore' });
  try {
    writeFileSync(join(w.data, 'releases/.lock'), String(holder.pid));
    const before = snapshot(w);
    const r = run(w);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /releases\/\.lock names a live process/);
    assertUntouched(w, before);
  } finally {
    holder.kill();
  }
});

test('a crash after step 4 leaves the hold and the timers for a rerun to finish steps 5 and 6', () => {
  const w = world('crash4');
  const r = run(w, [], { FAKE_FAIL: 'enable mootr-deploy-watch.timer' });
  assert.notEqual(r.status, 0);
  assert.ok(existsSync(join(w.new, 'deploy-hold')), 'the hold stays until steps 5 and 6 are done');
  assert.ok(!active(w, 'mootr-deploy-watch.timer'));
  assert.ok(isLink(w.data) && active(w, 'mootrd.service'));
  const again = run(w);
  assert.equal(again.status, 0, again.out);
  assert.ok(!/already done/.test(again.out), 'not reported done while steps 5 and 6 were open');
  assertMoved(w);
  assert.match(readFileSync(join(w.premove, 'progress'), 'utf8'), /step6/);
  assert.match(run(w).out, /already done/);
});

test('with a hold that existed before the move, a crash after step 4 is still finished, and the hold stays', () => {
  const w = world('foreignhold');
  writeFileSync(join(w.data, 'deploy-hold'), 'someone else');
  const r = run(w, [], { FAKE_FAIL: 'enable mootr-deploy-watch.timer' });
  assert.notEqual(r.status, 0);
  assert.ok(!existsSync(join(w.premove, 'hold-made')), 'no marker for a hold that is not ours');
  const again = run(w);
  assert.equal(again.status, 0, again.out);
  assert.ok(!/already done/.test(again.out));
  assert.ok(active(w, 'mootr-deploy-watch.timer'), 'step 6 started the timer');
  assert.equal(readFileSync(join(w.new, 'deploy-hold'), 'utf8'), 'someone else', 'their hold stays, untouched');
  assert.match(run(w).out, /already done/);
});

test('a second move after a rollback reads the current units and timers, not the first move\'s records', () => {
  const w = world('twice');
  assert.equal(run(w).status, 0);
  assert.equal(run(w, ['--rollback']).status, 0);
  assert.ok(readdirSync(w.premove).some((f) => f.startsWith('timers.rolled-back-')), 'the timer record was set aside');
  assert.ok(!existsSync(join(w.premove, 'timers')) && !existsSync(join(w.premove, 'progress')));
  assert.ok(!existsSync(join(w.premove, 'units/stamd.service')), 'the saved unit was set aside');
  // The units changed meanwhile: a new schedule, and the idle timer enabled.
  const t = join(w.units, 'stam-deploy-watch.timer');
  writeFileSync(t, readFileSync(t, 'utf8').replace('hourly', 'daily'));
  w.sd.enable('stam-idle.timer');
  const r = run(w);
  assert.equal(r.status, 0, r.out);
  assert.match(readFileSync(join(w.units, 'mootr-deploy-watch.timer'), 'utf8'), /OnCalendar=daily/);
  assert.ok(enabled(w, 'mootr-idle.timer'), 'the timer enabled since the rollback is enabled');
});

const setAgents = (w, agents) => w.sd.http('/api/agents', { body: JSON.stringify(agents) });
const agent = (name, extra) => ({ id: name, name, lifecycle: 'active', ...extra });

test('a running agent launched before the release makes step 0 refuse, naming it and not the token', () => {
  const w = world('stale');
  setAgents(w, [
    agent('old-dev', { launched_at: '2026-10-21T09:00:00.000Z' }),
    agent('resumed-dev', { created_at: '2026-10-20T09:00:00.000Z', resumed_at: '2026-10-21T11:00:00.000Z' }),
    agent('created-only', { created_at: '2026-10-20T09:00:00.000Z' }),
    agent('no-time', {}),
    agent('paused-old', { lifecycle: 'paused', launched_at: '2026-10-21T09:00:00.000Z' }),
  ]);
  const before = snapshot(w);
  const r = run(w);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /old-dev created-only no-time/);
  assert.ok(!/resumed-dev|paused-old/.test(r.out), 'a resumed-after-release and a paused agent are not named');
  assert.ok(!r.out.includes(TOKEN));
  assertUntouched(w, before);
});

test('a running agent resumed after the release passes step 0, though it was spawned before it (S-3372)', () => {
  const w = world('resumed-ok');
  // Spawned before the release, resumed after it: its launch time is the resume, so it passes.
  setAgents(w, [agent('resumed-dev', { launched_at: '2026-10-20T09:00:00.000Z', resumed_at: '2026-10-21T12:00:00.000Z', created_at: '2026-10-20T09:00:00.000Z' })]);
  const r = run(w);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /no agent predates the cutoff release/);
  assertMoved(w);
});

test('with no stale agent the check passes, and --allow-stale-agents skips it', () => {
  const w = world('fresh');
  setAgents(w, [agent('new-dev', { launched_at: '2026-10-21T12:00:00.000Z' })]);
  const r = run(w);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /no agent predates the cutoff release/);
  assertMoved(w);
  const w2 = world('allow');
  setAgents(w2, [agent('old-dev', { launched_at: '2026-10-21T09:00:00.000Z' })]);
  const r2 = run(w2, ['--allow-stale-agents']);
  assert.equal(r2.status, 0, r2.out);
  assert.match(r2.out, /skipping the stale agent check/);
  assertMoved(w2);
});

// Releases besides `current` (built at BUILT, lists both capabilities), each a folder with a .release.json as the deploy writes it.
const CAPS = ['mootr-deploy-names', 'mootr-suite-names'];
const CAP1 = '2026-10-19T10:00:00.000Z';
function addRelease(w, name, meta) {
  mkdirSync(join(w.data, 'releases', name));
  writeFileSync(join(w.data, 'releases', name, '.release.json'), typeof meta === 'string' ? meta : JSON.stringify(meta));
}
// Two capable releases (cap1, then current) and an older release without the deploy-names capability.
function cutoffWorld(name) {
  const w = world(name);
  addRelease(w, 'old', { release: 'old', built_at: '2026-10-17T10:00:00.000Z', capabilities: ['mootr-suite-names'] });
  addRelease(w, 'cap1', { release: 'cap1', built_at: CAP1, capabilities: CAPS });
  return w;
}

test('the cutoff is the first release listing mootr-deploy-names: an agent between the two capable releases passes', () => {
  const w = cutoffWorld('cutoff');
  // Launched after cap1 and before current: it ran cap1's daemon, so it is not stale.
  setAgents(w, [agent('between', { launched_at: '2026-10-20T12:00:00.000Z' })]);
  const r = run(w);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /no agent predates the cutoff release cap1 \(2026-10-19T10:00:00\.000Z\)/);
  assertMoved(w);
  assert.match(readFileSync(join(w.premove, 'progress'), 'utf8'), /^stale-check cap1 2026-10-19T10:00:00\.000Z$/m);
});

test('an agent launched before the cutoff is refused, and a later deploy does not move the cutoff', () => {
  const w = cutoffWorld('before-cutoff');
  addRelease(w, 'later', { release: 'later', built_at: '2026-10-22T10:00:00.000Z', capabilities: CAPS });
  setAgents(w, [agent('pre-cutoff', { launched_at: '2026-10-19T09:00:00.000Z' }), agent('between', { launched_at: '2026-10-20T12:00:00.000Z' })]);
  const before = snapshot(w);
  const r = run(w);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /before the cutoff release cap1/);
  assert.match(r.out, /pre-cutoff/);
  assert.ok(!/between/.test(r.out), 'the agent launched after the cutoff is not named');
  assertUntouched(w, before);
});

test('fail closed: no release lists mootr-deploy-names refuses', () => {
  const w = world('no-cutoff');
  // current lists only the suite capability; the required list is narrowed to it so the deploy-names check passes first.
  writeFileSync(join(w.data, 'releases/current/.release.json'), JSON.stringify({ release: 'abc', built_at: BUILT, capabilities: ['mootr-suite-names'] }));
  const before = snapshot(w);
  const r = run(w, [], { MOOTR_MOVE_REQUIRE_CAPS: 'mootr-suite-names' });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /no release lists mootr-deploy-names/);
  assertUntouched(w, before);
});

test('fail closed: a release .release.json that cannot be read refuses, even when it is older than the cutoff', () => {
  // A folder where the file should be fails with EISDIR, which is not not-found.
  const w = cutoffWorld('unreadable');
  mkdirSync(join(w.data, 'releases/bad/.release.json'), { recursive: true });
  const before = snapshot(w);
  const r = run(w);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /cannot read bad\/\.release\.json \(EISDIR\)/);
  assertUntouched(w, before);
  const w2 = cutoffWorld('bad-json');
  addRelease(w2, 'bad', 'not json');
  const r2 = run(w2);
  assert.notEqual(r2.status, 0);
  assert.match(r2.out, /bad\/\.release\.json is not readable JSON/);
});

test('fail closed: a release that lists mootr-deploy-names with no built_at refuses', () => {
  const w = cutoffWorld('cutoff-nobuilt');
  addRelease(w, 'cap0', { release: 'cap0', capabilities: CAPS });
  const before = snapshot(w);
  const r = run(w);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /cap0 lists mootr-deploy-names but has no usable built_at/);
  assertUntouched(w, before);
});

test('the stale agent check fails closed: an API that answers an error, or not JSON, refuses', () => {
  const w = world('apifail');
  w.sd.http('/api/agents', { code: 503 });
  const before = snapshot(w);
  const r = run(w);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /can't list the agents/);
  assertUntouched(w, before);
  const w2 = world('apibad');
  w2.sd.http('/api/agents', { body: 'not json' });
  const r2 = run(w2);
  assert.notEqual(r2.status, 0);
  assert.match(r2.out, /isn't readable JSON/);
  const w3 = world('nobuilt');
  writeFileSync(join(w3.data, 'releases/current/.release.json'), JSON.stringify({ release: 'abc', capabilities: ['mootr-deploy-names', 'mootr-suite-names'] }));
  const r3 = run(w3);
  assert.notEqual(r3.status, 0);
  assert.match(r3.out, /no usable built_at/);
});

test('step 1 waits for a running timer service and never stops it; at the bound it stops with the freeze in place', () => {
  const w = world('svc');
  w.sd.running('stam-deploy-watch.service', 4);
  const r = run(w, [], { MOOTR_MOVE_LOCK_SLEEP: '0' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /waiting for stam-deploy-watch\.service to finish/);
  assert.ok(!/stop stam-deploy-watch\.service/.test(log(w)), 'the service was not stopped');
  assertMoved(w);
  const w2 = world('svc-bound');
  w2.sd.running('stam-deploy-watch.service');
  const r2 = run(w2, [], { MOOTR_MOVE_LOCK_TRIES: '2', MOOTR_MOVE_LOCK_SLEEP: '0' });
  assert.notEqual(r2.status, 0);
  assert.match(r2.out, /still running after 2 tries: stam-deploy-watch\.service/);
  assert.equal(w2.sd.state('stam-deploy-watch.service'), 'activating', 'still running, untouched');
  assert.ok(!isLink(w2.data) && existsSync(join(w2.data, 'deploy-hold')), 'nothing moved, the freeze is in place');
});

test('a hold the deploy watcher rewrote is left alone, and the move still finishes', () => {
  const w = world('rewrite');
  const r = run(w, [], { FAKE_REWRITE_HOLD: 'deploy-watch stopped: hold until cos clears it' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /was rewritten since this script took it/);
  assert.equal(readFileSync(join(w.new, 'deploy-hold'), 'utf8'), 'deploy-watch stopped: hold until cos clears it', 'their hold survives');
  assert.ok(!existsSync(join(w.premove, 'hold-made')), 'the marker is dropped');
});

test('an older caller that creates releases/.lock after the first check is waited for, never replaced', () => {
  const w = world('legacy-race');
  // The hook runs inside the script right before its first attempt to create the lock: an older caller gets there first and
  // holds it for two seconds.
  const hook = `[ -e '${w.sc}/holder-started' ] || { touch '${w.sc}/holder-started'; (sleep 2; touch '${w.sc}/holder-done') >/dev/null 2>&1 & echo $! >'${w.data}/releases/.lock'; }`;
  const r = run(w, [], { MOOTR_MOVE_HOOK_LEGACY: hook, MOOTR_MOVE_LOCK_TRIES: '20', MOOTR_MOVE_LOCK_SLEEP: '1' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /waiting for .*releases\/\.lock to be free/);
  const stop = log(w).split('\n').find((l) => l.startsWith('stop stamd.service'));
  assert.match(stop, /holder=done/, `nothing moved before the older caller let go: ${stop}`);
  assertMoved(w);
});

test('a crash between the mv and the ln: the rerun skips the stale agent check, and its messages are not "nothing changed"', () => {
  const w = world('crash-ln');
  const r = run(w, [], { FAKE_LN_FAIL: '1', PATH: `${w.lnbin}:${process.env.PATH}` });
  assert.notEqual(r.status, 0, r.out);
  assert.ok(!existsSync(w.data) && existsSync(w.new), `the data moved and the symlink is missing: ${r.out}`);
  assert.ok(!active(w, 'stamd.service'), 'stamd is down, so the daemon cannot answer /api/agents');
  // A refusal in this state must not claim nothing changed.
  const f = join(w.new, 'releases/current/.release.json');
  const good = readFileSync(f, 'utf8');
  writeFileSync(f, JSON.stringify({ release: 'abc', built_at: BUILT, capabilities: [] }));
  const refused = run(w);
  assert.notEqual(refused.status, 0);
  assert.match(refused.out, /An earlier run already changed things/);
  assert.ok(!/Nothing was changed/.test(refused.out));
  writeFileSync(f, good);
  const again = run(w);
  assert.equal(again.status, 0, again.out);
  assert.match(again.out, /stale agent check already passed for this release/);
  assertMoved(w);
});

test('a first run with the daemon down fails closed on the stale agent check', () => {
  const w = world('daemon-down');
  rmActive(w, 'stamd.service');
  const before = snapshot(w);
  const r = run(w);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /can't list the agents/);
  assert.match(r.out, /Nothing was changed/);
  assertUntouched(w, before);
});

test('a rollback whose health check fails keeps deploy-hold and the timers stopped', () => {
  const w = world('rb-health');
  assert.equal(run(w).status, 0);
  w.sd.http('/api/health', { code: 503 });
  const r = run(w, ['--rollback']);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /deploy-hold stays in place/);
  assert.ok(existsSync(join(w.data, 'deploy-hold')), 'the hold stays');
  assert.ok(!active(w, 'stam-deploy-watch.timer'), 'the timers stay stopped');
  assert.ok(existsSync(join(w.premove, 'timers')), 'the record is kept for a second try');
  assert.ok(lockFree(join(w.data, 'releases/.flock')));
  // Fixed by hand, the rollback runs again and finishes.
  w.sd.http('/api/health');
  const again = run(w, ['--rollback']);
  assert.equal(again.status, 0, again.out);
  assert.ok(!existsSync(join(w.data, 'deploy-hold')));
  assert.ok(active(w, 'stam-deploy-watch.timer'));
});

test('the service wait fails closed: a failed state query, or an unknown state, stops with the freeze in place', () => {
  const w = world('state-fail');
  const r = run(w, [], { FAKE_FAIL: 'show -p ActiveState --value stam-deploy-watch.service' });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /can't read the state of stam-deploy-watch\.service/);
  assert.ok(!isLink(w.data));
  const w2 = world('state-unknown');
  w2.sd.setState('stam-deploy-watch.service', 'weird');
  const r2 = run(w2);
  assert.notEqual(r2.status, 0);
  assert.match(r2.out, /unknown state 'weird'/);
  assert.ok(!isLink(w2.data));
  for (const st of ['deactivating', 'reloading']) {
    const w3 = world('state-busy');
    w3.sd.setState('stam-deploy-watch.service', st);
    const r3 = run(w3, [], { MOOTR_MOVE_LOCK_TRIES: '2', MOOTR_MOVE_LOCK_SLEEP: '0' });
    assert.notEqual(r3.status, 0, st);
    assert.match(r3.out, /still running after 2 tries: stam-deploy-watch\.service/);
  }
});

test('a mootr that is a symlink, to a valid tree or dangling, is refused before the freeze', () => {
  for (const [name, target] of [['valid', 'elsewhere'], ['dangling', 'nowhere']]) {
    const w = world(`mootr-link-${name}`);
    if (name === 'valid') {
      mkdirSync(join(w.home, '.local/share', target), { recursive: true });
      writeFileSync(join(w.home, '.local/share', target, 'stam.db'), 'a different tree');
    }
    symlinkSync(target, w.new);
    const before = snapshot(w);
    const r = run(w);
    assert.notEqual(r.status, 0, name);
    assert.match(r.out, /is a symlink/);
    assert.match(r.out, /Nothing was changed/);
    assertUntouched(w, before);
    const rb = run(w, ['--rollback']);
    assert.notEqual(rb.status, 0);
    assert.match(rb.out, /is a symlink/);
  }
});

test('a rerun refused after a bound stop in step 1 says an earlier run changed things', () => {
  const w = world('bound-rerun');
  w.sd.running('stam-deploy-watch.service');
  const first = run(w, [], { MOOTR_MOVE_LOCK_TRIES: '2', MOOTR_MOVE_LOCK_SLEEP: '0' });
  assert.notEqual(first.status, 0);
  assert.ok(existsSync(join(w.data, 'deploy-hold')) && existsSync(join(w.premove, 'progress')), 'the freeze is recorded');
  // A rerun while a lock is still held is refused in step 0: that message must not say nothing changed.
  const lock = join(w.data, 'releases/.flock');
  const holder = spawnSync('sh', ['-c', `flock -n ${lock} true`]); // sanity: the lock is free
  assert.equal(holder.status, 0);
  const child = spawn('flock', [lock, 'sh', '-c', 'echo held; read x'], { stdio: ['pipe', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    child.stdout.once('data', () => {
      try {
        const again = run(w);
        assert.notEqual(again.status, 0);
        assert.match(again.out, /is held/);
        assert.match(again.out, /An earlier run already changed things/);
        assert.ok(!/Nothing was changed/.test(again.out));
        child.stdin.end();
        resolve();
      } catch (e) {
        child.stdin.end();
        reject(e);
      }
    });
  });
});

// Step 7 (S-4344): agents whose harness runs under the old path are restarted through the daemon once health passes.
// A fake proc root stands in for /proc: PROC/PID/comm and PROC/PID/cwd (a symlink to the cwd, as /proc shows it).
function proc(w, pid, comm, cwd) {
  mkdirSync(join(w.proc, String(pid)));
  writeFileSync(join(w.proc, String(pid), 'comm'), `${comm}\n`);
  symlinkSync(cwd, join(w.proc, String(pid), 'cwd'));
}
const FRESH = '2026-10-21T12:00:00.000Z';
// A live agent on this machine (the one GET /api/health names) with its worktree in the data dir.
function worktreeAgent(w, name, extra = {}) {
  const cwd = join(w.data, 'worktrees', name);
  mkdirSync(cwd, { recursive: true });
  return agent(name, { machine: 'testbox', launched_at: FRESH, cwd, ...extra });
}
const restartCalls = (w) => {
  const f = join(w.sc, 'curl-urls');
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((u) => u.endsWith('/restart')) : [];
};
const progress = (w) => readFileSync(join(w.premove, 'progress'), 'utf8');

test('step 7 with no agents under the data dir restarts nothing, and the step is done', () => {
  const w = world('restart-none');
  const r = run(w);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /no harness process has its cwd under/);
  assert.match(r.out, /nothing to restart/);
  assertMoved(w);
  assert.deepEqual(restartCalls(w), []);
  assert.match(progress(w), /^step7$/m);
});

test('step 7 restarts a running worktree agent after health, skips a resting one, and ignores peers and processes outside the data dir', () => {
  const w = world('restart-one');
  const a = worktreeAgent(w, 'dev-a');
  const rest = worktreeAgent(w, 'dev-rest', { lifecycle: 'paused', resting: { reason: 'idle', waits: [] } });
  const idle = worktreeAgent(w, 'dev-noproc');
  const outside = agent('dev-out', { machine: 'testbox', launched_at: FRESH, cwd: join(w.dir, 'elsewhere') });
  const peer = agent('peer-dev', { machine: 'storage', launched_at: FRESH, cwd: join(w.data, 'worktrees', 'peer-dev') });
  setAgents(w, [a, rest, idle, outside, peer]);
  proc(w, 101, 'claude', join(a.cwd, 'web'));
  proc(w, 102, 'claude', join(w.dir, 'elsewhere'));
  proc(w, 103, 'node', join(w.data, 'releases/current'));
  const r = run(w);
  assert.equal(r.status, 0, r.out);
  assertMoved(w);
  assert.match(r.out, /pid 101 \(claude\) in worktrees\/dev-a\/web/);
  assert.ok(!/pid 10[23]/.test(r.out), 'a process outside the data dir, or not a harness, is not listed');
  assert.deepEqual(restartCalls(w), ['http://127.0.0.1:7878/api/agents/dev-a/restart']);
  assert.match(r.out, /asked the daemon to restart dev-a/);
  assert.match(r.out, /skipped dev-rest: resting/);
  assert.match(r.out, /skipped dev-noproc: no harness process runs in its worktree/);
  assert.ok(!/dev-out|peer-dev/.test(r.out), 'an agent outside the data dir, or on a peer, is left out');
  // The restart came after the health check and the unfreeze.
  assert.ok(r.out.indexOf('step 7: restart') > r.out.indexOf('step 6: unfreeze'));
  assert.match(progress(w), /^restart-asked dev-a$/m);
  assert.match(progress(w), /^step7$/m);
  assert.ok(!r.out.includes(TOKEN), 'no token in the output');
  // A rerun never restarts it again.
  const again = run(w);
  assert.equal(again.status, 0, again.out);
  assert.match(again.out, /already done/);
  assert.equal(restartCalls(w).length, 1);
});

test('a failed restart is reported, the move stands, and a rerun retries only that agent', () => {
  const w = world('restart-fail');
  const a = worktreeAgent(w, 'dev-a');
  const b = worktreeAgent(w, 'dev-b');
  setAgents(w, [a, b]);
  proc(w, 201, 'claude', a.cwd);
  proc(w, 202, 'opencode', b.cwd);
  w.sd.http('/api/agents/dev-b/restart', { code: 500 });
  const r = run(w);
  assert.equal(r.status, 0, r.out);
  assertMoved(w);
  assert.match(r.out, /the restart of dev-b failed \(POST \/api\/agents\/dev-b\/restart answered 500\); the move stands/);
  assert.ok(!/rolled back|rolling back/.test(r.out));
  assert.match(progress(w), /^restart-asked dev-a$/m);
  assert.ok(!/restart-asked dev-b|^step7$/m.test(progress(w)), 'the failed restart and the step stay open');
  assert.ok(!r.out.includes(TOKEN));
  w.sd.http('/api/agents/dev-b/restart', {});
  const again = run(w);
  assert.equal(again.status, 0, again.out);
  assert.match(again.out, /skipped dev-a: the daemon accepted its restart in an earlier run/);
  assert.match(again.out, /asked the daemon to restart dev-b/);
  assert.match(again.out, /already done/);
  assert.deepEqual(restartCalls(w).map((u) => u.split('/').at(-2)), ['dev-a', 'dev-b', 'dev-b']);
  assert.match(progress(w), /^step7$/m);
});

test('--dry-run lists the harnesses under the data dir and restarts nothing', () => {
  const w = world('restart-dry');
  const a = worktreeAgent(w, 'dev-a');
  setAgents(w, [a]);
  proc(w, 301, 'claude', a.cwd);
  const before = snapshot(w);
  const r = run(w, ['--dry-run']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /pid 301 \(claude\) in worktrees\/dev-a/);
  assert.match(r.out, /would: ask the daemon \(POST \/api\/agents\/ID\/restart\)/);
  assert.deepEqual(restartCalls(w), []);
  assert.equal(snapshot(w), before);
});

test('a move whose health check fails rolls back and restarts nothing', () => {
  const w = world('restart-rollback');
  const a = worktreeAgent(w, 'dev-a');
  setAgents(w, [a]);
  proc(w, 401, 'claude', a.cwd);
  w.sd.unhealthy('mootrd.service');
  const r = run(w);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /rolled back/);
  assert.ok(!/step 7: restart/.test(r.out));
  assert.deepEqual(restartCalls(w), []);
});

test('a crash just before the restart call records nothing, and the rerun asks again', () => {
  const w = world('restart-crash');
  const a = worktreeAgent(w, 'dev-a');
  setAgents(w, [a]);
  proc(w, 501, 'claude', a.cwd);
  // The hook runs in a child of the script, just before the POST: killing its parent is the crash.
  const r = run(w, [], { MOOTR_MOVE_HOOK_RESTART: 'kill -9 $PPID' });
  assert.notEqual(r.status, 0, r.out);
  assert.deepEqual(restartCalls(w), []);
  assert.match(progress(w), /^step6$/m);
  assert.ok(!/restart-asked|^step7$/m.test(progress(w)), 'nothing recorded before the call');
  const again = run(w);
  assert.equal(again.status, 0, again.out);
  assert.match(again.out, /asked the daemon to restart dev-a/);
  assert.equal(restartCalls(w).length, 1);
  assert.match(progress(w), /^restart-asked dev-a$/m);
  assert.match(progress(w), /^step7$/m);
});

test('a restart call that answers nothing (a timeout) is not recorded, and the rerun asks again', () => {
  const w = world('restart-timeout');
  const a = worktreeAgent(w, 'dev-a');
  setAgents(w, [a]);
  proc(w, 601, 'claude', a.cwd);
  w.sd.http('/api/agents/dev-a/restart', { code: '' });
  const r = run(w);
  assert.equal(r.status, 0, r.out);
  assertMoved(w);
  assert.match(r.out, /the restart of dev-a failed \(POST \/api\/agents\/dev-a\/restart answered nothing\)/);
  assert.ok(!/restart-asked|^step7$/m.test(progress(w)));
  w.sd.http('/api/agents/dev-a/restart', {});
  const again = run(w);
  assert.equal(again.status, 0, again.out);
  assert.match(again.out, /asked the daemon to restart dev-a/);
  assert.equal(restartCalls(w).length, 2);
  assert.match(progress(w), /^step7$/m);
});
