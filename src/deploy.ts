// Releases: the live system (daemon, the MCP shim agents launch, hooks, and web files) runs
// from STAM_HOME/releases/current, never from a checkout, so a broken merge can't take it
// down. `stam deploy` builds a committed ref into releases/SHA, checks it on a scratch
// daemon, switches `current`, restarts the service, and switches back if the restarted
// daemon doesn't answer.
import { spawn, spawnSync, type ChildProcess, type SpawnSyncOptions } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync, closeSync } from 'node:fs';
import { createServer } from 'node:net';
import os, { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { RELEASES, ROOT, STAM_HOME } from './config.ts';
import { lockHolder, tryLock } from './release-lock.ts';
import { api } from './client.ts';
import { migrateUnit } from './unit.ts';
import { defaultService } from './default-home.ts';
import { checkRoot, sweepCheckHomes, writeOwner } from '../scripts/check-homes.mjs';
import { GONE, NODEPS, linkLocked, linkLockedAsync, tryExclusive } from '../scripts/deps-lock.mjs';
import { envVar, entryValue, withTwins } from './env.ts';
import { killTmuxServer } from './tmux-socket.ts';

// The service name (S-2890, src/default-home.ts defaultService): a regular stamd.service wins first, then mootrd.service, else stamd. mootrd carries Alias=stamd.service.
const UNIT_DIR = join(homedir(), '.config', 'systemd', 'user');
// A unit dir that can't be inspected (EACCES) doesn't crash the import: SERVICE falls back to stamd for display, and
// checkService() throws the error where the service is used, so nothing acts on a guessed name.
let serviceError: Error | undefined;
export const SERVICE = envVar('SERVICE') ?? (() => {
  try {
    return defaultService(UNIT_DIR);
  } catch (e) {
    serviceError = e instanceof Error ? e : new Error(String(e));
    return 'stamd';
  }
})();
export function checkService(): void {
  if (serviceError) throw serviceError;
}
export const UNIT = join(UNIT_DIR, `${SERVICE}.service`);
export const systemctl = (...args: string[]) => spawnSync('systemctl', ['--user', ...args], { stdio: 'inherit' }).status === 0;

const KEEP = 5;
// Pinned releases beyond the ones prune keeps before it asks idle agents to let go (S-756).
const MAX_SPARE_PINS = 3;
// Compile-cache entries older than a day go with the releases that made them (S-756).
const CACHE_MAX_AGE = 24 * 60 * 60 * 1000;
// Node's compile cache, on tmpfs, so it costs RAM: NODE_COMPILE_CACHE names one, else its default.
const CACHE_DIR = process.env.NODE_COMPILE_CACHE ?? join(tmpdir(), 'node-compile-cache');
const DEPS = join(STAM_HOME, 'deps');
// A warmed deps key a worktree linked within this window survives a prune, even when no release
// names it: a worktree on main may not be deployed yet (S-1044).
const DEPS_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One health request may take this long: a saturated event loop answers late, not never.
const HEALTH_TIMEOUT_MS = 5000;

// Polls the live daemon until it answers, and, given a release, until that release answers.
export async function waitHealthy(release?: string, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await sleep(250);
    try {
      const h = await api('GET', '/api/health', undefined, HEALTH_TIMEOUT_MS);
      if (release === undefined || h.release === release) return true;
    } catch {}
  }
  return false;
}

// How long a restarted daemon may take to answer: 20 s, plus 10 s for each whole point of
// 1-minute load above the CPU count, capped at 90 s. A saturated machine starts slowly, and the
// deadline should not turn that into a rollback.
export function healthDeadline(load1: number, cpus: number): number {
  const over = Math.max(0, Math.floor(load1 - cpus));
  return Math.min(90_000, 20_000 + over * 10_000);
}

// What `awaitRestart` reads from the machine, injectable so the wait is testable.
export type RestartDeps = {
  answers(release: string, timeoutMs: number): Promise<boolean>;
  unit(): { pid: number; state: string };
  load(): { load1: number; cpus: number };
  now(): number;
  sleep(ms: number): Promise<unknown>;
};

const unitState = (): { pid: number; state: string } => {
  checkService();
  const out = spawnSync('systemctl', ['--user', 'show', SERVICE, '--property=MainPID', '--property=ActiveState'], { encoding: 'utf8', timeout: 5000 }).stdout ?? '';
  const get = (key: string) => out.split('\n').find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1) ?? '';
  return { pid: Number(get('MainPID')) || 0, state: get('ActiveState') };
};

const liveRestartDeps: RestartDeps = {
  answers: async (release, timeoutMs) => {
    try {
      return (await api('GET', '/api/health', undefined, timeoutMs)).release === release;
    } catch {
      return false;
    }
  },
  unit: unitState,
  load: () => ({ load1: os.loadavg()[0], cpus: os.availableParallelism() }),
  now: Date.now,
  sleep,
};

// Waits for the restarted service to answer as `release`. It gives up at once, rather than at the
// deadline, when the unit stops being active or its main process changes: that is a crash, or
// systemd restarting a failed daemon, and waiting only delays the rollback. `pid` is the main
// process right after our restart.
export async function awaitRestart(release: string, pid: number, deps: RestartDeps = liveRestartDeps): Promise<'answering' | 'crashed' | 'timeout'> {
  const { load1, cpus } = deps.load();
  const ms = healthDeadline(load1, cpus);
  console.log(`waiting up to ${ms / 1000} s for ${release} (load ${load1.toFixed(1)} on ${cpus} CPUs)`);
  const deadline = deps.now() + ms;
  while (deps.now() < deadline) {
    await deps.sleep(250);
    const unit = deps.unit();
    // An empty or unknown state (systemctl failed or timed out) is no evidence of a crash: keep polling.
    if (['inactive', 'failed', 'deactivating'].includes(unit.state) || (pid && unit.pid && unit.pid !== pid)) return 'crashed';
    if (await deps.answers(release, HEALTH_TIMEOUT_MS)) return 'answering';
  }
  return 'timeout';
}

function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}, what = `${cmd} ${args.join(' ')}`): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`${what} failed${r.error ? `: ${r.error.message}` : ''}\n${String(r.stderr ?? '').trim()}\n${String(r.stdout ?? '').trim()}`.trim());
  return String(r.stdout ?? '').trim();
}

const link = (name: string): string | undefined => {
  try {
    return readlinkSync(join(RELEASES, name));
  } catch {
    return undefined;
  }
};

// Replaces a symlink in one rename, so `current` always points at a whole release.
function setLink(name: string, target: string | undefined): void {
  const path = join(RELEASES, name);
  if (!target) return rmSync(path, { force: true });
  const tmp = `${path}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp);
  renameSync(tmp, path);
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// One deploy, rollback or prune at a time: the deploy lock (releases/.flock, and releases/.lock for older releases), taken
// through src/release-lock.ts like the canary bisection's cleanup (S-1750). Throws when another holder has it, or when
// flock(1) is missing, with its own message.
async function lock(): Promise<() => Promise<void>> {
  mkdirSync(RELEASES, { recursive: true });
  const unlock = await tryLock(RELEASES);
  if (unlock) return unlock;
  throw new Error(`another deploy is running (pid ${lockHolder(RELEASES) ?? 'unknown'})`);
}

// The repository to deploy from: --repo, else the stam checkout the command runs in,
// else the checkout this code runs from.
function findRepo(repo?: string): string {
  if (repo) return run('git', ['-C', repo, 'rev-parse', '--git-dir']) && repo;
  for (const dir of [process.cwd(), ROOT]) {
    const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    const top = r.status === 0 ? r.stdout.trim() : '';
    if (top && existsSync(join(top, 'src', 'cli.ts')) && existsSync(join(top, 'bin', 'stam'))) return top;
  }
  throw new Error('not in a stam checkout; pass --repo DIR');
}

// The deps-cache key for a package folder: a hash of package.json, package-lock.json, the dev
// flag, and the Node version, platform and arch (S-1044). The same key names the same install in
// STAM_HOME/deps/KEY, so a release or a worktree links the one npm ci instead of installing again.
// Undefined when the folder has no lockfile to key on.
export function depsKey(dir: string, dev: boolean): string | undefined {
  const pkg = join(dir, 'package.json');
  const lockFile = join(dir, 'package-lock.json');
  if (!existsSync(pkg) || !existsSync(lockFile)) return undefined;
  return createHash('sha256')
    .update(readFileSync(pkg))
    .update(readFileSync(lockFile))
    .update(`${dev} ${process.version} ${process.platform} ${process.arch}`)
    .digest('hex')
    .slice(0, 16);
}

// The cache folder for a key: STAM_HOME/deps/KEY (S-1044).
export const depsCachePath = (key: string): string => join(DEPS, key);

// Marks a cache entry used now, so a prune keeps it for DEPS_KEEP_MS (S-1044). Best-effort: a
// prune never fails over it, and a link never fails when the marker can't be written.
export function touchDepsUsed(key: string): void {
  try {
    writeFileSync(join(depsCachePath(key), '.used'), new Date().toISOString());
  } catch {}
}

// Makes every file under dir read-only, recursively, leaving directories writable (S-1044). A
// worktree gets the cache's node_modules through `cp -al`: the directories there are fresh and
// writable, so npm can remove or add entries, but a write through a hard link to a cached file
// fails loudly instead of corrupting the cache. Only the write bits go: an executable (a `.bin`
// target, a native binary) keeps its exec bits. Symlinks are left alone (chmod would follow them).
function chmodReadOnly(dir: string): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) chmodReadOnly(p);
    else if (e.isFile()) try { chmodSync(p, statSync(p).mode & ~0o222); } catch {}
  }
}

// What a build writes under node_modules (tsc's tsbuildinfo, vite's and babel's caches). Never part
// of the deps cache or of a link: a read-only hard link to one of these files makes the next
// `tsc -b` fail with EACCES, so a build creates them fresh and writable in its own target.
export const BUILD_OUTPUT_DIRS = ['.tmp', '.cache', '.vite'];

function removeBuildOutputs(nodeModules: string): void {
  for (const d of BUILD_OUTPUT_DIRS) rmSync(join(nodeModules, d), { recursive: true, force: true });
}

// What a link of a cache entry's node_modules came to (S-1965): linked (hard-linked, or copied across filesystems),
// nodeps (a filled entry with no node_modules: a package with no dependencies), gone (the entry vanished, as a
// prune can remove an unused one: fill it again), or failed. The classification, the link and the copy fallback run
// as one operation under the deps root's shared lock (scripts/deps-lock.mjs), so a prune can't land between them.
export type LinkOutcome = 'linked' | 'nodeps' | 'gone' | 'failed';

function outcomeOf(status: number, target: string): LinkOutcome {
  if (status === 0) {
    // Hard links: removing them here leaves the cache's copies alone.
    removeBuildOutputs(target);
    return 'linked';
  }
  rmSync(target, { recursive: true, force: true });
  if (status === NODEPS) return 'nodeps';
  return status === GONE ? 'gone' : 'failed';
}

export function linkDepsOutcome(cache: string, target: string): LinkOutcome {
  return outcomeOf(linkLocked(dirname(cache), cache, target), target);
}

// linkDepsOutcome with the `cp -al` run async, so a link done on a daemon request (pr_open's relink, S-1706)
// doesn't stall the event loop for the seconds a big tree takes.
export async function linkDepsOutcomeAsync(cache: string, target: string): Promise<LinkOutcome> {
  return outcomeOf(await linkLockedAsync(dirname(cache), cache, target), target);
}

// Hard-links a filled cache's node_modules into target (S-1044). Returns false when the cache has no
// node_modules or the link fails.
export const linkDepsFrom = (cache: string, target: string): boolean => linkDepsOutcome(cache, target) === 'linked';
export const linkDepsFromAsync = async (cache: string, target: string): Promise<boolean> => (await linkDepsOutcomeAsync(cache, target)) === 'linked';

// A cache with `.ro` but no `.ro2` was converged by the first read-only code, which chmod'd every
// file to 0444 and so stripped the exec bits (`tsc: Permission denied`). The files share inodes
// with releases and worktrees, so they can't be repaired in place: moves the cache aside, atomically,
// so the key is a miss and `npm ci` refills it with fresh inodes; prune deletes `*.damaged-*`. A
// concurrent process that moved it first (ENOENT) is fine. Returns true when it moved it aside.
export function retireDamagedCache(cache: string): boolean {
  if (!existsSync(join(cache, '.ro')) || existsSync(join(cache, '.ro2'))) return false;
  try {
    renameSync(cache, `${cache}.damaged-${process.pid}-${randomBytes(4).toString('hex')}`);
    return true;
  } catch (e) {
    // Another process retired (ENOENT) or refilled (EEXIST, ENOTEMPTY) it first. Never throws: a
    // spawn must not fail over this. Damaged still on disk only when the rename failed otherwise.
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EEXIST' || code === 'ENOTEMPTY') return !existsSync(join(cache, '.ro2'));
    console.log(`deps: can't retire ${cache}: ${(e as Error).message}`);
    return false;
  }
}

// Converges a cache to read-only files once (S-1044). Every cache filled before this code was
// writable, and its files share inodes with releases/current, so a worktree write through a link
// would corrupt both the cache and the live release. `.ro2` records that the files are already
// read-only (with exec bits kept), so the walk runs once per cache. Directories stay writable, and nothing in a running
// release writes an existing file under node_modules (vite's `.vite` and npm add new files; native
// modules are only read), so making them read-only is safe.
export function ensureCacheReadOnly(cache: string): void {
  if (retireDamagedCache(cache)) return;
  // Every time, not once: a cache converged before this code holds build output a release linked.
  removeBuildOutputs(join(cache, 'node_modules'));
  if (existsSync(join(cache, '.ro2'))) return;
  chmodReadOnly(join(cache, 'node_modules'));
  // `.ro` too: a daemon still running the code before `.ro2` checks only `.ro`, and would chmod a
  // cache that lacks it to 0444 again.
  try {
    writeFileSync(join(cache, '.ro'), new Date().toISOString());
    writeFileSync(join(cache, '.ro2'), new Date().toISOString());
  } catch {}
}

// The npm ci for a cache fill, awaited without blocking the event loop (S-1044): a worktree warm
// runs inside the daemon, and deploy's one-shot install awaits the same way. STAM_NPM overrides
// the command, as scripts/ensure-deps.sh does.
function runAsync(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr?.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}${err ? `\n${err.trim()}` : ''}`))));
  });
}

// Fills STAM_HOME/deps/KEY with one npm ci, when it is missing, then makes its files read-only and
// drops a .ready marker (S-1044). Returns the key. A concurrent fill is tolerated: when another
// process published KEY with .ready first, this one drops its tmp folder. Throws on a failed
// install. Non-blocking, so a worktree spawn can warm the cache in the background.
export async function fillDeps(dir: string, dev: boolean, label?: string): Promise<string | undefined> {
  const key = depsKey(dir, dev);
  if (!key) return undefined;
  const cache = depsCachePath(key);
  retireDamagedCache(cache);
  if (existsSync(join(cache, '.ready'))) return key;
  console.log(`installing dependencies (${label ?? (dir.endsWith('web') ? 'web' : 'stam')}, ${key})`);
  // A unique tmp folder, so two concurrent fills (two spawns, one daemon) never share one.
  mkdirSync(DEPS, { recursive: true });
  const tmp = mkdtempSync(join(DEPS, `${key}.tmp-`));
  try {
    cpSync(join(dir, 'package.json'), join(tmp, 'package.json'));
    cpSync(join(dir, 'package-lock.json'), join(tmp, 'package-lock.json'));
    await runAsync(envVar('NPM') ?? 'npm', ['ci', '--no-audit', '--no-fund', ...(dev ? [] : ['--omit=dev'])], tmp);
    // Native modules must load with this Node, or the release is no good.
    const names = Object.keys(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies ?? {});
    if (!dev && existsSync(join(tmp, 'node_modules'))) await runAsync(process.execPath, ['--input-type=module', '-e', `for (const d of ${JSON.stringify(names)}) await import(d);`], tmp);
    removeBuildOutputs(join(tmp, 'node_modules'));
    chmodReadOnly(join(tmp, 'node_modules'));
    writeFileSync(join(tmp, '.ro'), new Date().toISOString());
    writeFileSync(join(tmp, '.ro2'), new Date().toISOString());
    writeFileSync(join(tmp, '.ready'), new Date().toISOString());
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  if (existsSync(join(cache, '.ready'))) rmSync(tmp, { recursive: true, force: true });
  else try {
    // No rmSync of an existing cache: another process (a deploy and a spawn warm can share a key)
    // may publish KEY first, and deleting its cache would be worse than losing this fill. `rename`
    // onto a non-empty directory fails, and that means the other process won.
    renameSync(tmp, cache);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    rmSync(tmp, { recursive: true, force: true });
    if ((code !== 'EEXIST' && code !== 'ENOTEMPTY') || !existsSync(join(cache, '.ready'))) throw e;
  }
  return key;
}

// Fills a worktree's cache in the background when it is missing, then links it into the worktree
// when nothing is there yet (S-1044). Returns the key and whether the worktree ended up with
// node_modules, so the spawn can log `deps:linked` when the warm finishes (not only
// `deps:warming`). Used by createWorkspace fire-and-forget: the spawn doesn't wait.
export async function warmDeps(dir: string, dev: boolean, target?: string): Promise<{ key: string; linked: boolean } | undefined> {
  let key: string | undefined;
  let linked = false;
  // A prune can remove an unused entry between the fill and the link: fill it again.
  for (let attempt = 0; attempt < 3; attempt++) {
    key = await fillDeps(dir, dev);
    if (!key) return undefined;
    const cache = depsCachePath(key);
    ensureCacheReadOnly(cache);
    touchDepsUsed(key);
    if (!target || existsSync(target)) {
      linked = Boolean(target);
      break;
    }
    const outcome = linkDepsOutcome(cache, target);
    linked = outcome === 'linked';
    if (outcome !== 'gone') break;
  }
  return key ? { key, linked } : undefined;
}

// node_modules for a package folder in a release. Installs once per package-lock (and Node
// version) into STAM_HOME/deps/KEY, then hard-links that into the release: node-pty is a
// native module, and this skips its build when the lock hasn't changed.
async function installDeps(dir: string, dev: boolean): Promise<string | undefined> {
  const pkg = join(dir, 'package.json');
  const lockFile = join(dir, 'package-lock.json');
  if (!existsSync(pkg)) return undefined;
  if (!existsSync(lockFile)) {
    run('npm', ['install', '--no-audit', '--no-fund', ...(dev ? [] : ['--omit=dev'])], { cwd: dir });
    return undefined;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const key = await fillDeps(dir, dev);
    if (!key) return undefined;
    const cache = depsCachePath(key);
    ensureCacheReadOnly(cache);
    touchDepsUsed(key);
    // A package with no dependencies installs no node_modules ('nodeps'); an entry a prune removed since the fill is filled again.
    const outcome = linkDepsOutcome(cache, join(dir, 'node_modules'));
    if (outcome === 'linked' || outcome === 'nodeps') return key;
    if (outcome === 'failed') throw new Error(`can't link the deps cache ${key} into ${dir}`);
  }
  throw new Error(`the deps cache for ${dir} kept disappearing`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

// Kills every process whose environment has STAM_HOME set to `home`: the scratch daemon and whatever it
// started, orphans included. Only this check's unique home matches, never the live daemon or the watcher.
function killHomeProcesses(home: string): void {
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      if (readFileSync(`/proc/${name}/environ`, 'utf8').split('\0').includes(`STAM_HOME=${home}`)) process.kill(Number(name), 'SIGKILL');
    } catch {}
  }
}

// Every module loads, the CLI runs, and the daemon answers HTTP from a scratch home on
// scratch ports, with no harness started.
export async function check(dir: string): Promise<void> {
  // Leaked homes go first, so a full disk can't stop the check that carries the fix (S-2573).
  sweepCheckHomes();
  mkdirSync(checkRoot(), { recursive: true });
  const home = mkdtempSync(join(checkRoot(), 'stam-check-'));
  // The sweep keeps a home whose check still runs, however old.
  writeOwner(home);
  const socket = `stam-check-${process.pid}`;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(STAM|MOOTR)_/.test(k) && v !== undefined) env[k] = v;
  const port = await freePort();
  Object.assign(env, withTwins({
    STAM_HOME: home,
    STAM_PORT: String(port),
    STAM_TMUX_SOCKET: socket,
    STAM_BIND: '127.0.0.1',
    STAM_MACHINE: 'deploy-check',
    STAM_OPENCODE_PORT: String(await freePort()),
    STAM_OPENCODE_BIN: '/bin/false',
    STAM_CODEX_BIN: '/bin/false',
    // No model install or download into the scratch home: an npm child of it can outlive the daemon.
    STAM_EMBEDDER: 'off',
  }));
  const log = join(home, 'check.log');
  let child: ChildProcess | undefined;
  let exited = false;
  try {
    const modules = (readdirSync(join(dir, 'src'), { recursive: true }) as string[])
      .filter((f) => f.endsWith('.ts') && f !== 'cli.ts' && f !== 'embed-worker.ts' && !f.startsWith('adapters/opencode-plugin'))
      .map((f) => `./src/${f}`);
    run(process.execPath, ['--no-warnings', '--input-type=module', '-e', `for (const m of ${JSON.stringify(modules)}) await import(m); process.exit(0);`], { cwd: dir, env }, 'loading every module');
    run(join(dir, 'bin', 'stam'), [], { cwd: dir, env }, 'running the CLI');

    const fd = openSync(log, 'a');
    child = spawn(process.execPath, ['--no-warnings', join(dir, 'src', 'cli.ts'), 'daemon', 'run'], { cwd: home, env, stdio: ['ignore', fd, fd] });
    closeSync(fd);
    child.on('exit', () => (exited = true));
    const get = async (path: string) => {
      const token = readFileSync(join(home, 'token'), 'utf8').trim();
      return fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) });
    };
    let ok = false;
    for (let i = 0; i < 60 && !exited && !ok; i++) {
      await sleep(250);
      try {
        ok = ((await (await get('/api/health')).json()) as { ok?: boolean }).ok === true;
      } catch {}
    }
    if (!ok) throw new Error('scratch daemon never answered /api/health');
    const page = await get('/');
    if (page.status !== 200 || !(await page.text()).includes('<html')) throw new Error(`scratch daemon served / with ${page.status}`);
  } catch (e) {
    const tail = existsSync(log) ? readFileSync(log, 'utf8').split('\n').slice(-30).join('\n') : '';
    throw new Error(`check failed: ${(e as Error).message}\n${tail}`);
  } finally {
    // Whatever the daemon started (an installer, a worker) can outlive it and write into the home
    // after the rm below, so everything holding this home is killed first. The daemon stays in the
    // build's group, which the canary reads to reap a killed build's check home.
    if (child) {
      child.kill('SIGTERM');
      for (let i = 0; i < 20 && !exited; i++) await sleep(100);
    }
    killHomeProcesses(home);
    killTmuxServer(socket);
    rmSync(home, { recursive: true, force: true });
  }
}

// Release folders, without the `current` and `previous` links and unfinished builds.
const releases = () => readdirSync(RELEASES, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && meta(e.name)).map((e) => e.name);

// What a release can do, for a script that must know a fix is deployed before it relies on it (scripts/mootr-move.sh
// Step 0 checks `.release.json` capabilities). The list is the committed `capabilities.json` of the tree being built
// (`dir`, the archived target), never a constant of the CLI that builds it: a new CLI building an older ref writes no
// marker for a fix that ref lacks, and the fixed ref carries it whichever CLI builds it. `mootr-deploy-names` is S-3347:
// the mootr home default, mootrd as the service, and serviceRunsReleases accepting either home spelling.
export function releaseCapabilities(dir: string): string[] {
  try {
    const list = JSON.parse(readFileSync(join(dir, 'capabilities.json'), 'utf8'));
    return Array.isArray(list) ? list.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

type Meta = { release: string; commit: string; subject: string; repo: string; built_at: string; deps: string[]; capabilities?: string[] };

function meta(name: string): Meta | undefined {
  try {
    return JSON.parse(readFileSync(join(RELEASES, name, '.release.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

// Builds REF into releases/SHA, unless that release exists already.
async function build(repo: string, ref: string): Promise<string> {
  // Before the install and the web build, which a full temp dir can stop (S-2573).
  sweepCheckHomes();
  const commit = run('git', ['-C', repo, 'rev-parse', '--verify', `${ref}^{commit}`]);
  const name = commit.slice(0, 10);
  if (meta(name)) return name;
  const dir = join(RELEASES, `.build-${name}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    console.log(`building ${name}: ${run('git', ['-C', repo, 'log', '-1', '--format=%s', commit])}`);
    run('sh', ['-c', 'git -C "$1" archive "$2" | tar -x -C "$3"', 'sh', repo, commit, dir]);
    const deps = [await installDeps(dir, false)];
    // The web UI's build, once it has one (a `build` script in web/package.json).
    const webPkg = join(dir, 'web', 'package.json');
    if (existsSync(webPkg) && JSON.parse(readFileSync(webPkg, 'utf8')).scripts?.build) {
      deps.push(await installDeps(join(dir, 'web'), true));
      console.log('building the web UI');
      run('npm', ['run', 'build'], { cwd: join(dir, 'web') });
    }
    console.log('checking it on a scratch daemon');
    await check(dir);
    const m: Meta = {
      release: name,
      commit,
      subject: run('git', ['-C', repo, 'log', '-1', '--format=%s', commit]),
      repo,
      built_at: new Date().toISOString(),
      deps: deps.filter((d): d is string => Boolean(d)),
      capabilities: releaseCapabilities(dir),
    };
    writeFileSync(join(dir, '.release.json'), JSON.stringify(m, null, 2));
    renameSync(dir, join(RELEASES, name));
    return name;
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

// The unit runs releases/current, so a restart picks up the switch.
// A crash-looping release can hit systemd's start limit, which would refuse the next start.
function restart(): void {
  checkService();
  systemctl('reset-failed', SERVICE);
  systemctl('restart', SERVICE);
}

// Whether a unit file's text starts the service from `releases/current`, under either home spelling: the stam home
// and, after the move, the mootr home (the stam path is then a symlink to it).
export function serviceRunsReleasesText(unit: string, releases: string): boolean {
  const current = join(releases, 'current');
  const other = current.includes('/share/mootr/') ? current.replace('/share/mootr/', '/share/stam/') : current.replace('/share/stam/', '/share/mootr/');
  return unit.includes(current) || unit.includes(other);
}

function serviceRunsReleases(): boolean {
  checkService();
  try {
    return serviceRunsReleasesText(readFileSync(UNIT, 'utf8'), RELEASES);
  } catch {
    return false;
  }
}

// An older unit (one that runs node on releases/current/src/cli.ts) is rewritten to start through
// bin/stamd with the fallback for releases without it (src/unit.ts), before the restart that uses it. The
// fallback is why a rollback to a release without the wrapper still starts, so a rollback never has to
// rewrite the unit back. A unit already in the new form is left alone.
function migrateServiceUnit(): void {
  try {
    const next = migrateUnit(readFileSync(UNIT, 'utf8'), join(RELEASES, 'current'));
    if (next === undefined) return;
    // Rename, not rewrite, so an interrupted deploy never leaves a half-written unit.
    const tmp = `${UNIT}.tmp-${process.pid}`;
    writeFileSync(tmp, next);
    renameSync(tmp, UNIT);
    systemctl('daemon-reload');
    console.log(`${UNIT} now starts ${SERVICE} through bin/stamd`);
  } catch (e) {
    console.error(`couldn't rewrite ${UNIT}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Restarts the service and waits for `release` to answer (`awaitRestart`).
async function restartAndWait(release: string): Promise<'answering' | 'crashed' | 'timeout'> {
  restart();
  return awaitRestart(release, unitState().pid);
}

// Points `current` at the target and restarts the service. If the restarted daemon doesn't
// answer as the target in time, or crashes while starting, points `current` back and restarts again.
export async function activate(target: string): Promise<boolean> {
  // Before `current` and `previous` move, so a service that can't be inspected leaves both unchanged.
  checkService();
  const before = { current: link('current'), previous: link('previous') };
  setLink('current', target);
  if (before.current && before.current !== target) setLink('previous', before.current);
  if (!serviceRunsReleases()) {
    console.log(`current -> ${target}. The ${SERVICE} service doesn't run from releases/current; install it with: ${join(RELEASES, 'current', 'bin', 'stam')} daemon install`);
    return true;
  }
  migrateServiceUnit();
  const up = await restartAndWait(target);
  if (up === 'answering') {
    console.log(`current -> ${target}; ${SERVICE} restarted and answering`);
    return true;
  }
  console.error(`${target} ${up === 'crashed' ? `stopped while starting ${SERVICE}` : "didn't answer in time"}; see ${join(STAM_HOME, 'daemon.log')}`);
  if (!before.current || before.current === target) return false;
  setLink('current', before.current);
  setLink('previous', before.previous);
  const back = await restartAndWait(before.current);
  console.error(back === 'answering' ? `rolled back: current -> ${before.current}, answering` : `rolled back to ${before.current}, but it isn't answering either`);
  return false;
}

// Every process whose command line names a release, with the one it names. An agent's MCP shim
// starts as `node .../releases/<sha>/bin/../src/cli.ts mcp`: `bin/stam` resolves the `current`
// link, so the shim holds the release it started from until the agent exits (S-756).
function pinnedProcesses(): { release: string; pid: number }[] {
  const found: { release: string; pid: number }[] = [];
  const prefix = `${realpathSync(RELEASES)}/`;
  for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      for (let i = cmd.indexOf(prefix); i >= 0; i = cmd.indexOf(prefix, i + 1)) found.push({ release: cmd.slice(i + prefix.length).split(/[/\0]/)[0], pid: Number(pid) });
    } catch {}
  }
  return found;
}

// The agent a process belongs to: its harness launches the MCP shim with STAM_AGENT_ID.
function agentIdOf(pid: number): string | undefined {
  try {
    return entryValue(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0'), 'AGENT_ID');
  } catch {
    return undefined;
  }
}

// Drops compile-cache entries older than a day: they are for files of releases that have moved
// on, and the cache lives on tmpfs, so it costs RAM. Node names each entry by a hash of the file
// it caches, so age is all the layout tells us (S-756). Best-effort throughout: a cache entry, a
// version directory, or the whole cache may be unreadable, gone, or written while we sweep, and
// none of that may fail a prune or a deploy that already switched `current`.
function sweepCompileCache(): void {
  const cutoff = Date.now() - CACHE_MAX_AGE;
  let versions: string[];
  try {
    versions = readdirSync(CACHE_DIR);
  } catch {
    return;
  }
  for (const version of versions) {
    const dir = join(CACHE_DIR, version);
    try {
      for (const entry of readdirSync(dir)) {
        try {
          if (statSync(join(dir, entry)).mtimeMs < cutoff) rmSync(join(dir, entry), { force: true });
        } catch {}
      }
      // Non-recursive, so a fresh entry a running node wrote meanwhile is never removed with the
      // directory; a directory that is not empty (or is gone) is simply left.
      if (!readdirSync(dir).length) rmdirSync(dir);
    } catch {}
  }
}

// Keeps the newest releases, `current`, `previous` (what rollback switches to), and the releases a
// process runs from by its path (`pinnedProcesses()`; a path through `releases/current` counts for
// `current`). Runs after every deploy, including one that finds its release already live, and
// through `stam prune`, so a release a process pinned at deploy time goes once it lets go.
// Returns the agents whose MCP shim it wants reloaded onto `current` (S-756), for `capPins`.
function prune(): string[] {
  const names = releases();
  const newest = [...names].sort((a, b) => meta(b)!.built_at.localeCompare(meta(a)!.built_at));
  const kept = new Set([...newest.slice(0, KEEP), link('current'), link('previous')]);
  const pinned = pinnedProcesses();
  const used = new Set(pinned.map((p) => p.release));
  const keep = new Set([...kept, ...used]);
  for (const n of names) if (!keep.has(n)) {
    rmSync(join(RELEASES, n), { recursive: true, force: true });
    console.log(`removed release ${n}`);
  }
  // Interrupted builds.
  for (const n of readdirSync(RELEASES)) {
    const m = n.match(/^\.build-\w+-(\d+)$/);
    if (m && !alive(Number(m[1]))) rmSync(join(RELEASES, n), { recursive: true, force: true });
  }
  const deps = new Set(releases().flatMap((n) => meta(n)!.deps));
  const depsCutoff = Date.now() - DEPS_KEEP_MS;
  const depsTmpCutoff = Date.now() - CACHE_MAX_AGE;
  // Under the deps root's exclusive lock, so no link starts from an entry being removed (S-1965); busy: left for the next prune.
  const depsLock = existsSync(DEPS) ? tryExclusive(DEPS) : null;
  if (depsLock) try {
    for (const d of readdirSync(DEPS)) {
      const p = join(DEPS, d);
      // Only the shapes the cache makes are removed: a key, its .tmp- and .damaged- folders, and a victim a sweep set
      // aside (.pruned-*). The lock file `.prune.lock` (its inode must outlive every prune) and anything unknown stay.
      if (!/^[0-9a-f]{16}(\.(tmp|damaged)-.+)?$/.test(d) && !/^\.pruned-/.test(d)) continue;
      // A cache moved aside as damaged (retireDamagedCache) goes at any age: releases and worktrees
      // keep their own hard links to the files.
      if (/\.damaged-/.test(d)) {
        rmSync(p, { recursive: true, force: true });
        continue;
      }
      // A fill in progress (a `.tmp-` folder) is left alone; one a stopped fill left behind goes
      // after a day (S-1044).
      if (/\.tmp-/.test(d)) {
        try {
          if (statSync(p).mtimeMs >= depsTmpCutoff) continue;
        } catch {
          continue;
        }
        rmSync(p, { recursive: true, force: true });
        continue;
      }
      // A key a release names, or one a worktree linked within the window, stays (S-1044). A
      // warmed dev key isn't in any release, so `.used` is what keeps it for a worktree on a branch
      // no deploy covers yet.
      if (deps.has(d)) continue;
      let used = 0;
      try {
        used = statSync(join(DEPS, d, '.used')).mtimeMs;
      } catch {}
      if (used >= depsCutoff) continue;
      rmSync(p, { recursive: true, force: true });
    }
  } finally {
    depsLock.release();
  }
  sweepCompileCache();
  // An agent's shim pins the release it started from until the agent exits, so a long-lived fleet
  // holds old releases open. Past a few pins beyond what prune keeps, the ones idle agents hold
  // are reloaded onto `current`, so the release goes on the next prune.
  const spare = [...used].filter((n) => !kept.has(n));
  if (spare.length <= MAX_SPARE_PINS) return [];
  const wanted = new Set(spare);
  const ids = new Set<string>();
  for (const { release, pid } of pinned) if (wanted.has(release)) {
    const id = agentIdOf(pid);
    if (id) ids.add(id);
  }
  if (ids.size) console.log(`${spare.length} releases are pinned beyond the newest ${KEEP}; asking ${ids.size} idle agent(s) to reload their MCP server`);
  return [...ids];
}

const IDLE_ACTIVITIES = new Set(['idle', 'waiting', 'errored']);

// Asks the daemon to reload the MCP server of each idle agent that pins a release prune would
// otherwise keep only for it (S-756). The shim then starts from `releases/current`, so the old
// release goes on the next prune. Only harnesses that reload without a restart are asked (Codex,
// OpenCode): a Claude Code agent is left alone rather than restarted. Best-effort: a `stam prune`
// from a checkout, or with no daemon, still prunes. `whenIdle` lets the daemon defer, so a reload
// never lands mid-turn.
export async function capPins(ids: string[]): Promise<void> {
  if (!ids.length) return;
  let agents: { id: string; harness?: string; activity?: string | null; lifecycle?: string }[];
  try {
    agents = await api('GET', `/api/agents?${new URLSearchParams({ ids: ids.join(',') })}`);
  } catch (e) {
    console.log(`the daemon didn't answer to reload pinned agents' MCP servers: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  // Imported here, not at the top: the adapters need `ws`, and a first deploy runs before any deps exist (S-1249).
  let adapters: (typeof import('./adapters/index.ts'))['adapters'];
  try {
    ({ adapters } = await import('./adapters/index.ts'));
  } catch (e) {
    console.log(`couldn't load the adapters to reload pinned agents' MCP servers: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const byId = new Map(agents.map((a) => [a.id, a]));
  for (const id of ids) {
    const a = byId.get(id);
    if (!a || !adapters[a.harness ?? '']?.reconnectMcp) continue;
    if (!IDLE_ACTIVITIES.has(a.activity ?? '') || (a.lifecycle !== 'active' && a.lifecycle !== 'paused')) continue;
    try {
      await api('POST', `/api/agents/${id}/reconnect-mcp`, { by: id, whenIdle: true });
      console.log(`asked ${a.id} to reload its MCP server at its next idle`);
    } catch (e) {
      console.log(`couldn't ask ${a.id} to reload its MCP server: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// `stam prune`: prune holding the deploy lock, so it can't race a deploy's deps cache or link switch.
export async function pruneLocked(): Promise<void> {
  const unlock = await lock();
  try {
    await capPins(prune());
  } finally {
    await unlock();
  }
}

// Builds REF into releases/SHA and checks it, without switching to it (S-1749): the deploy watcher's canary runs
// the release on a copy of the database first, and the deploy that follows finds it built. Returns its folder, and
// whether this call built it or found it built (S-1750), so the canary bisection removes only releases it made.
export async function buildRelease(ref = 'HEAD', repoArg?: string): Promise<{ dir: string; created: boolean }> {
  const repo = findRepo(repoArg);
  const unlock = await lock();
  try {
    const existed = meta(run('git', ['-C', repo, 'rev-parse', '--verify', `${ref}^{commit}`]).slice(0, 10)) !== undefined;
    return { dir: join(RELEASES, await build(repo, ref)), created: !existed };
  } finally {
    await unlock();
  }
}

export async function deploy(ref = 'HEAD', repoArg?: string): Promise<boolean> {
  const repo = findRepo(repoArg);
  const unlock = await lock();
  try {
    if (ref === 'HEAD' && spawnSync('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).stdout?.trim())
      console.log('note: uncommitted changes are not deployed');
    const name = await build(repo, ref);
    if (link('current') === name && serviceRunsReleases() && (await waitHealthy(name, 2000))) {
      console.log(`${name} is already deployed and answering`);
      await capPins(prune());
      return true;
    }
    const ok = await activate(name);
    await capPins(prune());
    return ok;
  } finally {
    await unlock();
  }
}

// Switches to the previous release, or to a named one.
export async function rollback(target?: string): Promise<boolean> {
  const unlock = await lock();
  try {
    const to = target ?? link('previous');
    if (!to || !meta(to)) throw new Error(to ? `no release ${to}` : 'no previous release');
    return await activate(to);
  } finally {
    await unlock();
  }
}

export function listReleases(): void {
  if (!existsSync(RELEASES)) return console.log('no releases; run stam deploy');
  const current = link('current');
  const previous = link('previous');
  for (const n of releases().sort((a, b) => meta(b)!.built_at.localeCompare(meta(a)!.built_at))) {
    const m = meta(n)!;
    const mark = n === current ? 'current ' : n === previous ? 'previous' : '        ';
    console.log(`${mark}  ${n}  ${m.built_at.slice(0, 16).replace('T', ' ')}  ${m.subject}`);
  }
}
