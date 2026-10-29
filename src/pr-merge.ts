// The merge relay (S-2279): `pr_merge` merges an approved PR for an agent on any machine. It runs on the ITSA
// home, where gh and the gate lock are: the home daemon starts `node scripts/merge-pr.mjs N` detached (its own
// session, outside any agent's shell, so no harness reaps it or blocks it), records the run under
// $STAM_HOME/pr-merge/, and when it ends mails the caller the outcome: the merge sha, a refusal with its reason,
// or "not merged" with the script's last lines. One run per PR at a time: a second call while one runs gets it.
// The run outlives a daemon restart: a shell around the script writes its exit status, and the poll here reads it.
// Open runs (not yet reported) are $STAM_HOME/pr-merge/N.json, kept in memory too so the poll reads only those; a reported
// run moves to done/N.json, and only the newest LOGS_KEPT logs stay.
// Who may merge: the chief of staff and the assistant (via.boss), the human, and an agent whose tree owns the
// PR's ITSA (its body's ITSA: line) or whose tree's worktree is on the PR's branch (branch-scope.ts).
// `pr_merge` with cancel (cancelHere, S-2709) takes the PR out of the merge queue on the same terms: scripts/merge-cancel.mjs runs
// under the gate lock, stops the run's shell and the PR's merge worker by recorded pid and start time, and drops its tickets.
// A held lock means a train is running: it can't be stopped (other PRs share it), so a PR that is in it gets a cancel claim on
// its ticket and the train drops the PR before its merge (S-3679); one exclusive claim file decides merge or cancel, never both.
// `pr_close` (closeHere) closes a PR on the same terms, such as one a later PR superseded: `gh pr close N --comment`.
// A PR sent back unmerged (refused, or not merged) whose caller is gone (archived, shut down, or refused mail) goes to whoever
// src/failure-route.ts finds (S-3802): its ITSA's owner, woken if gone, else up its tree, else cos with a fallback ITSA; its ITSA is
// reopened. Those steps run through the stam CLI as the `pr-merge` system sender.
import { execFile, spawn } from 'node:child_process';
import { lockHome } from './default-home.ts';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { MACHINE, STAM_HOME } from './config.ts';
import * as db from './db.ts';
import * as itsa from './itsa.ts';
import { HUMAN, RefusedError, sendMail } from './mail.ts';
import { descendants } from './org.ts';
import { branchScope } from './branch-scope.ts';
import { peerByName, peerCall, type Via } from './peers.ts';
import { prOpenConfig, type PrOpenConfig } from './pr-open.ts';
import { settings } from './settings.ts';
import { envVar } from './env.ts';
import { testOnlyEnv } from './test-env.ts';
import { deployCheckout } from './workspace.ts';
import { COS, fallback, itsaOf, pickUp, reopen, type ItsaView, type PickUp } from './failure-route.ts';

const run = promisify(execFile);

export type MergeState = 'running' | 'merged' | 'refused' | 'not_merged' | 'cancelled';

export interface MergeRun {
  pr: number;
  // Who asked: the agent the outcome is mailed to, or the human.
  by: string;
  itsa: string | null;
  branch: string;
  state: MergeState;
  started: string;
  ended?: string;
  // The shell around the script: its pid, start time (/proc stat field 22) and boot id, so a reused pid isn't taken for it.
  pid: number;
  start?: string;
  boot?: string;
  // The script's whole output, and the file the shell around it writes its exit status to.
  log: string;
  status: string;
  code?: number;
  sha?: string;
  // Why it wasn't merged: the script's refusal, or its last lines.
  reason?: string;
  reported?: boolean;
  // Who cancelled it (S-2709). Set before the run is stopped and kept while it is, so a daemon restart in between finishes the cancel.
  cancelBy?: string;
  // The gh and repo the run was started with, so a late reroute reads the PR's live state where it merges (S-3802). A record
  // without them (an older daemon's) reads settings.itsa.prOpen.
  gh?: string;
  github?: string;
}

export interface MergeStatus {
  pr: number;
  run: MergeRun | null;
  // The PR's place among merge-pr.mjs's live tickets (gate.mjs queuePosition): 1 is the one holding or next to take the gate lock.
  queue: { rank: number; first: string } | null;
  // The last lines of the merge worker's log under gate.lock.workers/, else of this run's own log.
  tail: string[];
  // The merge train holding the gate lock that has this PR (S-3067), read from the train's own record; null when none.
  train: TrainStatus | null;
  // Set on a build without the merge scripts (S-2827): there is no queue to read.
  note?: string;
}

// The train's active steps, from the train's record (gate.mjs openTrain). `since` is the earliest start among them, or the
// record's last change when none is in flight. `running` is a live train on this machine, `unknown` a record whose process can't
// be inspected, `elsewhere` a record from another host, which this machine can't check.
export interface TrainStatus {
  train: number;
  steps: string[];
  since: string;
  state: 'running' | 'unknown' | 'elsewhere';
  text: string;
}

// The script exits 0 when it merged and 3 on a verdict on the PR (merge-pr.mjs REFUSED); anything else is "not merged".
const REFUSED = 3;
const CANCELLED = 79; // merge-pr.mjs: the train dropped the PR on a cancel's claim, nothing merged (S-3679)
const TAIL = 15;
const SHA = /^[0-9a-f]{7,40}$/;
// The time gate.mjs stampText puts at a worker log line's start (S-3067). The run's own log has none (the caller relays the worker's
// lines without it); a worker log's lines are matched for a sha with it removed.
const STAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z /;
const stripStamp = (line: string): string => line.replace(STAMP, '');

const LOGS_KEPT = 50;

const runsDir = (): string => join(STAM_HOME, 'pr-merge');
const runFile = (pr: number): string => join(runsDir(), `${pr}.json`);
const doneFile = (pr: number): string => join(runsDir(), 'done', `${pr}.json`);
// The merge script: the deploy checkout's, as managers run it. STAM_PR_MERGE_SCRIPT replaces it in a test home only (test-env.ts),
// so a stray env var can't point the live home at another script.
export const scriptPath = (): string => testOnlyEnv('STAM_PR_MERGE_SCRIPT') || join(deployCheckout(), 'scripts/merge-pr.mjs');
// merge-pr.mjs's gate helpers, loaded on first use: the public export drops scripts/gate.mjs (as pr-open.ts loads it).
// STAM_PR_MERGE_GATE replaces its path in a test home only (test-env.ts), so a test can stand in a missing file.
const gatePath = (): string => testOnlyEnv('STAM_PR_MERGE_GATE') || fileURLToPath(new URL('../scripts/gate.mjs', import.meta.url));
// A build without gate.mjs (the public export, S-2420, S-2827) has no merge runs. Every path that needs the gate checks it first, and
// only its absence refuses: any other error from loading it surfaces as it is.
const gateMissing = (): boolean => !existsSync(gatePath());
function requireGate(pr: number): void {
  if (gateMissing()) throw new Error(`this build has no merge scripts (scripts/merge-pr.mjs, scripts/gate.mjs): merge with \`gh pr merge ${pr}\`. Nothing was started.`);
}
async function gate(pr: number): Promise<typeof import('../scripts/gate.mjs')> {
  requireGate(pr);
  return import(pathToFileURL(gatePath()).href);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function save(r: MergeRun, file = runFile(r.pr)): void {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(r, null, 2));
  renameSync(tmp, file);
}

// The PR's open run, else its last finished one.
export function readRun(pr: number): MergeRun | null {
  return readJson<MergeRun>(runFile(pr)) ?? readJson<MergeRun>(doneFile(pr));
}

// The merged PRs' last runs (the merge records the away digest reads, S-2821): one per PR, the newest kept.
export function mergedRuns(): MergeRun[] {
  const dir = join(runsDir(), 'done');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => /^\d+\.json$/.test(n))
    .map((n) => readJson<MergeRun>(join(dir, n)))
    .filter((r): r is MergeRun => !!r && r.state === 'merged' && !!r.ended);
}

// The PRs with an open run: read from disk once (the first poll after a daemon start), then kept here.
let open: Set<number> | null = null;
export function loadOpen(): Set<number> {
  open = new Set();
  if (existsSync(runsDir())) for (const name of readdirSync(runsDir())) if (/^\d+\.json$/.test(name)) open.add(Number(name.slice(0, -5)));
  return open;
}
const openRuns = (): Set<number> => open ?? loadOpen();

// One settle or start per PR at a time, so two calls can't both start a run.
const busy = new Map<number, Promise<unknown>>();
function serial<T>(pr: number, fn: () => Promise<T>): Promise<T> {
  const next = (busy.get(pr) ?? Promise.resolve()).then(fn, fn);
  busy.set(pr, next.catch(() => {}));
  return next;
}

// Whether the run's shell still runs: the same pid, start time and boot as recorded (gate.mjs's ticket check). Pid 0 is a
// spawn that failed.
async function alive(r: MergeRun): Promise<boolean> {
  if (!(r.pid > 0)) return false;
  const now = (await gate(r.pr)).processIdentity(r.pid);
  if (!now.start) return false;
  return (!r.start || now.start === r.start) && (!r.boot || now.boot === r.boot);
}

// Keeps the newest LOGS_KEPT logs (and their status files), never an open run's.
function pruneLogs(): void {
  const keep = new Set([...openRuns()].map((pr) => readJson<MergeRun>(runFile(pr))?.log));
  const logs = readdirSync(runsDir()).filter((n) => /^\d+-\d+\.log$/.test(n)).sort((a, b) => Number(b.split('-')[1].slice(0, -4)) - Number(a.split('-')[1].slice(0, -4)));
  for (const name of logs.slice(LOGS_KEPT)) {
    const log = join(runsDir(), name);
    if (keep.has(log)) continue;
    rmSync(log, { force: true });
    rmSync(log.replace(/\.log$/, '.status'), { force: true });
  }
}

function tailOf(file: string, n = TAIL): string[] {
  try {
    return readFileSync(file, 'utf8').split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-n);
  } catch {
    return [];
  }
}

function prNumber(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`pr_merge needs a PR number, not ${JSON.stringify(v)}`);
  return n;
}

async function gh(cfg: PrOpenConfig, args: string[]): Promise<string> {
  try {
    return (await run(cfg.gh, args, { maxBuffer: 16 << 20, timeout: 60_000 })).stdout;
  } catch (e: any) {
    throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${String(e.stderr ?? e.message).trim()}`);
  }
}

// The PR's body, head branch and state (OPEN, CLOSED, MERGED), from GitHub through the home's gh.
async function prView(cfg: PrOpenConfig, pr: number): Promise<{ body: string; branch: string; state: string }> {
  if (!cfg.github) throw new Error('pr_merge: no GitHub repo: set settings.itsa.prOpen.github, or give the repo an origin on github.com');
  const v = JSON.parse(await gh(cfg, ['pr', 'view', String(pr), '--repo', cfg.github, '--json', 'body,headRefName,state'])) as { body?: string; headRefName?: string; state?: string };
  return { body: v.body ?? '', branch: v.headRefName ?? '', state: v.state ?? '' };
}

export const itsaKeyOf = (body: string): string | null => body.match(/^ITSA:\s*(S-\d+)\s*$/m)?.[1] ?? null;

// Whether the agent's tree owns the ITSA: the agent or one of its descendants owns it, or the agent owns one of its parents.
function treeOwns(agent: string, x: itsa.Itsa): boolean {
  const id = db.getAgent(agent)?.id ?? agent;
  const tree = new Set([id, ...descendants(id)]);
  if (x.owner && tree.has(x.owner)) return true;
  return itsa.ancestorsOf(x).some((p) => p.owner === id);
}

// Why the caller may not merge (or close) the PR, or null when it may.
export async function mergeRefusal(via: Via | undefined, pr: number, view: { body: string; branch: string }, verb = 'merge'): Promise<string | null> {
  if (!via || via.boss) return null;
  const key = itsaKeyOf(view.body);
  const x = key ? itsa.find(key) : undefined;
  if (x && treeOwns(via.agent, x)) return null;
  if (view.branch && (await branchScope(via, view.branch)) === 'tree') return null;
  const name = db.getAgent(via.agent)?.name ?? db.findPeerAgent(via.agent)?.name ?? via.agent;
  const what = x ? `its ITSA ${x.key} isn't owned by ${name}'s tree` : key ? `its ITSA ${key} isn't known here` : 'its body names no ITSA';
  return `${name} can't ${verb} PR #${pr}: ${what}, and its branch ${view.branch || '(unknown)'} isn't the worktree branch of ${name} or a descendant. Only the owner's tree or the chief of staff may ${verb} it.`;
}

// Starts the merge script for the PR, detached, and records the run.
async function start(pr: number, by: string, key: string | null, branch: string, cfg: PrOpenConfig): Promise<MergeRun> {
  mkdirSync(runsDir(), { recursive: true });
  pruneLogs();
  const g = await gate(pr);
  const stamp = Date.now();
  const log = join(runsDir(), `${pr}-${stamp}.log`);
  const status = join(runsDir(), `${pr}-${stamp}.status`);
  // The shell writes the script's exit status once it ends, so a daemon restart in between still learns it.
  const child = spawn('sh', ['-c', '"$0" "$1" "$2" >"$3" 2>&1; echo $? >"$4.tmp"; mv "$4.tmp" "$4"', process.execPath, scriptPath(), String(pr), log, status], {
    cwd: deployCheckout(),
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.on('error', (e) => console.error(`pr_merge: PR #${pr}: ${e.message}`));
  child.unref();
  const id = child.pid ? g.processIdentity(child.pid) : { start: '', boot: '' };
  const r: MergeRun = { pr, by, itsa: key, branch, state: 'running', started: new Date(stamp).toISOString(), pid: child.pid ?? 0, start: id.start, boot: id.boot, log, status, gh: cfg.gh, github: cfg.github };
  save(r);
  openRuns().add(pr);
  return r;
}

// On the ITSA home: checks who asks, then starts the merge, or returns the run already going for the PR.
// A finished run whose mail failed comes back as `previous`, so its outcome reaches this caller instead of being lost.
export async function mergeHere(input: { pr: unknown; by?: string | null }, via?: Via, cfg: PrOpenConfig = prOpenConfig()): Promise<MergeRun & { already: boolean; previous?: MergeRun }> {
  const pr = prNumber(input.pr);
  const view = await prView(cfg, pr);
  const why = await mergeRefusal(via, pr, view);
  if (why) throw new itsa.ForbiddenError(why);
  requireGate(pr);
  return serial(pr, async () => {
    let current = await settle(pr);
    if (current?.state === 'running') return { ...current, already: true };
    if (current) archive(current);
    // An archived run nobody was told about (its caller is gone) goes to this caller instead.
    current ??= readJson<MergeRun>(doneFile(pr));
    if (current?.reported) current = null;
    // Checked just before a run would start: the public export leaves scripts/merge-pr.mjs out, so there is nothing to start.
    const script = scriptPath();
    if (!existsSync(script)) throw new Error(`pr_merge can't merge PR #${pr}: ${script} is missing. The merge script is the deploy checkout's scripts/merge-pr.mjs; set STAM_DEPLOY_REPO to a checkout that has it (otherwise stam uses the checkout it runs from). Nothing was started.`);
    const by = input.by || via?.agent || HUMAN;
    console.log(`pr_merge: PR #${pr} for ${by}`);
    return { ...(await start(pr, by, itsaKeyOf(view.body), view.branch, cfg)), already: false, ...(current ? { previous: current } : {}) };
  });
}

export interface Closed {
  pr: number;
  // False when the PR was already closed or merged: nothing was done.
  closed: boolean;
  // The PR's state before the call: OPEN, CLOSED, or MERGED.
  state: string;
}

// On the ITSA home: checks who asks as a merge does, then closes the PR with the comment. gh runs without a shell, and
// the comment rides as one --comment= argument, so its text is never read as a flag.
export async function closeHere(input: { pr: unknown; comment?: unknown; by?: string | null }, via?: Via, cfg: PrOpenConfig = prOpenConfig()): Promise<Closed> {
  const pr = prNumber(input.pr);
  const comment = String(input.comment ?? '').trim();
  if (!comment) throw new Error('pr_close needs a comment: say why, such as the PR that supersedes it');
  const view = await prView(cfg, pr);
  const why = await mergeRefusal(via, pr, view, 'close');
  if (why) throw new itsa.ForbiddenError(why);
  if (view.state !== 'OPEN') return { pr, closed: false, state: view.state };
  await gh(cfg, ['pr', 'close', String(pr), '--repo', cfg.github, `--comment=${comment}`]);
  console.log(`pr_close: PR #${pr} for ${input.by || via?.agent || HUMAN}`);
  return { pr, closed: true, state: view.state };
}

// On the ITSA home: the PR's run, its place in merge-pr.mjs's queue, and its worker log's last lines.
export async function statusHere(input: { pr: unknown }): Promise<MergeStatus> {
  const pr = prNumber(input.pr);
  const r = readRun(pr);
  if (gateMissing()) return { pr, run: r, queue: null, train: null, tail: [], note: 'no merge runs on this build' };
  const g = await gate(pr);
  const lock = g.lockFile(process.env);
  const queue = g.queueDir(lock);
  let place: MergeStatus['queue'] = null;
  if (existsSync(queue)) {
    const mine = g.tickets(queue).find((t) => String(g.ticketBodyOf(queue, t)?.pr) === String(pr));
    if (mine) place = g.queuePosition(queue, mine);
  }
  const worker = readJson<{ log?: string }>(join(`${lock}.workers`, `${pr}.json`));
  const tail = worker?.log ? tailOf(worker.log) : [];
  return { pr, run: r, queue: place, train: trainHere(g, pr), tail: tail.length ? tail : r ? tailOf(r.log) : [] };
}

// The merge train's active steps for PR, from its own record beside the gate lock, not from the worker log (which doesn't move
// while a train runs, S-3067). A record whose process is gone, or is another boot's, is no train: a restart left it behind. A
// record from another host is named as such, since its pid means nothing here, and an unreadable process is 'unknown', never
// running. Its PRs are compared as numbers, though a record written by a caller may hold them as strings.
function trainHere(g: typeof import('../scripts/gate.mjs'), pr: number): TrainStatus | null {
  type Step = { step: string; since: string };
  const rec = readJson<{ train: number; prs: (number | string)[]; host: string; pid: number; start?: string; boot?: string; steps: Step[]; since: string }>(g.trainFile(g.lockFile(process.env)));
  if (!rec || !Array.isArray(rec.prs) || !rec.prs.map(Number).includes(pr)) return null;
  const active = Array.isArray(rec.steps) ? rec.steps : [];
  const since = active.length ? active.map((x) => x.since).sort()[0] : rec.since;
  const what = active.length ? `${active.length === 1 ? 'step' : 'steps'} ${active.map((x) => x.step).join(', ')}` : 'between steps';
  const at = `in train ${rec.train}, ${what} since ${since}`;
  const base = { train: rec.train, steps: active.map((x) => x.step), since };
  if (rec.host !== hostname()) return { ...base, state: 'elsewhere', text: `${at}, on ${rec.host}: can't tell from this machine whether it still runs` };
  const boot = g.processIdentity(process.pid).boot;
  const state = rec.boot && boot && rec.boot !== boot ? 'gone' : procState(rec.pid, rec.start);
  if (state === 'gone') return null;
  if (state === 'unknown') return { ...base, state: 'unknown', text: `${at}: unknown whether it still runs` };
  return { ...base, state: 'running', text: at };
}

// The outcome of a finished run, from its exit status and its output.
function outcome(r: MergeRun, code: number): MergeRun {
  const lines = tailOf(r.log, 200);
  const ended = new Date().toISOString();
  if (code === 0) return { ...r, state: 'merged', code, ended, sha: [...lines].reverse().find((l) => SHA.test(l)) ?? lines.at(-1) ?? '' };
  const refusal = [...lines].reverse().find((l) => /merge refused: /.test(l));
  if (code === CANCELLED) return { ...r, state: 'cancelled', code, ended };
  if (code === REFUSED) return { ...r, state: 'refused', code, ended, reason: refusal?.replace(/^.*merge refused: /, '') ?? lines.slice(-TAIL).join('\n') };
  return { ...r, state: 'not_merged', code, ended, reason: lines.slice(-TAIL).join('\n') };
}

// The merge worker's own outcome for a run whose shell died without a status (S-2942): a cancel stops the shell, and a worker that
// exited 0 meanwhile had merged the PR just before the signal. Only a status written since the run started counts, so a
// worker record left by an older run never reads as this one's. Null when the worker did not exit 0.
async function workerMerged(r: MergeRun): Promise<MergeRun | null> {
  const g = await gate(r.pr);
  const rec = readJson<{ log?: string; status?: string }>(join(`${g.lockFile(process.env)}.workers`, `${r.pr}.json`));
  if (!rec?.status || readJson<{ code?: number }>(rec.status)?.code !== 0) return null;
  try {
    if (statSync(rec.status).mtimeMs < Date.parse(r.started)) return null;
  } catch {
    return null;
  }
  const lines = [...(rec.log ? tailOf(rec.log, 200) : []), ...tailOf(r.log, 200)].map(stripStamp);
  return { ...r, state: 'merged', code: 0, ended: new Date().toISOString(), sha: [...lines].reverse().find((l) => SHA.test(l)) ?? lines.at(-1) ?? '' };
}

// Whether the process recorded as PID (with START, when given) is running: 'alive', 'gone' (no such process, a zombie, or another
// process that reused the pid), or 'unknown' when /proc/PID/stat can't be read for any reason but "not found" (EACCES, EIO...).
// gate.mjs's processStart returns an empty start for every error, so it can't tell these apart (S-2942). Callers that delete
// files treat 'unknown' as alive.
type ProcState = 'alive' | 'gone' | 'unknown';
let readProcStat = (pid: number): string => readFileSync(`/proc/${pid}/stat`, 'utf8');
// Test hook: replaces the /proc/PID/stat reader to inject a fault or an interleaving; null restores it.
export function setProcStatReader(fn: ((pid: number) => string) | null): void {
  readProcStat = fn ?? ((pid) => readFileSync(`/proc/${pid}/stat`, 'utf8'));
}
function procState(pid: number | undefined, start?: string): ProcState {
  if (!(pid && pid > 0)) return 'gone';
  try {
    const f = readProcStat(pid).replace(/^.*\)\s/, '').split(' ');
    if (f[0] === 'Z') return 'gone';
    return !start || f[19] === start ? 'alive' : 'gone';
  } catch (e: any) {
    return e?.code === 'ENOENT' || e?.code === 'ESRCH' ? 'gone' : 'unknown';
  }
}

// Takes the PR's N.lock, the mkdir lock merge-pr.mjs's startWorker and the cancel helper hold while they replace the worker record
// and the marker. Null when it is held or can't be taken: the caller then keeps the files. Release with rmSync(dir, recursive).
function takeWorkerLock(dir: string, pr: number): string | null {
  const lockDir = join(dir, `${pr}.lock`);
  try {
    mkdirSync(lockDir);
    return lockDir;
  } catch {
    return null;
  }
}

// Removes the PR's cancel marker once its run has settled (S-2942). It stays when its worker, or the one now recorded, may still be
// alive or can't be inspected, when its run is still open, and on any error reading it other than "not found", so a restart never
// misreads a cancel as a worker's own failure. N.lock is held from the open-run check to the removal, so a new worker and cancel
// can't replace the record and the marker in between.
async function dropCancelMarker(pr: number): Promise<void> {
  let lockDir: string | null = null;
  try {
    const g = await gate(pr);
    const dir = `${g.lockFile(process.env)}.workers`;
    if (!existsSync(dir)) return;
    lockDir = takeWorkerLock(dir, pr);
    if (!lockDir) return;
    if (existsSync(runFile(pr))) return; // still open: not settled
    const read = (file: string): { pid?: number; start?: string } | null => {
      try {
        return JSON.parse(readFileSync(file, 'utf8'));
      } catch (e: any) {
        if (e?.code === 'ENOENT') return null;
        throw e;
      }
    };
    const marker = read(join(dir, `${pr}.cancel`));
    if (!marker) return;
    for (const w of [marker, read(join(dir, `${pr}.json`))]) if (w && procState(w.pid, w.start) !== 'gone') return;
    rmSync(join(dir, `${pr}.cancel`), { force: true });
  } catch (e) {
    console.error(`pr_merge: PR #${pr}: kept its cancel marker: ${e instanceof Error ? e.message : e}`);
  } finally {
    if (lockDir) rmSync(lockDir, { recursive: true, force: true });
  }
}

// Finished workers' files in $LOCK.workers older than this are pruned (S-2942). Settable by STAM_MERGE_WORKER_KEEP_DAYS.
const WORKER_KEEP_DAYS = 14;
const PRUNE_EVERY_MS = 3600_000;
let lastPrune = 0;

// Prunes the folder of finished workers (S-2942): per PR, the logs and statuses of runs older than the newest, once they are older
// than the keep time. The newest run's log, status and N.json stay, and so does everything of a PR whose run is still open, whose
// worker may be alive, whose record or a file can't be inspected (anything but "not found"), or that has a cancel marker.
// It takes the PR's N.lock (the mkdir lock merge-pr.mjs's startWorker holds while it reads N.json and spawns a worker, and the
// cancel helper holds while it stops one), so it can't race a new worker for the PR; a held lock keeps the PR's files this time.
// It never takes the gate lock: a train doesn't touch these files, and the per-PR lock is what the writers use.
export async function pruneWorkerFiles(now = Date.now(), keepMs = Number(process.env.STAM_MERGE_WORKER_KEEP_DAYS ?? WORKER_KEEP_DAYS) * 86_400_000): Promise<string[]> {
  const removed: string[] = [];
  let g;
  try {
    g = await gate(0);
  } catch {
    return removed;
  }
  const dir = `${g.lockFile(process.env)}.workers`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return removed;
  }
  const runs = new Map<number, Map<string, string[]>>(); // PR -> run stamp -> its files
  for (const name of names) {
    const m = name.match(/^(\d+)-(\d+)\.(log|status)$/);
    if (!m) continue;
    const byStamp = runs.get(Number(m[1])) ?? new Map<string, string[]>();
    byStamp.set(m[2], [...(byStamp.get(m[2]) ?? []), name]);
    runs.set(Number(m[1]), byStamp);
  }
  for (const [pr, byStamp] of runs) {
    if (byStamp.size < 2 || existsSync(runFile(pr))) continue;
    const lockDir = takeWorkerLock(dir, pr);
    if (!lockDir) continue; // held (or not inspectable): keep
    try {
      if (existsSync(join(dir, `${pr}.cancel`))) continue;
      let rec: { pid?: number; start?: string } | null = null;
      try {
        rec = JSON.parse(readFileSync(join(dir, `${pr}.json`), 'utf8'));
      } catch (e: any) {
        if (e?.code !== 'ENOENT') continue;
      }
      if (rec && procState(rec.pid, rec.start) !== 'gone') continue;
      const stamps = [...byStamp.keys()].sort((a, b) => Number(b) - Number(a));
      for (const stamp of stamps.slice(1)) {
        for (const name of byStamp.get(stamp) ?? []) {
          try {
            if (now - statSync(join(dir, name)).mtimeMs > keepMs) {
              rmSync(join(dir, name), { force: true });
              removed.push(name);
            }
          } catch {
            // not found or not inspectable: kept
          }
        }
      }
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
  }
  return removed;
}

// The stam CLI the failure routing runs (S-3802), as a local script: STAM_PR_MERGE_STAM stands in for it in a test home.
const stamPath = (): string => testOnlyEnv('STAM_PR_MERGE_STAM') || fileURLToPath(new URL('../bin/stam', import.meta.url));
async function stamCli(args: string[]): Promise<string> {
  const env = { ...process.env };
  delete env.STAM_AGENT_ID;
  try {
    return (await run(stamPath(), args, { encoding: 'utf8', timeout: 60_000, env })).stdout;
  } catch (e: any) {
    throw new Error(`stam ${args.slice(0, 2).join(' ')} failed: ${String(e?.stderr || e?.message || e).trim()}`);
  }
}

// Whether the caller is known to be gone (archived or shut down), here or as a peer last saw it. An agent stam knows nothing
// of (the assistant) is not: its mail goes as before, and a send refused for good reroutes then.
function callerGone(by: string): boolean {
  const lifecycle = db.getAgent(by)?.lifecycle ?? db.peerAgentLifecycle(by);
  return lifecycle === 'archived' || lifecycle === 'shut_down';
}

// A PR the gate sent back unmerged whose caller is gone (S-3802): src/failure-route.ts finds who takes it (the ITSA's owner,
// woken if gone, else up its tree, else cos), reopens the ITSA, and files a fallback ITSA when only cos is left. Returns the
// recipient and the lines that lead its mail. A lookup that fails sends it to cos alone. Every step is idempotent, so a mail
// that fails and is retried on the next poll changes nothing twice.
async function rerouted(r: MergeRun): Promise<{ to: string; lead: string } | null> {
  const why = `PR #${r.pr} was not merged (${r.state === 'refused' ? 'the merge gate refused it' : 'its merge run failed'}) and its caller ${r.by} is gone`;
  const say = (m: string) => console.error(`pr_merge: PR #${r.pr}: ${m}`);
  let x: ItsaView | null = null;
  let picked: PickUp;
  try {
    // A saved outcome may be delivered long after it was decided: a PR merged since (by hand, or by a train) is nobody's to fix.
    const cfg = r.gh && r.github ? ({ gh: r.gh, github: r.github } as PrOpenConfig) : prOpenConfig();
    if ((await prView(cfg, r.pr)).state === 'MERGED') {
      say('merged since its run was refused: not rerouted');
      return null;
    }
    x = r.itsa ? await itsaOf(stamCli, r.itsa) : null;
    picked = await pickUp(stamCli, x?.owner ?? r.by, `${why}: see your mail from pr-merge.`, say);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    say(`routing failed, so cos hears: ${m}`);
    return { to: COS, lead: `${why}, and looking up who else could take it failed (${m}): please route it.` };
  }
  const lines = [
    picked.route === 'cos'
      ? `${why}, and nobody up its owner's tree could take it: please route it.`
      : `${why}, so it comes to you${picked.route === 'owner' && r.itsa ? ` as ${r.itsa}'s owner` : ''}${picked.woke ? ' (you were woken for it)' : ''}.`,
  ];
  try {
    // Unmerged work was never done: only a review status comes back.
    const status = x ? await reopen(stamCli, x.key, `${why}.`, picked, 'pr-merge', { fromDone: false }) : null;
    if (status) lines.push(`${x!.key} is reopened (${status}).`);
  } catch (e) {
    say(`could not reopen ${r.itsa}: ${e instanceof Error ? e.message : e}`);
  }
  if (picked.route === 'cos') {
    try {
      const key = await fallback(stamCli, r.pr, 'unmerged', r.itsa, `Branch ${r.branch}, outcome ${r.state}.${r.reason ? `\n\n${r.reason}` : ''}`, 'pr-merge');
      lines.push(`${key} tracks it: PR #${r.pr} is not merged.`);
    } catch (e) {
      say(`could not file the fallback ITSA: ${e instanceof Error ? e.message : e}`);
    }
  }
  return { to: picked.to, lead: lines.join('\n') };
}

async function report(r: MergeRun): Promise<void> {
  const to = [...new Set([r.by, r.cancelBy].filter((x): x is string => !!x && x !== HUMAN))];
  if (!to.length) return;
  const ref = r.itsa ? ` (${r.itsa})` : '';
  const [subject, body] =
    r.state === 'merged'
      ? [`PR #${r.pr} merged${ref}`, `PR #${r.pr} (${r.branch}) is merged: ${r.sha}. The deploy watcher deploys it.`]
      : r.state === 'cancelled'
        ? [`PR #${r.pr} merge cancelled${ref}`, `The merge of PR #${r.pr} (${r.branch}) was cancelled by ${r.cancelBy ?? 'a caller'}: its run is stopped and its merge queue ticket is gone. The PR is still open. Call pr_merge again to queue it.`]
        : r.state === 'refused'
          ? [`PR #${r.pr} refused${ref}`, `merge-pr.mjs refused PR #${r.pr} (${r.branch}); it goes back to its developer:\n\n${r.reason}`]
          : [`PR #${r.pr} not merged${ref}`, `merge-pr.mjs ended with status ${r.code ?? '?'} without merging PR #${r.pr} (${r.branch}). Call pr_merge again to retry. Its last lines:\n\n\`\`\`\n${r.reason}\n\`\`\``];
  // Not merged and not cancelled: the PR goes back to whoever can take it, so a caller that is gone reroutes it (S-3802).
  const culprit = r.state === 'refused' || r.state === 'not_merged';
  // False when the PR merged since: the outcome then goes only to its caller, as before.
  const reroute = async (): Promise<boolean> => {
    const next = await rerouted(r);
    if (!next) return false;
    await sendMail({ from: '', system: 'pr-merge', to: [next.to], subject, body: `${next.lead}\n\n${body}`, new_thread: true });
    return true;
  };
  if (culprit && r.by !== HUMAN && callerGone(r.by) && (await reroute())) return;
  try {
    await sendMail({ from: '', system: 'pr-merge', to, subject, body, new_thread: true });
  } catch (e) {
    if (!(culprit && e instanceof RefusedError) || !(await reroute())) throw e;
  }
}

// Moves a run out of the open ones, to done/.
function archive(r: MergeRun): void {
  save(r, doneFile(r.pr));
  rmSync(runFile(r.pr), { force: true });
  openRuns().delete(r.pr);
}

// Settles the PR's open run: when its script has ended, records the outcome, mails the caller, and archives it. A script
// that died without writing a status (the machine rebooted, its pid now another process's) counts as not merged.
// Returns the run still running, or the settled run whose mail failed, or null once it is mailed. A mail that failed
// for now keeps the run open, so the next poll tries again; one refused for good (the caller is gone) is archived.
async function settle(pr: number): Promise<MergeRun | null> {
  let r = readJson<MergeRun>(runFile(pr));
  if (!r) {
    openRuns().delete(pr);
    return null;
  }
  if (r.state === 'running' && r.cancelBy) {
    // A cancel a restart cut short (S-2709). A run that already ended keeps its outcome, and so does one the helper finds decided
    // under the lock; otherwise the stop is redone. A held gate lock means a train runs, so try again on the next poll.
    const code = readJson<number>(r.status);
    if (code !== null) {
      const ended = outcome(r, Number(code));
      r = ended.state === 'cancelled' ? ended : { ...ended, cancelBy: undefined }; // the train dropped the PR on this cancel's claim (S-3679)
    }
    else {
      const done = await stopRun(r);
      if (!done) return r;
      if (done.decided) {
        r = { ...r, cancelBy: undefined };
        save(r);
        return r;
      }
      r = { ...r, state: 'cancelled', ended: new Date().toISOString() };
    }
    save(r);
  } else if (r.state === 'running') {
    const code = readJson<number>(r.status);
    if (code !== null) r = outcome(r, Number(code));
    else if (!(await alive(r))) r = (await workerMerged(r)) ?? { ...outcome(r, -1), reason: `the merge script died without an exit status. Its last lines:\n${tailOf(r.log).join('\n')}` };
    else return r;
    save(r);
  }
  try {
    await report(r);
  } catch (e) {
    console.error(`pr_merge: PR #${r.pr}: report failed: ${e instanceof Error ? e.message : e}`);
    if (e instanceof RefusedError) {
      archive(r);
      await dropCancelMarker(r.pr);
    }
    return r;
  }
  archive({ ...r, reported: true });
  await dropCancelMarker(r.pr);
  return null;
}

// Settles every open run. Runs every few seconds on the home, and reads nothing while no run is open.
export async function tick(): Promise<void> {
  if (Date.now() - lastPrune > PRUNE_EVERY_MS && !gateMissing()) {
    lastPrune = Date.now();
    await pruneWorkerFiles().catch((e) => console.error(`pr_merge: pruning worker files failed: ${e instanceof Error ? e.message : e}`));
  }
  for (const pr of [...openRuns()]) await serial(pr, () => settle(pr));
}

export interface Cancelled {
  pr: number;
  cancelled: true;
  // What was stopped: the relay's shell, the merge worker, and the queue tickets dropped.
  stopped: { shell: boolean; worker: boolean; tickets: number };
  // 'train': the PR is in a running train, which drops it before its merge and ends the run as cancelled (S-3679); nothing was stopped yet.
  pending?: 'train';
  // The run that was cancelled, when the relay started one; null for a merge run by hand.
  run: MergeRun | null;
}

// Runs scripts/merge-cancel.mjs under the gate lock for the PR. Null when the lock is held (a train or gate run is going):
// nothing was touched. The helper only stops recorded processes with a matching start time, and drops the PR's tickets.
async function stopRun(r: { pr: number; pid?: number; start?: string }): Promise<{ decided?: string; shell: boolean; worker: boolean; tickets: string[] } | null> {
  requireGate(r.pr);
  const lock = envVar('GATE_LOCK') || join(lockHome(), 'gate.lock');
  const script = fileURLToPath(new URL('../scripts/merge-cancel.mjs', import.meta.url));
  const args = [String(r.pr), ...(r.pid && r.start ? [String(r.pid), r.start] : [])];
  mkdirSync(join(lock, '..'), { recursive: true });
  const p = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) =>
    execFile('flock', ['-o', '-n', '-E', '75', lock, process.execPath, script, ...args], { env: process.env, timeout: 30_000 }, (e: any, stdout, stderr) => resolve({ status: e ? (typeof e.code === 'number' ? e.code : null) : 0, stdout: String(stdout), stderr: String(stderr || e?.message || '') })),
  );
  if (p.status === 75) return null;
  if (p.status !== 0) throw new Error(`pr_merge cancel of PR #${r.pr} failed (status ${p.status}): ${p.stderr.trim().slice(-300)}`);
  return JSON.parse(p.stdout.trim().split('\n').pop() ?? '{}');
}

// On the ITSA home: checks who asks as a merge does, then takes the PR out of the merge queue (S-2709). The run is marked
// cancelled by the caller first, then stopped under the gate lock, then settled: the caller and the run's requester get a
// mail. A held lock held by a running train that has the PR's ticket takes a cancel claim instead (S-3679): the train drops the PR
// before its merge, the result says pending 'train', and the run settles as cancelled when its worker exits; a claim the train's
// merge already holds refuses the cancel as "already merging". Any other held lock refuses it and leaves the run as it was. A PR with no run and no worker is an error.
export async function cancelHere(input: { pr: unknown; by?: string | null }, via?: Via, cfg: PrOpenConfig = prOpenConfig()): Promise<Cancelled> {
  const pr = prNumber(input.pr);
  const by = input.by || via?.agent || HUMAN;
  // Fails closed: with no verified identity (a via), only the human acts.
  if (!via && by !== HUMAN) throw new itsa.ForbiddenError(`can't cancel PR #${pr}: the caller isn't known`);
  let view;
  try {
    view = await prView(cfg, pr);
  } catch (e) {
    throw new Error(`can't cancel PR #${pr}: ${e instanceof Error ? e.message : e}`);
  }
  const why = await mergeRefusal(via, pr, view, 'cancel');
  if (why) throw new itsa.ForbiddenError(why);
  requireGate(pr);
  return serial(pr, async () => {
    const run = await settle(pr);
    if (run && run.state !== 'running') throw new Error(`PR #${pr}'s last merge run just ended (${run.state}); there is nothing to cancel`);
    const r = run ?? null;
    const g = await gate(pr);
    const workerRec = readJson<{ pid?: number; start?: string }>(join(`${g.lockFile(process.env)}.workers`, `${pr}.json`));
    const workerLive = !!workerRec?.pid && !!g.processIdentity(workerRec.pid).start && (!workerRec.start || g.processIdentity(workerRec.pid).start === workerRec.start);
    const queue = g.queueDir(g.lockFile(process.env));
    const ticketed = existsSync(queue) && g.tickets(queue).some((t) => String(g.ticketBodyOf(queue, t)?.pr) === String(pr));
    if (!r && !workerLive && !ticketed) throw new Error(`PR #${pr} has no merge run to cancel: no pr_merge run, merge worker or queue ticket (it may have ended already)`);
    if (r) save({ ...r, cancelBy: by });
    let done;
    try {
      done = await stopRun({ pr, pid: r?.pid, start: r?.start });
    } catch (e) {
      if (r) save(r);
      throw e;
    }
    if (done?.decided) {
      if (r) save(r);
      throw new Error(`can't cancel PR #${pr}: its merge already has an outcome (${done.decided}); nothing was cancelled, and the run's mail reports it`);
    }
    if (!done) {
      // The lock is held. A running train that has this PR's ticket is told to drop the PR before its merge (S-3679): one
      // exclusive claim on the ticket decides between the train's merge and this cancel, and the run settles once the train ends.
      const ticket = trainHere(g, pr)?.state === 'running' ? g.tickets(queue).find((t) => String(g.ticketBodyOf(queue, t)?.pr) === String(pr)) : undefined;
      if (ticket === undefined) {
        if (r) save(r);
        throw new Error(`can't cancel PR #${pr} now: the gate lock is held by a train or gate run that doesn't carry this PR's queue ticket, so it can't be told to drop it. Nothing was changed; retry after it.`);
      }
      if (g.claimDecision(queue, ticket, 'cancel') !== 'cancel') {
        if (r) save(r);
        throw new Error(`can't cancel PR #${pr}: already merging; the run's mail reports the outcome`);
      }
      // The worker's cleanup removes the ticket before its claim, so a ticket gone now means the worker ended: the claim is moot.
      if (!existsSync(join(queue, ticket))) {
        rmSync(g.decisionFile(queue, ticket), { force: true });
        if (r) save(r);
        throw new Error(`can't cancel PR #${pr}: its merge already has an outcome (the ticket is gone); nothing was cancelled, and the run's mail reports it`);
      }
      console.log(`pr_merge: cancel claimed for PR #${pr} in the running train, for ${by}`);
      return { pr, cancelled: true as const, pending: 'train' as const, stopped: { shell: false, worker: false, tickets: 0 }, run: r ? { ...r, cancelBy: by } : null };
    }
    let final: MergeRun | null = null;
    if (r) {
      final = { ...r, cancelBy: by, state: 'cancelled', ended: new Date().toISOString() };
      save(final);
      await settle(pr);
    }
    console.log(`pr_merge: cancelled PR #${pr} for ${by}`);
    return { pr, cancelled: true as const, stopped: { shell: done.shell, worker: done.worker, tickets: done.tickets.length }, run: final };
  });
}

export const isHome = (): boolean => (settings().itsa.home ?? MACHINE) === MACHINE;

async function routed<T>(path: string, body: unknown, via: Via | undefined, human: boolean, here: () => Promise<T>): Promise<T> {
  const home = settings().itsa.home ?? MACHINE;
  if (home === MACHINE) return here();
  const peer = peerByName(home);
  if (!peer) throw new Error(`ITSA home '${home}' is not a configured peer`);
  // No branch scope rides along: the home asks every peer who owns the branch (branch-scope.ts), since only it reads the branch from the PR.
  let r;
  try {
    r = await peerCall(peer, 'POST', path, body, 90_000, human, via);
  } catch (e) {
    throw new Error(`ITSA home '${home}' is unreachable (${e instanceof Error ? e.message : e}), so the request was not carried out`);
  }
  if (r.status === 403) throw new itsa.ForbiddenError(r.data?.error ?? `${home}: HTTP 403`);
  if (r.status !== 200) throw new Error(r.data?.error ?? `${home}: HTTP ${r.status}`);
  return r.data;
}

// Runs on the ITSA home, wherever the call came from (as pr_open does).
export function mergeRouted(input: { pr: unknown; by?: string | null }, via?: Via): Promise<MergeRun & { already: boolean; previous?: MergeRun }> {
  return routed('/api/pr/merge', input, via, input.by === HUMAN, () => mergeHere(input, via));
}

export function cancelRouted(input: { pr: unknown; by?: string | null }, via?: Via): Promise<Cancelled> {
  return routed('/api/pr/merge-cancel', input, via, input.by === HUMAN, () => cancelHere(input, via));
}

export function closeRouted(input: { pr: unknown; comment?: unknown; by?: string | null }, via?: Via): Promise<Closed> {
  return routed('/api/pr/close', input, via, input.by === HUMAN, () => closeHere(input, via));
}

export function statusRouted(input: { pr: unknown; by?: string | null }, via?: Via): Promise<MergeStatus> {
  return routed('/api/pr/merge-status', input, via, input.by === HUMAN, () => statusHere(input));
}
