#!/usr/bin/env node
// The OpenCode guard of test/lib.sh (S-4237, S-107): a test daemon never runs the real OpenCode outside a smoke test. The guard
// resolves STAM_OPENCODE_BIN (PATH, then links) before it compares it with the real binary, and fails closed. The real binary is
// a sentinel here (STAM_TEST_REAL_OPENCODE), a script that leaves a mark if anything runs it; no case runs it, and none touches
// ~/.opencode. The daemons' own check (src/test-env.ts opencodeBinFor) is tested here too, a daemon a script starts with
// runDaemon() included. Free: `node --test test/opencode-guard.test.mjs`; it starts a daemon, so it is not in the LIGHT list.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import './scrub-env.mjs';
import { killTmuxServer } from '../src/tmux-socket.ts';

const ROOT = join(import.meta.dirname, '..');
const T = mkdtempSync(join(tmpdir(), 'opencode-guard.'));
after(() => rmSync(T, { recursive: true, force: true }));
// src/test-env.ts reads STAM_HOME as it loads (src/config.ts): a throwaway one, never the live home.
process.env.STAM_HOME = join(T, 'import-home');
const { opencodeBinFor } = await import('../src/test-env.ts');

const MARK = join(T, 'ran');
const REAL = join(T, 'real', 'opencode');
const bin = (p) => {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, `#!/bin/sh\ntouch '${MARK}'\n`);
  chmodSync(p, 0o755);
};
bin(REAL);
// A PATH folder holding the real binary under its own name and an alias, and one holding only a harmless command.
const ALIASES = join(T, 'aliases');
mkdirSync(ALIASES);
symlinkSync(REAL, join(ALIASES, 'opencode'));
symlinkSync(REAL, join(ALIASES, 'oc'));
symlinkSync(join(ALIASES, 'oc'), join(T, 'link-to-link'));
const OTHER = join(T, 'other');
mkdirSync(OTHER);
symlinkSync('/bin/false', join(OTHER, 'harmless'));
const FAKE = join(ROOT, 'test', 'fake-opencode', 'opencode');
const SYS_PATH = '/usr/bin:/bin';

// guard(env) runs opencode_bin_guard in a clean shell: { ok, err }. HOME is the temp folder, so the default real location
// (~/.opencode/bin/opencode) is never the user's.
function guard(env) {
  const r = spawnSync('sh', ['-c', `. '${join(ROOT, 'test', 'opencode-guard.sh')}'; opencode_bin_guard`], {
    env: { HOME: T, PATH: SYS_PATH, STAM_TEST_REAL_OPENCODE: REAL, ...env },
    encoding: 'utf8',
  });
  return { ok: r.status === 0, err: r.stderr };
}
const refused = (env, why) => {
  const r = guard(env);
  assert.equal(r.ok, false, `${why}: refused`);
  assert.match(r.err, /^FAIL: /m, `${why}: says FAIL`);
};

test('the real binary is refused by its exact path', () => {
  refused({ STAM_OPENCODE_BIN: REAL }, 'exact path');
});

test('an alias of the real binary is refused: a symlink, a chain of them, a path with dots', () => {
  refused({ STAM_OPENCODE_BIN: join(ALIASES, 'oc') }, 'symlink');
  refused({ STAM_OPENCODE_BIN: join(T, 'link-to-link') }, 'symlink to a symlink');
  refused({ STAM_OPENCODE_BIN: join(T, 'real', '..', 'real', 'opencode') }, 'path with ..');
});

test('a bare name that PATH resolves to the real binary is refused', () => {
  refused({ STAM_OPENCODE_BIN: 'oc', PATH: `${ALIASES}:${SYS_PATH}` }, 'PATH alias');
  refused({ STAM_OPENCODE_BIN: 'opencode', PATH: `${ALIASES}:${SYS_PATH}` }, 'opencode on PATH');
});

test('opencode on PATH counts as real too, wherever it is', () => {
  // A second real location, found only as `opencode` on PATH, not named by STAM_TEST_REAL_OPENCODE.
  const elsewhere = join(T, 'elsewhere');
  bin(join(elsewhere, 'opencode'));
  refused({ STAM_OPENCODE_BIN: join(elsewhere, 'opencode'), PATH: `${elsewhere}:${SYS_PATH}` }, 'the PATH opencode');
});

test('a value the guard cannot judge is refused: empty, unset, a bare name PATH lacks, a dangling link', () => {
  refused({ STAM_OPENCODE_BIN: '' }, 'empty');
  refused({}, 'unset');
  refused({ STAM_OPENCODE_BIN: 'nosuch-opencode' }, 'a bare name not on PATH');
  const dangling = join(T, 'dangling');
  symlinkSync(join(T, 'missing', 'dir', 'opencode'), dangling);
  refused({ STAM_OPENCODE_BIN: dangling }, 'a dangling link');
});

test('the fake and a caller\'s own harmless binary pass', () => {
  assert.equal(guard({ STAM_OPENCODE_BIN: FAKE }).ok, true, 'the fake');
  assert.equal(guard({ STAM_OPENCODE_BIN: '/bin/false' }).ok, true, '/bin/false');
  assert.equal(guard({ STAM_OPENCODE_BIN: 'harmless', PATH: `${OTHER}:${SYS_PATH}` }).ok, true, 'a harmless bare name');
  // With the real binary on PATH too, the fake still passes.
  assert.equal(guard({ STAM_OPENCODE_BIN: FAKE, PATH: `${ALIASES}:${SYS_PATH}` }).ok, true, 'the fake beside a real PATH opencode');
});

test('a MOOTR_OPENCODE_BIN, which a reader takes first, is judged too', () => {
  refused({ STAM_OPENCODE_BIN: FAKE, MOOTR_OPENCODE_BIN: REAL }, 'MOOTR_ real path');
  refused({ STAM_OPENCODE_BIN: FAKE, MOOTR_OPENCODE_BIN: join(ALIASES, 'oc') }, 'MOOTR_ symlink');
  assert.equal(guard({ STAM_OPENCODE_BIN: FAKE, MOOTR_OPENCODE_BIN: FAKE }).ok, true, 'MOOTR_ fake');
});

test('a smoke test may run the real binary', () => {
  assert.equal(guard({ STAM_OPENCODE_BIN: REAL, STAM_TEST_SMOKE: '1' }).ok, true);
  assert.equal(guard({ STAM_TEST_SMOKE: '1' }).ok, true, 'unset, so TS falls back to the real one');
});

// libSh(env) sources test/lib.sh with env and exits, so only its source-time steps run (no daemon), then its cleanup.
function libSh(env) {
  const r = spawnSync('sh', ['-c', `. '${join(ROOT, 'test', 'lib.sh')}'; echo "BIN=$STAM_OPENCODE_BIN"`], {
    env: { HOME: T, PATH: process.env.PATH, STAM_TEST_ROOT: ROOT, STAM_TEST_TMPDIR: T, STAM_TEST_REAL_OPENCODE: REAL, ...env },
    encoding: 'utf8',
  });
  return { ok: r.status === 0, out: r.stdout, err: r.stdout + r.stderr };
}

test('sourcing lib.sh defaults to the fake, keeps a caller\'s fake, and refuses the real binary at once', () => {
  assert.match(libSh({}).out, new RegExp(`BIN=${FAKE}$`, 'm'), 'the default is the fake');
  assert.match(libSh({ STAM_OPENCODE_BIN: '/bin/false' }).out, /BIN=\/bin\/false$/m, "a caller's own binary is kept");
  const r = libSh({ STAM_OPENCODE_BIN: join(ALIASES, 'oc') });
  assert.equal(r.ok, false, 'an alias of the real binary stops the test as lib.sh is sourced');
  assert.match(r.err, /FAIL: .*real opencode/);
});

// afterSource(change) sources lib.sh, makes the change, then runs `"$STAM" daemon start` as a test would by hand. The CLI
// behind the wrapper is a stand-in that writes the OpenCode values it got to a file, so no daemon starts; a $STAM that
// isn't the wrapper stops the case first, so a real CLI is never run either.
const CLI_SAW = join(T, 'cli-saw');
const STANDIN = join(T, 'standin-stam');
writeFileSync(STANDIN, `#!/bin/sh\necho "STAM=$STAM_OPENCODE_BIN MOOTR=\${MOOTR_OPENCODE_BIN-unset} ARGS=$*" >'${CLI_SAW}'\n`);
chmodSync(STANDIN, 0o755);
function afterSource(change, env = {}) {
  rmSync(CLI_SAW, { force: true });
  const script = `. '${join(ROOT, 'test', 'lib.sh')}'
[ "$STAM" = "$ROOT/test/stam-guarded" ] || { echo "NOT WRAPPED: $STAM"; exit 3; }
export STAM_GUARDED_CLI='${STANDIN}'
${change}
"$STAM" daemon start`;
  const r = spawnSync('sh', ['-c', script], {
    env: { HOME: T, PATH: process.env.PATH, STAM_TEST_ROOT: ROOT, STAM_TEST_TMPDIR: T, STAM_TEST_REAL_OPENCODE: REAL, ...env },
    encoding: 'utf8',
  });
  return { status: r.status, out: r.stdout + r.stderr, saw: existsSync(CLI_SAW) ? readFileSync(CLI_SAW, 'utf8').trim() : null };
}

test('a "$STAM" call judges the value it runs with, not the one lib.sh saw', () => {
  for (const [change, why] of [
    [`export STAM_OPENCODE_BIN='${REAL}'`, 'the real path'],
    [`export STAM_OPENCODE_BIN='${join(ALIASES, 'oc')}'`, 'a symlink to it'],
    [`export PATH='${ALIASES}':"$PATH" STAM_OPENCODE_BIN=oc`, 'a PATH alias'],
  ]) {
    const r = afterSource(change);
    assert.notEqual(r.status, 3, `${why}: ${r.out}`);
    assert.notEqual(r.status, 0, `${why}: refused`);
    assert.match(r.out, /FAIL: .*real opencode/, why);
    assert.equal(r.saw, null, `${why}: the CLI never ran`);
  }
  const unset = afterSource('unset STAM_OPENCODE_BIN');
  assert.equal(unset.status, 0, unset.out);
  assert.equal(unset.saw, `STAM=${FAKE} MOOTR=unset ARGS=daemon start`, 'unset: the CLI runs with the fake');
  const mootr = afterSource(`export MOOTR_OPENCODE_BIN='${REAL}'`);
  assert.equal(mootr.saw, `STAM=${FAKE} MOOTR=unset ARGS=daemon start`, 'a MOOTR_ name, which a reader takes first, is dropped');
});

test('a smoke test keeps the plain CLI', () => {
  const r = spawnSync('sh', ['-c', `. '${join(ROOT, 'test', 'lib.sh')}'; echo "STAM=$STAM"`], {
    env: { HOME: T, PATH: process.env.PATH, STAM_TEST_ROOT: ROOT, STAM_TEST_TMPDIR: T, STAM_TEST_SMOKE: '1' },
    encoding: 'utf8',
  });
  assert.match(r.stdout, new RegExp(`^STAM=${ROOT}/bin/stam$`, 'm'));
});

test('go_daemon_up refuses an exported MOOTR_ real path before it starts anything', () => {
  // setsid is how go_daemon_up starts stamd: a function of that name shadows it and leaves a mark if it is reached.
  const started = join(T, 'go-started');
  const script = `. '${join(ROOT, 'test', 'lib.sh')}'
setsid() { touch '${started}'; }
daemon_home g
export MOOTR_OPENCODE_BIN='${REAL}'
go_daemon_up g`;
  const r = spawnSync('sh', ['-c', script], {
    env: { HOME: T, PATH: process.env.PATH, STAM_TEST_ROOT: ROOT, STAM_TEST_TMPDIR: T, STAM_TEST_REAL_OPENCODE: REAL },
    encoding: 'utf8',
  });
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /FAIL: MOOTR_OPENCODE_BIN .*real opencode/);
  assert.match(r.stdout, /FAIL: go daemon g not started/);
  assert.equal(existsSync(started), false, 'stamd was never started');
});

test('a test importing tmphome.mjs gets the fake, unless it names its own or is a smoke test', () => {
  const read = (env) =>
    spawnSync('node', ['--no-warnings', '--input-type=module', '-e', `await import(${JSON.stringify(join(ROOT, 'test', 'tmphome.mjs'))}); console.log(process.env.STAM_OPENCODE_BIN ?? 'unset')`], {
      env: { PATH: process.env.PATH, HOME: T, ...env },
      encoding: 'utf8',
    }).stdout.trim();
  assert.equal(read({}), FAKE);
  assert.equal(read({ STAM_OPENCODE_BIN: '/bin/false' }), '/bin/false');
  assert.equal(read({ STAM_TEST_SMOKE: '1' }), 'unset');
});

// A home with the test-home marker, as test/lib.sh's daemon_home and the runDaemon() tests make one, and one without.
const MARKED = join(T, 'marked-home');
mkdirSync(MARKED);
writeFileSync(join(MARKED, '.stam-test-home'), '');
const PLAIN = join(T, 'plain-home');
mkdirSync(PLAIN);

const refusal = (r) => ('refused' in r ? r.refused : '');

test("the daemons' own check refuses the real binary in a marked test home, however it is spelled", () => {
  const env = { HOME: T, PATH: SYS_PATH, STAM_TEST_REAL_OPENCODE: REAL };
  const no = (bin, why, re, extra = {}) => assert.match(refusal(opencodeBinFor(bin, { ...env, ...extra }, MARKED, false)), re, why);
  no(REAL, 'exact path', /real opencode/);
  no(join(ALIASES, 'oc'), 'symlink', /real opencode/);
  no(join(T, 'link-to-link'), 'symlink to a symlink', /real opencode/);
  no(join(T, 'real', '..', 'real', 'opencode'), 'path with ..', /real opencode/);
  no('oc', 'PATH alias', /real opencode/, { PATH: `${ALIASES}:${SYS_PATH}` });
  no('nosuch-opencode', 'a bare name not on PATH', /isn't on PATH/);
  no('', 'empty', /isn't on PATH/);
  // A relative path names whatever is at the cwd it runs in, which needn't be the daemon's.
  no('./oc', 'a relative path', /relative path/);
  no('aliases/oc', 'a relative path without ./', /relative path/);
  no(join(T, 'missing', 'opencode'), 'a path that is not there', /isn't there/);
  no(join(T, 'dangling'), 'a dangling link', /isn't there/);
  const elsewhere = join(T, 'elsewhere2');
  bin(join(elsewhere, 'opencode'));
  no(join(elsewhere, 'opencode'), 'the PATH opencode', /real opencode/, { PATH: `${elsewhere}:${SYS_PATH}` });
  // Without STAM_TEST_REAL_OPENCODE, ~/.opencode/bin/opencode is the real one.
  bin(join(T, '.opencode', 'bin', 'opencode'));
  assert.match(refusal(opencodeBinFor(join(T, '.opencode', 'bin', 'opencode'), { HOME: T, PATH: SYS_PATH }, MARKED, false)), /real opencode/, 'the default location');
});

test("the daemons' own check runs, in a test home, the absolute path it judged, and bin as given elsewhere", () => {
  const env = { HOME: T, PATH: `${ALIASES}:${SYS_PATH}`, STAM_TEST_REAL_OPENCODE: REAL };
  assert.deepEqual(opencodeBinFor(FAKE, env, MARKED, false), { bin: realpathSync(FAKE), checked: true }, 'the fake');
  assert.deepEqual(opencodeBinFor('/bin/false', env, MARKED, false), { bin: realpathSync('/bin/false'), checked: true }, '/bin/false');
  // A bare name runs as the path PATH gave it here, links followed, never as a name a launch's PATH looks up again.
  assert.deepEqual(opencodeBinFor('harmless', { ...env, PATH: `${OTHER}:${SYS_PATH}` }, MARKED, false), { bin: realpathSync('/bin/false'), checked: true }, 'a bare name');
  assert.deepEqual(opencodeBinFor(REAL, { ...env, STAM_TEST_SMOKE: '1' }, MARKED, false), { bin: REAL }, 'a smoke test');
  assert.deepEqual(opencodeBinFor(REAL, { ...env, MOOTR_TEST_SMOKE: '1' }, MARKED, false), { bin: REAL }, 'a smoke test, MOOTR_ name');
  assert.deepEqual(opencodeBinFor(REAL, env, PLAIN, false), { bin: REAL }, 'a home without the marker');
  assert.deepEqual(opencodeBinFor('./oc', env, MARKED, true), { bin: './oc' }, 'the live home');
});

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// bootDaemon(name, extra, opts) runs a script that calls runDaemon() in a marked test home (daemon-lock.test.mjs's home:
// what the daemon needs to boot, with the marker and no owner file beside it), with extra in its env and opts.cwd as its
// cwd, until its OpenCode adapter's start fails (the error) or its OpenCode server answers ('up'), then kills it. A run that
// ends any other way, or takes over 60 s, fails the case.
async function bootDaemon(name, extra, opts = {}) {
  const home = join(T, `daemon-${name}`);
  mkdirSync(join(home, 'opencode-data'), { recursive: true });
  writeFileSync(join(home, '.stam-test-home'), '');
  writeFileSync(join(home, 'settings.json'), '{ "peers": [] }\n');
  writeFileSync(join(home, 'token'), 'token-guard\n', { mode: 0o600 });
  writeFileSync(join(home, 'peer-token'), 'peer-guard\n', { mode: 0o600 });
  writeFileSync(join(home, 'opencode.env'), `XDG_DATA_HOME=${join(home, 'opencode-data')}\n`, { mode: 0o600 });
  opts.prepare?.(home);
  const port = await freePort();
  const ocPort = await freePort();
  const socket = `stam-test-ocguard-${process.pid}-${name}`;
  const wrapper = join(T, 'wrapper.mjs');
  writeFileSync(wrapper, `const { runDaemon } = await import(${JSON.stringify(join(ROOT, 'src', 'daemon.ts'))});\nawait runDaemon();\n`);
  const env = { ...process.env, STAM_HOME: home, STAM_PORT: String(port), STAM_URL: `http://127.0.0.1:${port}`, STAM_TMUX_SOCKET: socket,
    STAM_MACHINE: 'ocguard', STAM_BIND: '127.0.0.1', STAM_OPENCODE_PORT: String(ocPort), STAM_AGENTS_SKILLS: join(home, 'agents-skills'),
    STAM_EMBEDDER: 'stub', STAM_TEST_REAL_OPENCODE: REAL, ...extra };
  for (const k of ['STAM_AGENT_ID', 'STAM_TOKEN', 'STAM_TEST_SMOKE']) delete env[k];
  const child = spawn('node', ['--no-warnings', wrapper], { env, cwd: opts.cwd ?? T, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  let done = false;
  const exited = new Promise((resolve) => child.on('exit', resolve));
  try {
    const failedNow = new Promise((resolve) => child.stderr.on('data', (d) => {
      err += d;
      const failed = err.match(/opencode adapter failed to start: (.*)/);
      if (failed) resolve(failed[1]);
    }));
    const upNow = (async () => {
      while (!done) {
        if (await fetch(`http://127.0.0.1:${ocPort}/openapi.json`).then(() => true, () => false)) return 'up';
        await new Promise((r) => setTimeout(r, 200));
      }
    })();
    let timer;
    const outcome = await Promise.race([
      failedNow,
      upNow,
      exited.then(() => 'exited'),
      new Promise((resolve) => (timer = setTimeout(() => resolve('timeout'), 60_000))),
    ]);
    clearTimeout(timer);
    assert.ok(outcome !== 'exited' && outcome !== 'timeout', `the daemon ${outcome}; stderr:\n${err}`);
    return outcome;
  } finally {
    done = true;
    child.kill('SIGKILL');
    await exited;
    killTmuxServer(socket);
  }
}

test('a script that calls runDaemon() in a marked test home never runs the real binary', async () => {
  assert.match(await bootDaemon('symlink', { STAM_OPENCODE_BIN: join(ALIASES, 'oc') }), /^refusing the real opencode/, 'a symlink to it');
  // A relative alias that the daemon's cwd lacks and the server's cwd (the home) holds.
  const relative = await bootDaemon('relative', { STAM_OPENCODE_BIN: './oc' }, { prepare: (home) => symlinkSync(REAL, join(home, 'oc')) });
  assert.match(relative, /relative path/, 'a relative alias');
  assert.equal(existsSync(MARK), false, 'the sentinel never ran');
});

test('a bare name runs as the path the check judged, not as the launch PATH finds it again', async () => {
  // The daemon's PATH finds oc as the fake. The server's own PATH puts HOME/.local/go/bin first (withGoBinArgv), where oc
  // is the sentinel: looked up again there, the name would run it.
  const home = join(T, 'gobin-home');
  mkdirSync(join(home, '.local', 'go', 'bin'), { recursive: true });
  symlinkSync(REAL, join(home, '.local', 'go', 'bin', 'oc'));
  const fakeDir = join(T, 'fake-on-path');
  mkdirSync(fakeDir);
  symlinkSync(FAKE, join(fakeDir, 'oc'));
  const outcome = await bootDaemon('bare', { HOME: home, PATH: `${fakeDir}:${process.env.PATH}`, STAM_OPENCODE_BIN: 'oc' });
  assert.equal(outcome, 'up', 'the fake server started');
  assert.equal(existsSync(MARK), false, 'the sentinel never ran');
});

test("an upgrade's command runs the checked path, not a name the shell's PATH finds again", () => {
  // upgradeHarness runs the adapter's upgradeCommand through sh. The daemon's PATH starts with a relative dir, which
  // opencodeBinFor skips: it finds oc as a harmless binary further on. From the cwd the shell runs in, that relative dir
  // holds oc as the sentinel, so a command built from the name would run it.
  const home = join(T, 'upgrade-home');
  mkdirSync(home);
  writeFileSync(join(home, '.stam-test-home'), '');
  const cwd = join(T, 'upgrade-cwd');
  mkdirSync(join(cwd, 'rel'), { recursive: true });
  symlinkSync(REAL, join(cwd, 'rel', 'oc'));
  const harmless = join(T, 'upgrade-harmless');
  mkdirSync(harmless);
  symlinkSync('/bin/true', join(harmless, 'oc'));
  const script = `const { adapters } = await import(${JSON.stringify(join(ROOT, 'src', 'adapters', 'index.ts'))});
const opencode = adapters.opencode;
const { spawnSync } = await import('node:child_process');
const command = opencode.upgradeCommand;
const r = spawnSync('sh', ['-c', command], { encoding: 'utf8' });
console.log(JSON.stringify({ command, status: r.status }));`;
  const r = spawnSync('node', ['--no-warnings', '--input-type=module', '-e', script], {
    cwd,
    env: { PATH: `rel:${harmless}:${process.env.PATH}`, HOME: T, STAM_HOME: home, STAM_OPENCODE_BIN: 'oc', STAM_TEST_REAL_OPENCODE: REAL,
      STAM_EMBEDDER: 'stub', STAM_TMUX_SOCKET: `stam-test-ocguard-${process.pid}-upgrade`, STAM_MACHINE: 'ocguard' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.command, `${realpathSync('/bin/true')} upgrade`, 'the checked path');
  assert.equal(out.status, 0);
  // A checked path the shell would split or expand goes in quoted.
  const odd = join(T, 'odd dir;$(touch x)');
  mkdirSync(odd);
  writeFileSync(join(odd, 'oc'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(odd, 'oc'), 0o755);
  const q = spawnSync('node', ['--no-warnings', '--input-type=module', '-e', script], {
    cwd,
    env: { PATH: process.env.PATH, HOME: T, STAM_HOME: home, STAM_OPENCODE_BIN: join(odd, 'oc'), STAM_TEST_REAL_OPENCODE: REAL,
      STAM_EMBEDDER: 'stub', STAM_TMUX_SOCKET: `stam-test-ocguard-${process.pid}-upgrade`, STAM_MACHINE: 'ocguard' },
    encoding: 'utf8',
  });
  assert.equal(q.status, 0, q.stderr);
  const quoted = JSON.parse(q.stdout.trim().split('\n').pop());
  assert.equal(quoted.command, `'${join(odd, 'oc')}' upgrade`, 'quoted');
  assert.equal(quoted.status, 0);
  assert.equal(existsSync(join(cwd, 'x')), false, 'nothing in the path ran');
  assert.equal(existsSync(MARK), false, 'the sentinel never ran');
});

test('lib.sh runs the guard on every daemon start path', async () => {

  const lib = readFileSync(join(ROOT, 'test', 'lib.sh'), 'utf8');
  for (const fn of ['daemon_up', 'go_daemon_up']) {
    const body = lib.match(new RegExp(`^${fn}\\(\\) \\{\\n([\\s\\S]*?)^\\}`, 'm'));
    assert.ok(body, `${fn} is defined`);
    assert.match(body[1], /opencode_bin_guard/, `${fn} runs the guard`);
  }
});

test('no case ran the sentinel real binary', () => {
  assert.equal(existsSync(MARK), false);
});
