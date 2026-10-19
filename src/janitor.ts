// Janitor: removes the leftovers of tests that are no longer running (CLAUDE.md rule 6).
// A test's throwaway daemons, tmux servers, and systemd units live under
// /tmp/stam-test.OWNER.XXXXXX (test/lib.sh); the folder's `owner` file names the agent that
// started it (or "user") and the test shell's pid. A leftover is swept only when that owner
// is gone: the test shell's pid is dead and no live process holds the owner agent's
// STAM_AGENT_ID, or the folder is older than three hours with the test shell gone. A test
// whose script is still running is never touched, unless its owner agent is no longer active
// (archived, forgotten, unknown): then its shell is stopped too (S-195). A user's run keeps its
// shell only while the run is younger than the age limit. Conservative by design: when unsure it
// keeps the folder and says why. It never looks at the live daemon, its `stam` tmux socket,
// or ~/.local/share/stam, and only ever removes paths under /tmp/stam-test.*.
import { lstat, readdir, readFile, rm, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { testTmpBase } from './config.ts';

const MAX_AGE_MS = 3 * 60 * 60 * 1000;
// A tmux or systemctl call that hasn't answered in this long is killed. A hung test tmux server
// (stopped, or busy) then costs the sweep this much, not the daemon's whole event loop (S-354).
const CALL_TIMEOUT_MS = 3000;
// The sweep yields to the event loop between these many /proc entries and between sockets.
const PROC_BATCH = 50;
// A test's tmux server older than this is a leak even when its owner is still around.
const TMUX_MAX_AGE_MS = 2 * 60 * 60 * 1000;
// A test folder younger than this is left alone by an unscoped sweep (the live daemon's, or a
// run without --only), along with its tmux servers: its test may be starting or still sweeping
// its own fixtures. A scoped sweep (--only) ignores it.
const FRESH_MS = 5 * 60 * 1000;
const LIVE_SOCKET = 'stam';
const UNIT_DIR = join(homedir(), '.config', 'systemd', 'user');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const yieldLoop = () => new Promise<void>((r) => setImmediate(r));
const exists = (p: string) => stat(p).then(
  () => true,
  () => false,
);

// A command run without blocking the loop. timedOut: it was killed for not answering in time.
interface Run {
  status: number | null;
  stdout: string;
  timedOut: boolean;
}
function run(file: string, args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8', timeout: CALL_TIMEOUT_MS, killSignal: 'SIGKILL' }, (err, stdout) => {
      const status = !err ? 0 : typeof err.code === 'number' ? err.code : null;
      resolve({ status, stdout: stdout ?? '', timedOut: Boolean(err?.killed) });
    });
  });
}
const tmux = (socket: string, args: string[]) => run('tmux', ['-L', socket, ...args]);
const systemctl = (...args: string[]) => run('systemctl', ['--user', ...args]);

// What a tmux server that didn't answer leaves in the result: its socket is skipped this round.
function tmuxSkipped(socket: string): Kept {
  const why = `tmux server did not answer in ${CALL_TIMEOUT_MS / 1000} s; skipped this round`;
  console.log(`janitor: ${socket}: ${why}`);
  return { path: socket, why };
}

export interface Action {
  kind: 'unit' | 'tmux' | 'daemon' | 'dir';
  target: string;
  dir: string;
  detail?: string;
}
export interface Kept {
  path: string;
  why: string;
}
export interface SweepResult {
  dirs: number;
  actions: Action[];
  kept: Kept[];
  dryRun: boolean;
}

interface Owner {
  agent?: string;
  pid?: number;
  started?: string;
}
interface Proc {
  pid: number;
  cmd: string;
  env: Record<string, string>;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// /tmp, or whatever TMPDIR points at; both, in case a test hard-coded /tmp. Also the test base
// folder (test/tmpdir.sh): STAM_TEST_TMPDIR, or ~/.cache/stam-test when /tmp is a tmpfs.
// Looked up once per sweep (testTmpBase runs stat), and passed down as `roots`.
function tmpRoots(): string[] {
  const roots = [tmpdir(), '/tmp'];
  const base = testTmpBase();
  if (base) roots.push(base);
  return [...new Set(roots)];
}

// The /tmp/stam-test.* folder a path sits under, if any.
function testDirOf(p: string, roots: string[]): string | undefined {
  for (const root of roots) {
    if (!p.startsWith(root + '/')) continue;
    const first = p.slice(root.length + 1).split('/')[0];
    if (/^stam-test\./.test(first)) return join(root, first);
  }
  return undefined;
}

// A real folder, not a symlink. The sweep reads and removes what it finds under the roots, and a
// `stam-test.*` symlink reaching a wider folder would take that folder's children, their test.env
// files, and their tmux servers with it (S-764). lstat doesn't follow one, so this has to guard
// discovery and use, not only a caller's preflight. A same-user process racing this check against
// the read it guards is out of scope.
async function realDir(p: string): Promise<boolean> {
  return Boolean((await lstat(p).catch(() => undefined))?.isDirectory());
}

// Whether a `--only` value names exactly one of the test folders this sweep removes: a
// `stam-test.*` folder directly under a root it scans (/tmp, TMPDIR, or the test base), which is
// there and is a real folder. A wider path (a root, the test base), an empty one, a path inside a
// test folder, a symlink, and a path that isn't there are not one folder: a sweep without the
// daemon's registry must stay inside concrete folders, or it reaches past one and skips the
// freshness rule (S-764). Returns the folder's absolute path, or undefined.
export async function testFolderScope(p: string): Promise<string | undefined> {
  if (!p.trim()) return undefined;
  const abs = resolve(p);
  if (testDirOf(abs, tmpRoots()) !== abs) return undefined;
  return (await realDir(abs)) ? abs : undefined;
}

async function testDirs(roots: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const root of roots) {
    const names = await readdir(root).catch((): string[] => []);
    for (const n of names) {
      if (!/^stam-test\./.test(n)) continue;
      const p = join(root, n);
      if (await realDir(p)) out.push(p);
    }
  }
  return out;
}

async function readOwner(dir: string): Promise<Owner | undefined> {
  const text = await readFile(join(dir, 'owner'), 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  const o: Owner = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i < 0) continue;
    const [k, v] = [line.slice(0, i), line.slice(i + 1)];
    if (k === 'agent') o.agent = v;
    else if (k === 'pid') o.pid = Number(v) || undefined;
    else if (k === 'started') o.started = v;
  }
  return o;
}

async function ageMs(dir: string, owner: Owner): Promise<number> {
  const t = owner.started ? Date.parse(owner.started) : NaN;
  if (!Number.isNaN(t)) return Date.now() - t;
  const st = await stat(dir).catch(() => undefined);
  return st ? Date.now() - st.mtimeMs : 0;
}

async function procs(): Promise<Proc[]> {
  const out: Proc[] = [];
  const names = await readdir('/proc').catch((): string[] => []);
  let seen = 0;
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    if (++seen % PROC_BATCH === 0) await yieldLoop();
    const pid = Number(n);
    const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => undefined);
    if (cmdline === undefined) continue;
    const env: Record<string, string> = {};
    const environ = await readFile(`/proc/${pid}/environ`, 'utf8').catch(() => '');
    for (const kv of environ.split('\0')) {
      const i = kv.indexOf('=');
      if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
    }
    out.push({ pid, cmd: cmdline.replace(/\0/g, ' ').trim(), env });
  }
  return out;
}

// A process's start time, to tell a live test shell from a pid that was reused.
async function bootMs(): Promise<number | undefined> {
  const text = await readFile('/proc/stat', 'utf8').catch(() => undefined);
  const m = text?.match(/^btime (\d+)$/m);
  return m ? Number(m[1]) * 1000 : undefined;
}
async function procStartMs(pid: number): Promise<number | undefined> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => undefined);
  if (stat === undefined) return undefined;
  // comm may hold spaces and parens; fields resume after the last ')'.
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ticks = Number(rest[19]); // field 22 (starttime) overall
  const boot = await bootMs();
  if (!boot || !Number.isFinite(ticks)) return undefined;
  return boot + ticks * 10; // USER_HZ is 100 on Linux
}

// The test shell named by the owner file, if it is still that process.
async function ownerShellAlive(owner: Owner): Promise<boolean> {
  if (!owner.pid || owner.pid <= 1 || !alive(owner.pid)) return false;
  const started = owner.started ? Date.parse(owner.started) : NaN;
  const procStart = await procStartMs(owner.pid);
  if (!Number.isNaN(started) && procStart !== undefined && procStart > started + 60_000) return false;
  return true;
}

function pidsUnder(dir: string, all: Proc[]): Proc[] {
  return all.filter((p) => p.pid !== process.pid && p.env.STAM_HOME && (p.env.STAM_HOME === dir || p.env.STAM_HOME.startsWith(dir + '/')));
}

async function subdirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((): Dirent[] => []);
  return entries.filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
}

// tmux sockets a test used: named in its daemons' test.env, or derived from the folder
// name (stam-test.OWNER.RAND -> stam-test-OWNER-RAND-NAME).
async function socketsFor(dir: string): Promise<string[]> {
  // Reached with a folder discovery found; a symlink swapped in since then would read its target's
  // children instead (S-764).
  if (!(await realDir(dir))) return [];
  const set = new Set<string>();
  for (const sub of await subdirs(dir)) {
    const text = await readFile(join(sub, 'test.env'), 'utf8').catch(() => undefined);
    if (text === undefined) continue;
    const m = text.match(/STAM_TMUX_SOCKET=('?)([^\s'"]+)\1/);
    if (m && m[2] !== LIVE_SOCKET) set.add(m[2]);
  }
  const m = basename(dir).match(/^stam-test\.(.+)\.([^.]+)$/);
  if (m) {
    const prefix = `stam-test-${m[1]}-${m[2]}-`;
    const sockDir = join(tmpdir(), `tmux-${process.getuid?.() ?? 0}`);
    for (const s of await readdir(sockDir).catch((): string[] => [])) if (s.startsWith(prefix) && s !== LIVE_SOCKET) set.add(s);
  }
  return [...set];
}

// stamd-test-* units and the test home each one runs.
async function testUnits(): Promise<{ name: string; path: string; home?: string }[]> {
  const names = await readdir(UNIT_DIR).catch((): string[] => []);
  const out: { name: string; path: string; home?: string }[] = [];
  for (const n of names) {
    if (!/^stamd-test-.*\.service$/.test(n)) continue;
    const path = join(UNIT_DIR, n);
    const text = await readFile(path, 'utf8').catch(() => undefined);
    const home = text?.match(/^Environment=STAM_HOME=(.+)$/m)?.[1]?.trim();
    out.push({ name: n.replace(/\.service$/, ''), path, home });
  }
  return out;
}

// Stops a test's systemd unit and removes it, only once systemd says it is inactive. False when
// the stop or the disable failed or timed out: the unit file stays, and so does its folder.
async function removeUnit(u: { name: string; path: string }): Promise<boolean> {
  const stop = await systemctl('stop', u.name);
  if (stop.timedOut || stop.status !== 0) return false;
  // is-active exits 3 and prints "inactive", "failed" or "unknown"; exit 4 is no such unit, printed
  // as "inactive" (systemd 259) or "unknown". Anything else (an error, a timeout, a status it doesn't
  // document) keeps the unit.
  const active = await systemctl('is-active', u.name);
  const state = active.stdout.trim();
  const inactive =
    !active.timedOut &&
    ((active.status === 3 && ['inactive', 'failed', 'unknown'].includes(state)) || (active.status === 4 && ['inactive', 'unknown'].includes(state)));
  if (!inactive) return false;
  const disable = await systemctl('disable', u.name);
  if (disable.timedOut || disable.status !== 0) return false;
  await systemctl('reset-failed', u.name);
  await rm(u.path, { force: true });
  return true;
}

async function stopPids(pids: number[]): Promise<void> {
  const sent: number[] = [];
  for (const pid of pids) {
    if (pid <= 1 || pid === process.pid) continue;
    try {
      process.kill(pid, 'SIGTERM');
      sent.push(pid);
    } catch {}
  }
  for (let i = 0; i < 30 && sent.some(alive); i++) await sleep(100);
  for (const pid of sent) {
    if (!alive(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

// Kills a tmux server by its socket, then the process groups of its panes: a Codex TUI or
// OpenCode server outlives the hangup. False when the server didn't answer: then nothing is
// killed and the socket waits for the next sweep.
async function stopTmux(socket: string): Promise<boolean> {
  const panes = await tmux(socket, ['list-panes', '-a', '-F', '#{pane_pid}']);
  if (panes.timedOut) return false;
  const killed = await tmux(socket, ['kill-server']);
  if (killed.timedOut) return false;
  for (const p of panes.stdout.split('\n').map(Number).filter((n) => n > 1)) {
    try {
      process.kill(-p, 'SIGTERM');
    } catch {}
  }
  await rm(join(tmpdir(), `tmux-${process.getuid?.() ?? 0}`, socket), { force: true });
  return true;
}

// A test's tmux socket, stam-test-OWNER-RAND-NAME: the owner is the agent id (or "user"), RAND
// the six characters of the folder's mktemp suffix. Undefined for anything else.
export function socketOwner(socket: string): { owner: string; rand: string } | undefined {
  const m = socket.match(/^stam-test-([^-]+)-([A-Za-z0-9]{6})-.+$/);
  return m ? { owner: m[1], rand: m[2] } : undefined;
}

// Whether a test's tmux server is a leak: never while its test shell runs; otherwise when its
// owner agent is no longer active, or the server is older than TMUX_MAX_AGE_MS.
export function leakedTmux(s: { ownerActive: boolean; ageMs: number; shellAlive: boolean }): boolean {
  if (s.shellAlive) return false;
  return !s.ownerActive || s.ageMs > TMUX_MAX_AGE_MS;
}

// The test tmux servers under the tmux socket directory, other than the live `stam` one.
async function testSockets(): Promise<string[]> {
  const names = await readdir(join(tmpdir(), `tmux-${process.getuid?.() ?? 0}`)).catch((): string[] => []);
  return names.filter((s) => s.startsWith('stam-test-') && s !== LIVE_SOCKET);
}

// One sweep of every test folder. With dryRun nothing is stopped or removed; `only`
// restricts it to these folders (and their daemons, tmux servers, and units).
// activeAgents / knownAgents: the registry's active ids and all ids (the daemon passes both). Without
// them an owner counts as active when a process runs with its STAM_AGENT_ID (the CLI, daemon down).
export async function sweep(opts: { dryRun?: boolean; only?: string[]; activeAgents?: Set<string>; knownAgents?: Set<string> } = {}): Promise<SweepResult> {
  const dryRun = Boolean(opts.dryRun);
  const only = (opts.only ?? []).filter(Boolean).map((p) => p.replace(/\/+$/, ''));
  const inScope = (dir: string) => !only.length || only.some((p) => dir === p || dir.startsWith(p + '/'));
  const result: SweepResult = { dirs: 0, actions: [], kept: [], dryRun };
  const roots = tmpRoots();
  const all = await procs();
  const dirs = (await testDirs(roots)).filter(inScope);
  result.dirs = dirs.length;
  const orphans: { dir: string; procs: Proc[] }[] = [];
  const activeAgent = (id: string) => (opts.activeAgents ? opts.activeAgents.has(id) : all.some((p) => p.env.STAM_AGENT_ID === id));
  // An owner this daemon's registry doesn't hold: a live agent of another daemon on this machine, or a
  // forgotten one. Its folders and servers are kept (the age limits still apply), not swept.
  const unknownOwner = (id: string) => Boolean(opts.knownAgents && !opts.knownAgents.has(id));

  for (const dir of dirs) {
    await yieldLoop();
    const owner = await readOwner(dir);
    if (!owner) {
      result.kept.push({ path: dir, why: 'no owner file' });
      continue;
    }
    const shellAlive = await ownerShellAlive(owner);
    if (shellAlive) {
      // The shell protects its folder while its owner is active or unknown here (see unknownOwner);
      // a user's run only while young.
      const protectedShell =
        owner.agent === 'user' ? (await ageMs(dir, owner)) <= MAX_AGE_MS : !owner.agent || unknownOwner(owner.agent) || activeAgent(owner.agent);
      if (protectedShell) {
        result.kept.push({ path: dir, why: `test shell ${owner.pid} is alive` });
        continue;
      }
    }
    const agentAlive = Boolean(owner.agent && owner.agent !== 'user' && all.some((p) => p.env.STAM_AGENT_ID === owner.agent));
    if (agentAlive && (await ageMs(dir, owner)) <= MAX_AGE_MS) {
      result.kept.push({ path: dir, why: `owner agent ${owner.agent} is alive` });
      continue;
    }
    if (!only.length && owner.agent && unknownOwner(owner.agent) && (await ageMs(dir, owner)) < FRESH_MS) {
      result.kept.push({ path: dir, why: `too new for an unscoped sweep (owner ${owner.agent} unknown, under five minutes old)` });
      continue;
    }
    const mine = pidsUnder(dir, all);
    if (shellAlive) mine.unshift({ pid: owner.pid!, cmd: 'test shell', env: {} });
    orphans.push({ dir, procs: mine });
  }

  const orphanDirs = new Set(orphans.map((o) => o.dir));

  // systemd units first: an enabled unit would restart a daemon the moment it is stopped. A unit
  // that won't stop keeps its folder, and the folder's daemons and servers are left to the next sweep.
  const units: { name: string; path: string; home: string; dir: string }[] = [];
  for (const u of await testUnits()) {
    if (!u.home) continue;
    const dir = testDirOf(u.home, roots);
    if (!dir || !inScope(dir)) continue;
    if (orphanDirs.has(dir) || !(await exists(dir))) units.push({ name: u.name, path: u.path, home: u.home, dir });
  }
  const keptUnitDirs = new Set<string>();
  let removedUnit = false;
  for (const u of units) {
    if (dryRun) {
      result.actions.push({ kind: 'unit', target: u.name, dir: u.dir, detail: u.home });
      continue;
    }
    if (await removeUnit(u)) {
      removedUnit = true;
      result.actions.push({ kind: 'unit', target: u.name, dir: u.dir, detail: u.home });
    } else {
      keptUnitDirs.add(u.dir);
      result.kept.push({ path: u.name, why: 'its systemd unit did not stop; kept for the next sweep' });
    }
  }
  if (removedUnit) await systemctl('daemon-reload');

  for (const { dir, procs: mine } of orphans) {
    if (keptUnitDirs.has(dir)) {
      result.kept.push({ path: dir, why: 'its systemd unit did not stop; kept for the next sweep' });
      continue;
    }
    // A socket whose server didn't answer keeps its folder: the next sweep finds it again there.
    let skipped = false;
    for (const socket of await socketsFor(dir)) {
      if (socket === LIVE_SOCKET) continue;
      await yieldLoop();
      if (dryRun) {
        result.actions.push({ kind: 'tmux', target: socket, dir });
        continue;
      }
      if (!(await stopTmux(socket))) {
        skipped = true;
        result.kept.push(tmuxSkipped(socket));
        continue;
      }
      result.actions.push({ kind: 'tmux', target: socket, dir });
    }
    for (const p of mine) result.actions.push({ kind: 'daemon', target: String(p.pid), dir, detail: p.cmd.slice(0, 80) });
    if (!dryRun) await stopPids(mine.map((p) => p.pid));
    if (skipped) {
      result.kept.push({ path: dir, why: 'a tmux server there did not answer; kept for the next sweep' });
      continue;
    }
    result.actions.push({ kind: 'dir', target: dir, dir });
    if (!dryRun && testDirOf(dir, roots) === dir) await rm(dir, { recursive: true, force: true });
  }

  // Test tmux servers no folder claims any more (the folder is gone, or its owner's test never
  // cleaned up): a leak when the owner is no longer active or the server is too old. Under
  // `only` the sweep is scoped to folders, so these are left alone.
  if (!only.length) {
    const handled = new Set((await Promise.all(orphans.map((o) => socketsFor(o.dir)))).flat());
    for (const socket of await testSockets()) {
      await yieldLoop();
      if (handled.has(socket)) continue;
      const id = socketOwner(socket);
      if (!id) continue;
      // The start time of the running server; no answer (no server) leaves nothing to sweep.
      const probe = await tmux(socket, ['display-message', '-p', '#{start_time}']);
      if (probe.timedOut) {
        result.kept.push(tmuxSkipped(socket));
        continue;
      }
      const secs = Number(probe.stdout.trim());
      if (probe.status !== 0 || !Number.isFinite(secs) || secs <= 0) continue;
      const started = secs * 1000;
      const dir = dirs.find((d) => basename(d) === `stam-test.${id.owner}.${id.rand}`);
      const owner = dir ? await readOwner(dir) : undefined;
      // A young folder of an owner this daemon doesn't know keeps its servers too: its test may
      // still be setting up (as for the folders above).
      if (!only.length && dir && owner && unknownOwner(id.owner) && (await ageMs(dir, owner)) < FRESH_MS) continue;
      const shellAlive = Boolean(owner && (await ownerShellAlive(owner)));
      const ownerActive = activeAgent(id.owner) || unknownOwner(id.owner);
      const serverAgeMs = Date.now() - started;
      if (!leakedTmux({ ownerActive, ageMs: serverAgeMs, shellAlive })) continue;
      const why = !ownerActive ? `owner ${id.owner} is not active` : `older than ${Math.round(TMUX_MAX_AGE_MS / 3600_000)} h`;
      if (dryRun) {
        result.actions.push({ kind: 'tmux', target: socket, dir: dir ?? '', detail: why });
        continue;
      }
      if (!(await stopTmux(socket))) {
        result.kept.push(tmuxSkipped(socket));
        continue;
      }
      result.actions.push({ kind: 'tmux', target: socket, dir: dir ?? '', detail: why });
    }
  }

  return result;
}
