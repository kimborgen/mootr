import { readdirSync, readFileSync, realpathSync, rmSync, readlinkSync, lstatSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm } from 'node:fs/promises';
import { STAM_HOME } from './config.ts';
import { testHome } from './test-env.ts';

const execFileAsync = promisify(execFile);
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// The processes an agent started, so archive and shutdown can stop them (S-323): the tree
// under its pane, and every process that carries its STAM_AGENT_ID. A sandbox's children
// (Codex runs commands under bwrap --new-session) leave the pane's process group, and a
// process whose parent died is reparented out of the tree, but the env goes with both.
// Shared infrastructure an agent may have started (a stam daemon, a tmux server) and
// another agent's processes are never its own, and neither is anything under them.
// A pid reused between the check and the kill can still be hit (signalProcesses).
// Linux only (/proc); elsewhere only the tree's group signal in tmux.killSession applies.

type Stat = { ppid: number; start: string; state: string };

function stat(pid: number): Stat | undefined {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm may hold spaces and parens; fields resume after the last ')'.
    const rest = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return { ppid: Number(rest[1]), start: rest[19], state: rest[0] };
  } catch {
    return undefined;
  }
}

// The start time of a process, to pair with its pid for signalProcesses.
export const procStart = (pid: number): string | undefined => stat(pid)?.start;

function agentIdOf(pid: number): string | undefined {
  try {
    const kv = readFileSync(`/proc/${pid}/environ`, 'utf8')
      .split('\0')
      .find((e) => e.startsWith('STAM_AGENT_ID='));
    return kv?.slice('STAM_AGENT_ID='.length);
  } catch {
    return undefined;
  }
}

// A stam daemon (`… stam|cli.ts daemon run`), by its command line.
export function isStamDaemon(pid: number): boolean {
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    const i = argv.indexOf('daemon');
    return i > 0 && argv[i + 1] === 'run' && /(^|\/)(stam|cli\.ts)$/.test(argv[i - 1]);
  } catch {
    return false;
  }
}

// A stam daemon or a tmux server, which agents share.
function infrastructure(pid: number): boolean {
  try {
    if (readFileSync(`/proc/${pid}/comm`, 'utf8').trim() === 'tmux: server') return true;
  } catch {
    return false;
  }
  return isStamDaemon(pid);
}

// The pids to stop for agent `id`, each with its start time, so a later signal can check it
// is still that process: `panePid` and its descendants when given, and every process whose
// env names `id`. Protected are shared infrastructure and another agent's processes, and
// everything under them, in both: a daemon the agent ran by hand passes its id on to its
// children, which are the daemon's. Never this process, its ancestors, or the pids in `spare`.
export function agentProcesses(id: string, panePid?: number, spare: number[] = []): Map<number, string> {
  const all = new Map<number, Stat>();
  let names: string[] = [];
  try {
    names = readdirSync('/proc');
  } catch {}
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    const s = stat(Number(n));
    if (s) all.set(Number(n), s);
  }
  const keep = new Set(spare);
  for (let p = process.pid, i = 0; p > 1 && i < 1000; p = all.get(p)?.ppid ?? 0, i++) keep.add(p);
  const ids = new Map<number, string | undefined>();
  const idOf = (pid: number) => (ids.has(pid) ? ids.get(pid) : ids.set(pid, agentIdOf(pid)).get(pid));
  const root = (pid: number) => {
    const owner = idOf(pid);
    return (!!owner && owner !== id) || infrastructure(pid);
  };
  // Whether pid is protected: a root, or below one before the pane (the agent's own tree).
  const below = new Map<number, boolean>();
  const isProtected = (pid: number): boolean => {
    const path: number[] = [];
    let found = false;
    for (let p = pid; p > 1 && p !== panePid && path.length < 1000; p = all.get(p)?.ppid ?? 0) {
      const known = below.get(p);
      if (known !== undefined) {
        found = known;
        break;
      }
      path.push(p);
      if (root(p)) {
        found = true;
        break;
      }
    }
    // Each process on the path lies above the root found, or none was found: one answer for all.
    for (const q of path) below.set(q, found);
    return found;
  };
  const out = new Map<number, string>();
  const add = (pid: number) => {
    const s = all.get(pid);
    if (s && pid > 1 && !keep.has(pid)) out.set(pid, s.start);
  };
  if (panePid && all.has(panePid)) {
    const children = new Map<number, number[]>();
    for (const [pid, s] of all) {
      const c = children.get(s.ppid);
      if (c) c.push(pid);
      else children.set(s.ppid, [pid]);
    }
    const todo = [panePid];
    while (todo.length) {
      const pid = todo.pop()!;
      if (pid !== panePid && root(pid)) continue;
      add(pid);
      todo.push(...(children.get(pid) ?? []));
    }
  }
  for (const pid of all.keys()) if (!out.has(pid) && idOf(pid) === id && !isProtected(pid)) add(pid);
  return out;
}

// S-428: the processes of agent `id` that lie in the directory `dir` when it is archived: a cwd
// inside it, or a path inside it in the command line. Only the agent's own are taken: a process
// that carries its STAM_AGENT_ID (what it started and left), or a test's (STAM_HOME in a stam-test.*
// or stam-* test folder, which `lib.sh` and tempHome give a daemon without the agent's id). A person's
// shell or editor in the folder, another agent's process, this process and its ancestors, and a tmux
// server that isn't a test's own (socket `stam-test-*`) are spared.
export function dirProcesses(dir: string, id: string): Map<number, string> {
  const out = new Map<number, string>();
  let root: string;
  try {
    root = realpathSync(dir);
  } catch {
    return out;
  }
  const inside = (p: string) => p === root || p.startsWith(root + '/');
  const keep = new Set<number>();
  for (let p = process.pid, i = 0; p > 1 && i < 1000; p = stat(p)?.ppid ?? 0, i++) keep.add(p);
  let names: string[] = [];
  try {
    names = readdirSync('/proc');
  } catch {}
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    const pid = Number(n);
    if (pid <= 1 || keep.has(pid)) continue;
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      let hit = false;
      try {
        hit = inside(realpathSync(`/proc/${pid}/cwd`));
      } catch {}
      hit = hit || argv.some((a) => inside(a) || a.includes(`=${root}/`) || a.includes(` ${root}/`) || a.includes(`'${root}/`));
      if (!hit) continue;
      const env = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
      const owner = env.find((e) => e.startsWith('STAM_AGENT_ID='))?.slice('STAM_AGENT_ID='.length);
      const home = env.find((e) => e.startsWith('STAM_HOME='))?.slice('STAM_HOME='.length) ?? '';
      if (owner ? owner !== id : !/(^|\/)stam-[^/]*/.test(home)) continue;
      if (readFileSync(`/proc/${pid}/comm`, 'utf8').trim() === 'tmux: server' && !argv.some((a) => a.startsWith('stam-test-'))) continue;
      const s = stat(pid);
      if (s) out.set(pid, s.start);
    } catch {}
  }
  return out;
}

// Sends `signal` to each pid whose start time, read right before the signal, still matches.
// A known limitation (accepted in S-323's review): Node has no pidfd, so a pid that exits and
// is reused between that read and the kill would still be signalled.
export function signalProcesses(pids: Map<number, string>, signal: NodeJS.Signals): number {
  let sent = 0;
  for (const [pid, start] of pids) {
    if (stat(pid)?.start !== start) continue;
    try {
      process.kill(pid, signal);
      sent++;
    } catch {}
  }
  return sent;
}

// A SIGTERM now, and a SIGKILL `graceMs` later for those still running.
export function stopProcesses(pids: Map<number, string>, graceMs = 5000): void {
  if (!pids.size || !signalProcesses(pids, 'SIGTERM')) return;
  setTimeout(() => signalProcesses(pids, 'SIGKILL'), graceMs).unref();
}

// S-358: the headless compactors running on agent `id`'s session, each with its start time: a
// daemon restart cuts them off from the daemon that started them. One is a process whose command
// line resumes `session` in print mode (`-p … --resume SESSION`), and that carries
// STAM_COMPACTOR=ID:… or, started before that marker existed, runs in the agent's workspace `cwd`.
export function compactorProcesses(id: string, session: string, cwd: string): Map<number, string> {
  const out = new Map<number, string>();
  let names: string[] = [];
  try {
    names = readdirSync('/proc');
  } catch {}
  for (const n of names) {
    if (!/^\d+$/.test(n) || Number(n) === process.pid) continue;
    const pid = Number(n);
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      const r = argv.indexOf('--resume');
      if (r < 0 || argv[r + 1] !== session || !argv.includes('-p')) continue;
      const marker = readFileSync(`/proc/${pid}/environ`, 'utf8')
        .split('\0')
        .find((e) => e.startsWith('STAM_COMPACTOR='));
      const mine = marker ? marker.slice('STAM_COMPACTOR='.length).split(':')[0] === id : realpathSync(`/proc/${pid}/cwd`) === realpathSync(cwd);
      const s = mine && stat(pid);
      if (s) out.set(pid, s.start);
    } catch {}
  }
  return out;
}

// Stops `pids` and resolves once each has exited: SIGTERM, then SIGKILL after `graceMs`. Rejects
// when one still runs after that.
export async function stopAndConfirm(pids: Map<number, string>, graceMs = 5000): Promise<void> {
  // A zombie has exited; only its parent's wait is left.
  const alive = () =>
    [...pids]
      .filter(([pid, start]) => {
        const s = stat(pid);
        return s?.start === start && s.state !== 'Z';
      })
      .map(([pid]) => pid);
  const gone = async (ms: number) => {
    for (const end = Date.now() + ms; alive().length && Date.now() < end; ) await new Promise((r) => setTimeout(r, 50));
    return !alive().length;
  };
  signalProcesses(pids, 'SIGTERM');
  if (await gone(graceMs)) return;
  signalProcesses(pids, 'SIGKILL');
  if (!(await gone(2000))) throw new Error(`process ${alive().join(', ')} still runs after SIGKILL`);
}

// S-604: Claude Code keeps a scratch dir per cwd under /tmp/claude-<uid>/, named after the cwd with
// every non-alphanumeric character turned into '-'. It is the base `STAM_CLAUDE_TMP` overrides.
export const claudeSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-');
const claudeTmpBase = (): string => process.env.STAM_CLAUDE_TMP ?? `/tmp/claude-${process.getuid?.() ?? 0}`;

// True when a process has its cwd or an open file inside `dir` (a /proc scan).
export function dirInUse(dir: string): boolean {
  const inside = (p: string) => p === dir || p.startsWith(dir + '/');
  let names: string[] = [];
  try {
    names = readdirSync('/proc');
  } catch {}
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    try {
      if (inside(readlinkSync(`/proc/${n}/cwd`))) return true;
    } catch {}
    try {
      for (const fd of readdirSync(`/proc/${n}/fd`)) {
        try {
          if (inside(readlinkSync(`/proc/${n}/fd/${fd}`))) return true;
        } catch {}
      }
    } catch {}
  }
  return false;
}

// The main checkout, whose Claude scratch dir the janitor never takes: STAM_REPO, else the repo
// settings name for stam2 (a release's checkout, or the checkout a dev daemon runs from; the
// caller passes it, since this module must not import settings.ts: the CLI loads it, and
// settings pulls in the adapters and their npm deps, which a first deploy hasn't installed), else
// ~/projects/stam2.
function mainCheckout(settingsRepo?: string): string {
  if (process.env.STAM_REPO) return process.env.STAM_REPO;
  if (settingsRepo) return settingsRepo;
  return join(homedir(), 'projects', 'stam2');
}

// Removes the Claude Code scratch dir of an archived agent whose cwd was `cwd`, unless another live
// agent shares the slug (`liveCwds`), the slug is the home dir's or the live checkout's (shared by
// cos and others), or a process uses the dir. Only a direct child of the base dir is ever removed.
// Returns what happened; never throws.
export function removeClaudeScratch(cwd: string, liveCwds: string[], settingsRepo?: string): string {
  try {
    const base = resolve(claudeTmpBase());
    const slug = claudeSlug(cwd);
    const dir = join(base, slug);
    if (!slug || dirname(dir) !== base || resolve(dir) !== dir) return `scratch dir ${dir}: refused, not a direct child of ${base}`;
    const protectedSlugs = [homedir(), mainCheckout(settingsRepo)].map(claudeSlug);
    if (protectedSlugs.includes(slug)) return `scratch dir ${dir}: kept, shared`;
    if (liveCwds.some((c) => claudeSlug(c) === slug)) return `scratch dir ${dir}: kept, another agent uses its cwd`;
    try {
      if (!lstatSync(dir).isDirectory()) return `scratch dir ${dir}: not a directory`;
    } catch {
      return 'no scratch dir';
    }
    if (dirInUse(dir)) return `scratch dir ${dir}: kept, a process uses it`;
    rmSync(dir, { recursive: true, force: true });
    return `removed scratch dir ${dir}`;
  } catch (e) {
    return `scratch dir: ${e instanceof Error ? e.message : e}`;
  }
}

// S-733: reviewers and managers make git worktrees of the main checkout under ~/.cache/stam-wt/NAME
// and scratch clones under ~/.cache/stam-test/NAME (NAME is the agent's name), and test homes named
// stam-test.AGENT_ID.RAND. Removes those an archived agent made: a worktree through `git worktree
// remove --force` from its main repo (the metadata goes too), a plain clone with rm -rf. Never
// another agent's dir (exact name match only), a dir a live agent's cwd or workspace lies in
// (`liveDirs`), a dir a process uses, a symlink, or anything outside the two base folders.
// Returns one line per dir; never throws. Async, so a slow git or a big rm doesn't block the daemon.
// Without `bases` it uses the real ~/.cache folders and does nothing in a test home (a test daemon
// archiving a fake agent must not touch a real agent's dir of the same name).
export async function removeAgentScratchDirs(agent: { id: string; name: string }, liveDirs: string[], bases?: string[]): Promise<string[]> {
  if (!bases && testHome(STAM_HOME)) return [];
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  const roots = (bases ?? [join(cache, 'stam-wt'), join(cache, 'stam-test')]).map((b) => resolve(b));
  const out: string[] = [];
  const real = (p: string) => {
    try { return realpathSync(p); } catch { return resolve(p); }
  };
  const live = liveDirs.filter(Boolean).map(real);
  const protectedDirs = [homedir(), mainCheckout(), join(homedir(), 'projects')].map(real);
  for (const base of roots) {
    let names: string[] = [];
    try { names = readdirSync(base); } catch { continue; }
    for (const n of names) {
      if (n !== agent.name && !(n.startsWith(`stam-test.${agent.id}.`) && n.length > `stam-test.${agent.id}.`.length)) continue;
      const dir = join(base, n);
      try {
        if (dirname(dir) !== base || !lstatSync(dir).isDirectory()) {
          out.push(`${dir}: kept, not a plain directory`);
          continue;
        }
        const rd = real(dir);
        if (protectedDirs.some((p) => rd === p || p.startsWith(rd + '/') || rd.startsWith(join(homedir(), 'projects') + '/'))) {
          out.push(`${dir}: refused, protected`);
          continue;
        }
        if (live.some((l) => l === rd || l.startsWith(rd + '/'))) {
          out.push(`${dir}: kept, a live agent works in it`);
          continue;
        }
        if (dirInUse(rd)) {
          out.push(`${dir}: kept, a process uses it`);
          continue;
        }
        let removedByGit = false;
        try {
          if (lstatSync(join(dir, '.git')).isFile()) {
            const common = (await execFileAsync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeout: 10000 })).stdout.trim();
            await execFileAsync('git', ['--git-dir', common, 'worktree', 'remove', '--force', '--force', dir], { timeout: 60000 });
            removedByGit = true;
          }
        } catch {}
        await rm(dir, { recursive: true, force: true });
        out.push(`removed ${removedByGit ? 'worktree' : 'dir'} ${dir}`);
      } catch (e) {
        out.push(`${dir}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  return out;
}

// S-912: a reviewer's own clone, exactly ~/.cache/stam-review/<agent name> (exported to it as
// STAM_REVIEW_DIR). Null for a name that isn't one plain path segment, so no name can reach a
// sibling or leave the root.
export const reviewRoot = () => join(homedir(), '.cache', 'stam-review');
export function reviewDirOf(name: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return null;
  const dir = join(reviewRoot(), name);
  return dirname(dir) === reviewRoot() ? dir : null;
}

// The checks a reviewer's clone and its test folder share before removal (S-912, S-1330): refuse a path
// whose real location isn't directly inside `base`, stop what runs in `dir`, then keep it while a live
// agent works in it or a process uses it. Returns the message to report when `dir` must stay, else null.
async function keptOrRefused(dir: string, base: string, a: { id: string; name: string }, liveDirs: string[]): Promise<string | null> {
  const rd = realpathSync(dir);
  if (dirname(rd) !== realpathSync(base)) return `refused: ${dir} resolves outside ${base}`;
  await stopAndConfirm(dirProcesses(dir, a.id)).catch((e) => console.error(`archive ${a.name}: ${e.message}`));
  const live = liveDirs.filter(Boolean).map((p) => {
    try { return realpathSync(p); } catch { return resolve(p); }
  });
  if (live.some((l) => l === rd || l.startsWith(rd + '/'))) return `${dir}: kept, a live agent works in it`;
  if (dirInUse(rd)) return `${dir}: kept, a process uses it`;
  return null;
}

// Archive of a reviewer: stop what runs in its review dir, then remove it (`git worktree remove
// --force` when it is a linked worktree, else rm -rf). Touches only this agent's dir, refuses a
// symlink or a path whose real location isn't directly inside the root, keeps it while a live
// agent works in it or another process uses it, and never throws. Without `root` it uses the real
// ~/.cache/stam-review and does nothing in a test home (a test daemon archiving a fake reviewer
// must not touch a real agent's dir of the same name).
export async function removeReviewDir(a: { id: string; name: string }, liveDirs: string[] = [], root?: string): Promise<string> {
  if (!root && testHome(STAM_HOME)) return 'no review dir';
  const base = root ?? reviewRoot();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(a.name)) return 'no review dir';
  const dir = join(base, a.name);
  try {
    let st;
    try {
      st = lstatSync(dir);
    } catch {
      return 'no review dir';
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return `refused: ${dir} is not a plain directory`;
    const kept = await keptOrRefused(dir, base, a, liveDirs);
    if (kept) return kept;
    try {
      if (lstatSync(join(dir, '.git')).isFile()) await execFileAsync('git', ['-C', dir, 'worktree', 'remove', '--force', dir], { timeout: 60000 });
    } catch {}
    await rm(dir, { recursive: true, force: true });
    return `removed ${dir}`;
  } catch (e) {
    return `${dir}: ${e instanceof Error ? e.message : e}`;
  }
}

// S-1330: a reviewer's test folder (STAM_TEST_TMPDIR), `.tmp-NAME` beside its clone in the same root.
// The leading dot keeps it out of the agent-name space, so it never is another agent's clone.
export const reviewTmpDirOf = (name: string): string | null => {
  const dir = reviewDirOf(name);
  return dir ? join(dirname(dir), `.tmp-${name}`) : null;
};

// The test folder to create and export at spawn, or null: none when the spec already sets
// STAM_TEST_TMPDIR, or in a test home, where a test daemon would leak `.tmp-NAME` into the real root.
export function reviewTmpForSpawn(name: string, env: Record<string, string>, home = STAM_HOME): string | null {
  if (env.STAM_TEST_TMPDIR || testHome(home)) return null;
  return reviewTmpDirOf(name);
}

// Archive of a reviewer's test folder: the same rules as removeReviewDir (a plain directory directly
// inside the root, never a symlink, kept while a live agent or process uses it, never throws). Without
// `root` it does nothing in a test home.
export async function removeReviewTmpDir(a: { id: string; name: string }, liveDirs: string[] = [], root?: string): Promise<string> {
  if (!root && testHome(STAM_HOME)) return 'no review tmp dir';
  const base = root ?? reviewRoot();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(a.name)) return 'no review tmp dir';
  const dir = join(base, `.tmp-${a.name}`);
  try {
    let st;
    try {
      st = lstatSync(dir);
    } catch {
      return 'no review tmp dir';
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return `refused: ${dir} is not a plain directory`;
    const kept = await keptOrRefused(dir, base, a, liveDirs);
    if (kept) return kept;
    await rm(dir, { recursive: true, force: true });
    return `removed ${dir}`;
  } catch (e) {
    return `${dir}: ${e instanceof Error ? e.message : e}`;
  }
}
