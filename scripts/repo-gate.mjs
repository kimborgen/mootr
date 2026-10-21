#!/usr/bin/env node
// The generic PR gate (S-2202): runs the gates a repo's `.stam/repo.json` names for a PR, on the PR head merged onto
// the base branch in a scratch clone, then posts the stam/gates commit status and a PR comment.
//   node scripts/repo-gate.mjs PR_NUMBER
// The config is read from the base branch as fetched now (repo-config.mjs), so the PR can't change its own gates. Each
// gate is a shell command run with `sh -c` at the tree's root, one after another; the ones that run are those the config
// always runs, those the body's Gates: line names, and those whose path glob matches a changed file. The status
// description ends with `; base SHA`, which repo-merge.mjs reads to know the gate ran against the current base.
// Gates run PR code, so a run is kept apart from the runner: the tree is a `--shared` clone with no remote (not a worktree
// of the checkout, so a gate can't move its refs or config), the environment is an allowlist with a scratch HOME (so no
// gh, GitHub or stam tokens in the env), and each gate runs in its own process group, killed when it ends or passes its
// timeout. That scrubs the environment only: a gate runs as the runner's Unix user, so it can still read ~/.config/gh,
// stam's state and .env files. Gate trusted PRs only. One run at a time per cache folder holds flock on gate.lock; each
// run has its own tree, logs and comment file.
// Env: STAM_GATE_REPO the git checkout (default the current directory), STAM_GH the gh binary, STAM_REPO_CONFIG a JSON
// settings fallback under the file, STAM_REPO_GATE_CACHE the scratch folder (default ~/.cache/stam-repo-gate),
// STAM_REPO_GATE_TIMEOUT_MIN each gate's limit (default 60), STAM_REPO_GATE_LOCK_WAIT_MIN the wait for the lock (default
// 120), STAM_REPO_GATE_ENV a comma list of extra variable names the gates get.
// SIGINT, SIGTERM and SIGHUP stop the running gate's group before the run exits.
// Exit 0 when every gate passed, 1 when one failed or the gates could not run, 2 for usage, 130 when a signal stopped it.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GATES_CONTEXT, RepoConfigError, parseRepoGates, readRepoConfig, selectGates } from './repo-config.mjs';
import { envVar } from '../src/env.ts';
import { isMain } from './main-guard.mjs';

const DESCRIPTION_MAX = 140;
const TAIL_LINES = 40;
const TAIL_CHARS = 3000;
// The variables a gate gets from the runner (plus LC_*, STAM_REPO_GATE_ENV's names, and STAM_GATE=1 and a scratch HOME).
const ENV_ALLOW = ['PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TERM', 'TMPDIR', 'TZ'];
const KEEP_LOG_DAYS = 7;

export class RepoGateError extends Error {}

function git(cwd, args) {
  return spawnSync('git', ['-c', 'user.name=stam-gate', '-c', 'user.email=gate@stam.local', ...args], { cwd, encoding: 'utf8' });
}

// Runs gh in the checkout and returns its stdout; a failure throws RepoGateError with gh's message.
export function gh(args, cwd) {
  const r = spawnSync(envVar('GH') || 'gh', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new RepoGateError(`gh ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || r.stdout || r.error?.message || '').trim()}`);
  return r.stdout;
}

// `--repo OWNER/NAME` when the config names the GitHub repo; else gh takes it from the checkout's remote.
export const repoArgs = (config) => (config?.github ? ['--repo', config.github] : []);
// The API path prefix for the repo: gh fills {owner}/{repo} from the checkout when the config names none.
export const apiRepo = (config) => `repos/${config?.github ?? '{owner}/{repo}'}`;

// Fetches origin's BRANCH into a ref of this run's own and returns its sha; the ref is deleted on every path.
export function fetchSha(repo, branch) {
  const ref = `refs/repo-gate/${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    const r = git(repo, ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:${ref}`]);
    if (r.status !== 0) throw new RepoGateError(`fetch of ${branch} failed: ${r.stderr.trim()}`);
    return git(repo, ['rev-parse', '--verify', ref]).stdout.trim();
  } finally {
    git(repo, ['update-ref', '-d', ref]);
  }
}

// The branch a PR must target, from a source the PR can't change: the settings fallback's mainBranch, else origin's
// default branch (its HEAD). The config is read only from this branch, so a PR aimed at a branch it controls can't bring
// its own config.
export function trustedMain(repo, fallback) {
  if (fallback?.mainBranch) return fallback.mainBranch;
  const r = git(repo, ['ls-remote', '--symref', 'origin', 'HEAD']);
  const m = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(r.stdout ?? '');
  if (r.status !== 0 || !m) throw new RepoGateError(`can't read origin's default branch: ${(r.stderr || 'no HEAD symref').trim()}`);
  return m[1];
}

// The settings fallback from STAM_REPO_CONFIG, or null.
export function fallbackOf(env) {
  if (!envVar('REPO_CONFIG', env)) return null;
  try {
    return JSON.parse(envVar('REPO_CONFIG', env));
  } catch (e) {
    throw new RepoConfigError(`STAM_REPO_CONFIG is not JSON: ${e.message}`);
  }
}

const cacheOf = (env) => envVar('REPO_GATE_CACHE', env) || join(homedir(), '.cache/stam-repo-gate');
const minutes = (v, d) => (Number(v) > 0 ? Number(v) : d);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Takes flock on LOCK in a child that holds it until its stdin closes; resolves with that child, or null when flock gave
// up (-n, or -w SECONDS ran out). The kernel releases the lock when the holder dies, so a dead run never blocks the next,
// and -o keeps the lock's fd out of the holder's own child, so nothing else can keep it.
function takeFlock(lock, waitArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn('flock', ['-o', ...waitArgs, '-E', '75', lock, 'sh', '-c', 'echo held; exec cat >/dev/null'], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('held\n')) resolve(child);
    });
    child.on('error', (e) => reject(new RepoGateError(`flock failed: ${e.message}`)));
    child.on('exit', (code) => (code === 75 ? resolve(null) : reject(new RepoGateError(`flock exited ${code} before taking ${lock}`))));
  });
}

// Runs fn holding flock on CACHE/gate.lock, one run at a time (the same kernel lock scripts/gate.mjs uses; S-1883 showed
// pid files with takeover still let two runs in). Waits up to STAM_REPO_GATE_LOCK_WAIT_MIN, then throws RepoGateError.
export async function withLock(env, fn) {
  const cache = cacheOf(env);
  mkdirSync(cache, { recursive: true });
  const lock = join(cache, 'gate.lock');
  let holder = await takeFlock(lock, ['-n']);
  if (!holder) {
    console.error(`repo-gate: waiting for another gate run (${lock} is locked)`);
    const seconds = Math.ceil(minutes(envVar('REPO_GATE_LOCK_WAIT_MIN', env), 120) * 60);
    holder = await takeFlock(lock, ['-w', String(seconds)]);
    if (!holder) throw new RepoGateError(`another gate run holds ${lock}`);
  }
  for (const sig of SIGNALS) process.on(sig, stopOnSignal);
  try {
    return await fn();
  } finally {
    for (const sig of SIGNALS) process.off(sig, stopOnSignal);
    // A holder that already died has nothing left to release.
    if (holder.exitCode === null && holder.signalCode === null) {
      const gone = new Promise((r) => holder.once('exit', r));
      holder.stdin.end();
      await gone;
    }
  }
}

// The process groups of the gates running now. A signal that ends the run stops them first, so no gate outlives the
// run whose lock the kernel then frees.
// `stopping` is set at once, so no gate starts after the signal, and every group still live is stopped before the exit.
const running = new Set();
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
let stopping = false;
function stopOnSignal() {
  if (stopping) return;
  stopping = true;
  const stopAll = async () => {
    while (running.size) await Promise.all([...running].map(stopGroup));
  };
  void stopAll().finally(() => process.exit(130));
}

// The env a gate runs with: the allowlisted variables, any STAM_REPO_GATE_ENV names, a scratch HOME, and STAM_GATE=1.
// Everything else (GH_TOKEN, GITHUB_TOKEN, STAM_TOKEN, API keys) stays with the runner.
export function gateEnv(env, home) {
  const extra = String(envVar('REPO_GATE_ENV', env) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const out = {};
  for (const [k, v] of Object.entries(env)) if (ENV_ALLOW.includes(k) || k.startsWith('LC_') || extra.includes(k)) out[k] = v;
  return { ...out, HOME: home, ...{ STAM_GATE: '1' } };
}

// Removes a run's log folders older than KEEP_LOG_DAYS.
function pruneLogs(dir) {
  const cutoff = Date.now() - KEEP_LOG_DAYS * 86_400_000;
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {}
  for (const n of names) {
    try {
      if (statSync(join(dir, n)).mtimeMs < cutoff) rmSync(join(dir, n), { recursive: true, force: true });
    } catch {}
  }
}

// Stops a gate's process group: TERM, then KILL after 5 s.
async function stopGroup(pid) {
  const alive = () => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  if (!alive()) return;
  try { process.kill(-pid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 50 && alive(); i++) await sleep(100);
  try { process.kill(-pid, 'SIGKILL'); } catch {}
}

// A status description, at most 140 characters, that ends with the base sha the gate tested on.
export function describe(text, baseSha) {
  const suffix = baseSha ? `; base ${baseSha}` : '';
  const room = DESCRIPTION_MAX - suffix.length;
  return (text.length > room ? `${text.slice(0, room - 3)}...` : text) + suffix;
}

function tail(log) {
  const text = readFileSync(log, 'utf8').split('\n').slice(-TAIL_LINES).join('\n').trimEnd();
  return text.length > TAIL_CHARS ? text.slice(-TAIL_CHARS) : text;
}

// Runs one gate's command in TREE, in its own process group, with its output in LOG. Resolves to { code, timedOut }: 127
// when it could not start, 124 when it passed TIMEOUT_MS and was stopped. The group is stopped when the gate ends too, so
// a server it started doesn't outlive it. Once a signal is stopping the run, it starts nothing and never resolves: the run
// exits from the signal handler, with nothing posted.
function runOne(command, tree, log, env, timeoutMs) {
  return new Promise((done) => {
    if (stopping) return;
    const fd = openSync(log, 'w');
    const child = spawn('sh', ['-c', command], { cwd: tree, env, stdio: ['ignore', fd, fd], detached: true });
    closeSync(fd);
    if (child.pid) running.add(child.pid);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void stopGroup(child.pid);
    }, timeoutMs);
    const finish = async (code) => {
      clearTimeout(timer);
      if (child.pid) await stopGroup(child.pid);
      running.delete(child.pid);
      // A gate the signal handler stopped never completes: the run exits from the handler.
      if (!stopping) done({ code: timedOut ? 124 : code, timedOut });
    };
    child.on('error', () => void finish(127));
    child.on('exit', (code, signal) => void finish(code ?? (signal ? 128 : 1)));
  });
}

// Merges the PR head onto the base in a fresh `--shared` clone, reads the config at the base, picks and runs the gates.
// Returns { ok, text, baseSha, comment, config, logDir }; `notRun` is set when the gates never ran for a reason that is no
// verdict on the PR (a failed fetch or clone, a moved head). Posts nothing. Callers hold the lock (runRepoGate does).
export async function gatePr(pr, info, env = process.env) {
  const repo = envVar('GATE_REPO', env) || process.cwd();
  const cache = cacheOf(env);
  const run = `${process.pid}-${randomBytes(4).toString('hex')}`;
  const work = join(cache, 'runs', `pr-${pr}-${run}`);
  const tree = join(work, 'tree');
  const logDir = join(cache, 'logs', `pr-${pr}`, run);
  const short = info.headRefOid.slice(0, 7);
  let baseSha = null;
  let config = null;
  const notRun = (message) => ({ ok: false, notRun: true, text: message, baseSha, config, comment: `Gates not run: ${message}.` });
  try {
    // A fork's head isn't a branch of origin: fetching it by name would find another branch or nothing.
    if (info.isCrossRepository) {
      const text = `fork PRs aren't supported (head ${info.headRepositoryOwner?.login ?? 'a fork'}:${info.headRefName})`;
      return { ok: false, text, baseSha, config, comment: `Gates not run: ${text}.` };
    }
    const fallback = fallbackOf(env);
    const main = trustedMain(repo, fallback);
    if (info.baseRefName !== main) {
      const text = `base is ${info.baseRefName}, not ${main}`;
      return { ok: false, text, baseSha, config, comment: `Gates not run: the PR's ${text}.` };
    }
    baseSha = fetchSha(repo, main);
    const headNow = fetchSha(repo, info.headRefName);
    if (headNow !== info.headRefOid) return notRun(`PR head moved to ${headNow.slice(0, 7)} since the gate read it`);
    config = readRepoConfig(repo, baseSha, fallback);
    if (!config) return { ok: false, text: `${main} has no .stam/repo.json`, baseSha, config, comment: `Gates not run: ${main} has no .stam/repo.json and no settings fallback.` };
    if (config.mainBranch !== main) {
      const text = `.stam/repo.json says mainBranch ${config.mainBranch}, but the main branch is ${main}`;
      return { ok: false, text, baseSha, config, comment: `Gates not run: ${text}; set itsa.repoConfig mainBranch in settings or fix the file.` };
    }
    let named;
    try {
      named = parseRepoGates(info.body, config);
    } catch (e) {
      if (!(e instanceof RepoConfigError)) throw e;
      return { ok: false, text: e.message, baseSha, config, comment: `Gates not run: ${e.message}.` };
    }
    mkdirSync(work, { recursive: true });
    // Its own repo, borrowing the checkout's objects: the gate can't move the checkout's refs or config, and with no
    // remote it has nowhere to push.
    const clone = git(work, ['clone', '--quiet', '--shared', '--no-checkout', repo, tree]);
    if (clone.status) return notRun(`clone failed: ${clone.stderr.trim()}`);
    git(tree, ['remote', 'remove', 'origin']);
    const checkout = git(tree, ['checkout', '--quiet', '--detach', baseSha]);
    if (checkout.status) return notRun(`checkout of ${baseSha.slice(0, 7)} failed: ${checkout.stderr.trim()}`);
    const merge = git(tree, ['merge', '--no-ff', '--no-edit', '-m', `Gate: merge PR head into ${info.baseRefName}`, info.headRefOid]);
    if (merge.status !== 0) {
      const conflicts = git(tree, ['diff', '--name-only', '--diff-filter=U']).stdout.split('\n').filter(Boolean);
      git(tree, ['merge', '--abort']);
      if (!conflicts.length) return notRun(`merge failed: ${(merge.stderr || merge.stdout).trim()}`);
      const files = conflicts.join(', ');
      return { ok: false, text: `merge conflict: ${files}`, baseSha, config, comment: `Gates not run: ${short} conflicts with ${info.baseRefName} at ${baseSha.slice(0, 7)} in ${files}.` };
    }
    const paths = git(tree, ['diff', '--name-only', '--no-renames', baseSha, 'HEAD']).stdout.split('\n').filter(Boolean);
    const gates = selectGates(config, named, paths);
    pruneLogs(join(cache, 'logs', `pr-${pr}`));
    mkdirSync(logDir, { recursive: true });
    const home = join(work, 'home');
    mkdirSync(home);
    const timeoutMin = minutes(envVar('REPO_GATE_TIMEOUT_MIN', env), 60);
    const results = [];
    for (const [i, g] of gates.entries()) {
      const log = join(logDir, `${i + 1}-${g.name}.log`);
      const r = await runOne(g.command, tree, log, gateEnv(env, home), timeoutMin * 60_000);
      results.push({ name: g.name, ...r, log });
    }
    const failed = results.filter((r) => r.code !== 0);
    const why = (r) => (r.timedOut ? `timed out after ${timeoutMin} min` : `exit ${r.code}`);
    const lines = results.length
      ? results.map((r) => (r.code === 0 ? `- pass: ${r.name}` : `- FAIL: ${r.name} (${why(r)})\n\n  \`\`\`\n${tail(r.log).replace(/^/gm, '  ')}\n  \`\`\``))
      : ['- no gates matched'];
    return {
      ok: failed.length === 0,
      text: failed.length ? `gates fail: ${failed.map((r) => r.name).join(', ')}` : `gates pass: ${results.map((r) => r.name).join(', ') || 'no gates'}`,
      baseSha,
      config,
      comment: [`Gates on ${short} merged onto ${info.baseRefName} at ${baseSha.slice(0, 7)}:`, ...lines].join('\n'),
      logDir,
    };
  } catch (e) {
    if (e instanceof RepoConfigError) return { ok: false, text: e.message, baseSha, config, comment: `Gates not run: ${e.message}.` };
    if (e instanceof RepoGateError) return notRun(e.message);
    throw e;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// The `gh pr view` fields the gate and the merge read.
export const PR_FIELDS = 'headRefName,headRefOid,body,baseRefName,isCrossRepository,headRepositoryOwner';

// Runs the PR's gates end to end under the lock: reads the PR, gates it, posts the status on its head and a comment.
// Returns the gate's result (see gatePr).
export async function runRepoGate(pr, env = process.env) {
  return withLock(env, () => gateAndPost(pr, env));
}

async function gateAndPost(pr, env) {
  const repo = envVar('GATE_REPO', env) || process.cwd();
  const cache = cacheOf(env);
  // The fallback may name the GitHub repo before the base's file is read.
  const early = fallbackOf(env);
  const info = JSON.parse(gh(['pr', 'view', pr, ...repoArgs(early), '--json', PR_FIELDS], repo));
  const result = await gatePr(pr, info, env);
  // A run a signal is stopping posts nothing; the handler exits it.
  if (stopping) return new Promise(() => {});
  const config = result.config ?? early;
  const description = describe(result.text, result.baseSha);
  const state = result.ok ? 'success' : 'failure';
  gh(['api', `${apiRepo(config)}/statuses/${info.headRefOid}`, '-f', `state=${state}`, '-f', `context=${GATES_CONTEXT}`, '-f', `description=${description}`], repo);
  const file = join(cache, `comment-pr-${pr}-${process.pid}-${randomBytes(4).toString('hex')}.md`);
  writeFileSync(file, result.comment);
  try {
    gh(['pr', 'comment', pr, ...repoArgs(config), '--body-file', file], repo);
  } finally {
    rmSync(file, { force: true });
  }
  console.log(`${state}: ${description}`);
  return { ...result, head: info.headRefOid };
}

async function cli(args) {
  if (args.length !== 1 || !/^\d+$/.test(args[0])) {
    console.error('usage: node scripts/repo-gate.mjs PR_NUMBER');
    return 2;
  }
  try {
    return (await runRepoGate(args[0])).ok ? 0 : 1;
  } catch (e) {
    console.error(`repo-gate: ${e instanceof Error ? e.message : e}`);
    return 1;
  }
}

if (isMain(import.meta.url)) process.exitCode = await cli(process.argv.slice(2));
