// The GitHub repo (OWNER/NAME) a checkout's `origin` points at, for pr_open and watch_pr (S-614).
import { execFileSync } from 'node:child_process';
import { primaryRepoName, settings } from './settings.ts';

// OWNER/NAME from an https, ssh:// or scp-style github.com url, else null.
export function parseGithubRepo(url: string): string | null {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/\s]+@)github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

export function originRepo(checkout: string, remote = 'origin'): string | null {
  try {
    return parseGithubRepo(execFileSync('git', ['remote', 'get-url', remote], { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return null;
  }
}

// The explicit settings.itsa.prOpen.github, else the repo parsed from origin of the prOpen checkout; null when neither.
export function defaultGithubRepo(): string | null {
  const { prOpen, repos } = settings().itsa;
  if (prOpen.github) return prOpen.github;
  const path = repos[primaryRepoName(settings().itsa)];
  return path ? originRepo(path, prOpen.origin) : null;
}
