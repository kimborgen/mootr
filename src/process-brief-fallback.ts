// The {{next_steps}} of a type's brief (S-925): rendered from the loaded processes/*.yaml, or,
// when no process loads or none has a lane for the type, today's prose below.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.ts';
import { loadProcesses, renderNextSteps, type ProcessDef } from './process.ts';

const FALLBACK: Record<string, string> = {
  developer: "When the branch is ready, open its pull request with `pr_open` (branch, title, and the body per docs/pull-requests.md, with `itsa` set to your ITSA). It fetches the branch from storage, pushes it, opens the PR (or replaces the body of the open one), and links the PR and the branch to your ITSA. Then `watch_pr` the PR number it returns, so its checks and reviews reach you. Then mail {{parent}} your branch and commits, the PR link, what changed, what you tested and the results, and anything you weren't sure about. Then set your ITSA to `in_review`, and stop. Never set it to done; the deploy watcher closes it after deploy. If you're blocked, mail {{parent}} instead of guessing. Never mail the human; report to your parent.",
  reviewer: "Watch the PR you review with `watch_pr` when it's open, so you hear its checks and any changes. When the review is of a PR, give your verdict with the `pr_review` tool (PR number, approve or request_changes, a one-line summary, and head: the full sha of the commit you reviewed), then mail {{parent}} your findings when you're done.",
  manager: "A reviewer's task for a PR must include this sentence verbatim: \"When the review is of a PR, watch it with `watch_pr`, and give your verdict with the `pr_review` tool (PR number, approve or request_changes, a one-line summary, and head: the full sha of the commit you reviewed).\"\n\nOnce its reviewer's `stam/review` is success on the PR's current head, the PR is merged with the `pr_merge` tool (see Merging in docs/pull-requests.md): by you, or by the process runner when `process.run` is `on`.",
};
FALLBACK.coordinator = FALLBACK.manager;
FALLBACK['reviewer-opus'] = FALLBACK.reviewer;

export const fallbackNextSteps = (type: string): string => FALLBACK[type] ?? '';

// The loaded processes, kept while the folder's yaml files (names and mtimes) stay the same, so
// a caller that renders many briefs (the inventory) parses the folder once.
let cache: { key: string; processes: ProcessDef[] } | null = null;

function processes(dir: string): ProcessDef[] {
  const key = readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort().map((f) => `${f}:${statSync(join(dir, f)).mtimeMs}`).join('|');
  if (cache?.key !== key) cache = { key, processes: loadProcesses(dir).processes };
  return cache.processes;
}

export function nextSteps(type: string, dir = join(ROOT, 'processes')): string {
  try {
    for (const p of processes(dir)) {
      const text = renderNextSteps(p, type);
      if (text) return text;
    }
  } catch {}
  return fallbackNextSteps(type);
}
