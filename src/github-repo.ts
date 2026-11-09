// The GitHub repo (OWNER/NAME) a checkout's `origin` points at, for pr_open and watch_pr (S-614).
import { execFileSync } from 'node:child_process';
import { MACHINE } from './config.ts';
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

// The repo a PR tool call is about (S-4831): the one given, else the origin of the calling agent's worktree when that agent works on
// this machine, else null (the ITSA home's default repo).
export function callerRepo(given: unknown, agent?: { machine: string; cwd?: string | null } | null, machine = MACHINE): string | null {
  const s = typeof given === 'string' ? given.trim() : '';
  if (s) return s;
  return agent && agent.machine === machine && agent.cwd ? originRepo(agent.cwd) : null;
}

// The repo of a call whose pr may name one itself (S-4831): a pr that is OWNER/REPO#N passes on only a repo the caller gave (the
// home refuses one that differs), never the worktree's, which would conflict with it. Any other pr is callerRepo's.
export function prCallRepo(pr: unknown, given: unknown, agent?: { machine: string; cwd?: string | null } | null, machine = MACHINE): string | null {
  if (typeof pr === 'string' && /^[\w.-]+\/[\w.-]+#\d+$/.test(pr.trim())) return callerRepo(given, null, machine);
  return callerRepo(given, agent, machine);
}
