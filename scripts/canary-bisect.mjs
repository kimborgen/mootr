#!/usr/bin/env node
// Canary bisection (S-1750). When the pre-deploy canary (S-1749) fails a batch of merges, the deploy watcher holds first,
// then starts this as its own systemd unit, so the bisection never delays the hold or counts against the watcher's run
// budget. It halves the first-parent merges between the live release and the candidate, running only the canary on
// each midpoint (canary.mjs's canary(): a scratch build and scratch daemons on a copy of the db, at nice priority),
// never live. The canary compares each midpoint with releases/current, which is the live release, so a pass means that
// midpoint is good and a fail that the regression is at or before it.
//   node scripts/canary-bisect.mjs FILE     FILE is STAM_HOME/deploy-bisect.json, written by the watcher
// Flake guard: the candidate's fail must reproduce (one more run), and so must each midpoint's fail (it runs twice).
// A rerun that passes, or any step that returns an error, stops the bisection as inconclusive, with the steps tried.
// The result goes to cos by mail and, when one merge is named, as a comment on its PR; it is also written back to FILE.
// The whole bisection has its own deadline (STAM_DEPLOY_BISECT_TIMEOUT_MS), each step the canary's own timeout, and
// the unit's RuntimeMaxSec is past both. A SIGTERM (the watcher, once the hold is removed, or systemd) aborts the step
// that runs, whose canary stops its daemons and build and removes its run folder, and reports the bisection canceled.
// A removed hold stops it before the next step too.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { comment, config, mail } from './deploy-on-merge.mjs';
import { canary, canaryConfig } from './canary.mjs';
import { tryLock } from '../src/release-lock.ts';

// Bisects `merges` (oldest first, each { sha, pr }), whose last one the canary already failed once, with
// runCanary(sha, signal) -> { verdict, reasons }. Returns { result: 'found', merge, reasons, steps } naming the first bad
// merge, or { result: 'inconclusive', why, steps }. Each step in `steps` is { sha, pr, runs, reasons }.
export async function bisect(merges, runCanary, { signal, stepMs = Infinity, log = () => {}, held = () => true } = {}) {
  const steps = [];
  const stop = (why) => ({ result: 'inconclusive', why, steps });
  // One canary run of merge i, cut off at stepMs: 'pass', 'fail', or an error with its reason.
  const once = async (i, step) => {
    const timer = AbortSignal.timeout(stepMs === Infinity ? 2 ** 31 - 1 : stepMs);
    const r = await runCanary(merges[i].sha, signal ? AbortSignal.any([signal, timer]) : timer);
    const verdict = r.verdict === 'pass' || r.verdict === 'fail' ? r.verdict : 'error';
    step.runs.push(verdict);
    const why = timer.aborted && !signal?.aborted ? [`timed out after ${Math.round(stepMs / 1000)} s`] : (r.reasons ?? []).filter(Boolean);
    if (verdict !== 'pass') step.reasons = why;
    log(`bisect: ${merges[i].sha.slice(0, 10)}${merges[i].pr ? ` (PR #${merges[i].pr.number})` : ''}: ${verdict}${why.length && verdict !== 'pass' ? `: ${why.join('; ')}` : ''}`);
    return verdict;
  };
  // A step: `runs` canary runs at most, of which every one must fail for the merge to count as bad. Returns 'pass',
  // 'fail', or the reason it can't say.
  const check = async (i, runs) => {
    if (signal?.aborted) return 'canceled';
    if (!held()) return 'canceled: the hold was removed';
    const step = { sha: merges[i].sha, pr: merges[i].pr?.number ?? null, runs: [], reasons: [] };
    steps.push(step);
    for (let n = 0; n < runs; n++) {
      const v = await once(i, step);
      if (signal?.aborted) return 'canceled';
      if (v === 'error') return `the canary of ${step.sha.slice(0, 10)} couldn't run: ${step.reasons.join('; ') || 'no reason given'}`;
      if (v === 'pass') return n === 0 ? 'pass' : `the canary of ${step.sha.slice(0, 10)} failed, then passed: it is flaky here`;
    }
    return 'fail';
  };
  let lo = -1;
  let hi = merges.length - 1;
  // The watcher's run was the candidate's first fail; one more makes it reproduce.
  const tip = await check(hi, 1);
  if (tip === 'pass') return stop(`the candidate's fail didn't reproduce: the canary passed ${merges[hi].sha.slice(0, 10)} on its rerun`);
  if (tip !== 'fail') return stop(tip);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const r = await check(mid, 2);
    if (r === 'pass') lo = mid;
    else if (r === 'fail') hi = mid;
    else return stop(r);
  }
  // The merge before the bad one passed once; it must pass again before the bad one is named. With none (lo is -1), the
  // one before is the live release, which every canary run compares against.
  if (lo >= 0) {
    const again = await check(lo, 1);
    if (again === 'fail') return stop(`the canary of ${merges[lo].sha.slice(0, 10)} passed, then failed: it is flaky there`);
    if (again !== 'pass') return stop(again);
  }
  const last = steps.findLast((s) => s.sha === merges[hi].sha);
  return { result: 'found', merge: merges[hi], before: lo >= 0 ? merges[lo] : null, reasons: last.reasons, steps };
}

// The process's start time, in clock ticks since boot (/proc/PID/stat field 22): with the pid, it names one process,
// so a pid reused later is never taken for the bisection. Undefined when it can't be read.
export function startTime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch {
    return undefined;
  }
}

const linkName = (c, name) => {
  try {
    return basename(readlinkSync(join(c.releases, name)));
  } catch {
    return undefined;
  }
};

// Whether any process runs from `dir` (its cwd, or a path in its command line).
function inUse(dir) {
  for (const p of readdirSync('/proc')) {
    if (!/^\d+$/.test(p)) continue;
    try {
      if (readlinkSync(`/proc/${p}/cwd`).startsWith(dir) || readFileSync(`/proc/${p}/cmdline`, 'utf8').includes(dir)) return true;
    } catch {}
  }
  return false;
}

// Removes the release folders the bisection's own builds created (canary()'s `built.created`, from `stam deploy
// --build-only`), never one a build found already there. Under the deploy lock that deploy, rollback and
// prune take (src/release-lock.ts), it reads current and previous, checks which folders a process runs from, and renames each
// folder it may take to a hidden `.build-NAME-PID`, so no deploy can switch current to a folder while it goes. It spares
// current, previous, `keep` (the candidate's release) and folders in use. When another process holds the lock it takes
// nothing and leaves the folders to prune. The recursive deletes run after the lock is given back; one killed halfway
// leaves no .release.json under the release's name for build() to reuse, and prune sweeps `.build-*-PID` once this pid
// is gone. No prune and no MCP reload. `rm` is the delete, for tests. Returns the names removed, or undefined when locked.
export async function removeBuilt(c, built, keep = [], rm = (dir) => rmSync(dir, { recursive: true, force: true })) {
  if (![...built].length) return [];
  const unlock = existsSync(c.releases) ? await tryLock(c.releases) : undefined;
  if (!unlock) return undefined;
  const taken = [];
  try {
    const spare = new Set([linkName(c, 'current'), linkName(c, 'previous'), ...keep].filter(Boolean));
    for (const name of built) {
      const dir = join(c.releases, name);
      if (spare.has(name) || !existsSync(dir) || inUse(dir)) continue;
      const hidden = join(c.releases, `.build-${name}-${process.pid}`);
      renameSync(dir, hidden);
      taken.push({ name, hidden });
    }
  } finally {
    await unlock();
  }
  for (const { hidden } of taken) rm(hidden);
  return taken.map((t) => t.name);
}

// The steps as lines, for the mail: each merge, its PR, and its runs.
const stepLines = (steps) => steps.map((s) => `- ${s.sha.slice(0, 10)}${s.pr ? ` PR #${s.pr}` : ''}: ${s.runs.join(', ')}${s.reasons.length ? ` (${s.reasons.join('; ').slice(0, 300)})` : ''}`);

// A canary run through a shell command (STAM_BISECT_CANARY_CMD, for tests): exit 0 pass, 1 fail, anything else an
// error; its last output line is the reason, and a `build-only: created NAME` or `reused NAME` line is its build, as
// stam deploy --build-only prints it. CANARY_SHA is the sha. An abort kills it.
function canaryCmd(command, cwd) {
  return (sha, signal) =>
    new Promise((done) => {
      // Its own group, killed whole on abort, so nothing it started keeps its output open.
      const child = spawn('sh', ['-c', command], { cwd, env: { ...process.env, CANARY_SHA: sha }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      const kill = () => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      };
      if (signal.aborted) kill();
      signal.addEventListener('abort', kill, { once: true });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('error', () => {});
      child.on('close', (code) => {
        signal.removeEventListener('abort', kill);
        const reason = out.trim().split('\n').pop()?.replace(/^canary: \w+: ?/, '') ?? '';
        const b = /^build-only: (created|reused) (\S+)$/m.exec(out);
        done({ verdict: signal.aborted ? 'error' : code === 0 ? 'pass' : code === 1 ? 'fail' : 'error', reasons: signal.aborted ? ['canceled'] : [reason], ...(b ? { built: { release: b[2], created: b[1] === 'created' } } : {}) });
      });
    });
}

// Runs the bisection the watcher wrote to `file` ({ release, good, merges, env }), then reports it and writes it back.
// `env` is the watcher's own STAM_DEPLOY_* and STAM_CANARY_* settings, so the unit runs with the deadline, timeouts,
// canary settings and mail command the watcher had (and its RuntimeMaxSec was computed from).
export async function main(file, base = process.env) {
  const job = JSON.parse(readFileSync(file, 'utf8'));
  // The canary's build and copy read process.env, so the settings go there.
  Object.assign(process.env, job.env ?? {});
  const env = { ...base, ...(job.env ?? {}) };
  const c = config(env);
  const ctx = { DEPLOY_SHA: job.merges.at(-1).sha, DEPLOY_RELEASE: job.release };
  const save = (fields) => writeFileSync(file, `${JSON.stringify({ ...job, ...fields })}\n`);
  const self = { pid: process.pid, pidStart: startTime(process.pid) };
  save({ state: 'running', ...self, started: new Date().toISOString() });
  const controller = new AbortController();
  let why;
  const end = (reason) => {
    why ??= reason;
    controller.abort();
  };
  const deadline = setTimeout(() => end(`timed out after ${Math.round(c.timeout.bisect / 1000)} s`), c.timeout.bisect);
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(sig, () => end(`canceled (${sig})`));
  const run = env.STAM_BISECT_CANARY_CMD ? canaryCmd(env.STAM_BISECT_CANARY_CMD, c.repo) : (sha, signal) => canary(canaryConfig(env), sha, console.log, signal);
  // The release folders the steps' builds created, as the builds report them, so they go when the bisection ends.
  const built = new Set();
  const runCanary = async (sha, signal) => {
    const r = await run(sha, signal);
    if (r.built?.created) built.add(r.built.release);
    return r;
  };
  let r;
  try {
    r = await bisect(job.merges, runCanary, { signal: controller.signal, stepMs: c.timeout.canary, log: console.log, held: () => existsSync(c.hold) });
  } catch (e) {
    r = { result: 'inconclusive', why: `the bisection crashed: ${e.message}`, steps: [] };
  } finally {
    clearTimeout(deadline);
    // A failed cleanup must not lose the result: it is logged, and the report goes on.
    try {
      const removed = await removeBuilt(c, built, [job.release]);
      if (removed === undefined) console.log(`bisect: the deploy lock is held, so the releases it built are left to prune: ${[...built].join(' ')}`);
      else if (removed.length) console.log(`bisect: removed the releases it built: ${removed.join(' ')}`);
    } catch (e) {
      console.error(`bisect: removing the releases it built failed: ${e.message}`);
    }
  }
  if (r.result === 'inconclusive' && why) r.why = why;
  save({ state: 'done', ...self, finished: new Date().toISOString(), outcome: r });
  const n = job.merges.length;
  const holds = existsSync(c.hold) ? `The watcher still holds until ${c.hold} is removed.` : 'The hold was removed, so the watcher has moved on.';
  if (r.result === 'found') {
    const { sha, pr } = r.merge;
    const name = pr ? `PR #${pr.number}` : `commit ${sha.slice(0, 10)}`;
    const before = r.before ? `the merge before it (${r.before.sha.slice(0, 10)}${r.before.pr ? `, PR #${r.before.pr.number}` : ''}) passed twice` : `the merge before it is the live release, ${job.good?.slice(0, 10) ?? 'releases/current'}, which every canary run compares against`;
    const body = [
      `The canary bisection of the ${n} merges held at ${job.release} names the first bad merge: ${name} (${sha}). Its canary failed twice, and ${before}.`,
      `Canary: ${r.reasons.join('; ') || 'fail'}`,
      '',
      `Steps (canary runs only, live untouched):`,
      ...stepLines(r.steps),
      '',
      holds,
    ].join('\n');
    await mail(c, ctx, `deploy of ${job.release} held: canary bisection names ${name}`, body);
    if (pr) comment(c, pr, `The canary bisection of deploy ${job.release} names this PR's merge (${sha.slice(0, 10)}) as the first bad one of ${n}: its canary failed twice, and ${before}.\n\n\`\`\`\n${r.reasons.join('\n').slice(0, 2000)}\n\`\`\``);
    console.log(`bisect: first bad merge ${sha} (${name})`);
    return 0;
  }
  const body = [`The canary bisection of the ${n} merges held at ${job.release} is inconclusive: ${r.why}.`, '', 'Steps tried:', ...(r.steps.length ? stepLines(r.steps) : ['- none']), '', holds].join('\n');
  await mail(c, ctx, `deploy of ${job.release} held: canary bisection inconclusive`, body);
  console.log(`bisect: inconclusive: ${r.why}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [file, ...rest] = process.argv.slice(2);
  if (!file || rest.length) {
    console.error('usage: node scripts/canary-bisect.mjs FILE');
    process.exit(2);
  }
  main(file).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`canary-bisect.mjs: ${e.message}`);
      process.exit(2);
    },
  );
}
