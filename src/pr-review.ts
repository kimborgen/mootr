// The review verdict relay (S-1061): a reviewer without gh (on storage, or in a Codex sandbox) posts its
// stam/review verdict through the daemon. It runs on the ITSA home, where gh is: the home runs
// scripts/pr-review.mjs in its checkout with STAM_AGENT_ID set to the reviewer, so the comment and the
// stam/review status are the script's own. The head the reviewer reviewed is pinned: a PR whose head has
// moved is refused (409) before anything is posted. The reviewer is the caller's own agent, never a name
// in the body (as pr_open takes its agent, S-514).
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { MACHINE } from './config.ts';
import { prOpenConfig, type PrOpenConfig } from './pr-open.ts';
import { peerByName, peerCall, type Via } from './peers.ts';
import { settings } from './settings.ts';

const run = promisify(execFile);

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

// A forwarded agent that came with the shared token (settings.auth.legacyPeerToken, S-1061) is no peer's word:
// the shared token can forge x-stam-agent. Only a peer's own token proves the agent, so a verdict from one is refused.
export function assertPeerCaller(caller: { legacy?: boolean }): void {
  if (caller.legacy) throw new ReviewError(403, 'a verdict is relayed only from a peer that proves the agent with its peer token; the shared token can\'t name a reviewer (S-1061)');
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
  try {
    const { stdout } = await run(process.execPath, [join(cfg.repo, 'scripts/pr-review.mjs'), v.pr, v.verdict, v.summary, '--head', v.head], {
      cwd: cfg.repo,
      // The gh binary is settings.itsa.prOpen.gh, as pr_open runs it (the script's gate reads STAM_GH).
      env: { ...process.env, STAM_AGENT_ID: via.agent, STAM_GH: cfg.gh },
      timeout: 120_000,
    });
    return { pr: Number(v.pr), verdict: v.verdict, head: v.head, line: stdout.trim() };
  } catch (e: any) {
    // pr-review.mjs exits 3 for a moved head, 2 for a bad argument, 1 for a gh failure (its stderr says why).
    const status = e.code === 3 ? 409 : e.code === 2 ? 400 : 502;
    const why = String(e.stderr || e.message || '').trim().split('\n').pop() ?? '';
    throw new ReviewError(status, why || 'pr-review.mjs failed');
  }
}

// Runs on the ITSA home, wherever the call came from: this daemon when it's the home, else the home over
// the peer link, with the reviewer's identity forwarded (as openPrRouted does).
export async function reviewPrRouted(input: ReviewInput, via?: Via): Promise<ReviewPosted> {
  const home = settings().itsa.home ?? MACHINE;
  if (home === MACHINE) return reviewPrHere(input, via);
  const peer = peerByName(home);
  if (!peer) throw new ReviewError(502, `ITSA home '${home}' is not a configured peer`);
  const r = await peerCall(peer, 'POST', '/api/pr/review', input, 180_000, false, via);
  if (r.status !== 200) throw new ReviewError(r.status, r.data?.error ?? `${home}: HTTP ${r.status}`);
  return r.data;
}
