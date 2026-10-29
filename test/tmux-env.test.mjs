import { test, after } from 'node:test';
import { killTmuxServer } from '../src/tmux-socket.ts';
import assert from 'node:assert/strict';
import './scrub-env.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// S-477: an agent's env, its token included, reaches its session without going on any tmux
// command line, where `ps` shows it: a tmux server keeps the argv of the client that started it.
const SOCKET = `stam-test-env-${process.pid}`;
process.env.STAM_TMUX_SOCKET = SOCKET;
const tmux = await import('../src/tmux.ts');
const run = (...args) => execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8' });
after(() => killTmuxServer(SOCKET));

const token = randomBytes(16).toString('hex');
const odd = `it's $HOME ~ ; {x} #{pid} # "q" \\ \nline two`;

// Every process's command line that mentions the test's socket, read while the session is up.
function cmdlines() {
  const out = [];
  for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    try {
      const c = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (c.includes(SOCKET) || c.includes(token)) out.push(c.replace(/\0/g, ' '));
    } catch {}
  }
  return out;
}

// The pane's environ is the tmux server's copy until the pane's process execs the command, so wait for the env to show
// (S-3618): the pane is read as state, bounded, 10 ms apart.
function paneEnv(id) {
  const sleep = new Int32Array(new SharedArrayBuffer(4));
  let env = {};
  for (let i = 0; i < 500 && !env.STAM_TOKEN; i++) {
    const pid = run('display-message', '-p', '-t', `=${id}:`, '#{pane_pid}').trim();
    try {
      env = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    } catch {}
    if (!env.STAM_TOKEN) Atomics.wait(sleep, 0, 0, 10);
  }
  return env;
}

test('the session gets the env, and no command line holds the token', () => {
  // This call starts the server, so the server's argv is newSession's own.
  tmux.newSession('a', tmpdir(), { STAM_TOKEN: token, ODD: odd }, ['sh', '-c', 'printf "%s|%s" "$STAM_TOKEN" "$ODD" > /dev/null; exec sleep 600']);
  const lines = cmdlines();
  assert.ok(lines.some((c) => c.includes(SOCKET)), 'the tmux server runs');
  for (const c of lines) assert.ok(!c.includes(token), 'no command line holds the token');
  // The session's env, which the e2e tests read back, and the pane's.
  assert.equal(run('show-environment', '-t', 'a', 'STAM_TOKEN').trim(), `STAM_TOKEN=${token}`);
  const env = paneEnv('a');
  assert.equal(env.STAM_TOKEN, token);
  assert.equal(env.ODD, odd, 'quotes, $, ~, ;, braces, # and newlines arrive as given');
  assert.equal(run('show-options', '-v', '-t', 'a', 'remain-on-exit').trim(), 'on');
});

test('a second session on a running server, and argv with quotes', () => {
  tmux.newSession('b', tmpdir(), { STAM_TOKEN: token }, ['sh', '-c', "echo \"it's\"; exec sleep 600"]);
  for (let i = 0; i < 1000 && !tmux.capturePane('b').includes("it's"); i++);
  assert.match(tmux.capturePane('b'), /it's/);
  for (const c of cmdlines()) assert.ok(!c.includes(token), 'no command line holds the token');
});

test('a failed new-session still throws, and leaves no command file behind', () => {
  const before = readdirSync(tmpdir()).filter((f) => f.startsWith('stam-session-')).length;
  assert.throws(() => tmux.newSession('a', tmpdir(), { STAM_TOKEN: token }, ['sleep', '600']), /duplicate session/);
  assert.equal(readdirSync(tmpdir()).filter((f) => f.startsWith('stam-session-')).length, before);
});

test('S-3229, S-3345: a daemon-side MOOTR_ twin of a STAM_ name set for the agent is replaced by the STAM_ value in the pane', async () => {
  // The server's global environment is what a pane inherits from the daemon.
  for (const [k, v] of Object.entries({ MOOTR_URL: 'http://foreign.invalid', MOOTR_AGENT_ID: 'foreign', MOOTR_TOKEN: 'foreign-token', MOOTR_KEEP: 'kept' })) run('set-environment', '-g', k, v);
  tmux.newSession('c', tmpdir(), { STAM_URL: 'http://stam.test', STAM_AGENT_ID: 'zz', STAM_TOKEN: token }, ['sh', '-c', 'exec sleep 600']);
  const pid = run('display-message', '-p', '-t', '=c:', '#{pane_pid}').trim();
  // The pane pid runs sh, then env, then sleep by exec: only the sleep has the scrubbed environment, and the earlier
  // processes already hold STAM_URL and the inherited MOOTR_ names.
  const comm = () => { try { return readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { return ''; } };
  for (let i = 0; i < 400 && comm() !== 'sleep'; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(comm(), 'sleep', 'the pane reached the harness command');
  const env = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  assert.equal(env.STAM_URL, 'http://stam.test');
  assert.equal(env.MOOTR_URL, 'http://stam.test');
  assert.equal(env.MOOTR_AGENT_ID, 'zz');
  assert.equal(env.MOOTR_TOKEN, token);
  assert.equal(env.MOOTR_KEEP, 'kept', 'a MOOTR_ name stam does not write is left alone');
});

// S-3406: the human's shell gets none of an agent's identity, under either spelling, the token included. A fake tmux
// records the env new-session is given, so the test reads what newShell passes and starts no server.
test('S-3406: newShell drops all six identity names from the shell env', () => {
  const six = ['STAM_AGENT_ID', 'MOOTR_AGENT_ID', 'STAM_AGENT_NAME', 'MOOTR_AGENT_NAME', 'STAM_TOKEN', 'MOOTR_TOKEN'];
  const dir = mkdtempSync(join(tmpdir(), 'stam-test-shell-'));
  const before = { ...process.env };
  try {
    const out = join(dir, 'env');
    writeFileSync(join(dir, 'tmux'), `#!/bin/sh\ncase "$*" in *new-session*) /usr/bin/env > '${out}';; esac\n`, { mode: 0o700 });
    for (const k of six) process.env[k] = `${k}-${token}`;
    process.env.KEEP_SHELL = 'kept';
    process.env.PATH = `${dir}:${before.PATH}`;
    tmux.newShell(dir);
    const names = readFileSync(out, 'utf8').split('\n').map((l) => l.slice(0, l.indexOf('=')));
    for (const k of six) assert.ok(!names.includes(k), `${k} reached the shell`);
    assert.ok(names.includes('KEEP_SHELL'), 'a name stam does not scrub is kept');
    assert.ok(!readFileSync(out, 'utf8').includes(token), 'no token value reached the shell');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k];
    Object.assign(process.env, before);
    rmSync(dir, { recursive: true, force: true });
  }
});

// S-3618: the server exits once its last session is killed, so a session started at once can reach one that is exiting.
test('S-3618: a session started right after the last one was killed starts a fresh server', () => {
  killTmuxServer(SOCKET);
  for (let i = 0; i < 20; i++) {
    const name = `last-${i}`;
    tmux.newSession(name, tmpdir(), { STAM_TOKEN: token }, ['sh', '-c', 'exec sleep 600']);
    assert.ok(tmux.hasSession(name), `session ${i} runs`);
    run('kill-session', '-t', `=${name}`);
  }
});

test('S-3618: retryExitingServer retries only the exiting server, and stops at its deadline', () => {
  const exiting = () => Object.assign(new Error('tmux start-server failed'), { stderr: 'server exited unexpectedly\n' });
  let tries = 0;
  tmux.retryExitingServer(() => {
    if (++tries < 3) throw exiting();
  });
  assert.equal(tries, 3);

  tries = 0;
  assert.throws(() => tmux.retryExitingServer(() => {
    tries++;
    throw Object.assign(new Error('no space left'), { stderr: 'no space left on device\n' });
  }), /no space left/);
  assert.equal(tries, 1);

  tries = 0;
  const start = Date.now();
  assert.throws(() => tmux.retryExitingServer(() => {
    tries++;
    throw exiting();
  }), /tmux start-server failed/);
  assert.ok(Date.now() - start >= 2000, 'retries until the deadline');
  assert.ok(tries > 1, 'retried more than once');
});
