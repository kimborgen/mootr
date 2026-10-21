#!/usr/bin/env node
// The Go catch-up list (S-2244, S-2194 phase 0): for each Go module in docs/migration/modules.json that has a port SHA, prints the
// commits on origin/main since that SHA which touch the module's src/ globs, newest first. Read-only; run `git fetch` first.
// Usage: node scripts/go-catchup.mjs [MODULE]   (MODULE limits the list to one module's name)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './main-guard.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MODULES_FILE = join(ROOT, 'docs/migration/modules.json');

export const readModules = (file = MODULES_FILE) => JSON.parse(readFileSync(file, 'utf8'));

// The commits on REF since each module's port SHA that touch its globs. MODULES are [{ name, globs, portSha }]; a module without a
// portSha is skipped, and ONLY (a name) limits the list. Merge commits are left out: the PR's own commits are listed. Returns
// [{ name, portSha, commits: [{ sha, date, subject }] }]. Throws (git's message) when a port SHA is unknown.
export function catchUp({ repo = ROOT, modules, ref = 'origin/main', only } = {}) {
  return modules
    .filter((m) => m.portSha && (only === undefined || m.name === only))
    .map((m) => ({ name: m.name, portSha: m.portSha, commits: commitsSince(repo, m, ref) }));
}

function commitsSince(repo, { globs, portSha }, ref) {
  if (globs.length === 0) return [];
  const out = execFileSync('git', ['-C', repo, 'log', '--no-merges', '--full-history', '--date=short', '--format=%H%x09%ad%x09%s', `${portSha}..${ref}`, '--', ...globs.map((g) => `:(glob)${g}`)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return out.split('\n').filter(Boolean).map((line) => {
    const [sha, date, ...subject] = line.split('\t');
    return { sha, date, subject: subject.join('\t') };
  });
}

if (isMain(import.meta.url)) {
  const only = process.argv[2];
  const modules = readModules();
  if (only !== undefined && !modules.some((m) => m.name === only)) {
    console.error(`no module named ${only} in docs/migration/modules.json`);
    process.exit(2);
  }
  const lists = catchUp({ modules, only });
  if (lists.length === 0) console.log('no module has a port SHA yet');
  for (const l of lists) {
    console.log(`${l.name} (ported at ${l.portSha.slice(0, 7)}): ${l.commits.length} commit${l.commits.length === 1 ? '' : 's'} since`);
    for (const c of l.commits) console.log(`  ${c.sha.slice(0, 7)} ${c.date} ${c.subject}`);
  }
}
