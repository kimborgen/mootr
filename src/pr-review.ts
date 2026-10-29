// The review verdict relay (S-1061): a reviewer without gh (on storage, or in a Codex sandbox) posts its
// stam/review verdict through the daemon. It runs on the ITSA home, where gh is: the home runs
// scripts/pr-review.mjs in its checkout with STAM_AGENT_ID set to the reviewer, so the comment and the
// stam/review status are the script's own. The head the reviewer reviewed is pinned: a PR whose head has
// moved is refused (409) before anything is posted. The reviewer is the caller's own agent, never a name
// in the body (as pr_open takes its agent, S-514).
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { isReviewerType } from './agent-types.ts';
import { MACHINE } from './config.ts';
import * as db from './db.ts';
import { releaseReviewer } from './itsa-owners.ts';
import { prOpenConfig, type PrOpenConfig } from './pr-open.ts';
import { approveRefusal } from './ring.ts';
import { unconfirmedVerdict } from './pr-review-message.ts';
import { PeerUnreachable, peerByName, peerCall, type Via } from './peers.ts';
import { settings } from './settings.ts';
import { testOnlyEnv } from './test-env.ts';
import { envVar, withTwins } from './env.ts';

const run = promisify(execFile);

// The verdict script, in the ITSA home's checkout. The public export drops it (export/exclude.txt), so a build without it refuses
// a verdict before anything is posted (S-1645). STAM_PR_REVIEW_SCRIPT replaces its path in a test home only (test-env.ts).
const reviewScript = (cfg: PrOpenConfig): string => testOnlyEnv('STAM_PR_REVIEW_SCRIPT') || join(cfg.repo, 'scripts/pr-review.mjs');

// A refused or failed verdict, with the HTTP status the route answers.
export class ReviewError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ReviewInput {
  // The PR number (a bare number or its string).
  pr: number | string;
  verdict: 'approve' | 'request_changes' | string;
  summary: string;
  // The sha (full, or a prefix of at least 7 characters) of the commit the reviewer reviewed: refused when the PR's head is another.
  head: string;
}

export interface ReviewPosted {
  pr: number;
  verdict: string;
  head: string;
  // The script's own line: the stam/review status and the comment text.
  line: string;
}

const VERDICTS = ['approve', 'request_changes'];

const MANAGER_TYPES = ['manager', 'coordinator'];

// The branch an agent's worktree was made on (workspace.ts): a string, null for an agent with no worktree, and
// undefined when the workspace metadata can't be read (so ownership is unknown, never "owns nothing").
function worktreeBranchOf(a: db.Agent): string | null | undefined {
  if (!a.workspace) return null;
  try {
    const wt = JSON.parse(a.workspace)?.worktree;
    if (wt === undefined || wt === null) return null;
    return typeof wt.branch === 'string' && wt.branch ? wt.branch : undefined;
  } catch {
    return undefined;
  }
}

// What this daemon knows of one of its own agents (S-1065): its review role and the branches it owns. A manager is
// a manager or coordinator type; nothing else counts (an agent with helpers is no manager). ownBranches is null when
// unknown. Returns null for an agent not in this database, or on another machine.
export function reviewFacts(agent: string): Pick<Via, 'reviewRole' | 'ownBranches'> | null {
  const a = db.getAgent(agent);
  if (!a || a.machine !== MACHINE) return null;
  const reviewRole = a.type && isReviewerType(a.type) ? 'reviewer' : a.type && MANAGER_TYPES.includes(a.type) ? 'manager' : 'other';
  const wt = worktreeBranchOf(a);
  return { reviewRole, ownBranches: wt === undefined ? null : [`stam/${a.name}`, ...(wt ? [wt] : [])] };
}

// The facts a peer forwarded (x-stam-review-role, x-stam-own-branches); only read from a peer's token-proven call.
// Missing or malformed branches stay unknown (null), which the relay refuses.
export function parseReviewHeaders(h: Record<string, string | string[] | undefined>): { reviewRole?: 'reviewer' | 'manager' | 'other'; ownBranches?: string[] | null } {
  const role = h['x-stam-review-role'];
  if (role !== 'reviewer' && role !== 'manager' && role !== 'other') return {};
  let own: unknown = null;
  try {
    own = JSON.parse(String(h['x-stam-own-branches']));
  } catch {
    /* unknown */
  }
  return { reviewRole: role, ownBranches: Array.isArray(own) && own.every((b) => typeof b === 'string') ? (own as string[]) : null };
}

function checkInput(input: ReviewInput): { pr: string; verdict: string; summary: string; head: string } {
  const pr = String(input.pr ?? '');
  if (!/^[1-9]\d*$/.test(pr)) throw new ReviewError(400, `a PR is a number: ${pr}`);
  if (!VERDICTS.includes(String(input.verdict))) throw new ReviewError(400, `unknown verdict "${input.verdict}": use approve or request_changes`);
  const summary = String(input.summary ?? '').trim();
  if (!summary || /[\r\n]/.test(summary)) throw new ReviewError(400, 'a verdict needs a one-line summary');
  const head = String(input.head ?? '');
  if (!/^[0-9a-f]{7,40}$/.test(head)) throw new ReviewError(400, 'head is the sha of the commit you reviewed: the full 40 characters, or at least 7');
  return { pr, verdict: String(input.verdict), summary, head };
}

// Runs on the ITSA home. `via` is the reviewer: the agent whose own token (or a peer's forwarded one) asks.
// The shared token, the human's, and a daemon's own call name no reviewer, so they're refused.
export async function reviewPrHere(input: ReviewInput, via?: Via, cfg: PrOpenConfig = prOpenConfig()): Promise<ReviewPosted> {
  const v = checkInput(input);
  if (!via) throw new ReviewError(403, 'only an agent posts a review: this request names no reviewing agent (S-1061)');
  // Who may post (S-1065), decided from the home's own database or the facts the caller's daemon proved; fail closed.
  if (!via.boss) {
    if (!via.reviewRole) throw new ReviewError(403, `can't tell what ${via.agent} may review: its role is unknown here (S-1065)`);
    if (via.reviewRole === 'other') throw new ReviewError(403, `${via.agent} may not post a verdict: only a reviewer, a manager, or the chief of staff does (S-1065)`);
  }
  if (!via.boss && !Array.isArray(via.ownBranches)) throw new ReviewError(403, `can't tell which branches ${via.agent} owns, so can't rule out a review of its own PR (S-1065)`);
  // Checked before gh runs: only the script's absence refuses. Any other failure of the script surfaces as it always has.
  const script = reviewScript(cfg);
  if (!existsSync(script)) {
    // The body is single-quoted for the shell, with each ' written as '\'' so a summary's quotes, $ or backticks paste as they are.
    const body = `'${`Review (${via.agent}): ${v.verdict}. ${v.summary}`.replace(/'/g, "'\\''")}'`;
    const state = v.verdict === 'approve' ? 'success' : 'failure';
    throw new ReviewError(501, `this build has no verdict script (${script}), so pr_review can't post PR #${v.pr}. Nothing was posted. Post the verdict by hand: \`gh pr comment ${v.pr} --repo ${cfg.github} --body ${body}\`, and set the stam/review status on the head: \`gh api repos/${cfg.github}/statuses/${v.head} -f state=${state} -f context=stam/review\`.`);
  }
  let branch = '';
  let shown = '';
  try {
    const pr = JSON.parse((await run(cfg.gh, ['pr', 'view', v.pr, '--json', 'headRefName,headRefOid'], { cwd: cfg.repo, timeout: 60_000 })).stdout);
    branch = String(pr.headRefName ?? '');
    shown = String(pr.headRefOid ?? '');
  } catch {
    /* fails closed below */
  }
  if (!branch) throw new ReviewError(502, `can't read PR #${v.pr}'s branch, so can't tell whether ${via.agent} owns it (S-1065)`);
  if (!via.boss && via.ownBranches?.includes(branch)) throw new ReviewError(403, `${via.agent} owns ${branch} and may not review its own PR (S-1065)`);
  try {
    const { stdout } = await run(process.execPath, [script, v.pr, v.verdict, v.summary, '--head', v.head], {
      cwd: cfg.repo,
      // The gh binary is settings.itsa.prOpen.gh, as pr_open runs it (the script's gate reads STAM_GH).
      env: { ...process.env, ...withTwins({ STAM_AGENT_ID: via.agent, STAM_GH: cfg.gh }) },
      timeout: 120_000,
    });
    // S-3015: an approve ends the reviewer's review, so it leaves the ITSAs linked to this PR (its branch, or its github link,
    // S-3508). A request_changes keeps it in them. Its own catch: the posted verdict stands either way.
    if (v.verdict === 'approve' && via.reviewRole === 'reviewer' && !via.boss) await releaseReviewer(via.agent, via.agent, { branch, repo: cfg.repoName, subject: `github:${cfg.github}#${Number(v.pr)}` }).catch((e) => console.error(`pr_review: couldn't take ${via.agent} out of its ITSAs: ${e.message}`));
    return { pr: Number(v.pr), verdict: v.verdict, head: v.head, line: stdout.trim() };
  } catch (e: any) {
    // pr-review.mjs exits 3 for a moved head, 2 for a bad argument, 1 for a gh failure (its stderr says why).
    const status = e.code === 3 ? 409 : e.code === 2 ? 400 : 502;
    const why = String(e.stderr || e.message || '').trim().split('\n').pop() ?? '';
    // S-3385: a refused head that is already the tip of the PR's branch on origin is GitHub's PR head lagging the push. Only the message
    // changes: the refusal stands, and an ls-remote that fails keeps the message it had.
    const tip = status === 409 ? await originTipOf(cfg, branch, v.head) : '';
    if (tip) throw new ReviewError(409, `origin is at ${tip}, GitHub's PR head shows ${shown || 'nothing'}. ${HEAD_LAGS}`);
    throw new ReviewError(status, why || 'pr-review.mjs failed');
  }
}

// What a 409 says when the refused head is on origin already: GitHub's PR head is behind the push, so a re-push changes nothing (S-3385).
const HEAD_LAGS = "GitHub's PR head lags the push; wait for the synchronize notice, don't re-push.";

// origin's branch tip, when it is `head` (a full sha or a prefix of one); '' otherwise, and on any ls-remote error or timeout (S-3385).
async function originTipOf(cfg: PrOpenConfig, branch: string, head: string): Promise<string> {
  try {
    const { stdout } = await run('git', ['ls-remote', '--heads', cfg.origin, `refs/heads/${branch}`], { cwd: cfg.repo, timeout: 30_000 });
    const tip = stdout.split('\t')[0] ?? '';
    return /^[0-9a-f]{40}$/.test(tip) && tip.startsWith(head) ? tip : '';
  } catch {
    return '';
  }
}

// Runs on the ITSA home, wherever the call came from: this daemon when it's the home, else the home over
// the peer link, with the reviewer's identity forwarded (as openPrRouted does).
export async function reviewPrRouted(input: ReviewInput, via?: Via): Promise<ReviewPosted> {
  const home = settings().itsa.home ?? MACHINE;
  // S-3874: an approve from a ring's creator or moderator needs that ring to have ended in an agreed approve for this head. Fails closed.
  if (via && String(input?.verdict) === 'approve') {
    const v = checkInput(input);
    let why: string | null;
    try {
      why = approveRefusal(via.agent, v.pr, v.head);
    } catch (e: any) {
      why = `can't read the rings on PR ${v.pr} (${e.message}), so can't tell whether a ring allows this approve`;
    }
    if (why) throw new ReviewError(409, `${why} (S-3874)`);
  }
  // A call from this daemon's own agent: its role and branches come from this database, never from the caller.
  // The local facts win over anything the request carried; a peer's agent isn't in this database, so its forwarded facts stand.
  if (via) via = { ...via, ...reviewFacts(via.agent) };
  if (home === MACHINE) return reviewPrHere(input, via);
  const peer = peerByName(home);
  if (!peer) throw new ReviewError(502, `ITSA home '${home}' is not a configured peer`);
  let r;
  try {
    r = await peerCall(peer, 'POST', '/api/pr/review', input, forwardMs(), false, via);
  } catch (e) {
    // A home that is down, or refused the connection, was never sent the request, so there is no verdict to be unsure of (S-3596).
    if (e instanceof PeerUnreachable) throw new ReviewError(503, `ITSA home ${home} is unreachable, so the verdict was not posted; retry when it is up`);
    // The forward timed out or its connection dropped: the home may have posted the verdict already, and this side can't tell (S-2631).
    throw new ReviewError(502, unconfirmedVerdict(input.pr, `the forward to ITSA home ${home} timed out or lost its connection`));
  }
  if (r.status !== 200) throw new ReviewError(r.status, r.data?.error ?? `${home}: HTTP ${r.status}`);
  return r.data;
}

// How long the forward to the ITSA home waits (S-2631), 180 seconds unless STAM_REVIEW_PEER_MS sets it (as peers.ts reads its own).
function forwardMs(): number {
  return Number(envVar('REVIEW_PEER_MS')) || 180_000;
}

