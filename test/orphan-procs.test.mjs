#!/usr/bin/env node
// Unit tests for the orphaned test helper decision (S-907): pure function on fixture data, nothing
// is killed. `node --test test/orphan-procs.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { orphanSweepAllowed, liveRunDirs, orphanTestDaemons, orphanTestPids, withDescendants } from '../src/orphan-procs.ts';

const H = 3600;
const fake = { ppid: 1, ageS: 5 * H, cmd: 'node /tmp/review-x/test/mcp-registry-fake.mjs', cwd: '/tmp/review-x' };
const live = ['/home/user/.local/share/stam/worktrees/stam2-live'];

test('kills an old orphaned fake under no live dir', () => {
  assert.deepEqual(orphanTestPids([{ pid: 10, ...fake }], live), [10]);
});

test('kills decide-stub and a test tmux server too', () => {
  const procs = [
    { pid: 11, ppid: 1, ageS: 2 * H, cmd: 'node test/decide-stub.mjs /tmp/x', cwd: '/gone/wt' },
    { pid: 12, ppid: 1, ageS: 2 * H, cmd: 'tmux -L cost-fallback-test-123 new-session', cwd: '/gone/wt' },
    { pid: 13, ppid: 1, ageS: 2 * H, cmd: 'tmux -L compact-restart-test-9 start-server', cwd: '/gone/wt' },
  ];
  assert.deepEqual(orphanTestPids(procs, live), [11, 12, 13]);
});

test('keeps a live agent\'s fake', () => {
  const p = { pid: 20, ppid: 1, ageS: 5 * H, cmd: 'node test/mcp-registry-fake.mjs', cwd: live[0] + '/sub' };
  assert.deepEqual(orphanTestPids([p], live), []);
});

test('keeps a fake whose script path is under a live dir', () => {
  const p = { pid: 21, ppid: 1, ageS: 5 * H, cmd: `node ${live[0]}/test/mcp-registry-fake.mjs`, cwd: '/' };
  assert.deepEqual(orphanTestPids([p], live), []);
});

test('keeps a young process', () => {
  assert.deepEqual(orphanTestPids([{ pid: 30, ...fake, ageS: H - 1 }], live), []);
});

test('keeps a process whose parent is not 1', () => {
  assert.deepEqual(orphanTestPids([{ pid: 31, ...fake, ppid: 4242 }], live), []);
});

test('keeps a non-test process, and a tmux server on the live socket', () => {
  const procs = [
    { pid: 40, ppid: 1, ageS: 9 * H, cmd: 'node /tmp/review-x/server.mjs', cwd: '/tmp/review-x' },
    { pid: 41, ppid: 1, ageS: 9 * H, cmd: 'tmux -L stam start-server', cwd: '/tmp/review-x' },
    { pid: 42, ppid: 1, ageS: 9 * H, cmd: 'tmux -L my-cost-fallback-test-1 x', cwd: '/tmp/review-x' },
  ];
  assert.deepEqual(orphanTestPids(procs, live), []);
});

test('keeps a helper that cannot be placed', () => {
  const p = { pid: 50, ppid: 1, ageS: 9 * H, cmd: 'tmux -L cost-fallback-test-1 x' };
  assert.deepEqual(orphanTestPids([p], live), []);
});

test('kills an orphan reparented to a systemd subreaper', () => {
  assert.deepEqual(orphanTestPids([{ pid: 60, ...fake, ppid: 1445, reaper: true }], live), [60]);
  assert.deepEqual(orphanTestPids([{ pid: 61, ...fake, ppid: 1445 }], live), []);
});

test('a dir does not cover a sibling that shares its prefix', () => {
  const p = { pid: 70, ppid: 1, ageS: 5 * H, cmd: 'node test/mcp-registry-fake.mjs', cwd: '/x/wt-ab' };
  assert.deepEqual(orphanTestPids([p], ['/x/wt-a']), [70]);
  assert.deepEqual(orphanTestPids([{ ...p, cwd: '/x/wt-a/sub' }], ['/x/wt-a']), []);
});

test('the sweep is skipped for a test home and under --only', () => {
  assert.equal(orphanSweepAllowed(undefined, false), true);
  assert.equal(orphanSweepAllowed([], false), true);
  assert.equal(orphanSweepAllowed(['/tmp/stam-test.x.y'], false), false);
  assert.equal(orphanSweepAllowed(undefined, true), false);
});

// Leaked test daemons (S-1294).
const D = 'node src/cli.ts daemon run';
const T = '/home/user/.cache/stam-test/stam-test.adw8n.eYqyem';
const leak = (pid, o) => ({ pid, ppid: 1, ageS: 40 * H, cmd: D, ...o });

const R = ['/home/user/.cache/stam-test', '/tmp'];
const NOW = 1_800_000_000;
const owner = { pid: 900, startedS: NOW - 40 * H };
const dm = (pid, o) => leak(pid, { testHome: true, owner, ...o });

test('reaps the leaked twin, gate main and ui daemon shapes', () => {
  const procs = [
    dm(494768, { home: `${T}/twin`, cwd: '/home/user/projects/stam2' }),
    dm(754293, { home: `${T}/main`, cwd: '/home/user/.cache/stam-gate/pr-78/tree (deleted)', ppid: 77, reaper: true }),
    dm(1894652, { home: `${T}/ui`, cwd: '/home/user/.cache/stam-wt/usage-redesign (deleted)' }),
  ];
  assert.deepEqual(orphanTestDaemons(procs, [], undefined, R, NOW), [494768, 754293, 1894652]);
});

test('spares a daemon of a live run, a live parent (even with a deleted cwd), and a young one', () => {
  const procs = [
    dm(100, { home: `${T}/twin`, cwd: '/home/user/projects/stam2/sub' }),
    dm(101, { home: `${T}/twin`, cwd: '/x', ppid: 4242 }),
    dm(102, { home: `${T}/twin`, cwd: '/x/tree (deleted)', ppid: 4242 }),
    dm(103, { home: `${T}/twin`, cwd: '/x', ageS: H - 1 }),
    dm(104, { home: `${T}/twin`, cwd: '/gate/tree (deleted)' }),
  ];
  assert.deepEqual(orphanTestDaemons(procs, ['/home/user/projects/stam2', '/gate/tree'], undefined, R, NOW), []);
});

test('spares a non-test home, an unmarked one, the live home, and a stam-test.* path outside the test roots', () => {
  const procs = [
    dm(110, { home: '/home/user/.stam', cwd: '/x' }),
    leak(111, { home: `${T}/twin`, cwd: '/x' }),
    dm(112, { home: '/srv/stam-test.production/live', cwd: '/x' }),
    dm(113, { home: '/tmp/stam-test.x', cwd: '/x' }),
    leak(114, { cwd: '/x' }),
    { pid: 115, ppid: 1, ageS: 40 * H, cmd: 'node other.js', home: `${T}/twin`, testHome: true, cwd: '/x' },
  ];
  assert.deepEqual(orphanTestDaemons(procs, [], undefined, R, NOW), []);
});

test('a live owner shell spares the daemon with no recognized slot; a dead or reused owner does not', () => {
  const d = dm(120, { home: `${T}/twin`, cwd: '/x' });
  const live = { pid: 900, ppid: 1, ageS: 40 * H + 3, cmd: 'sh test/foo.sh' };
  assert.deepEqual(orphanTestDaemons([d, live], [], undefined, R, NOW), []);
  assert.deepEqual(orphanTestDaemons([d], [], undefined, R, NOW), [120]);
  assert.deepEqual(orphanTestDaemons([d, { ...live, ageS: 3 * H }], [], undefined, R, NOW), [120]);
  assert.deepEqual(orphanTestDaemons([{ ...d, owner: undefined }], [], undefined, R, NOW), []);
});

test('reaps the three legacy homes (no marker, no owner file) and spares a young, parented, slot-covered, non-test or marked-no-owner one', () => {
  const envOf = (a, b, m) => ({ tmuxSocket: `stam-test-${a}-${b}-${m}`, testTmpdir: '/home/user/.cache/stam-test', claudeBin: '/home/user/projects/stam2/test/fake-claude/claude' });
  const lg = (pid, o) => {
    const [, a, b, m] = (o.home ?? '').match(/stam-test\.([^./]+)\.([^./]+)\/([^/]+)$/) ?? [];
    return leak(pid, { legacy: true, ageS: 70 * H, env: envOf(a, b, m), ...o });
  };
  const procs = [
    lg(494768, { home: `${T}/twin`, cwd: '/home/user/projects/stam2' }),
    lg(754293, { home: `${T}/main`, cwd: '/home/user/.cache/stam-gate/pr-78/tree (deleted)' }),
    lg(1894652, { home: `${T}/ui`, cwd: '/home/user/.cache/stam-wt/usage-redesign (deleted)' }),
  ];
  assert.deepEqual(orphanTestDaemons(procs, [], undefined, R, NOW), [494768, 754293, 1894652]);
  const spared = [
    lg(130, { home: `${T}/twin`, cwd: '/x', ageS: 11 * H }),
    lg(131, { home: `${T}/twin`, cwd: '/x', ppid: 4242 }),
    lg(132, { home: `${T}/twin`, cwd: '/home/user/projects/stam2' }),
    lg(133, { home: '/srv/stam-test.production/live', cwd: '/x' }),
    leak(134, { home: `${T}/twin`, cwd: '/x', ageS: 70 * H }),
    lg(135, { home: `${T}/twin`, cwd: '/x', env: undefined }),
    lg(136, { home: `${T}/twin`, cwd: '/x', env: { ...envOf('adw8n', 'eYqyem', 'twin'), claudeBin: '/usr/bin/claude' } }),
    lg(137, { home: `${T}/twin`, cwd: '/x', env: { ...envOf('adw8n', 'eYqyem', 'twin'), tmuxSocket: 'stam' } }),
    lg(138, { home: `${T}/twin`, cwd: '/x', env: { ...envOf('adw8n', 'eYqyem', 'twin'), testTmpdir: '/tmp' } }),
    lg(139, { home: `${T}/../../x/stam-test.adw8n.eYqyem/twin`, cwd: '/x', env: { ...envOf('adw8n', 'eYqyem', 'twin'), testTmpdir: `${T}/../..` } }),
    lg(140, { home: `${T}/twin/extra`, cwd: '/x' }),
  ];
  assert.deepEqual(orphanTestDaemons(spared, ['/home/user/projects/stam2'], undefined, R, NOW), []);
});

test('liveRunDirs reads every stam-test-slots pool, gate pools included', async () => {
  const base = mkdtempSync(join(tmpdir(), 'slots-'));
  try {
    for (const d of ['stam-test-slots', 'stam-test-slots-gate', 'stam-test-slots-gate-browser', 'stam-test-slots-main', 'other']) {
      mkdirSync(join(base, d));
      writeFileSync(join(base, d, 'slot.0.owner'), `${process.pid} /run/${d} node x\n`);
    }
    writeFileSync(join(base, 'stam-test-slots-main', 'slot.1.owner'), '999999999 /stale x\n');
    assert.deepEqual((await liveRunDirs(base)).sort(), ['/run/stam-test-slots', '/run/stam-test-slots-gate', '/run/stam-test-slots-gate-browser', '/run/stam-test-slots-main']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('withDescendants lists children before their parent', () => {
  const procs = [{ pid: 5, ppid: 1 }, { pid: 6, ppid: 5 }, { pid: 7, ppid: 6 }, { pid: 8, ppid: 1 }];
  assert.deepEqual(withDescendants(procs, [5]), [7, 6, 5]);
});
