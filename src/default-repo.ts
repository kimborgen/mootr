// The repo stam is built from, for the places that default to "the stam checkout" (S-2083). A release records
// its source in .release.json (deploy.ts); a checkout is its own. Kept free of settings.ts so the CLI-loaded
// modules (proctree.ts) can use it.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ROOT } from './config.ts';

function canonical(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

// The checkout path stam runs from, or '' when `root` is neither a release nor a git checkout.
export function derivedRepoPath(root = ROOT): string {
  try {
    const m = JSON.parse(readFileSync(join(root, '.release.json'), 'utf8'));
    if (typeof m.repo === 'string' && m.repo) return canonical(m.repo);
  } catch {}
  return existsSync(join(root, '.git')) ? canonical(root) : '';
}

// The default repo as { name: path }: keyed by the checkout's own directory name.
export function derivedRepos(root = ROOT): Record<string, string> {
  const p = derivedRepoPath(root);
  return p ? { [basename(p)]: p } : {};
}

// The folder that holds the default repo, for the file root and the janitor's protected folder.
export function derivedRepoParent(root = ROOT): string {
  const p = derivedRepoPath(root);
  return p ? dirname(p) : '';
}
