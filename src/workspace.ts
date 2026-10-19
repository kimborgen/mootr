import { execFileSync, spawn } from 'node:child_process';
import { existsSync, statSync, mkdirSync, chmodSync, realpathSync, lstatSync, readlinkSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { MACHINE, STAM_HOME } from './config.ts';
import { settings } from './settings.ts';
import { depsCachePath, depsKey, ensureCacheReadOnly, fillDeps, linkDepsOutcome, linkDepsOutcomeAsync, type LinkOutcome, retireDamagedCache, touchDepsUsed, warmDeps } from './deploy.ts';
import type { AgentType } from './agent-types.ts';

// What linking a worktree's dependencies did (S-1044), for the spawn to log as an agent event.
// `warm` starts nothing: it hands the background fill's promise to a caller that wants to await
// it (the tests); the daemon only logs `event`. A function, so JSON.stringify of the workspace
// drops it.
export interface DepsEvent {
  dir: string;
  key: string;
  event: 'deps:linked' | 'deps:warming' | 'deps:failed';
  // On a miss: awaits the background fill and reports whether the worktree linked, so the spawn
  // logs `deps:linked` (or `deps:failed`) when the warm finishes. A function, so JSON.stringify of
  // the workspace drops it.
  warm?: () => Promise<{ key: string; linked: boolean }>;
}

// How an agent's working directory was made. Spawn takes one of these; archive
// undoes what the agent owns (a worktree), and leaves everything else alone.
export type WorkspaceSpec =
  | { kind: 'dir'; path: string }
  | { kind: 'worktree'; repo: string; branch?: string; base?: string }
  | { kind: 'script'; command: string; cwd: string }
  | { kind: 'instructions'; text: string; cwd: string };

export interface Workspace {
  spec: WorkspaceSpec;
  cwd: string;
  // Set for worktrees the agent owns.
  worktree?: { repo: string; path: string; branch: string; base?: string };
  // The worktree's dependency linking (S-1044): one entry per package folder.
  deps?: DepsEvent[];
  // Where the branch was cut from and how the fetch went (S-1666), so a stale fallback is visible.
  baseUsed?: BaseUsed;
}

// The package folders a worktree links dependencies for: the root and `web/`.
const DEPS_FOLDERS = ['', 'web'];

// Links one package folder's cached node_modules into the worktree, or warms the cache in the
// background on a miss (S-1044). A folder without a lockfile is skipped; a worktree that already
// has node_modules is left alone. On a hit the link is a `cp -al` of the read-only cache files:
// no extra disk, fresh writable directories, and no write can reach the cache. On a miss the
// spawn returns at once; the background fill links into the worktree when it finishes, if nothing
// is there yet.
function linkDeps(worktree: string, rel: string): DepsEvent | undefined {
  const dir = rel ? join(worktree, rel) : worktree;
  if (!existsSync(join(dir, 'package.json')) || !existsSync(join(dir, 'package-lock.json'))) return undefined;
  const target = join(dir, 'node_modules');
  if (existsSync(target)) return undefined;
  const key = depsKey(dir, true);
  if (!key) return undefined;
  const cache = depsCachePath(key);
  retireDamagedCache(cache);
  if (existsSync(join(cache, '.ready'))) {
    ensureCacheReadOnly(cache);
    const outcome = linkDepsOutcome(cache, target);
    // gone: a prune removed the entry since the check, so it is a miss and the fill below runs.
    if (outcome !== 'gone') {
      if (outcome !== 'linked') return { dir: rel || '.', key, event: 'deps:failed' };
      touchDepsUsed(key);
      return { dir: rel || '.', key, event: 'deps:linked' };
    }
  }
  const promise = warmDeps(dir, true, target)
    .then((r) => r ?? { key, linked: false })
    .catch((e) => {
      console.log(`deps: warm failed for ${dir}: ${e instanceof Error ? e.message : e}`);
      return { key, linked: false };
    });
  return { dir: rel || '.', key, event: 'deps:warming', warm: () => promise };
}

// How a worktree's start point was chosen (S-1666): the ref, the commit, and whether fetching it worked.
// `fetch` is `ok`, `failed` (the start fell back to the checkout's HEAD, `ref` is then `HEAD`), or
// `none` (no remote to fetch from, or no fetch asked for).
export interface BaseUsed {
  ref: string;
  sha: string;
  fetch: 'ok' | 'failed' | 'none';
  error?: string;
  // True when the spawn gave no base and the default origin/main was tried.
  defaulted?: boolean;
}

// A fetch that hangs (a stopped `storage` remote) must not hold a spawn.
const fetchTimeoutMs = (): number => Number(process.env.STAM_FETCH_TIMEOUT_MS) || 15_000;

const gitIn = (repo: string, ...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();

// The remote of `repo` that `ref` is under (`origin/stam/x` -> `origin`), if any.
const remoteOf = (repo: string, ref: string): string | undefined => gitIn(repo, 'remote').split('\n').find((r) => r && ref.startsWith(`${r}/`));

// What a spawn's base needs fetched, decided before createWorkspace so the fetch can run async (S-1666).
export interface BaseFetch {
  ref: string;
  defaulted: boolean;
  ok: boolean;
  error?: string;
}

// `git fetch` off the event loop with a hard bound: its own process group is killed at the deadline, so a
// hung ssh child that holds the pipes open cannot outlive the timeout. Resolves to an error text, or null.
function fetchBounded(repo: string, remote: string, refspec: string): Promise<string | null> {
  return new Promise((done) => {
    const ms = fetchTimeoutMs();
    const child = spawn('git', ['-C', repo, 'fetch', '-q', remote, refspec], {
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    let err = '';
    let settled = false;
    const finish = (r: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(r);
    };
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {}
      finish(`timed out after ${ms / 1000}s`);
    }, ms);
    child.stderr!.on('data', (d) => (err += d));
    child.on('error', (e) => finish(e.message));
    child.on('exit', (code) => finish(code === 0 ? null : (err.trim() || `git fetch exited ${code}`).slice(0, 300)));
  });
}

// Fetches in flight, so spawns at the same moment share one fetch per repo and ref (S-1351, S-1424).
const fetching = new Map<string, Promise<BaseFetch | undefined>>();

// The default branch ref a spawn with no base cuts from: origin's HEAD when the checkout knows it, else origin/main.
const defaultRef = (repo: string): string => {
  try {
    return gitIn(repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  } catch {
    return 'origin/main';
  }
};

// Fetches the remote ref a spawn cuts from, off the event loop and bounded by a timeout (S-1666). A given
// `base` under a remote is fetched (S-964); with none, origin's default branch is, when the repo has an origin
// remote. Returns undefined when there is nothing to fetch. Never throws: a failure is reported in the result.
export function prefetchBase(repo: string, base?: string): Promise<BaseFetch | undefined> {
  let ref = base;
  let remote: string | undefined;
  try {
    ref ??= gitIn(repo, 'remote').split('\n').includes('origin') ? defaultRef(repo) : undefined;
    if (!ref) return Promise.resolve(undefined);
    remote = remoteOf(repo, ref);
  } catch {
    return Promise.resolve(undefined);
  }
  if (!remote) return Promise.resolve(undefined);
  const key = `${repo}\0${ref}`;
  const running = fetching.get(key);
  if (running) return running.then((r) => (r ? { ...r, defaulted: !base } : r));
  const rem = remote;
  const go = fetchBounded(repo, rem, `+refs/heads/${ref.slice(rem.length + 1)}:refs/remotes/${ref}`)
    .then((error): BaseFetch => ({ ref: ref!, defaulted: !base, ok: !error, ...(error ? { error } : {}) }))
    .finally(() => fetching.delete(key));
  fetching.set(key, go);
  return go;
}

// Resolves a spawn's `base` ref to a commit in `repo` (S-964). Without `fetched`, a ref under one of the
// repo's remotes (`origin/stam/x`) is fetched first, so an unmerged branch another agent just pushed is
// there; with `fetched` (prefetchBase already ran it, async) it is not fetched again. A failed fetch is
// left to the resolve below, which names the ref. Throws when it doesn't resolve.
function resolveBase(repo: string, ref: string, fetched?: BaseFetch): string {
  const remote = remoteOf(repo, ref);
  if (remote && !fetched) {
    try {
      gitIn(repo, 'fetch', '-q', remote, `+refs/heads/${ref.slice(remote.length + 1)}:refs/remotes/${ref}`);
    } catch {}
  }
  try {
    return gitIn(repo, 'rev-parse', '--verify', '-q', `${ref}^{commit}`);
  } catch {
    throw new Error(`base ${ref} does not resolve to a commit in ${repo}${remote ? ` (after fetching ${remote})` : ''}`);
  }
}

// Why the default branch `stam/NAME` can't be used (S-1419), or null when it can: the checkout already has it, as a local
// branch or as a remote-tracking ref of origin or storage. A new agent named like an old one would otherwise open its PR
// on the old branch's name. Local refs only, no network: this runs on the daemon's event loop, and a stopped storage
// would stall it. The check is best-effort (a tracking ref can be stale); the real guard is pr-sync's ancestry check.
export function reusedBranchRefusal(repo: string, branch: string, remotes: string[] = ['origin', 'storage']): string | null {
  const refs = ['refs/heads', ...remotes.map((r) => `refs/remotes/${r}`)].map((p) => `${p}/${branch}`);
  const out = execFileSync('git', ['-C', repo, 'for-each-ref', '--format=%(refname)', ...refs], { encoding: 'utf8', stdio: 'pipe', timeout: 5000 }).trim();
  if (!out) return null;
  return `${branch} already exists here (${out.split('\n')[0]}): an earlier agent used that name. Pick another agent name, or pass an explicit branch.`;
}

// createWorkspace after an async, bounded fetch of its base (S-1666): what the daemon runs, so a slow or
// stopped remote never blocks its event loop. A worktree with no base is cut from the fresh origin/main.
export async function createWorkspaceFetched(spec: WorkspaceSpec, agentName: string): Promise<Workspace> {
  const fetched = spec.kind === 'worktree' ? await prefetchBase(spec.repo, spec.base) : undefined;
  return createWorkspace(spec, agentName, fetched);
}

export function createWorkspace(spec: WorkspaceSpec, agentName: string, fetched?: BaseFetch): Workspace {
  switch (spec.kind) {
    case 'dir':
      return { spec, cwd: resolve(spec.path) };
    case 'worktree': {
      const repo = execFileSync('git', ['-C', spec.repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
      const path = join(STAM_HOME, 'worktrees', `${basename(repo)}-${agentName}`);
      const branch = spec.branch ?? `stam/${agentName}`;
      if (!spec.branch) {
        const why = reusedBranchRefusal(repo, branch);
        if (why) throw new Error(why);
      }
      // A base that doesn't resolve fails here, before any worktree exists.
      let start: string | undefined;
      let baseUsed: BaseUsed | undefined;
      if (spec.base) {
        start = resolveBase(repo, spec.base, fetched);
        baseUsed = { ref: spec.base, sha: start, fetch: fetched ? (fetched.ok ? 'ok' : 'failed') : 'none', ...(fetched?.error ? { error: fetched.error } : {}) };
      } else if (fetched) {
        // The default: the freshly fetched origin/main. When the fetch failed, the local origin/main tracking
        // ref (possibly stale, though the checkout's HEAD never moves), else the checkout's HEAD.
        try {
          start = resolveBase(repo, fetched.ref, fetched);
          baseUsed = { ref: fetched.ref, sha: start, fetch: fetched.ok ? 'ok' : 'failed', ...(fetched.error ? { error: fetched.error } : {}), defaulted: true };
        } catch (e) {
          start = undefined;
          baseUsed = { ref: 'HEAD', sha: gitIn(repo, 'rev-parse', 'HEAD'), fetch: 'failed', error: fetched.error ?? (e instanceof Error ? e.message : String(e)), defaulted: true };
        }
      }
      mkdirSync(join(STAM_HOME, 'worktrees'), { recursive: true });
      execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', branch, path, ...(start ? [start] : [])], { encoding: 'utf8', stdio: 'pipe' });
      const deps = DEPS_FOLDERS.map((rel) => linkDeps(path, rel)).filter((d): d is DepsEvent => Boolean(d));
      return { spec, cwd: path, worktree: { repo, path, branch, ...(spec.base ? { base: spec.base } : {}) }, deps, ...(baseUsed ? { baseUsed } : {}) };
    }
    case 'script': {
      // The script prints the directory to use on its last line of output.
      const out = execFileSync('sh', ['-c', spec.command], { cwd: spec.cwd, encoding: 'utf8', env: { ...process.env, STAM_AGENT_NAME: agentName } });
      const dir = out.trim().split('\n').pop() ?? '';
      if (!dir || !existsSync(dir)) throw new Error(`workspace script printed no existing directory: ${dir}`);
      return { spec, cwd: resolve(spec.cwd, dir) };
    }
    case 'instructions':
      return { spec, cwd: resolve(spec.cwd) };
  }
}

// Whether a type gets its own worktree by default (S-990): its `worktree` flag, or any reviewer
// type (one with `review` set), registry-defined ones like reviewer-fallback included.
export const typeWantsWorktree = (type: AgentType | undefined): boolean => type?.worktree === true || Boolean(type?.review);

const inGitRepo = (dir: string): boolean => {
  try {
    execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

// The spec a spawn gets, from its body and its type (S-627): an explicit `worktree` flag wins,
// else a workspace script or instructions, else the type's worktree default (the developer type
// ships with `worktree: true`). The live deploy checkout is checked later, on the resolved
// workspace (spawnWorkspaceRefusal): a script's directory isn't known until it has run.
export function spawnWorkspaceSpec(body: any, type: AgentType | undefined, base: string): WorkspaceSpec {
  const given = body?.worktree === undefined || body?.worktree === null ? undefined : Boolean(body.worktree);
  // A reviewer type's default worktree falls back to a plain dir outside a git repo; an explicit
  // `worktree: true` keeps the error, and the developer type is unchanged.
  const worktree = given ?? (body?.workspace_script || body?.workspace_instructions ? false : typeWantsWorktree(type) && (!type?.review || inGitRepo(base)));
  if (worktree) return { kind: 'worktree', repo: base, branch: body.branch ? String(body.branch) : undefined, ...(body.base ? { base: String(body.base) } : {}) };
  if (body.workspace_script) return { kind: 'script', command: String(body.workspace_script), cwd: base };
  if (body.workspace_instructions) return { kind: 'instructions', text: String(body.workspace_instructions), cwd: base };
  return { kind: 'dir', path: base };
}

// A linked worktree's `.git` is a file; a checkout's is a directory.
const isLinkedWorktree = (dir: string): boolean => {
  try {
    return statSync(join(dir, '.git')).isFile();
  } catch {
    return false;
  }
};

// The live deploy checkout (S-627): the repo the deploy watcher deploys from
// (scripts/deploy-on-merge.mjs), where a deploy holds while it isn't a clean main. The watcher
// names it with STAM_DEPLOY_REPO; else the repo settings name for stam2 (a release records the
// checkout it came from, and a checkout is its own); else ~/projects/stam2, the watcher's default.
export function deployCheckout(): string {
  if (process.env.STAM_DEPLOY_REPO) return resolve(process.env.STAM_DEPLOY_REPO);
  try {
    const repo = settings().itsa?.repos?.stam2;
    if (repo) return resolve(repo);
  } catch {}
  return join(homedir(), 'projects', 'stam2');
}

// Why a spawn that wanted its own worktree may not use the resolved workspace `ws`, or null when it
// may (S-627, S-990). Only a type whose worktree default is true — the developer and the reviewer types
// — is held to it: one that ends up without a worktree (an explicit `worktree: false`, or a
// workspace script that printed the checkout) and whose final working directory is the live deploy
// checkout would commit there and hold every deploy (a reviewer's `git checkout` did, S-989). Other
// types are left alone: a manager is spawned with its parent's cwd, often the checkout. Reading
// the resolved `ws.cwd` is what catches a script started somewhere safe that printed the checkout.
export function spawnWorkspaceRefusal(type: AgentType | undefined, ws: Workspace): string | null {
  if (!typeWantsWorktree(type) || ws.worktree) return null;
  return liveCheckoutRefusal(ws.cwd);
}

// Why a spawn without a worktree can't work in `dir`, or null when it can (S-627). Refused when
// the git working tree `dir` is in is the live deploy checkout. A linked worktree inside the
// checkout is its own tree, so it isn't: the watcher's fast-forward of the checkout is what this
// protects, and only the checkout's own HEAD and files can hold it.
export function liveCheckoutRefusal(dir: string): string | null {
  let checkout: string;
  try {
    checkout = realpathSync(deployCheckout());
  } catch {
    return null;
  }
  let top: string;
  try {
    top = realpathSync(execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim());
  } catch {
    return null;
  }
  if (top !== checkout) return null;
  // A linked worktree isn't the checkout (S-1863) unless STAM_DEPLOY_REPO names it: the repo settings
  // default for a CLI or daemon run from a worktree's own copy is that worktree ("a checkout is its own").
  if (!process.env.STAM_DEPLOY_REPO && isLinkedWorktree(top)) return null;
  return `${dir} is in the live deploy checkout ${top}, the repo the deploy watcher deploys from, so an agent that works there without its own worktree would block every deploy. Pass worktree: true, or a cwd outside it.`;
}

// Removes what the agent owns. Throws if a worktree has uncommitted changes, unless forced.
export function cleanupWorkspace(ws: Workspace, force = false): string {
  if (!ws.worktree) return 'nothing to clean up';
  const { repo, path } = ws.worktree;
  if (!existsSync(path)) return 'worktree already gone';
  // The repo it was made from can be another agent's worktree, archived since (S-1049). Then git runs
  // against the repo's shared git dir, read from the worktree itself, which still exists.
  const git = existsSync(repo) ? ['-C', repo] : ['--git-dir', execFileSync('git', ['-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: 'pipe' }).trim()];
  execFileSync('git', [...git, 'worktree', 'remove', ...(force ? ['--force'] : []), path], { encoding: 'utf8', stdio: 'pipe' });
  return `removed worktree ${path}; branch ${ws.worktree.branch} kept`;
}

// A personal workspace (S-894): a folder an agent owns for its own notes and files, at
// STAM_HOME/workspaces/NAME. Separate from the working directory above, never a git repo or
// worktree, and never removed by archive, so a respawned specialist adopts the same folder.
export const WORKSPACES_DIR = join(STAM_HOME, 'workspaces');
// The same shape as an agent name: lowercase letters, digits and dashes.
const WORKSPACE_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

// The folder name a spawn's `workspace` option names: `true` is the agent's own name, a string
// names an existing or new workspace itself. Throws when the name isn't lowercase letters,
// digits and dashes, so the refusal comes before any folder or worktree exists.
export function personalWorkspaceName(value: true | string, agentName: string): string {
  const name = value === true ? agentName : String(value);
  if (!WORKSPACE_NAME.test(name)) throw new Error(`workspace name ${JSON.stringify(name)} must be lowercase letters, digits, and dashes`);
  return name;
}

// The absolute path of the personal workspace called `name`, whether or not it exists yet.
export function personalWorkspacePath(name: string): string {
  return join(WORKSPACES_DIR, name);
}

// Makes the personal workspace folder mode 0700 when it is missing and returns its absolute
// path. An existing folder (an archived specialist's) is reused as it is.
export function createPersonalWorkspace(name: string): string {
  const path = personalWorkspacePath(name);
  const existed = existsSync(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by the umask, so set it plainly the first time.
  if (!existed) chmodSync(path, 0o700);
  return path;
}

// One line for the spawn prompt (S-1662): what linking each package folder did, so an agent knows
// its deps are in, or that a fill is still running, and not to npm ci or symlink a live checkout.
export function depsReport(deps: DepsEvent[] | undefined): string {
  if (!deps?.length) return '';
  const by = (ev: DepsEvent['event']) => deps.filter((d) => d.event === ev);
  const names = (list: DepsEvent[]) => list.map((d) => (d.dir === '.' ? 'root' : d.dir)).join(', ');
  const parts: string[] = [];
  const linked = by('deps:linked');
  if (linked.length) parts.push(`linked: ${names(linked)} (lockfile ${[...new Set(linked.map((d) => d.key))].join(', ')})`);
  const warming = by('deps:warming');
  if (warming.length) parts.push(`warming: ${names(warming)} (a deps:linked event says when it is in; don't npm ci on ${MACHINE})`);
  const failed = by('deps:failed');
  if (failed.length) parts.push(`failed: ${names(failed)}`);
  return `Deps ${parts.join('; ')}. After a rebase or merge that changes package-lock.json, run \`stam deps relink\`.`;
}

// How a package folder's node_modules compares with its lockfile (S-1662). `symlink`: node_modules
// is a link leading outside the worktree (a live checkout's stale one). `stale`: the install's
// hidden lockfile lacks a package the lockfile needs, or holds another version (a rebase pulled in
// new deps). `missing`: a lockfile and no node_modules. `unknown`: no hidden lockfile to read.
export interface DepsStatus {
  dir: string;
  state: 'ok' | 'missing' | 'symlink' | 'stale' | 'unknown';
  detail?: string;
}

export function depsStatus(worktree: string, folders: string[] = DEPS_FOLDERS): DepsStatus[] {
  const out: DepsStatus[] = [];
  for (const rel of folders) {
    const dir = rel ? join(worktree, rel) : worktree;
    const label = rel || '.';
    if (!existsSync(join(dir, 'package.json')) || !existsSync(join(dir, 'package-lock.json'))) continue;
    const nm = join(dir, 'node_modules');
    let st;
    try {
      st = lstatSync(nm);
    } catch {
      out.push({ dir: label, state: 'missing' });
      continue;
    }
    if (st.isSymbolicLink()) {
      let real = '';
      try {
        real = realpathSync(nm);
      } catch {}
      const inside = real && (real === realpathSync(worktree) || real.startsWith(`${realpathSync(worktree)}/`));
      if (!inside) {
        out.push({ dir: label, state: 'symlink', detail: `node_modules links to ${real || readlinkSync(nm)}, outside the worktree` });
        continue;
      }
    }
    try {
      const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')).packages ?? {};
      const hidden = JSON.parse(readFileSync(join(nm, '.package-lock.json'), 'utf8')).packages ?? {};
      // A package the lockfile lists but the install lacks, or at another version. Packages that
      // npm skips on this platform (os/cpu) or marks optional may be absent from the install.
      const bad = Object.keys(lock).filter((k) => k && !lock[k].link && !lock[k].optional && !lock[k].os && !lock[k].cpu && hidden[k]?.version !== lock[k].version);
      if (bad.length) out.push({ dir: label, state: 'stale', detail: `${bad.length} package${bad.length === 1 ? '' : 's'} differ from package-lock.json (${bad.slice(0, 3).map((k) => k.replace(/^.*node_modules\//, '')).join(', ')}${bad.length > 3 ? ', ...' : ''})` });
      else out.push({ dir: label, state: 'ok' });
    } catch {
      out.push({ dir: label, state: 'unknown', detail: 'no readable node_modules/.package-lock.json' });
    }
  }
  return out;
}

// The warning pr_open and `stam deps relink` show for folders that aren't ok, or '' when all are.
export function depsWarning(worktree: string): string {
  const bad = depsStatus(worktree).filter((s) => s.state !== 'ok' && s.state !== 'unknown');
  if (!bad.length) return '';
  return `node_modules does not match package-lock.json in ${bad.map((s) => `${s.dir} (${s.state}${s.detail ? `: ${s.detail}` : ''})`).join('; ')}. Run \`stam deps relink\` and rerun your tests.`;
}

type RelinkResult = { dir: string; event: DepsEvent['event'] | 'ok'; key?: string; aside?: string };

// Relinks in flight, by worktree and folder (S-1706): a second call (another pr_open, or `stam deps
// relink`) while a cache miss is still installing joins the running one instead of racing its swap.
const relinking = new Map<string, Promise<RelinkResult>>();

// Re-runs the lockfile-keyed link for a worktree's folders whose node_modules isn't ok (S-1662), or
// every folder with `force`; `only` limits it to those folders (S-1706). The cache is filled first
// (fillDeps, awaited, no new npm ci path) and linked into node_modules.new-STAMP; only then is the
// old node_modules (a symlink is unlinked) moved aside to node_modules.old-STAMP (git-ignored; delete
// it when you like) and the new one renamed in, so the worktree never has a half-copied
// node_modules, and a failed install or link leaves the old one in place.
export async function relinkDeps(worktree: string, force = false, only?: string[]): Promise<RelinkResult[]> {
  const out: RelinkResult[] = [];
  for (const s of depsStatus(worktree)) {
    if (only && !only.includes(s.dir)) continue;
    if (s.state === 'ok' && !force) {
      out.push({ dir: s.dir, event: 'ok' });
      continue;
    }
    const id = `${realpathSync(worktree)}\0${s.dir}`;
    let p = relinking.get(id);
    if (!p) {
      p = relinkFolder(worktree, s).finally(() => relinking.delete(id));
      relinking.set(id, p);
    }
    out.push(await p);
  }
  return out;
}

async function relinkFolder(worktree: string, s: DepsStatus): Promise<RelinkResult> {
  const rel = s.dir === '.' ? '' : s.dir;
  const dir = rel ? join(worktree, rel) : worktree;
  const nm = join(dir, 'node_modules');
  let key: string | undefined;
  const stamp = `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${process.pid}-${randomBytes(3).toString('hex')}`;
  const fresh = `${nm}.new-${stamp}`;
  // The cache is filled, so this is a hit: link it like linkDeps does, with an async cp. A prune can remove an unused
  // entry between the fill and the link ('gone'): fill it again.
  let linked = false;
  for (let attempt = 0; attempt < 3 && !linked; attempt++) {
    key = undefined;
    try {
      key = await fillDeps(dir, true);
    } catch (e) {
      console.log(`deps: relink fill failed for ${dir}: ${e instanceof Error ? e.message : e}`);
    }
    if (!key) return { dir: s.dir, event: 'deps:failed' };
    const cache = depsCachePath(key);
    let outcome: LinkOutcome = 'failed';
    try {
      ensureCacheReadOnly(cache);
      outcome = await linkDepsOutcomeAsync(cache, fresh);
    } catch {}
    linked = outcome === 'linked';
    if (outcome !== 'gone') break;
  }
  if (!linked) {
    rmSync(fresh, { recursive: true, force: true });
    return { dir: s.dir, event: 'deps:failed', key };
  }
  // A folder that was missing and has one now (a spawn's background warm linked first): keep theirs.
  if (s.state === 'missing' && existsSync(nm)) {
    rmSync(fresh, { recursive: true, force: true });
    return { dir: s.dir, event: 'deps:linked', key };
  }
  let aside: string | undefined;
  let was: 'link' | 'dir' | undefined;
  try {
    if (lstatSync(nm, { throwIfNoEntry: false })) {
      if (lstatSync(nm).isSymbolicLink()) {
        was = 'link';
        aside = readlinkSync(nm);
        unlinkSync(nm);
      } else {
        was = 'dir';
        aside = `${nm}.old-${stamp}`;
        renameSync(nm, aside);
      }
    }
    renameSync(fresh, nm);
  } catch (e) {
    // Put the old install back, so a failed swap never leaves the worktree with none.
    rmSync(fresh, { recursive: true, force: true });
    try {
      if (!existsSync(nm) && !lstatSync(nm, { throwIfNoEntry: false })) {
        if (was === 'dir' && aside) renameSync(aside, nm);
        else if (was === 'link' && aside) symlinkSync(aside, nm);
      }
    } catch (e2) {
      console.log(`deps: could not restore ${nm}${aside ? ` from ${aside}` : ''}: ${e2 instanceof Error ? e2.message : e2}`);
    }
    console.log(`deps: relink swap failed for ${nm}: ${e instanceof Error ? e.message : e}`);
    return { dir: s.dir, event: 'deps:failed', key, aside: was === 'dir' && !existsSync(nm) ? aside : undefined };
  }
  touchDepsUsed(key!);
  return { dir: s.dir, event: 'deps:linked', key, aside: was === 'dir' ? aside : undefined };
}

// Whether `dir` is inside a worktree stam made for an agent (STAM_HOME/worktrees).
const inStamWorktrees = (dir: string): boolean => {
  try {
    return realpathSync(dir).startsWith(`${realpathSync(join(STAM_HOME, 'worktrees'))}/`);
  } catch {
    return false;
  }
};

// The deps warning pr_open shows (S-1662): only for the caller's own stam worktree, never the live deploy checkout.
export const prOpenDepsWarning = (cwd: string): string => (inStamWorktrees(cwd) && !liveCheckoutRefusal(cwd) ? depsWarning(cwd) : '');

// The relink pr_open runs itself (S-1706): every developer passes pr_open after the rebase or merge
// that can change package-lock.json, so it is the one hook that needs no agent to remember. Same
// guards as the warning (a stam worktree, never the live checkout) and the same relinkDeps, so no
// parallel path. Returns the note for the pr_open reply, or '' when nothing was stale. relinkDeps
// fills the cache before it touches node_modules, so the old install stays until the new one is
// ready. When a stale folder's cache is a miss (npm ci), the request doesn't wait for it: the relink
// carries on in the background and the note says so. A failed relink falls back to the S-1662 warning.
export async function prOpenDepsRelink(cwd: string): Promise<string> {
  if (!inStamWorktrees(cwd) || liveCheckoutRefusal(cwd)) return '';
  const bad = depsStatus(cwd).filter((s) => s.state !== 'ok' && s.state !== 'unknown').map((s) => s.dir);
  if (!bad.length) return '';
  const names = bad.join(', ');
  const miss = bad.some((d) => {
    const key = depsKey(d === '.' ? cwd : join(cwd, d), true);
    return Boolean(key) && !existsSync(join(depsCachePath(key as string), '.ready'));
  });
  const work = relinkDeps(cwd, false, bad).catch(() => undefined);
  if (miss) {
    work.then((r) => console.log(`deps: background relink of ${cwd}: ${r ? r.map((x) => `${x.dir} ${x.event}`).join(', ') : 'failed'}`));
    return `node_modules does not match package-lock.json in ${names}, and its cache isn't built yet, so the relink runs in the background (npm ci). The old install stays until the new one is ready, and it finishes by itself: when \`stam deps check\` is ok, rerun your tests.`;
  }
  const done = await work;
  if (done?.every((r) => r.event === 'deps:linked' || r.event === 'ok')) return `node_modules did not match package-lock.json in ${names}; relinked it. Rerun your tests.`;
  const left = done?.filter((r) => r.aside && r.event === 'deps:failed').map((r) => r.aside);
  return `${depsWarning(cwd)}${left?.length ? ` The previous install is at ${left.join(', ')}.` : ''}`;
}

// Why `stam deps relink` must not run in `top`, or null: never the live deploy checkout, and outside stam's worktrees only with force.
export function relinkRefusal(top: string, force = false): string | null {
  const live = liveCheckoutRefusal(top);
  if (live) return `${top} is the live deploy checkout; relink only works in an agent's worktree.`;
  if (!inStamWorktrees(top) && !force) return `${top} is not a stam worktree (${join(STAM_HOME, 'worktrees')}); pass --force to relink here anyway.`;
  return null;
}
