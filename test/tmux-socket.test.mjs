#!/usr/bin/env node
// Dead tmux socket files of tests (S-3288): which names the sweep may touch, how `tmux ls` output
// decides a socket is dead, and a sweep against a real tmux on a scratch TMUX_TMPDIR:
// `node --test test/tmux-socket.test.mjs`.
import './scrub-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { classifyTmuxLs, isTestSocket, killTmuxServer, socketPid } from '../src/tmux-socket.ts';

test('isTestSocket accepts test names and never the live or default socket', () => {
  for (const n of ['stam-check-123', 'rest-test-99', 'cost-switch-test-5', 'stam-test-user-Ab3dE5-main', 'transcript-gz-resume-7']) assert.equal(isTestSocket(n), true, n);
  for (const n of ['stam', 'default', 'stam-test-', 'mystam', 'rest-test', 'x/rest-test-1', 'pd-smoke', 'rest-test-1x']) assert.equal(isTestSocket(n), false, n);
});

test('classifyTmuxLs calls a socket dead only for "no server" or a refused connection', () => {
  assert.equal(classifyTmuxLs({ status: 1, stderr: 'no server running on /tmp/tmux-1000/x' }), 'dead');
  assert.equal(classifyTmuxLs({ status: 1, stderr: 'error connecting to /tmp/tmux-1000/x (Connection refused)' }), 'dead');
  assert.equal(classifyTmuxLs({ status: 1, stderr: 'error connecting to /tmp/tmux-1000/x (No such file or directory)' }), 'dead');
  assert.equal(classifyTmuxLs({ status: 0, stderr: '' }), 'live');
});

test('classifyTmuxLs keeps a socket on any other failure', () => {
  assert.equal(classifyTmuxLs({ status: 1, stderr: 'error connecting to /tmp/tmux-1000/x (Permission denied)' }), 'unknown');
  assert.equal(classifyTmuxLs({ status: 1, stderr: 'protocol version mismatch' }), 'unknown');
  assert.equal(classifyTmuxLs({ status: null, stderr: '', timedOut: true }), 'unknown');
  // A timed-out call with stderr that would read as dead is still unknown.
  assert.equal(classifyTmuxLs({ status: null, stderr: 'no server running on /tmp/x', timedOut: true }), 'unknown');
  assert.equal(classifyTmuxLs({ status: 127, stderr: '' }), 'unknown');
});

test('killTmuxServer removes the socket file after the kill, and the sweep keeps a live one', async () => {
  const dir = mkdtempSync('/tmp/tms-') // tmux socket paths are short;
  process.env.TMUX_TMPDIR = dir;
  try {
    const { sweepDeadSockets } = await import('../src/janitor.ts');
    const sockDir = join(dir, `tmux-${process.getuid()}`);
    const live = `rest-test-${process.pid}1`;
    const gone = `rest-test-${process.pid}2`;
    const other = `unrelated-${process.pid}`;
    for (const s of [live, gone, other]) { const n = spawnSync('tmux', ['-L', s, 'new-session', '-d', 'sleep 60'], { encoding: 'utf8', env: { ...process.env, TMUX: '' } }); assert.equal(n.status, 0, n.stderr); }
    assert.equal(spawnSync('tmux', ['-L', gone, 'kill-server']).status, 0);
    // A killed server's file may or may not remain; bind a socket file nothing serves, as a crashed server leaves one.
    const dead = `rest-test-${process.pid}3`;
    assert.equal(spawnSync('python3', ['-c', 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])', join(sockDir, dead)]).status, 0);
    assert.ok(existsSync(join(sockDir, dead)));
    const dry = await sweepDeadSockets({ dryRun: true });
    assert.ok(!dry.removed.includes(live), 'live server kept');
    const r = await sweepDeadSockets();
    assert.ok(!r.removed.includes(live) && existsSync(join(sockDir, live)), 'live socket stays');
    assert.ok(existsSync(join(sockDir, other)), 'a non-test name is never touched');
    assert.ok(!existsSync(join(sockDir, gone)), 'dead test socket is gone');
    assert.ok(r.removed.includes(dead) && !existsSync(join(sockDir, dead)), 'an unserved socket file is removed');
    killTmuxServer(live);
    assert.ok(!existsSync(join(sockDir, live)), 'killTmuxServer removes the file');
    spawnSync('tmux', ['-L', other, 'kill-server']);
  } finally {
    spawnSync('tmux', ['-L', `unrelated-${process.pid}`, 'kill-server']);
    rmSync(dir, { recursive: true, force: true });
    delete process.env.TMUX_TMPDIR;
  }
});

test('socketPid reads the owning PID of a PID-named socket and nothing else', () => {
  assert.equal(socketPid('rest-test-123'), 123);
  assert.equal(socketPid('stam-check-77'), 77);
  assert.equal(socketPid('transcript-gz-resume-9'), 9);
  assert.equal(socketPid('stam-test-lock-55-a'), 55);
  assert.equal(socketPid('stam-test-user-Ab3dE5-main'), undefined);
});

test('isTestSocket excludes the configured STAM_TMUX_SOCKET', () => {
  process.env.STAM_TMUX_SOCKET = 'rest-test-4242';
  try {
    assert.equal(isTestSocket('rest-test-4242'), false);
  } finally {
    delete process.env.STAM_TMUX_SOCKET;
  }
});

test('killTmuxServer kills the socket a test configured as STAM_TMUX_SOCKET', () => {
  const dir = mkdtempSync('/tmp/tms-');
  process.env.TMUX_TMPDIR = dir;
  const name = `rest-test-${process.pid}8`;
  process.env.STAM_TMUX_SOCKET = name; // the way the tests set it
  try {
    const calls = [];
    assert.equal(killTmuxServer(name, { run: (a) => (calls.push(a), { status: 0, stderr: '' }) }), true);
    assert.equal(calls.length, 1, 'tmux ran');
    // And for real: a live server on that socket is dead afterwards, and so is its file.
    const n = spawnSync('tmux', ['-L', name, 'new-session', '-d', 'sleep 60'], { encoding: 'utf8', env: { ...process.env, TMUX: '' } });
    assert.equal(n.status, 0, n.stderr);
    assert.equal(killTmuxServer(name), true);
    assert.notEqual(spawnSync('tmux', ['-L', name, 'ls']).status, 0, 'the server is dead');
    assert.ok(!existsSync(join(dir, `tmux-${process.getuid()}`, name)), 'the file is gone');
    assert.equal(isTestSocket(name), false, 'the sweep still skips it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.TMUX_TMPDIR;
    delete process.env.STAM_TMUX_SOCKET;
  }
});

test('killTmuxServer keeps the file unless the server is down', () => {
  const dir = mkdtempSync('/tmp/tms-');
  process.env.TMUX_TMPDIR = dir;
  const sockDir = join(dir, `tmux-${process.getuid()}`);
  const name = `rest-test-${process.pid}9`;
  const file = join(sockDir, name);
  const reset = () => {
    spawnSync('mkdir', ['-p', sockDir]);
    writeFileSync(file, '');
  };
  try {
    reset();
    // kill-server times out and ls does not say "no server": stays, whatever stderr says.
    assert.equal(killTmuxServer(name, { run: () => ({ status: null, stderr: 'no server running', timedOut: true }) }), false);
    assert.ok(existsSync(file), 'a timed-out kill keeps the file');
    // kill-server fails and a server still answers: stays.
    assert.equal(killTmuxServer(name, { run: (a) => (a.includes('ls') ? { status: 0, stderr: '' } : { status: 1, stderr: 'boom' }) }), false);
    assert.ok(existsSync(file), 'a still-live server keeps the file');
    // kill-server fails with an unknown error: stays.
    assert.equal(killTmuxServer(name, { run: () => ({ status: 1, stderr: 'permission denied' }) }), false);
    assert.ok(existsSync(file));
    // kill-server fails but ls says no server: goes.
    assert.equal(killTmuxServer(name, { run: (a) => (a.includes('ls') ? { status: 1, stderr: 'no server running on x' } : { status: 1, stderr: 'no server running on x' }) }), true);
    assert.ok(!existsSync(file));
    // The live and default sockets are never touched.
    for (const n of ['stam', 'default']) {
      writeFileSync(join(sockDir, n), '');
      assert.equal(killTmuxServer(n, { run: () => ({ status: 0, stderr: '' }) }), false);
      assert.ok(existsSync(join(sockDir, n)));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.TMUX_TMPDIR;
  }
});

// Sweep-level cases with injected tmux answers on fake socket files (python binds a real unix socket file).
async function withSockets(names, fn) {
  const dir = mkdtempSync('/tmp/tms-');
  process.env.TMUX_TMPDIR = dir;
  const sockDir = join(dir, `tmux-${process.getuid()}`);
  spawnSync('mkdir', ['-p', sockDir]);
  for (const n of names) spawnSync('python3', ['-c', 'import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])', join(sockDir, n)]);
  try {
    await fn(sockDir, await import('../src/janitor.ts'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.TMUX_TMPDIR;
  }
}
const DEAD = async () => ({ status: 1, stderr: 'no server running on /x' });

test('the sweep skips a PID-named socket whose process is alive, without probing it', async () => {
  await withSockets(['rest-test-111', 'rest-test-222'], async (sockDir, { sweepDeadSockets }) => {
    let probes = [];
    const r = await sweepDeadSockets({ alive: (p) => p === 111, ls: async (n) => (probes.push(n), DEAD()) });
    assert.deepEqual(probes, ['rest-test-222']);
    assert.deepEqual(r.removed, ['rest-test-222']);
    assert.ok(existsSync(join(sockDir, 'rest-test-111')));
  });
});

test('a replacement server between probe and delete keeps the file', async () => {
  await withSockets(['rest-test-333'], async (sockDir, { sweepDeadSockets }) => {
    const file = join(sockDir, 'rest-test-333');
    const r = await sweepDeadSockets({
      alive: () => false,
      // The probe says dead; then a new server replaces the file (new inode).
      ls: async () => {
        const out = await DEAD();
        rmSync(file);
        spawnSync('python3', ['-c', 'import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])', file]);
        return out;
      },
    });
    assert.deepEqual(r.removed, []);
    assert.ok(existsSync(file), 'the replaced file stays');
  });
});

test('the PID coming alive between probe and delete keeps the file', async () => {
  await withSockets(['rest-test-444'], async (sockDir, { sweepDeadSockets }) => {
    let alive = false;
    const r = await sweepDeadSockets({ alive: () => alive, ls: async () => ((alive = true), DEAD()) });
    assert.deepEqual(r.removed, []);
    assert.ok(existsSync(join(sockDir, 'rest-test-444')));
  });
});

test('a name without a PID is never swept, however old', async () => {
  await withSockets(['stam-test-user-Cd4eF6-main'], async (sockDir, { sweepDeadSockets }) => {
    const old = new Date(Date.now() - 400 * 3600_000);
    utimesSync(join(sockDir, 'stam-test-user-Cd4eF6-main'), old, old);
    let probed = 0;
    const r = await sweepDeadSockets({ ls: async () => (probed++, DEAD()) });
    assert.deepEqual(r.removed, []);
    assert.equal(probed, 0);
    assert.ok(existsSync(join(sockDir, 'stam-test-user-Cd4eF6-main')));
  });
});

test('timeouts and unknown failures keep the files, even with dead-looking stderr', async () => {
  await withSockets(['rest-test-501', 'rest-test-502', 'rest-test-503'], async (sockDir, { sweepDeadSockets }) => {
    const answers = {
      'rest-test-501': { status: null, stderr: 'no server running', timedOut: true },
      'rest-test-502': { status: 1, stderr: 'error connecting to /x (Permission denied)' },
      'rest-test-503': { status: 0, stderr: '' },
    };
    const r = await sweepDeadSockets({ alive: () => false, ls: async (n) => answers[n] });
    assert.deepEqual(r.removed, []);
    for (const n of Object.keys(answers)) assert.ok(existsSync(join(sockDir, n)), n);
  });
});

test('a pass probes at most its budget and the next pass continues after the last name', async () => {
  const names = Array.from({ length: 7 }, (_, i) => `rest-test-6${i}0`);
  await withSockets(names, async (sockDir, { sweepDeadSockets }) => {
    const slow = async () => ({ status: null, stderr: '', timedOut: true });
    const seen = [];
    const ls = async (n) => (seen.push(n), slow());
    const a = await sweepDeadSockets({ alive: () => false, ls, probes: 3 });
    const b = await sweepDeadSockets({ alive: () => false, ls, probes: 3 });
    const c = await sweepDeadSockets({ alive: () => false, ls, probes: 3 });
    assert.deepEqual([a.probed, b.probed, c.probed], [3, 3, 3]);
    assert.deepEqual(seen.slice(0, 7), [...names].sort(), 'every file is reached in turn');
    // A time budget already spent stops the pass before any probe.
    let t = 0;
    const d = await sweepDeadSockets({ alive: () => false, ls, now: () => (t += 20_000) });
    assert.equal(d.probed, 0);
  });
});
