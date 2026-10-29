// The PR view relay (S-3107): `pr_view` reads a pull request's title, state, branches, full head sha, body, files changed
// and checks, from any machine. A reviewer on storage has no gh and no GitHub token, so the ITSA home (where gh is) reads it
// for the caller, as pr_open, pr_review and pr_merge do: a peer's call is forwarded there, and an unreachable home is an error.
// Read-only and stateless: gh runs with a fixed argument list and no shell, and `pr` is checked before gh sees it. The PR is a
// number (the home's default repo, settings.itsa.prOpen.github) or OWNER/REPO#N in a repo of settings.itsa.repos.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { MACHINE } from './config.ts';
import { HUMAN } from './mail.ts';
import { peerByName, peerCall, type Via } from './peers.ts';
import { originRepo } from './github-repo.ts';
import { prOpenConfig, type PrOpenConfig } from './pr-open.ts';
import { budgetMs, refreshPrHead, runGit } from './pr-mirror.ts';
import { settings } from './settings.ts';

const run = promisify(execFile);

// How long gh may take to read a PR, and how long a peer waits for the home to answer. The peer's must be longer than gh's, or a
// slow read times out at the peer before the home has its answer (S-3107 review).
export const VIEW_GH_MS = 120_000;
export const VIEW_PEER_MS = VIEW_GH_MS + 30_000;

// A refused or failed read, with the HTTP status the route answers.
export class PrViewError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface PrViewInput {
  // The PR number, or OWNER/REPO#N: a bare number is in the home's default repo.
  pr: unknown;
  // Who asks: the agent or the human. Only read to tell a caller apart; any agent may read a PR.
  by?: string | null;
}

export interface PrFile {
  path: string;
  additions: number;
  deletions: number;
}

// A check run (its state: its status while it runs, else its conclusion) or a commit status such as stam/review.
export interface PrCheck {
  name: string;
  state: string;
}

export interface PrView {
  number: number;
  repo: string;
  url: string;
  title: string;
  state: string;
  base: string;
  head_branch: string;
  head: string;
  body: string;
  files: PrFile[];
  checks: PrCheck[];
  // The merge-base sha of head and the PR's base branch, and `git diff MERGE_BASE HEAD` for the PR's changes (S-3751). Left out
  // when the merge-base can't be read; `base` is the branch's name, so the sha is merge_base.
  merge_base?: string;
  diff?: string;
}

// The fields gh reads, as one fixed --json list.
const FIELDS = 'number,url,title,state,baseRefName,headRefName,headRefOid,body,files,statusCheckRollup';
const NUMBER = /^[1-9]\d{0,8}$/;
const KEYED = /^([\w.-]+\/[\w.-]+)#([1-9]\d{0,8})$/;
// A token or credential never reaches an error message, even one gh printed.
const SECRET = /gh[pousr]_[\w]+|github_pat_[\w]+|Bearer\s+\S+/gi;

// The GitHub repos a PR may be read from: the home's default repo and the origin of each settings.itsa.repos checkout.
// A repo outside this list is refused before gh runs.
export function viewRepos(cfg: PrOpenConfig = prOpenConfig()): string[] {
  const { repos, prOpen } = settings().itsa;
  const names = Object.values(repos).map((path) => originRepo(path, prOpen.origin)).filter((r): r is string => !!r);
  return [...new Set([cfg.github, ...names].filter(Boolean))];
}

// `pr` as a repo and a number, or a PrViewError. Anything but a number or OWNER/REPO#N is refused before gh runs.
export function parsePr(pr: unknown, repos: string[], defaultRepo: string): { repo: string; number: number } {
  const s = String(pr ?? '').trim();
  if (NUMBER.test(s)) {
    if (!defaultRepo) throw new PrViewError(400, 'no default GitHub repo: set settings.itsa.prOpen.github on the ITSA home, or give the pr as OWNER/REPO#N');
    return { repo: defaultRepo, number: Number(s) };
  }
  const m = KEYED.exec(s);
  if (!m) throw new PrViewError(400, `pr must be a number or OWNER/REPO#N, not ${JSON.stringify(s)}`);
  if (!repos.includes(m[1])) throw new PrViewError(403, `${m[1]} is not a repo of settings.itsa.repos, so its PRs can't be read here`);
  return { repo: m[1], number: Number(m[2]) };
}

// The last line gh printed, with any credential taken out and a length cap.
function reason(e: any): string {
  const text = String(e?.stderr || e?.message || '').replace(SECRET, '[redacted]').trim();
  const last = text.split('\n').filter(Boolean).pop() ?? '';
  return last.length > 300 ? `${last.slice(0, 300)}…` : last;
}

// gh's view of one PR, as JSON. An unknown PR or repo is a 404; any other failure of gh is a 502 with its last line.
async function ghView(cfg: PrOpenConfig, repo: string, number: number): Promise<any> {
  let stdout: string;
  try {
    stdout = (await run(cfg.gh, ['pr', 'view', String(number), '--repo', repo, '--json', FIELDS], { maxBuffer: 16 << 20, timeout: VIEW_GH_MS })).stdout;
  } catch (e: any) {
    if (/Could not resolve to a (PullRequest|Repository)/i.test(String(e?.stderr ?? ''))) throw new PrViewError(404, `PR #${number} is not in ${repo}`);
    throw new PrViewError(502, `gh couldn't read PR #${number} in ${repo}: ${reason(e)}`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new PrViewError(502, `gh printed no PR #${number} JSON for ${repo}`);
  }
}

// A check: a commit status has `context` and `state`; a check run has `name` and a status, with a conclusion once completed.
function checkOf(c: any): PrCheck {
  if (c && 'context' in c) return { name: String(c.context), state: String(c.state ?? '').toLowerCase() };
  const state = c?.status && c.status !== 'COMPLETED' ? c.status : c?.conclusion ?? '';
  return { name: String(c?.name ?? ''), state: String(state).toLowerCase() };
}

// The checkout a PR's repo is read in: the home's own, else the settings.itsa.repos checkout whose origin is that repo.
function checkoutOf(repo: string, cfg: PrOpenConfig): string | null {
  if (repo === cfg.github) return cfg.repo;
  return Object.values(settings().itsa.repos).find((p) => originRepo(p, cfg.origin) === repo) ?? null;
}

// A branch name as gh gives it, checked before git sees it: no leading dash and no `..`.
const BRANCH = /^\w[\w./-]*$/;
const SHA = /^[0-9a-f]{40}$/;

// The merge-base of the PR's head and its base branch (S-3751), with the one `git diff` for the PR's changes. Both come from
// origin, fetched into scratch refs that are dropped after, so the base is the PR's real base, not origin/main's tip. Null when
// either can't be read or the merge-base isn't one commit: the view goes on without them. Never rejects.
async function mergeBaseOf(cfg: PrOpenConfig, repo: string, number: number, head: string, base: string): Promise<{ merge_base: string; diff: string } | null> {
  const dir = checkoutOf(repo, cfg);
  if (!dir || !SHA.test(head) || !BRANCH.test(base) || base.includes('..')) return null;
  const tag = randomBytes(4).toString('hex');
  const pr = `refs/stam/pr-view/${number}-${tag}`;
  const branch = `refs/stam/pr-view/${number}-base-${tag}`;
  const signal = AbortSignal.timeout(budgetMs());
  try {
    await runGit(dir, ['fetch', '--no-tags', cfg.origin, `+refs/pull/${number}/head:${pr}`, `+refs/heads/${base}:${branch}`], signal);
    const bases = (await runGit(dir, ['merge-base', '--all', head, branch], signal)).split('\n');
    if (bases.length !== 1 || !SHA.test(bases[0])) return null;
    return { merge_base: bases[0], diff: `git diff ${bases[0]} ${head}` };
  } catch {
    return null;
  } finally {
    // No deadline here: deleting a scratch ref is quick, and it must happen even after the fetch's deadline.
    await Promise.all([runGit(dir, ['update-ref', '-d', pr]), runGit(dir, ['update-ref', '-d', branch])]).catch(() => {});
  }
}

// Runs on the ITSA home. Reads PR `pr` from its repo with gh and shapes the answer.
export async function viewHere(input: PrViewInput, cfg: PrOpenConfig = prOpenConfig()): Promise<PrView> {
  const { repo, number } = parsePr(input.pr, viewRepos(cfg), cfg.github);
  const v = await ghView(cfg, repo, number);
  const head = String(v.headRefOid ?? '');
  // Run together, after gh answers; neither fails the view. storage's mirror holds the home's repo's PRs only, so only that repo's head is refreshed.
  const [links] = await Promise.all([
    mergeBaseOf(cfg, repo, number, head, String(v.baseRefName ?? '')),
    repo === cfg.github ? refreshPrHead(cfg, number, head) : undefined,
  ]);
  return {
    number: Number(v.number ?? number),
    repo,
    url: String(v.url ?? ''),
    title: String(v.title ?? ''),
    state: String(v.state ?? ''),
    base: String(v.baseRefName ?? ''),
    head_branch: String(v.headRefName ?? ''),
    head: String(v.headRefOid ?? ''),
    body: String(v.body ?? ''),
    files: (v.files ?? []).map((f: any) => ({ path: String(f.path ?? ''), additions: Number(f.additions ?? 0), deletions: Number(f.deletions ?? 0) })),
    checks: (v.statusCheckRollup ?? []).map(checkOf),
    ...links,
  };
}

// Runs on the ITSA home, wherever the call came from: this daemon when it's the home, else the home over the peer link,
// with the caller's identity forwarded. An unreachable home is an error, never a guess.
export async function viewRouted(input: PrViewInput, via?: Via): Promise<PrView> {
  const home = settings().itsa.home ?? MACHINE;
  if (home === MACHINE) return viewHere(input);
  const peer = peerByName(home);
  if (!peer) throw new PrViewError(502, `ITSA home '${home}' is not a configured peer`);
  let r;
  try {
    r = await peerCall(peer, 'POST', '/api/pr/view', input, VIEW_PEER_MS, input.by === HUMAN, via);
  } catch (e) {
    throw new PrViewError(502, `ITSA home '${home}' is unreachable (${e instanceof Error ? e.message : e}), so the PR was not read`);
  }
  if (r.status !== 200) throw new PrViewError(r.status, r.data?.error ?? `${home}: HTTP ${r.status}`);
  return r.data;
}
