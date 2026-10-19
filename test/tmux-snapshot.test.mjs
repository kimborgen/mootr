import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempDir } from './tmphome.mjs';

// S-345: tmux.snapshot() against a tmux server of its own, on a socket only this test uses.
const SOCKET = `stam-test-snapshot-${process.pid}`;
process.env.STAM_TMUX_SOCKET = SOCKET;
const tmux = await import('../src/tmux.ts');
const run = (...args) => execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8' });
const sessions = () => run('display-message', '-p', '#{server_sessions}').trim();
after(() => spawnSync('tmux', ['-L', SOCKET, 'kill-server']));

test('no server: no server and no sessions', () => {
  assert.deepEqual(tmux.snapshot(), { server: null, dead: new Map(), activity: new Map(), pane: new Map() });
});

test("a live and a dead pane, under the server serverId names", () => {
  run('new-session', '-d', '-s', 'live', 'sleep 600');
  run('set-option', '-g', 'remain-on-exit', 'on');
  run('new-session', '-d', '-s', 'gone', 'true');
  for (let i = 0; i < 1000 && run('list-panes', '-t', '=gone:', '-F', '#{pane_dead}').trim() !== '1'; i++);
  const s = tmux.snapshot();
  assert.equal(s.server, tmux.serverId());
  assert.deepEqual([...s.dead].sort(), [['gone', true], ['live', false]]);
  // When each window last had output, in whole seconds (S-349).
  assert.deepEqual([...s.activity.keys()].sort(), ['gone', 'live']);
  for (const t of s.activity.values()) assert.ok(Number.isInteger(t) && Math.abs(t - Date.now() / 1000) < 3600, `activity ${t}`);
  assert.equal(s.pane.get('live'), run('display-message', '-p', '-t', '=live:', '#{pane_id}').trim());
});

test('a pane belongs to its session until the session is replaced, and the front pane follows the window', () => {
  run('new-session', '-d', '-s', 'swap', 'sleep 600');
  const old = tmux.snapshot().pane.get('swap');
  assert.equal(tmux.paneOwner(old), `${tmux.serverId()}\tswap`);
  run('new-window', '-t', '=swap:', 'sleep 600');
  assert.notEqual(tmux.snapshot().pane.get('swap'), old);
  run('kill-session', '-t', '=swap');
  run('new-session', '-d', '-s', 'swap', 'sleep 600');
  assert.equal(tmux.paneOwner(old), null);
  assert.notEqual(tmux.snapshot().pane.get('swap'), old);
  run('kill-session', '-t', '=swap');
});

test('a server that outlives its last session (tmux 3.6 answers "no current target")', () => {
  run('set-option', '-g', 'exit-empty', 'off');
  run('kill-session', '-t', '=live');
  run('kill-session', '-t', '=gone');
  assert.equal(sessions(), '0');
  const s = tmux.snapshot();
  assert.equal(s.server, tmux.serverId());
  assert.equal(s.dead.size, 0);
});

// A tmux on PATH that answers list-panes with `code` and `stderr` (or nothing), and display-message with `id`.
function withTmux({ code = 0, stderr = '', id = '' }, fn) {
  const dir = tempDir('stam-snapshot-');
  const script = `#!/bin/sh\ncase "$*" in *display-message*) printf '%s\\n' '${id}'; exit 0 ;; esac\nprintf '%s\\n' '${stderr}' >&2\nexit ${code}\n`;
  writeFileSync(join(dir, 'tmux'), script);
  chmodSync(join(dir, 'tmux'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  try {
    return fn();
  } finally {
    process.env.PATH = path;
    rmSync(dir, { recursive: true });
  }
}

test('a call that fails without saying the server is gone tells nothing', () => {
  assert.equal(withTmux({ code: 1, stderr: 'lost server reply' }, tmux.snapshot), null);
});

test('tmux saying no server runs means no server', () => {
  assert.deepEqual(withTmux({ code: 1, stderr: `no server running on /tmp/tmux-1/${SOCKET}` }, tmux.snapshot), { server: null, dead: new Map(), activity: new Map(), pane: new Map() });
});

test('no panes is believed only from a server that says it has no sessions', () => {
  assert.equal(withTmux({ id: '41 1700000000\t3' }, tmux.snapshot), null);
  assert.equal(withTmux({ id: 'garbled\t0' }, tmux.snapshot), null);
  assert.deepEqual(withTmux({ id: '41 1700000000\t0' }, tmux.snapshot), { server: '41 1700000000', dead: new Map(), activity: new Map(), pane: new Map() });
  assert.deepEqual(withTmux({ code: 1, stderr: 'no current target', id: '41 1700000000\t0' }, tmux.snapshot), { server: '41 1700000000', dead: new Map(), activity: new Map(), pane: new Map() });
});
