// One daemon per STAM_HOME (S-346), as a script that calls runDaemon() meets it: not through `daemon run`, which the
// shell e2e (test/e2e-home-lock.sh) covers without caring which binary it starts. The incident was a script that called
// runDaemon() against a live home and booted a second daemon on its state. Here the caller is such a script:
//   1. the lock is held by another holder: runDaemon refuses, names the holder's pid, and exits before it creates the
//      database or starts a tmux server;
//   2. the holder is a runDaemon() daemon too: a second runDaemon() is refused beside it and the first keeps answering;
//      killed with SIGKILL, the holder leaves the home free for the next start.
// `node --test test/daemon-lock.test.mjs`; it starts a daemon on a throwaway home, so it is not in the LIGHT list.
import { test, after } from 'node:test';
import { killTmuxServer } from '../src/tmux-socket.ts';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmphome.mjs';
import { takeDaemonLock } from '../src/daemon-lock.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const children = new Set();
const sockets = new Set();
after(() => {
  for (const c of children) c.kill('SIGKILL');
  for (const s of sockets) killTmuxServer(s);
});

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// A throwaway test home with its own port and tmux socket, shaped as test/lib.sh's daemon_home makes one.
async function testHome(name) {
  const home = tempDir(`stam-lock-${name}-`);
  writeFileSync(join(home, '.stam-test-home'), '');
  writeFileSync(join(home, 'settings.json'), '{ "peers": [] }\n');
  writeFileSync(join(home, 'token'), `token-${name}\n`, { mode: 0o600 });
  writeFileSync(join(home, 'peer-token'), `peer-${name}\n`, { mode: 0o600 });
  mkdirSync(join(home, 'opencode-data'));
  writeFileSync(join(home, 'opencode.env'), `XDG_DATA_HOME=${join(home, 'opencode-data')}\n`, { mode: 0o600 });
  const port = await freePort();
  const socket = `stam-test-lock-${process.pid}-${name}`;
  sockets.add(socket);
  const env = {
    ...process.env,
    STAM_HOME: home,
    STAM_PORT: String(port),
    STAM_URL: `http://127.0.0.1:${port}`,
    STAM_TMUX_SOCKET: socket,
    STAM_MACHINE: name,
    STAM_BIND: '127.0.0.1',
    STAM_OPENCODE_PORT: String(await freePort()),
    STAM_AGENTS_SKILLS: join(home, 'agents-skills'),
    STAM_EMBEDDER: 'stub',
  };
  for (const k of ['STAM_AGENT_ID', 'STAM_TOKEN']) delete env[k];
  return { home, port, socket, env, token: `token-${name}` };
}

// The script of the incident: it imports the daemon and calls runDaemon() directly.
const wrapper = join(tempDir('stam-lock-wrapper-'), 'wrapper.mjs');
writeFileSync(wrapper, `const { runDaemon } = await import(${JSON.stringify(`${root}src/daemon.ts`)});\nawait runDaemon();\n`);

function run(h) {
  const child = spawn('node', ['--no-warnings', wrapper], { env: h.env, stdio: ['ignore', 'ignore', 'pipe'] });
  children.add(child);
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal, err })));
  return { child, exited };
}

const until = async (cond, what) => {
  for (let i = 0; i < 150; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.fail(`timed out waiting for ${what}`);
};
const answers = (h) => () => fetch(`${h.env.STAM_URL}/api/health`, { headers: { authorization: `Bearer ${h.token}` } }).then((r) => r.ok, () => false);
const noTmuxServer = (h) => spawnSync('tmux', ['-L', h.socket, 'list-sessions'], { stdio: 'ignore' }).status !== 0;

test('runDaemon beside another holder is refused before it touches the database or tmux', async () => {
  const h = await testHome('held');
  assert.equal(await takeDaemonLock(h.home), undefined, 'the test takes the lock');
  const second = run(h);
  const { code, err } = await second.exited;
  assert.notEqual(code, 0, 'a second runDaemon exited 0');
  assert.match(err, new RegExp(`another stam daemon \\(pid ${process.pid}\\)`));
  assert.ok(!existsSync(join(h.home, 'stam.db')), 'the refused start created the database');
  assert.ok(noTmuxServer(h), 'the refused start started a tmux server');
});

test('a second runDaemon beside a runDaemon holder is refused, and a SIGKILLed holder frees the home', async () => {
  const h = await testHome('wrapped');
  const first = run(h);
  await until(answers(h), 'the first daemon to answer');
  const second = run(h);
  const refused = await second.exited;
  assert.notEqual(refused.code, 0, 'a second runDaemon exited 0');
  assert.match(refused.err, new RegExp(`another stam daemon \\(pid ${first.child.pid}\\)`));
  assert.ok(await answers(h)(), 'the first daemon stopped answering');
  // SIGKILL: no exit handler runs, and the lock goes with the process.
  first.child.kill('SIGKILL');
  const killed = await first.exited;
  assert.equal(killed.signal, 'SIGKILL');
  assert.equal(await takeDaemonLock(h.home), undefined, 'the home is still locked after the holder died');
});
