// The merge queue's data (S-40): the ITSAs in `ready_to_merge` that link a branch, each with
// the facts computed from the branch's repo on this daemon: the diff against the main branch
// (files, insertions, deletions), whether it merges cleanly, its head, and how far behind main
// it is. Read-only: nothing here changes a branch, a working tree, or an ITSA. Merging stays
// with the managers (scripts/merge-pr.mjs).
//
// A branch link names its repo only by a name in settings.itsa.repos, never a path, so git
// only ever runs in a repo the operator configured. git runs async with a timeout, and the
// branches are read in parallel, so a slow repo can't hold up the daemon.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as db from './db.ts';
import { settings } from './settings.ts';
import { links, validBranch, type LinkMeta } from './itsa.ts';
import * as requirements from './requirements.ts';

const run = promisify(execFile);
// A git call that runs longer than this is given up, and its branch row says so.
export const GIT_TIMEOUT_MS = 15_000;

export interface BranchFacts {
  repo: string;
  branch: string;
  // The configured path of the repo, or null when the name isn't configured.
  path: string | null;
  head: string | null;
  diff: { files: number; insertions: number; deletions: number } | null;
  mergeable: boolean | null;
  behind: number | null;
  error: string | null;
}

async function git(path: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', path, ...args], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 1 << 20 });
  return stdout.trim();
}

// The path a configured repo name resolves to, or null.
export function repoPath(repo: string): string | null {
  return settings().itsa.repos[repo] ?? null;
}

// The facts for one branch against the configured main branch. Each fact that can't be
// computed is null, and `error` says why the branch couldn't be read.
export async function branchFacts(repo: string, branch: string): Promise<BranchFacts> {
  const main = settings().itsa.mainBranch;
  const out: BranchFacts = { repo, branch, path: repoPath(repo), head: null, diff: null, mergeable: null, behind: null, error: null };
  if (!out.path) return { ...out, error: `repo ${repo} is not configured in settings.itsa.repos` };
  if (!validBranch(branch)) return { ...out, error: `branch ${branch} is not a valid branch name` };
  const path = out.path;
  const ref = (b: string) => `refs/heads/${b}`;
  const timedOut = (e: unknown) => (e as { killed?: boolean }).killed === true;
  try {
    out.head = (await git(path, ['rev-parse', '--verify', '--quiet', `${ref(branch)}^{commit}`])) || null;
  } catch (e) {
    return { ...out, error: timedOut(e) ? `git timed out in ${repo}` : `no branch ${branch} in ${repo}` };
  }
  try {
    const stat = await git(path, ['diff', '--shortstat', `${ref(main)}...${ref(branch)}`]);
    const num = (re: RegExp) => Number(re.exec(stat)?.[1] ?? 0);
    out.diff = { files: num(/(\d+) files? changed/), insertions: num(/(\d+) insertions?/), deletions: num(/(\d+) deletions?/) };
    out.behind = Number(await git(path, ['rev-list', '--count', `${ref(branch)}..${ref(main)}`]));
  } catch (e) {
    out.error = timedOut(e) ? `git timed out in ${repo}` : `cannot compare ${branch} with ${main}`;
  }
  // merge-tree writes the merge as a tree object only, touching no working tree: exit 0 is a
  // clean merge, 1 a conflict.
  try {
    await git(path, ['merge-tree', '--write-tree', '--no-messages', ref(main), ref(branch)]);
    out.mergeable = true;
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code === 1) out.mergeable = false;
    else out.error ??= timedOut(e) ? `git timed out in ${repo}` : `cannot check the merge with ${main}`;
  }
  return out;
}

// The diff of a branch against the main branch as text, split by file, with the branch's head.
// The same async, timeout-bound git call as the facts; null when the repo or branch can't be read.
export async function branchDiff(repo: string, branch: string): Promise<{ head: string; files: { path: string; text: string }[] } | null> {
  const path = repoPath(repo);
  if (!path || !validBranch(branch)) return null;
  const main = settings().itsa.mainBranch;
  try {
    const head = await git(path, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
    const { stdout } = await run('git', ['-C', path, 'diff', '--no-color', `refs/heads/${main}...refs/heads/${branch}`], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 16 << 20 });
    const files = stdout
      .split(/^(?=diff --git )/m)
      .filter((t) => t.startsWith('diff --git '))
      .map((text) => ({ path: /^diff --git a\/.+? b\/(.+)$/m.exec(text)?.[1] ?? '', text }))
      .filter((f) => f.path);
    return { head, files };
  } catch {
    return null;
  }
}

// What the requirement checks said about a branch at its head: one line per requirement, and a
// hold when an `enforce` requirement of severity major or above is likely violated. Nothing reads
// the hold yet. Null while requirements are off.
export interface Conformity {
  checked: boolean;
  lines: requirements.ConformityLine[];
  hold: boolean;
}

export function conformity(repo: string, branch: string, head: string | null): Conformity | null {
  if (!requirements.enabled() || !head) return null;
  try {
    const lines = requirements.verdictsOn(`branch:${repo}/${branch}@${head}`);
    const hold = lines.some((l) => l.verdict === 'violates' && l.mode === 'enforce' && (l.severity === 'major' || l.severity === 'critical'));
    return { checked: lines.length > 0, lines, hold };
  } catch {
    return null;
  }
}

export interface QueueRow {
  id: string;
  key: string;
  title: string;
  owner: string | null;
  // When the ITSA last changed; the Work page's Needs-you group sorts its rows by it.
  updated_at: string;
  link: { n: number; branch: string; repo: string; review: LinkMeta['review'] | null; tests: LinkMeta['tests'] | null; screenshots: LinkMeta['screenshots'] | null };
  facts: BranchFacts;
  // The requirement checks on this head, when requirements are on.
  conformity?: Conformity | null;
}

// The ITSAs in ready_to_merge with a branch link, most recently updated first, each branch
// with its facts. An ITSA with several branch links lists each one.
export async function queue(): Promise<QueueRow[]> {
  const rows = db.open().prepare("SELECT id, key, title, owner, updated_at FROM itsas WHERE status = 'ready_to_merge' ORDER BY updated_at DESC").all() as { id: string; key: string; title: string; owner: string | null; updated_at: string }[];
  const entries = rows.flatMap((x) => links(x.id).flatMap((l) => (l.system === 'branch' && l.external_id && l.meta?.repo
    ? [{ id: x.id, key: x.key, title: x.title, owner: x.owner, updated_at: x.updated_at, link: { n: l.n, branch: l.external_id, repo: l.meta.repo, review: l.meta.review ?? null, tests: l.meta.tests ?? null, screenshots: l.meta.screenshots ?? null } }]
    : [])));
  return Promise.all(
    entries.map(async (e) => {
      const facts = await branchFacts(e.link.repo, e.link.branch);
      return { ...e, facts, conformity: conformity(e.link.repo, e.link.branch, facts.head) };
    }),
  );
}
