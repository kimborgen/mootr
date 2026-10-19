import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';

// S-477: an agent's env, its token included, reaches its session without going on any tmux
// command line, where `ps` shows it: a tmux server keeps the argv of the client that started it.
const SOCKET = `stam-test-env-${process.pid}`;
process.env.STAM_TMUX_SOCKET = SOCKET;
const tmux = await import('../src/tmux.ts');
const run = (...args) => execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8' });
after(() => spawnSync('tmux', ['-L', SOCKET, 'kill-server']));

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

test('the session gets the env, and no command line holds the token', () => {
  // This call starts the server, so the server's argv is newSession's own.
  tmux.newSession('a', tmpdir(), { STAM_TOKEN: token, ODD: odd }, ['sh', '-c', 'printf "%s|%s" "$STAM_TOKEN" "$ODD" > /dev/null; exec sleep 600']);
  const lines = cmdlines();
  assert.ok(lines.some((c) => c.includes(SOCKET)), 'the tmux server runs');
  for (const c of lines) assert.ok(!c.includes(token), 'no command line holds the token');
  // The session's env, which the e2e tests read back, and the pane's.
  assert.equal(run('show-environment', '-t', 'a', 'STAM_TOKEN').trim(), `STAM_TOKEN=${token}`);
  const pid = run('display-message', '-p', '-t', '=a:', '#{pane_pid}').trim();
  const env = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
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
