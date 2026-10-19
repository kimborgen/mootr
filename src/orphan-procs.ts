// Orphaned test helpers (S-907): a test's mcp-registry-fake, decide-stub, or private tmux server that
// outlived its run and was reparented to PID 1. Archive's sweep only covers the worktree it removes,
// so fakes started from a /tmp/review-* clone, or from a worktree already gone, linger for hours.
// The decision is a pure function (process list and live dirs in, PIDs out); the readers and the
// kill sit around it. Kills by PID only, never by pattern.
import { execFile } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, posix } from 'node:path';
import { readdir, readFile, readlink, stat } from 'node:fs/promises';
import { DEFAULT_STAM_HOME } from './config.ts';
import { procStart, stopProcesses } from './proctree.ts';
import { testHome } from './test-env.ts';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// A helper this young may belong to a test that is still running.
export const ORPHAN_MIN_AGE_S = 60 * 60;
// A legacy home has no owner file to prove its run is gone, so it must also be this old.
export const LEGACY_MIN_AGE_S = 12 * 60 * 60;

export interface ProcInfo {
  pid: number;
  ppid: number;
  // The parent is a same-user systemd: storage reparents orphans to the `systemd --user` subreaper, not PID 1.
  reaper?: boolean;
  ageS: number;
  cmd: string;
  cwd?: string;
  // STAM_HOME from the environment, read for a `daemon run` process only (orphanTestDaemons).
  home?: string;
  // STAM_HOME is a real test home (marker files, test-env.ts), checked where the process is read.
  testHome?: boolean;
  // The test shell that made the home, from its `owner` file (test/lib.sh): pid and the epoch seconds it started.
  owner?: { pid: number; startedS: number };
  // A home made before the marker and owner files existed: neither is there. Reaped on age alone (LEGACY_MIN_AGE_S).
  legacy?: boolean;
  // The test env a run gives its daemon (STAM_TMUX_SOCKET, STAM_TEST_TMPDIR, STAM_CLAUDE_BIN): positive provenance for a legacy home.
  env?: { tmuxSocket?: string; testTmpdir?: string; claudeBin?: string };
  // Start time from /proc, read with the process list, so a later signal can tell a reused pid.
  start?: string;
}

// The helpers a test starts: the two node fakes, and a tmux server on a test's private socket.
const HELPER = /(?:^|[\s/])(?:mcp-registry-fake|decide-stub)\.mjs(?:\s|$)|\btmux\s+-L\s+(?:cost-fallback-test|compact-restart-test|stam-test)-\S+/;

const under = (p: string, dir: string) => p === dir || p.startsWith(dir.replace(/\/+$/, '') + '/');

// Absolute paths named in a command line, to place a helper whose cwd isn't known.
const cmdPaths = (cmd: string) => cmd.split(/\s+/).filter((w) => w.startsWith('/'));

// The PIDs to kill: orphaned (parent 1, or a same-user systemd subreaper), a known test helper, older than the limit, and placed under
// no live agent's dir. A helper that can't be placed (no cwd, no path in its command) is kept.
export function orphanTestPids(procs: ProcInfo[], liveDirs: string[], minAgeS = ORPHAN_MIN_AGE_S): number[] {
  const out: number[] = [];
  for (const p of procs) {
    if ((p.ppid !== 1 && !p.reaper) || p.pid <= 1) continue;
    if (p.ageS < minAgeS) continue;
    if (!HELPER.test(p.cmd)) continue;
    const places = [...(p.cwd ? [p.cwd] : []), ...cmdPaths(p.cmd)];
    if (!places.length) continue;
    if (places.some((pl) => liveDirs.some((d) => d && under(pl, d)))) continue;
    out.push(p.pid);
  }
  return out;
}

// Whether this pid is a systemd run by the given uid (the `systemd --user` subreaper).
async function isUserSystemd(pid: number, uid: number | undefined): Promise<boolean> {
  const comm = (await readFile(`/proc/${pid}/comm`, 'utf8').catch(() => '')).trim();
  if (comm !== 'systemd') return false;
  return (await stat(`/proc/${pid}`).catch(() => undefined))?.uid === uid;
}

// The sweep looks at the whole host, so only the real daemon runs it, and not under `--only`.
export function orphanSweepAllowed(only: string[] | undefined, isTestHome: boolean): boolean {
  return !isTestHome && !(only && only.length);
}

// Every process with its parent, age in seconds, command, and cwd (undefined when unreadable).
export async function listProcs(): Promise<ProcInfo[]> {
  const { stdout } = await execFileP('ps', ['-eo', 'pid=,ppid=,etimes=,args='], { maxBuffer: 16 << 20 });
  const out: ProcInfo[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), ageS: Number(m[3]), cmd: m[4], start: procStart(Number(m[1])) });
  }
  // Only candidates need a cwd and a parent check; reading them for every process would be wasted work.
  const uid = process.getuid?.();
  const reapers = new Map<number, boolean>();
  for (const p of out) {
    if (!HELPER.test(p.cmd)) continue;
    if (p.ppid !== 1) {
      if (!reapers.has(p.ppid)) reapers.set(p.ppid, await isUserSystemd(p.ppid, uid));
      p.reaper = reapers.get(p.ppid);
    }
    p.cwd = await readlink(`/proc/${p.pid}/cwd`).catch(() => undefined);
  }
  for (const p of out) {
    if (!DAEMON.test(p.cmd)) continue;
    if (p.ppid !== 1) {
      if (!reapers.has(p.ppid)) reapers.set(p.ppid, await isUserSystemd(p.ppid, uid));
      p.reaper = reapers.get(p.ppid);
    }
    p.cwd = await readlink(`/proc/${p.pid}/cwd`).catch(() => undefined);
    const env = await readFile(`/proc/${p.pid}/environ`, 'utf8').catch(() => '');
    const get = (k: string) => env.split('\0').find((e) => e.startsWith(k + '='))?.slice(k.length + 1);
    p.home = get('STAM_HOME');
    p.env = { tmuxSocket: get('STAM_TMUX_SOCKET'), testTmpdir: get('STAM_TEST_TMPDIR'), claudeBin: get('STAM_CLAUDE_BIN') };
    p.testHome = Boolean(p.home) && testHome(p.home!);
    if (p.testHome) p.owner = await readOwner(p.home!);
    else if (p.home) p.legacy = await legacyHome(p.home);
  }
  return out;
}

export interface OrphanKill {
  pid: number;
  cmd: string;
  ageS: number;
}

// One pass: finds the orphans and, unless dryRun, sends each SIGTERM by PID. Returns what it picked.
export async function sweepOrphanProcs(liveDirs: string[], dryRun = false): Promise<OrphanKill[]> {
  const procs = await listProcs();
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const picked = orphanTestPids(procs, liveDirs).map((pid) => byPid.get(pid)!);
  if (!dryRun) {
    for (const p of picked) {
      try {
        process.kill(p.pid, 'SIGTERM');
      } catch {}
    }
  }
  return picked.map((p) => ({ pid: p.pid, cmd: p.cmd.slice(0, 120), ageS: p.ageS }));
}

// Leaked test daemons (S-1294): a `daemon run` on a test home (<tmpdir>/stam-test.*/…) whose run is gone.
// A killed run.sh or a deleted gate/worktree tree leaves its daemon behind; helpers are matched above, daemons here.
const DAEMON = /(?:^|[\s/])(?:stam|cli\.ts)\s+daemon\s+run(?:\s|$)/;
// The pid and start time in the owner file beside a test home (`pid=N`, `started=<date -Is>`), or undefined when unreadable.
async function readOwner(home: string): Promise<ProcInfo['owner']> {
  const txt = await readFile(`${dirname(home)}/owner`, 'utf8').catch(() => '');
  const pid = Number(txt.match(/^pid=(\d+)$/m)?.[1]);
  const startedS = Date.parse(txt.match(/^started=(.+)$/m)?.[1] ?? '') / 1000;
  return pid > 1 && Number.isFinite(startedS) ? { pid, startedS } : undefined;
}

// Neither the marker nor the owner file exists (ENOENT; an unreadable one is not legacy): a home from before test/lib.sh wrote them.
async function legacyHome(home: string): Promise<boolean> {
  const gone = (f: string) => stat(f).then(() => false, (e) => e?.code === 'ENOENT');
  return (await gone(`${home}/.stam-test-home`)) && (await gone(`${dirname(home)}/owner`));
}

// Positive provenance for a legacy home: the home is exactly ROOT/stam-test.A.B/MACHINE (no `..`, no extra parts), and the
// daemon's own env agrees: STAM_TEST_TMPDIR is ROOT, STAM_TMUX_SOCKET is stam-test-A-B-MACHINE, and STAM_CLAUDE_BIN, when set,
// is the test fake. A missing marker and owner file alone prove nothing.
export function legacyProvenance(p: ProcInfo, roots: string[]): boolean {
  const home = p.home;
  if (!home || !p.env || home.split('/').includes('..') || posix.normalize(home) !== home) return false;
  const m = home.match(/^(.+)\/stam-test\.([^./]+)\.([^./]+)\/([^/.][^/]*)$/);
  if (!m || !roots.includes(m[1]) || p.env.testTmpdir !== m[1]) return false;
  if (p.env.tmuxSocket !== `stam-test-${m[2]}-${m[3]}-${m[4]}`) return false;
  return !p.env.claudeBin || p.env.claudeBin.endsWith('test/fake-claude/claude');
}

const deleted = (cwd?: string) => Boolean(cwd?.endsWith(' (deleted)'));

// The folders a test's home can sit in: STAM_TEST_TMPDIR, the cache folder test/tmpdir.sh picks when /tmp is RAM, and /tmp.
export function testRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const cache = `${env.XDG_CACHE_HOME || `${homedir()}/.cache`}/stam-test`;
  return [env.STAM_TEST_TMPDIR, cache, '/tmp', tmpdir()].filter((d): d is string => Boolean(d)).map((d) => d.replace(/\/+$/, ''));
}

// A home is a test home when it sits in `stam-test.*/` directly under a test root, is a marked test home, and isn't the live one.
const inTestRoot = (home: string, roots: string[]) =>
  roots.some((r) => home.startsWith(r + '/stam-test.') && home.slice(r.length + 1).includes('/'));

// The daemons to stop: a stam daemon on a test home, older than the limit, whose run is gone. A run is alive while
// the daemon has a live parent or a live test-slot holder's dir covers its cwd; only without an owner does the cwd
// (deleted with its tree, or intact) count, and the daemon must have been reparented to PID 1 or the user systemd.
// The live daemon, any non-test home, and a home whose provenance is unknown are kept.
// A home whose owner shell still runs is kept, whatever the slot dir or cwd. A legacy home (no marker, no owner file),
// older than LEGACY_MIN_AGE_S, is judged on parentage and slot coverage alone.
// `liveRunDirs` are the cwds of live test-slot holders (liveRunDirs below).
export function orphanTestDaemons(procs: ProcInfo[], liveRunDirs: string[], minAgeS = ORPHAN_MIN_AGE_S, roots = testRoots(), nowS = Date.now() / 1000): number[] {
  const out: number[] = [];
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  for (const p of procs) {
    if (p.pid <= 1 || p.ageS < minAgeS || !DAEMON.test(p.cmd)) continue;
    if (!p.home || p.home === DEFAULT_STAM_HOME || !inTestRoot(p.home, roots)) continue;
    const legacy = !p.testHome && p.legacy && p.ageS >= LEGACY_MIN_AGE_S && legacyProvenance(p, roots);
    if (!p.testHome && !legacy) continue;
    if (p.ppid !== 1 && !p.reaper) continue;
    if (!p.cwd) continue;
    // `daemon start` detaches, so a live test's daemon has PPID 1 too: its test shell, named in the home's owner
    // file, keeps it. That process counts when it is not younger than the file says (a reused pid starts later).
    // A home with no readable owner is kept: fail closed.
    if (!legacy && !p.owner) continue;
    const o = p.owner && byPid.get(p.owner.pid);
    if (o && p.owner && o.ageS + 5 >= nowS - p.owner.startedS) continue;
    const cwd = deleted(p.cwd) ? p.cwd.slice(0, -' (deleted)'.length) : p.cwd;
    if (liveRunDirs.some((d) => d && under(cwd, d))) continue;
    out.push(p.pid);
  }
  return out;
}

// The pids of `roots` and everything under them, children first, so a stopped parent can't respawn them.
export function withDescendants(procs: ProcInfo[], roots: number[]): number[] {
  const kids = new Map<number, number[]>();
  for (const p of procs) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p.pid]);
  const out: number[] = [];
  const walk = (pid: number) => {
    for (const k of kids.get(pid) ?? []) if (k > 1) walk(k);
    out.push(pid);
  };
  roots.forEach(walk);
  return [...new Set(out)];
}

// The cwds of live test-slot holders: each slot.I.owner file in a slot dir names "pid cwd cmd". A holder whose pid is gone is stale.
// Every pool is read: /tmp/stam-test-slots, and the gate's -gate, -gate-browser and -main (scripts/gate.mjs).
export async function liveRunDirs(base = '/tmp'): Promise<string[]> {
  const out: string[] = [];
  const slotDirs = (await readdir(base).catch(() => [] as string[])).filter((n) => n.startsWith('stam-test-slots')).map((n) => `${base}/${n}`);
  for (const dir of slotDirs) {
    for (const f of (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.owner'))) {
      const m = (await readFile(`${dir}/${f}`, 'utf8').catch(() => '')).match(/^(\d+)\s+(\S+)/);
      if (m && (await stat(`/proc/${m[1]}`).catch(() => undefined))) out.push(m[2]);
    }
  }
  return out;
}

// One pass over the leaked test daemons: SIGTERM each with its process tree, SIGKILL after the grace. Returns what it picked.
export async function sweepOrphanDaemons(dryRun = false): Promise<OrphanKill[]> {
  const procs = await listProcs();
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const picked = orphanTestDaemons(procs, await liveRunDirs()).map((pid) => byPid.get(pid)!);
  if (!dryRun && picked.length) {
    const pids = new Map<number, string>();
    for (const pid of withDescendants(procs, picked.map((p) => p.pid))) {
      const start = byPid.get(pid)?.start;
      if (start) pids.set(pid, start);
    }
    stopProcesses(pids);
  }
  return picked.map((p) => ({ pid: p.pid, cmd: `${p.cmd.slice(0, 100)} [${p.home}]`, ageS: p.ageS }));
}
