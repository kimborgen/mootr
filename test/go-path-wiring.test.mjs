#!/usr/bin/env node
// S-3666 wiring: the Go bin dir goes first on the shell PATH of the tmux session a harness starts in (spawn and resume,
// lifecycle.ts launchAt) and of the OpenCode server (opencode.ts startServer). Each test reads the PATH of the real pane.
// The pane's shell stands in for a user's zsh: a fake default shell adds a marker dir to PATH the way .zshenv does, so a
// launch that replaced PATH would lose it. The inherited PATH has the dirs a pane keeps today (~/.opencode/bin, the sbin dirs).
// A fake harness stands in for the agent, and a stub server for OpenCode's port. No daemon, no model, no network:
// `node --test test/go-path-wiring.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { basename, join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('go-path-wiring-');
const userHome = tempHome('go-path-wiring-user-');
const bin = join(userHome, '.local/go/bin');
const opencodeBin = join(userHome, '.opencode/bin');
const marker = join(home, 'startup-marker');
mkdirSync(bin, { recursive: true });
mkdirSync(opencodeBin, { recursive: true });
mkdirSync(marker, { recursive: true });
const socket = `go-path-wiring-test-${process.pid}`;
const port = 46000 + (process.pid % 10000);
const fakeOpenCode = join(home, 'fake-opencode');
writeFileSync(fakeOpenCode, '#!/bin/sh\nexec sleep 600\n');
chmodSync(fakeOpenCode, 0o755);
// The default shell: adds the marker dir to PATH, then runs the command it is given (tmux runs `$SHELL -c COMMAND`).
const shell = join(home, 'startup-shell');
writeFileSync(shell, `#!/bin/sh\nPATH="${marker}:$PATH"\nexport PATH\nexec /bin/sh "$@"\n`);
chmodSync(shell, 0o755);
// The PATH the daemon's tmux server starts with: the dirs a pane keeps today, none of them the Go bin dir.
const inherited = [opencodeBin, '/usr/local/sbin', '/usr/sbin', '/sbin', '/usr/bin', '/bin'].join(':');
process.env.PATH = inherited;
process.env.SHELL = shell;
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = socket;
process.env.STAM_EMBEDDER = 'stub';
process.env.STAM_MACHINE = 'test';
process.env.STAM_OPENCODE_PORT = String(port);
process.env.STAM_OPENCODE_BIN = fakeOpenCode;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [], stuckStartMinutes: 15 }));

let db, lifecycle, opencode;
// The stub stands in for OpenCode's HTTP API: any path answers, so the server counts as healthy once its session starts.
const stub = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{}');
});
before(async () => {
  db = await import('../src/db.ts');
  lifecycle = await import('../src/lifecycle.ts');
  const { adapters } = await import('../src/adapters/index.ts');
  opencode = (await import('../src/adapters/opencode.ts')).opencode;
  // The spec's env sets HOME, the agent's own; without it the session's HOME is the daemon's.
  adapters.fake = {
    pushPrompt: async () => true,
    launch: async () => ({ argv: ['sleep', '600'], env: { HOME: userHome } }),
    afterLaunch: async () => {},
    atPrompt: () => true,
  };
  await within(new Promise((r) => stub.listen(port, '127.0.0.1', r)), 'stub listen');
});
after(() => {
  stub.closeAllConnections();
  stub.close();
  spawnSync('tmux', ['-L', socket, 'kill-server']);
});

// A promise the test waits on, bounded: a stall fails with its label in ms instead of hanging the run.
function within(promise, label, ms = 20000) {
  let timer;
  const stalled = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: no result in ${ms} ms`)), ms);
  });
  return Promise.race([promise, stalled]).finally(() => clearTimeout(timer));
}

let n = 0;
function agent() {
  const id = db.newAgentId();
  const cwd = join(home, `work-${id}`);
  mkdirSync(cwd);
  db.createAgent({ id, name: `w${++n}`, role: '', machine: 'test', harness: 'fake', model: null, effort: null, cwd, parent_id: null, session_id: `sess-${id}` });
  db.updateAgent(id, { workspace: JSON.stringify({ spec: { kind: 'dir', path: cwd }, cwd }), lifecycle: 'active', activity: 'idle' });
  return db.getAgent(id);
}

// The pane's shell has children: the wrapper, then the harness, which is the deepest one. The harness's own environ is the one
// it starts with, so this reads that process once its executable is `exe` (the pane's shell still runs while it starts).
function parentOf(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
}
function childrenOf(pid) {
  return readdirSync('/proc')
    .filter((d) => /^\d+$/.test(d))
    .map(Number)
    .filter((p) => {
      try {
        return parentOf(p) === pid;
      } catch {
        return false;
      }
    });
}
function harnessEnv(session, exe) {
  for (let i = 0; i < 100; i++) {
    let pid = Number(execFileSync('tmux', ['-L', socket, 'display-message', '-p', '-t', `=${session}:`, '#{pane_pid}'], { encoding: 'utf8' }).trim());
    for (let kids = childrenOf(pid); kids.length; kids = childrenOf(pid)) pid = kids[0];
    if (basename(readlinkSync(`/proc/${pid}/exe`)) === exe) {
      return Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    }
    execFileSync('sleep', ['0.05']);
  }
  throw new Error(`no ${exe} under the ${session} pane`);
}

// The pane's PATH is the Go bin dir first, then what the shell and the inherited PATH give, every dir kept once.
function assertPanePath(path, label) {
  const dirs = path.split(':');
  assert.equal(dirs[0], bin, `${label}: the Go bin dir is first`);
  assert.equal(dirs.filter((d) => d === bin).length, 1, `${label}: the Go bin dir once`);
  assert.ok(dirs.includes(marker), `${label}: the dir the shell's startup adds stays`);
  for (const d of inherited.split(':')) assert.ok(dirs.includes(d), `${label}: the inherited ${d} stays`);
}

test('a spawn and a resume give the harness pane the Go bin dir first, keeping every other dir', async () => {
  const a = agent();
  const spawned = await lifecycle.startHarness(db.getAgent(a.id), 'hello', false);
  await within(spawned.launched, 'spawn launched');
  assertPanePath(harnessEnv(a.id, 'sleep').PATH, 'spawn');

  const resumed = await lifecycle.startHarness(db.getAgent(a.id), undefined, true);
  await within(resumed.launched, 'resume launched');
  assertPanePath(harnessEnv(a.id, 'sleep').PATH, 'resume');
});

test('the OpenCode server pane gets the Go bin dir first, keeping every other dir', async () => {
  const saved = process.env.HOME;
  process.env.HOME = userHome; // startServer's goBinDir takes the daemon's HOME
  try {
    await within(opencode.afterUpgrade(), 'opencode afterUpgrade');
    assertPanePath(harnessEnv('_opencode', 'sleep').PATH, 'opencode server');
  } finally {
    process.env.HOME = saved;
  }
});
