// The PR head mirror (S-1347): each PR's head is pushed to storage's bare repo as refs/pull/N/head, so a
// storage reviewer fetches any PR without GitHub. pr_open mirrors the head it opened or updated; a GitHub
// event (pull_request.opened, .reopened or .synchronize), or the poll's first sight of an open PR, mirrors a PR
// opened outside pr_open, its head fetched from GitHub first. Only that ref is written, with `+SHA:refs/pull/N/head`, never a branch, and only the bare
// repo (the storage remote). A failed or slow mirror is logged and never thrown, and nothing waits on it.
//
// Main (S-1389): a GitHub `pull_request.merged` event mirrors GitHub's main to the bare repo's refs/heads/main, so
// storage can base on a just-merged PR before the deploy. Fast-forward only, never a force; the deploy still moves
// the live checkout. It shares the per-key queue, deadline and process-group kill below.
//
// Latest wins, per PR: one job runs at a time, and a request made while it runs replaces the pending one
// rather than queueing behind it, so a backlog never builds. Each job has one deadline, which kills the git
// command it is running and starts no other. A job that finds a newer request waiting skips its push.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { MACHINE } from './config.ts';
import { settings, storageRemoteFallback } from './settings.ts';
import { envVar } from './env.ts';

// A job's whole deadline. STAM_MIRROR_TIMEOUT_MS overrides it (tests).
const budgetMs = (): number => Number(envVar('MIRROR_TIMEOUT_MS')) || 30_000;
// After the deadline's TERM, a process group gets KILL this long later.
const KILL_GRACE_MS = 2_000;

// The checkout a mirror runs in: its path, its origin (GitHub) remote, its storage remote ('' = none, or the
// `storage` remote when the checkout has one), and the GitHub repo (OWNER/NAME) the origin is.
export interface MirrorConfig {
  repo: string;
  origin: string;
  storage: string;
  github: string;
}

// Runs git in its own process group, so a deadline reaches the whole tree (a push's ssh too). On abort the group
// gets TERM, then KILL after KILL_GRACE_MS, and the promise settles only on the child's `close`: nothing from this
// command is still running when it settles.
function runGit(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('gave up at the deadline'));
    const child = spawn('git', args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const signalGroup = (sig: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, sig);
      } catch {
        // The group is already gone.
      }
    };
    let killer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      signalGroup('SIGTERM');
      killer = setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => reject(new Error(`git ${args[0]} failed: ${e.message}`)));
    child.on('close', (code) => {
      clearTimeout(killer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) reject(new Error('gave up at the deadline'));
      else if (code === 0) resolve(stdout.trim());
      else reject(new Error(`git ${args[0]} failed: ${stderr.trim() || `exit ${code}`}`));
    });
  });
}

async function git(cfg: MirrorConfig, args: string[], signal?: AbortSignal): Promise<string> {
  return runGit(cfg.repo, args, signal);
}

// Refuses a PR number that isn't a positive safe integer, and a head that isn't a full sha, before any refspec is built.
export function checkNumber(number: number): void {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`PR number ${number} is not a positive integer`);
}

export function checkMirror(number: number, sha: string): void {
  checkNumber(number);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`head ${sha} is not a 40-character sha`);
}

// The remote the branch is fetched from and the mirror pushes to: the configured name, else `storage` when the
// checkout has that remote and a `storage` peer is configured (settings.ts storageRemoteFallback), else '' (no storage, so no mirror).
export async function storageRemote(cfg: MirrorConfig, signal?: AbortSignal): Promise<string> {
  return cfg.storage || storageRemoteFallback((await git(cfg, ['remote'], signal)).split('\n'));
}

// One mirror request. `sha` is the head the checkout holds (pr_open); without it the head is fetched from origin
// (a GitHub event). `main` asks for GitHub's main to be mirrored instead of a PR head (S-1389).
type Want =
  | { cfg: MirrorConfig; number: number; sha?: string; main?: false; what: string }
  | { cfg: MirrorConfig; main: true; what: string };

const keyOf = (want: Want): string => (want.main === true ? `${want.cfg.repo}#main` : `${want.cfg.repo}#${want.number}`);

// Per PR: the job running (if any), the request waiting behind it, and a promise that settles when the PR is idle.
interface Slot {
  pending: Want | null;
  done: Promise<void>;
  resolve: () => void;
}
const slots = new Map<string, Slot>();

// Asks for a mirror. Returns a promise that settles once the PR has no job left, which pr_open never waits on.
function request(want: Want): Promise<void> {
  const key = keyOf(want);
  const slot = slots.get(key);
  if (slot) {
    slot.pending = want;
    return slot.done;
  }
  let resolve!: () => void;
  const fresh: Slot = { pending: want, done: new Promise<void>((r) => (resolve = r)), resolve };
  slots.set(key, fresh);
  void drain(key, fresh);
  return fresh.done;
}

async function drain(key: string, slot: Slot): Promise<void> {
  // A burst of requests in one tick becomes one job, for the last of them.
  await new Promise((r) => setImmediate(r));
  while (slot.pending) {
    const want = slot.pending;
    slot.pending = null;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), budgetMs());
    try {
      await mirror(want, ac.signal, () => slot.pending !== null);
    } catch (e) {
      console.error(`pr head mirror: ${want.what} not mirrored: ${e instanceof Error ? e.message : e}`);
    } finally {
      clearTimeout(timer);
    }
  }
  slots.delete(key);
  slot.resolve();
}

// One job: resolves the head, skips the push if a newer request is waiting, then pushes.
async function mirror(want: Want, signal: AbortSignal, superseded: () => boolean): Promise<void> {
  if (want.main === true) return mirrorMainJob(want.cfg, signal, superseded);
  const { cfg, number } = want;
  checkNumber(number);
  let scratch: string | null = null;
  try {
    let sha = want.sha;
    if (sha === undefined) {
      scratch = `refs/stam/pr-mirror/${number}-${randomBytes(4).toString('hex')}`;
      await git(cfg, ['fetch', '--no-tags', cfg.origin, `+refs/pull/${number}/head:${scratch}`], signal);
      sha = await git(cfg, ['rev-parse', '--verify', scratch], signal);
    }
    checkMirror(number, sha);
    if (superseded()) return;
    const storage = await storageRemote(cfg, signal);
    if (!storage) return;
    await git(cfg, ['push', storage, `+${sha}:refs/pull/${number}/head`], signal);
  } finally {
    // No signal here: deleting the scratch ref is quick, and it must happen even after the deadline.
    if (scratch) await git(cfg, ['update-ref', '-d', scratch]).catch(() => {});
  }
}

// Whether `a` is an ancestor of `b`. git's "no" (exit 1) is false; a deadline is rethrown. Any other failure is also
// false, so the caller skips rather than moves a branch it could not check.
async function isAncestor(cfg: MirrorConfig, a: string, b: string, signal: AbortSignal): Promise<boolean> {
  try {
    await git(cfg, ['merge-base', '--is-ancestor', a, b], signal);
    return true;
  } catch (e) {
    if (signal.aborted) throw e;
    return false;
  }
}

// One main job (S-1389): GitHub's main goes to storage's refs/heads/main, only when storage's main is an ancestor of
// it. Both shas come into scratch refs of this run, deleted after, as the PR job's scratch ref is.
async function mirrorMainJob(cfg: MirrorConfig, signal: AbortSignal, superseded: () => boolean): Promise<void> {
  const tag = randomBytes(4).toString('hex');
  const github = `refs/stam/pr-mirror/main-${tag}`;
  const theirs = `refs/stam/pr-mirror/storage-main-${tag}`;
  try {
    await git(cfg, ['fetch', '--no-tags', cfg.origin, `+refs/heads/main:${github}`], signal);
    const sha = await git(cfg, ['rev-parse', '--verify', github], signal);
    if (superseded()) return;
    const storage = await storageRemote(cfg, signal);
    if (!storage) return;
    await git(cfg, ['fetch', '--no-tags', storage, `+refs/heads/main:${theirs}`], signal);
    const current = await git(cfg, ['rev-parse', '--verify', theirs], signal);
    if (current === sha) return;
    if (!(await isAncestor(cfg, current, sha, signal))) {
      console.error(`pr head mirror: storage's main ${current.slice(0, 7)} is not behind GitHub's main ${sha.slice(0, 7)}; not moved`);
      return;
    }
    // No `+`: git refuses a non-fast-forward too, so a main that moved on storage meanwhile is never overwritten.
    await git(cfg, ['push', storage, `${sha}:refs/heads/main`], signal);
  } finally {
    // No signal here, as for the PR job's scratch ref. A ref that was never made fails to delete, which is fine.
    await git(cfg, ['update-ref', '-d', github]).catch(() => {});
    await git(cfg, ['update-ref', '-d', theirs]).catch(() => {});
  }
}

// Settles once no PR has a mirror job or a request waiting: for tests, and for a caller that must know the storage
// refs are final.
export async function mirrorsIdle(): Promise<void> {
  while (slots.size) await Promise.all([...slots.values()].map((s) => s.done));
}

// pr_open's mirror: `sha` is the head the checkout holds, which pr_open has just pushed to origin.
export function mirrorPrHead(cfg: MirrorConfig, number: number, sha: string): Promise<void> {
  return request({ cfg, number, sha, what: `PR #${number}` });
}

const PR_SUBJECT = /^github:([^/#\s]+\/[^/#\s]+)#(\d+)$/;

// Mirrors the head GitHub holds now for the PR a `github:OWNER/REPO#N` subject names. A subject of another repo,
// or one that isn't a PR, does nothing.
export function mirrorPrFromEvent(cfg: MirrorConfig, subject: string): Promise<void> {
  const m = PR_SUBJECT.exec(subject);
  if (!m || m[1].toLowerCase() !== cfg.github.toLowerCase()) return Promise.resolve();
  return request({ cfg, number: Number(m[2]), what: subject });
}

// GitHub's main to storage's refs/heads/main, fast-forward only (S-1389). Settles when no main job is left.
export function mirrorMain(cfg: MirrorConfig): Promise<void> {
  return request({ cfg, main: true, what: 'main' });
}

// The daemon's wiring for a poll's events: only on the ITSA home (where origin is GitHub), for the checkout
// settings.itsa.prOpen names. pr-open is loaded lazily, so the poller doesn't pull in the PR relay at start.
// Never rejects.
async function onHome(what: string, run: (cfg: MirrorConfig) => Promise<void>): Promise<void> {
  if ((settings().itsa.home ?? MACHINE) !== MACHINE) return;
  try {
    const { prOpenConfig } = await import('./pr-open.ts');
    await run(prOpenConfig());
  } catch (e) {
    console.error(`pr head mirror: ${what} not mirrored to storage: ${e instanceof Error ? e.message : e}`);
  }
}

export function mirrorEventPr(subject: string): Promise<void> {
  return onHome(subject, (cfg) => mirrorPrFromEvent(cfg, subject));
}

// A poll saw a PR merge (S-1389): GitHub's main goes to storage now, not at the deploy.
export function mirrorEventMain(): Promise<void> {
  return onHome('main', (cfg) => mirrorMain(cfg));
}
