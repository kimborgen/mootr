#!/usr/bin/env node
// The generic merge (S-2202): merges one PR into a repo's main branch as its `.stam/repo.json` says, only when the PR is
// open, targets the main branch, doesn't conflict, every status in `requiredStatuses` is success on its current head, and
// stam/gates is success on that head against the current main (it runs repo-gate.mjs when not). Then it runs `deploy`.
//   node scripts/repo-merge.mjs PR_NUMBER
// The config is read from main as fetched now, never from the PR. `merge.command` replaces only the `gh pr merge` call:
// the checks above always run first. The command runs with `sh -c` in the checkout, with STAM_PR, STAM_PR_HEAD,
// STAM_BASE_SHA and STAM_MERGE_METHOD set. `deploy` runs the same way after the merge, with STAM_MERGE_SHA too.
// When the config names a `home`, only that machine (STAM_MACHINE, else the hostname) merges.
// Env as repo-gate.mjs: STAM_GATE_REPO, STAM_GH, STAM_REPO_CONFIG, STAM_REPO_GATE_CACHE.
// Exit statuses: 0 merged (and deployed); 3 a verdict on the PR (not open, wrong base, conflict, a required status
// missing, gates failed: it goes back to its developer); 4 merged, but the deploy failed; 1 anything else (a gh or git
// failure, main moved, the wrong machine); 2 usage.
import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { GATES_CONTEXT, RepoConfigError, readRepoConfig } from './repo-config.mjs';
import { PR_FIELDS, RepoGateError, apiRepo, fallbackOf, fetchSha, gh, repoArgs, runRepoGate, trustedMain } from './repo-gate.mjs';
import { envVar, withTwins } from '../src/env.ts';
import { isMain } from './main-guard.mjs';

export const REFUSED = 3;
export const DEPLOY_FAILED = 4;

// A verdict on the PR itself: exit 3.
export class RefusalError extends Error {}
// The merge happened and the deploy failed: exit 4.
export class DeployError extends Error {}

// The newest status per context on SHA (GitHub lists a commit's statuses newest first).
function statusesOf(config, sha, repo) {
  const list = JSON.parse(gh(['api', `${apiRepo(config)}/commits/${sha}/statuses`], repo));
  const latest = new Map();
  for (const s of list) if (!latest.has(s.context)) latest.set(s.context, s);
  return latest;
}

function sh(command, repo, env) {
  return spawnSync('sh', ['-c', command], { cwd: repo, env, stdio: 'inherit' }).status;
}

// Merges PR (a number string) and returns { sha, deployed }. Throws RefusalError for a verdict on the PR, DeployError
// when the deploy failed after the merge, and RepoGateError or RepoConfigError for the rest.
export async function mergeRepoPr(pr, env = process.env) {
  const repo = envVar('GATE_REPO', env) || process.cwd();
  const fallback = fallbackOf(env);
  const view = JSON.parse(gh(['pr', 'view', pr, ...repoArgs(fallback), '--json', `state,mergeable,${PR_FIELDS}`], repo));
  if (view.state !== 'OPEN') throw new RefusalError(`PR #${pr} is ${view.state}, not open`);
  if (view.isCrossRepository) throw new RefusalError(`PR #${pr} is from a fork (${view.headRepositoryOwner?.login ?? 'another repo'}:${view.headRefName}); fork PRs aren't supported`);
  const main = trustedMain(repo, fallback);
  if (view.baseRefName !== main) throw new RefusalError(`refusing PR #${pr}: its base is ${view.baseRefName}, not ${main}`);
  const baseSha = fetchSha(repo, main);
  let config;
  try {
    config = readRepoConfig(repo, baseSha, fallback);
  } catch (e) {
    if (e instanceof RepoConfigError) throw new RefusalError(e.message);
    throw e;
  }
  if (!config) throw new RefusalError(`${main} has no .stam/repo.json and no settings fallback`);
  if (config.mainBranch !== main) throw new RefusalError(`.stam/repo.json says mainBranch ${config.mainBranch}, but the main branch is ${main}`);
  const machine = envVar('MACHINE', env) || hostname();
  if (config.home && config.home !== machine) throw new RepoGateError(`merges run on ${config.home}, not ${machine}`);
  if (view.mergeable === 'CONFLICTING') throw new RefusalError(`PR #${pr} conflicts with ${main}`);
  const head = view.headRefOid;
  const short = head.slice(0, 7);
  if (fetchSha(repo, view.headRefName) !== head) throw new RefusalError(`${view.headRefName} moved since the check; run the merge again`);

  // Every required status, whatever merge.command says.
  const statuses = statusesOf(config, head, repo);
  for (const context of config.requiredStatuses) {
    const s = statuses.get(context);
    if (s?.state !== 'success') throw new RefusalError(`${context} on ${short} is ${s?.state ?? 'missing'}, not success`);
  }
  // The gates count only when they ran against main as it is now; otherwise run them again.
  const gates = statuses.get(GATES_CONTEXT);
  if (!(gates?.state === 'success' && String(gates.description ?? '').endsWith(`; base ${baseSha}`))) {
    const result = await runRepoGate(pr, env);
    if (result.notRun) throw new RepoGateError(`gates did not run on ${short}: ${result.text}`);
    if (!result.ok) throw new RefusalError(`gates failed on ${short} against ${main} ${String(result.baseSha ?? baseSha).slice(0, 7)}: ${result.text}`);
    if (result.baseSha !== baseSha) throw new RepoGateError(`${main} moved while the gates ran; run the merge again`);
    if (result.head !== head) throw new RepoGateError(`${view.headRefName} moved while the gates ran; run the merge again`);
  }
  // The gates passed against baseSha: a main that moved since would merge an untested tree.
  if (fetchSha(repo, main) !== baseSha) throw new RepoGateError(`${main} moved since the gates ran; run the merge again`);

  const method = config.merge.method;
  if (config.merge.command) {
    const code = sh(config.merge.command, repo, { ...env, ...withTwins({ STAM_PR: pr, STAM_PR_HEAD: head, STAM_BASE_SHA: baseSha, STAM_MERGE_METHOD: method }) });
    if (code !== 0) throw new RepoGateError(`merge.command exited ${code}`);
  } else {
    // --match-head-commit makes GitHub refuse the merge if the head moved since the checks.
    gh(['pr', 'merge', pr, ...repoArgs(config), `--${method}`, '--match-head-commit', head], repo);
  }
  let sha = head;
  try {
    sha = JSON.parse(gh(['pr', 'view', pr, ...repoArgs(config), '--json', 'mergeCommit'], repo)).mergeCommit?.oid ?? head;
  } catch {} // the merge is done; a failed read of its sha must not turn it into a failure
  if (config.deploy) {
    const code = sh(config.deploy, repo, { ...env, ...withTwins({ STAM_PR: pr, STAM_PR_HEAD: head, STAM_BASE_SHA: baseSha, STAM_MERGE_METHOD: method, STAM_MERGE_SHA: sha }) });
    if (code !== 0) throw new DeployError(`merged as ${sha}, but deploy exited ${code}`);
  }
  return { sha, deployed: Boolean(config.deploy) };
}

async function cli(args) {
  if (args.length !== 1 || !/^\d+$/.test(args[0])) {
    console.error('usage: node scripts/repo-merge.mjs PR_NUMBER');
    return 2;
  }
  try {
    const { sha } = await mergeRepoPr(args[0]);
    console.log(sha);
    return 0;
  } catch (e) {
    console.error(`repo-merge: ${e instanceof Error ? e.message : e}`);
    return e instanceof RefusalError ? REFUSED : e instanceof DeployError ? DEPLOY_FAILED : 1;
  }
}

if (isMain(import.meta.url)) process.exitCode = await cli(process.argv.slice(2));
