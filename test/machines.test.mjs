#!/usr/bin/env node
// Unit tests for the machine sampler (src/machines.ts): the /proc parsing, the CPU
// percentage between two reads, and the one-minute rolling average the sidebar's meters
// show. Fixed fixtures, no daemon, no network: `node --test test/machines.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-machines-');
process.env.STAM_HOME = home;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let m;
before(async () => { m = await import('../src/machines.ts'); });
after(() => rmSync(home, { recursive: true, force: true }));

const STAT = [
  'cpu  100 0 50 800 50 0 0 0 0 0',
  'cpu0 50 0 25 400 25 0 0 0 0 0',
  'cpu1 50 0 25 400 25 0 0 0 0 0',
  'intr 0',
].join('\n');
const MEMINFO = ['MemTotal:       16000000 kB', 'MemAvailable:    4000000 kB', 'SwapTotal:       2000000 kB', 'SwapFree:        1500000 kB', 'Buffers: 0 kB'].join('\n');

test('parseStat reads the total and each core, busy excluding idle and iowait', () => {
  const s = m.parseStat(STAT);
  assert.deepEqual(s.total, { busy: 150, total: 1000 });
  assert.deepEqual(s.cores, [{ busy: 75, total: 500 }, { busy: 75, total: 500 }]);
});

test('cpuPct is the share of the jiffies between two reads that were busy', () => {
  assert.equal(m.cpuPct({ busy: 1200, total: 2000 }, { busy: 1000, total: 1500 }), 40);
  // No time passed (or a counter went backwards): no load, never a divide by zero.
  assert.equal(m.cpuPct({ busy: 5, total: 5 }, { busy: 5, total: 5 }), 0);
  // Clamped to 0-100.
  assert.equal(m.cpuPct({ busy: 9999, total: 10000 }, { busy: 0, total: 1 }), 100);
});

test('parseMeminfo and parseLoadavg read the values the meters need', () => {
  assert.deepEqual(m.parseMeminfo(MEMINFO), { memTotalKb: 16000000, memAvailableKb: 4000000, swapTotalKb: 2000000, swapFreeKb: 1500000 });
  assert.deepEqual(m.parseLoadavg('1.24 0.98 0.75 1/200 12345'), [1.24, 0.98, 0.75]);
});

test('summarize averages the last minute and keeps the latest raw values', () => {
  const now = 1_000_000;
  const samples = [
    { ts: now - 30_000, cpuPct: 10, cores: [10, 20], ramPct: 50, swapPct: 0, ramUsed: 8e9, ramTotal: 16e9, swapUsed: 0, swapTotal: 2e9, load: [1, 1, 1] },
    { ts: now - 10_000, cpuPct: 30, cores: [30, 40], ramPct: 60, swapPct: 10, ramUsed: 9e9, ramTotal: 16e9, swapUsed: 2e8, swapTotal: 2e9, load: [1.5, 1.2, 1] },
    // Older than the window: it must not drag the average down.
    { ts: now - 120_000, cpuPct: 99, cores: [99, 99], ramPct: 99, swapPct: 99, ramUsed: 1, ramTotal: 1, swapUsed: 1, swapTotal: 1, load: [9, 9, 9] },
  ];
  const r = m.summarize(samples, 'box', now);
  assert.equal(r.online, true);
  assert.equal(r.cpu.pct, 20);
  assert.deepEqual(r.cpu.cores, [20, 30]);
  assert.equal(r.cpu.count, 2);
  assert.equal(r.ram.pct, 55);
  assert.equal(r.ram.used, 9e9);
  assert.equal(r.ram.total, 16e9);
  assert.equal(r.swap.pct, 5);
  assert.deepEqual(r.load, [1.5, 1.2, 1]);
  assert.equal(r.ts, now - 10_000);
});

test('summarize falls back to the newest sample when the whole buffer is stale', () => {
  const now = 1_000_000;
  const r = m.summarize([{ ts: now - 120_000, cpuPct: 42, cores: [42], ramPct: 10, swapPct: 0, ramUsed: 1, ramTotal: 2, swapUsed: 0, swapTotal: 0, load: [0, 0, 0] }], 'box', now);
  assert.equal(r.cpu.pct, 42);
  assert.equal(m.summarize([], 'box', now).online, false);
});

test('countAgents sorts active agents by activity and counts paused ones, leaving out shut-down and archived', () => {
  const agents = [
    { lifecycle: 'active', activity: 'working' },
    { lifecycle: 'active', activity: 'starting' },
    { lifecycle: 'active', activity: 'waiting' },
    { lifecycle: 'active', activity: 'blocked' },
    { lifecycle: 'active', activity: 'idle' },
    { lifecycle: 'active', activity: 'errored' },
    { lifecycle: 'paused', activity: 'idle' },
    { lifecycle: 'paused', activity: 'working' },
    { lifecycle: 'shut_down', activity: 'working' },
    { lifecycle: 'archived', activity: 'idle' },
  ];
  assert.deepEqual(m.countAgents(agents), { working: 2, waiting: 2, idle: 2, paused: 2 });
  assert.deepEqual(m.countAgents([]), { working: 0, waiting: 0, idle: 0, paused: 0 });
});

test('compact keeps the one-minute averages, GB, and counts, and no per-core arrays', () => {
  const now = 1_000_000;
  const r = m.summarize(
    [{ ts: now, cpuPct: 12.34, cores: [10, 20], ramPct: 50, swapPct: 5, ramUsed: 8 * 2 ** 30, ramTotal: 16 * 2 ** 30, swapUsed: 0, swapTotal: 2 ** 30, load: [1.25, 1, 1] }],
    'box',
    now,
  );
  r.agents = { working: 1, waiting: 0, idle: 2, paused: 0 };
  assert.deepEqual(m.compact(r), {
    name: 'box',
    online: true,
    cores: 2,
    cpu_pct: 12.3,
    ram_pct: 50,
    ram_used_gb: 8,
    ram_total_gb: 16,
    swap_pct: 5,
    load_1m: 1.25,
    agents: { working: 1, waiting: 0, idle: 2, paused: 0 },
  });
  assert.deepEqual(m.compact(m.offline('gone', now)).agents, { working: 0, waiting: 0, idle: 0, paused: 0 });
  assert.equal(m.compact(m.offline('gone', now)).load_1m, null);
});

test('compact gives a peer on an older release null agents, not a missing key', () => {
  const old = { name: 'old', online: true, ts: 1, cpu: { pct: 1, cores: [], count: 1 }, ram: { pct: 1, used: 0, total: 0 }, swap: { pct: 0, used: 0, total: 0 }, load: [0.5, 0, 0] };
  const c = m.compact(old);
  assert.equal(c.agents, null);
  assert.ok('agents' in c);
  assert.equal(c.load_1m, 0.5);
});

test('offline carries no meters', () => {
  const r = m.offline('storage', 5);
  assert.equal(r.online, false);
  assert.equal(r.cpu.pct, 0);
  assert.deepEqual(r.cpu.cores, []);
  assert.deepEqual(r.load, []);
});

test('a real read of /proc/stat and /proc/meminfo gives this machine a reading', () => {
  const s = m.parseStat(readFileSync('/proc/stat', 'utf8'));
  assert.equal(s.cores.length, cpus().length);
  const snap = m.snapshot();
  assert.equal(snap.online, true);
  assert.equal(snap.cpu.count, cpus().length);
  assert.ok(snap.cpu.pct >= 0 && snap.cpu.pct <= 100);
  assert.ok(snap.ram.total > 0 && snap.ram.used >= 0);
  assert.equal(snap.load.length, 3);
});

// Resource warnings: the lines, one mail per crossing, repeats each interval while across,
// and a recovery that lets the next crossing mail at once.
const CFG = { enabled: true, loadPerCore: 2, ramAvailableGb: 2, swapPct: 80, repeatMinutes: 30, recipients: [] };
const GB = 2 ** 30;
const sample = (over = {}) => ({
  ts: 0, cpuPct: 0, cores: [10, 10], ramPct: 10, swapPct: 0, diskPct: 50,
  ramUsed: 4 * GB, ramTotal: 16 * GB, swapUsed: 0, swapTotal: 2 * GB, load: [0.5, 0.5, 0.5], ...over,
});
const MIN = 60_000;

test('overLines flags only the kinds across their lines', () => {
  assert.deepEqual(m.overLines(sample(), CFG), {});
  // Load 5 on 2 cores is 2.5 per core, over the line of 2.
  assert.deepEqual(Object.keys(m.overLines(sample({ load: [5, 5, 5] }), CFG)), ['cpu']);
  // 1 GB free is under 2 GB; swap at 90% is over 80%.
  const low = m.overLines(sample({ ramUsed: 15 * GB, swapUsed: 1.8 * GB, swapPct: 90 }), CFG);
  assert.deepEqual(Object.keys(low).sort(), ['ram', 'swap']);
  // Exactly on a line is not across it.
  assert.deepEqual(m.overLines(sample({ load: [4, 4, 4], swapPct: 80 }), CFG), {});
});

test('warnResources mails on crossing, then stays quiet for the repeat interval even through a recovery', () => {
  const mails = [];
  const send = (subject) => mails.push(subject);
  const t0 = 10_000_000;
  const hot = sample({ load: [5, 5, 5] });
  const cool = sample();
  // Crossing mails once.
  assert.deepEqual(m.warnResources(hot, CFG, send, t0), ['cpu']);
  // Still across before the repeat interval: nothing.
  assert.deepEqual(m.warnResources(hot, CFG, send, t0 + 5 * MIN), []);
  // Flapping: recovers and crosses again inside the interval, so it stays quiet.
  assert.deepEqual(m.warnResources(cool, CFG, send, t0 + 6 * MIN), []);
  assert.deepEqual(m.warnResources(hot, CFG, send, t0 + 7 * MIN), []);
  assert.deepEqual(m.warnResources(cool, CFG, send, t0 + 8 * MIN), []);
  assert.deepEqual(m.warnResources(hot, CFG, send, t0 + 9 * MIN), []);
  assert.equal(mails.length, 1);
  // Still across after the interval since the last mail: mails again.
  assert.deepEqual(m.warnResources(hot, CFG, send, t0 + 30 * MIN), ['cpu']);
  assert.equal(mails.length, 2);
  assert.match(mails[0], /Resource warning on .*: CPU load/);
  // Disabled: nothing, whatever the reading.
  assert.deepEqual(m.warnResources(hot, { ...CFG, enabled: false }, send, t0 + 90 * MIN), []);
  assert.equal(mails.length, 2);
});

test('diskPct is df\'s used share, and tick reads the root filesystem through the injected statfs', () => {
  // 80 of 100 blocks used, 15 still free to users: 80 / (80 + 15).
  assert.ok(Math.abs(m.diskPct({ blocks: 100, bfree: 20, bavail: 15 }) - 80 / 95 * 100) < 1e-9);
  assert.equal(m.diskPct({ blocks: 0, bfree: 0, bavail: 0 }), 0);
  const seen = [];
  const s = m.tick(1_000, (p) => (seen.push(p), { blocks: 100, bfree: 20, bavail: 15 }));
  assert.deepEqual(seen, ['/']);
  assert.ok(Math.abs(s.diskPct - 80 / 95 * 100) < 1e-9);
  // A root filesystem that can't be read has no reading (null), never a warning.
  assert.equal(m.tick(2_000, () => { throw new Error('EACCES'); }).diskPct, null);
});

test('warnResources mails the root disk once per crossing: re-armed only below 80%', () => {
  const mails = [];
  const send = (subject) => mails.push(subject);
  const t0 = 80_000_000;
  const disk = (diskPct) => sample({ diskPct });
  // Under the line: nothing.
  assert.deepEqual(m.warnResources(disk(84), CFG, send, t0), []);
  // Crossing 85% mails once.
  assert.deepEqual(m.warnResources(disk(86), CFG, send, t0 + MIN), ['disk']);
  // Staying above, or dipping to 82% (above the re-arm line), does not mail again.
  assert.deepEqual(m.warnResources(disk(90), CFG, send, t0 + 2 * MIN), []);
  assert.deepEqual(m.warnResources(disk(82), CFG, send, t0 + 3 * MIN), []);
  assert.deepEqual(m.warnResources(disk(86), CFG, send, t0 + 4 * MIN), []);
  assert.equal(mails.length, 1);
  assert.match(mails[0], /Resource warning on .*: disk/);
  // Dropping below 80% re-arms, so the next crossing mails, even inside the repeat interval.
  assert.deepEqual(m.warnResources(disk(79), CFG, send, t0 + 5 * MIN), []);
  assert.deepEqual(m.warnResources(disk(87), CFG, send, t0 + 6 * MIN), ['disk']);
  assert.equal(mails.length, 2);
});

test('warnResources: a failed statfs read neither mails nor re-arms the disk warning', () => {
  const mails = [];
  const send = (subject) => mails.push(subject);
  const t0 = 90_000_000;
  const disk = (diskPct) => sample({ diskPct });
  // Settings persist between tests: start from an armed disk.
  m.warnResources(disk(79), CFG, send, t0 - MIN);
  assert.deepEqual(m.warnResources(disk(86), CFG, send, t0), ['disk']);
  // One failed read in between, then 86% again: still one mail.
  assert.deepEqual(m.warnResources(disk(null), CFG, send, t0 + MIN), []);
  assert.deepEqual(m.warnResources(disk(86), CFG, send, t0 + 2 * MIN), []);
  assert.equal(mails.length, 1);
});

test('warnResources judges CPU on the 5-minute load, so a 1-minute spike sends nothing', () => {
  const mails = [];
  const send = (subject) => mails.push(subject);
  const t0 = 50_000_000;
  // 1-minute load 9 on 2 cores (a deploy spike), 5-minute load 1: under the line of 2 per core.
  assert.deepEqual(m.warnResources(sample({ load: [9, 1, 1] }), CFG, send, t0), []);
  assert.deepEqual(m.overLines(sample({ load: [9, 1, 1] }), CFG), {});
  assert.equal(mails.length, 0);
  // The 5-minute load over the line does mail.
  assert.deepEqual(m.warnResources(sample({ load: [1, 5, 1] }), CFG, send, t0 + MIN), ['cpu']);
  assert.equal(mails.length, 1);
});

test('warnResources keeps the repeat across a restart, since the last mail is in settings', async () => {
  const mails = [];
  const send = (subject) => mails.push(subject);
  // Last, so the settings it leaves behind (its mail time) can't hold back the tests above.
  const t0 = 100_000_000;
  assert.deepEqual(m.warnResources(sample({ load: [5, 5, 5] }), CFG, send, t0), ['cpu']);
  // A fresh module, as after a daemon restart: no in-memory state, so only the settings say it mailed.
  const fresh = await import(`../src/machines.ts?restart=${t0}`);
  assert.deepEqual(fresh.warnResources(sample({ load: [5, 5, 5] }), CFG, send, t0 + 5 * MIN), []);
  assert.equal(mails.length, 1);
  assert.deepEqual(fresh.warnResources(sample({ load: [5, 5, 5] }), CFG, send, t0 + 30 * MIN), ['cpu']);
  assert.equal(mails.length, 2);
});
