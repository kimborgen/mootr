// Starting, pausing, shutting down, archiving, resuming, and restarting agents.
// Actions that would cut a working agent off wait until it goes idle: the agent gets
// a prompt to wrap up, and the action runs when its turn ends.
import { forgetLessons } from './retro-lessons.ts';
import { unownAgent, queueUnown, dropPendingUnown, openOwnedItsas } from './itsa-owners.ts';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { MACHINE, STAM_URL, agentDir } from './config.ts';
import { mintAgentToken } from './agent-token.ts';
import * as db from './db.ts';
import * as tree from './tree.ts';
import * as tmux from './tmux.ts';
import { agentExec } from './agent-exec.ts';
import { adapters } from './adapters/index.ts';
import { render, renderWithRetro, withRetroReminder } from './templates.ts';
import { branchIsBase, cleanupWorkspace, workspaceUnpushedRefusal, type Workspace } from './workspace.ts';
import { markCompacted, idleCompactIfDue, overCompactionThreshold } from './context.ts';
import { markCold } from './cache-cold.ts';
import { typeOf } from './agent-class.ts';
import { compactorProcesses, dirProcesses, removeAgentScratchDirs, removeClaudeScratch, removeReviewDir, removeReviewTmpDir, reviewDirForLaunch, reviewTmpForSpawn, stopAndConfirm } from './proctree.ts';
import { isReviewerType } from './agent-types.ts';
import { admit, heldBy, type TurnKind } from './admission.ts';
import { schedulePush, queueNotice, tellAnywhere, wakeableNoticeCount, onRestWake, tellStopped, forgetAgentNotices } from './mail.ts';
import { failLaunch } from './test-hooks.ts';
import { switchFailed, type SwitchUndo } from './permission-modes.ts';
import { registry } from './registry.ts';
import { settings } from './settings.ts';
import { chiefOfStaff, syncChildrenWaits } from './org.ts';
import { isAssistant } from './mail-visibility.ts';
import * as itsa from './itsa.ts';
import { restoreTranscript } from './transcript-gz.ts';
import * as costFallback from './cost-fallback.ts';
import { withdrawPendingInputs, withdrawStaleRequests } from './permissions.ts';
import { envVar, goBinDir, withGoBinArgv } from './env.ts';
import { networkUp } from './network-probes.ts';

type Pending =
  // `at` (epoch ms, S-1402): the deadline for the final round a plain shutdown now asks for.
  // `midTurn` (S-1618): the wrap-up was pushed while the agent ran a step, so a harness that queues it
  // ends that step before the wrap-up turn starts. `waited`: that step's end already passed.
  | { type: 'shutdown'; at?: number; midTurn?: boolean; waited?: boolean }
  // `force` no longer skips the final-round wrap-up (S-1043): it means "don't wait for the
  // agent's current step", and still implies `discard` for older callers. `discard` removes
  // uncommitted worktree changes. `at` (epoch ms) is the deadline for the final round: past it,
  // the sweep archives regardless of the agent's turn. `tries` counts deadline retries.
  | { type: 'archive'; force?: boolean; discard?: boolean; forceUnpushed?: boolean; at?: number; tries?: number; midTurn?: boolean; waited?: boolean }
  // `permission`: a mode switch's undo, applied if the relaunch fails (S-1967).
  // `handoff`: the agent was asked to compact_self first (S-2241); `at` (epoch ms) is when an idle
  // agent restarts without it.
  | { type: 'restart'; reason: string; permission?: SwitchUndo; handoff?: boolean; at?: number }
  // `restart`: a restart that was pending when the agent asked for this compaction; the compaction's
  // relaunch carries it out, else it runs after the compaction (S-2241).
  | { type: 'compact'; instructions?: string; prompt?: string; reason: string; restart?: RestartPending }
  // Set on a shut-down agent whose terminal went down with the tmux server; see recoverLost.
  // `interrupted`: the operation id of a compaction a daemon restart cut short (S-358), not a context exit.
  // `compacted`: its compaction already ran, so only the resume is left.
  | { type: 'recover'; reason: string; compact?: boolean; tokens?: number; interrupted?: string; compacted?: boolean }
  // Reloads its MCP servers after a deploy changed stam's tools (tool-changes.ts).
  // `tries` failed so far; the next waits until `after` (ms since the epoch).
  | { type: 'reconnect-mcp'; tries?: number; after?: number };

type RestartPending = { reason: string; permission?: SwitchUndo };

const isIdle = (a: db.Agent) => a.activity === 'idle' || a.activity === 'waiting' || a.activity === 'errored';

function adapterFor(a: db.Agent) {
  const adapter = adapters[a.harness];
  if (!adapter) throw new Error(`${a.name} runs ${a.harness}, which stam can't control`);
  return adapter;
}

// Who holds a pause on the agent besides stam's cost blockers: 'human' or agent ids.
export function pauseOwners(a: db.Agent): string[] {
  return a.paused_by ? JSON.parse(a.paused_by) : [];
}

// Whether the agent must stay paused: someone paused it, or it has cost blockers.
export function isHeld(a: db.Agent): boolean {
  return heldBy(a) !== null;
}

// Pause transitions of one agent run one at a time, so a cost pause and a human's pause or
// unpause can't interleave and write stale state over each other. blockers.ts runs its
// changes inside the same chain.
const chains = new Map<string, Promise<unknown>>();
export function serial<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  const run = (chains.get(agentId) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  chains.set(agentId, tail);
  tail.then(() => chains.get(agentId) === tail && chains.delete(agentId));
  return run;
}

// S-578: which launch is current per agent. A launch awaits the adapter and can be superseded
// meanwhile by an archive or shutdown of a still-starting agent; the generation lets a delayed
// launch notice that it is no longer wanted, so it can't create a session or mark the agent
// active after it was stopped. Any stop path calls invalidateLaunch; startHarness takes the next
// generation and rechecks it around the awaits.
const launchSeq = new Map<string, number>();
function launchCurrent(id: string, gen: number): boolean {
  return (launchSeq.get(id) ?? 0) === gen;
}
// Cancels any launch in flight for this agent, so one that resolves later does nothing.
export function invalidateLaunch(id: string): void {
  launchSeq.set(id, (launchSeq.get(id) ?? 0) + 1);
}
// S-3250: the agents whose launch is still in its afterLaunch in this daemon, by generation. A daemon
// restart drops them, which is how settleStart tells a launch the restart cut off from one still running.
const launching = new Map<string, number>();

// Starts the harness in a new tmux session: a fresh launch, or a resume of the
// agent's conversation when `resume` is set. An agent that is held (isHeld) comes back
// paused, without the prompt, so a restart or resume never starts a turn it may not run.
// `kind` names the turn for the admission gate, which the adapter asks again right before
// it delivers the prompt: a blocker added during the launch keeps the prompt back, queued
// as a notice that goes in once the blockers clear. A deferred compaction stays pending
// across the launch and runs when the agent next goes idle. `launched` settles when the
// adapter's afterLaunch does: the prompt delivered (or kept back by the gate), or the error.
// `mark` goes into the launch's spawn or resume event (S-3250: the stuck-start restart marks its own).
export async function startHarness(a: db.Agent, prompt: string | undefined, resume: boolean, kind: TurnKind = resume ? 'resume' : 'spawn', mark?: Record<string, unknown>): Promise<{ launched: Promise<void>; superseded?: boolean }> {
  assertNotTakenOver(a);
  const gen = (launchSeq.get(a.id) ?? 0) + 1;
  launchSeq.set(a.id, gen);
  // S-3250: the launch counts as running here from its generation on, so settleStart never reads a
  // relaunch's old pane, still 'starting', as a launch that ended; superseded, failed or landed clears it.
  launching.set(a.id, gen);
  const landed = () => launching.get(a.id) === gen && launching.delete(a.id);
  try {
    const r = await launchAt(a, gen, prompt, resume, kind, mark);
    if (r.superseded) landed();
    else r.launched.then(landed, landed);
    return r;
  } catch (e) {
    landed();
    throw e;
  }
}

async function launchAt(a: db.Agent, gen: number, prompt: string | undefined, resume: boolean, kind: TurnKind, mark?: Record<string, unknown>): Promise<{ launched: Promise<void>; superseded?: boolean }> {
  await releaseTurnStop(a);
  const adapter = adapterFor(a);
  const held = isHeld(a);
  if (held && prompt) {
    // Records the refusal when cost blockers are among what holds it.
    admit(a, kind);
    db.addEvent(a.id, 'launch-held', { owners: pauseOwners(a), blockers: db.blockerRows(a.id).map((b) => b.kind) });
    // S-4304: a compaction's continue prompt isn't lost to the hold; it goes in when the agent is idle again.
    if (kind === 'compact') queueNotice(a.id, prompt, { idleOnly: true });
    prompt = undefined;
  }
  if (failLaunch.has(a.name)) throw new Error(`test: launch of ${a.name} failed`);
  const spec = await adapter.launch(a, { resume });
  // The agent may have been archived, shut down, or taken over while the launch ran.
  if (!launchCurrent(a.id, gen)) return { launched: Promise.resolve(), superseded: true };
  // A transition may have taken the agent while the launch ran.
  if (db.getAgent(a.id)?.forwarded_to) throw new Error(`${a.name} was taken over while it started`);
  if (spec.fields) db.updateAgent(a.id, spec.fields);
  // Recheck before creating the tmux session and before marking the agent active: a launch
  // superseded while it awaited must not leave a live harness behind.
  if (!launchCurrent(a.id, gen)) return { launched: Promise.resolve(), superseded: true };
  tmux.killSession(a.id);
  // A new token per launch (S-237): the agent's own, not the shared one, which stays the human's and the CLI's.
  const token = mintAgentToken(a.id);
  // A reviewer's test folder (S-1330) sits in its writable root, so its runs work in a sandbox; the
  // folder is made here, before the runner's mktemp -d. A STAM_TEST_TMPDIR the spec sets wins, and a test home makes none.
  const reviewDir = a.type && isReviewerType(a.type) ? reviewDirForLaunch(a.name) : null;
  const reviewTmp = reviewDir ? reviewTmpForSpawn(a.name, spec.env) : null;
  if (reviewTmp) mkdirSync(reviewTmp, { recursive: true });
  // The Go bin dir goes first on the shell's PATH, for spawn and resume alike (S-3666; src/env.ts withGoBinArgv).
  const goBin = goBinDir(spec.env.HOME ?? process.env.HOME);
  agentExec(withGoBinArgv(spec.argv, goBin), { ...spec.env, ...(reviewDir ? { STAM_REVIEW_DIR: reviewDir } : {}), ...(reviewTmp ? { STAM_TEST_TMPDIR: reviewTmp } : {}), STAM_AGENT_ID: a.id, STAM_URL, STAM_TOKEN: token }, { mode: 'session', cwd: a.cwd, session: a.id });
  if (!launchCurrent(a.id, gen)) {
    tmux.killSession(a.id);
    return { launched: Promise.resolve(), superseded: true };
  }
  // 'with prompt' keeps the agent 'starting' until its first turn begins, so it never looks idle in between.
  const pending = a.pending_action && JSON.parse(a.pending_action).type === 'compact' ? a.pending_action : null;
  // The harness starts here, whatever asked for it (spawn, resume, restart, wake from rest), so these are
  // the only writes of launched_at and resumed_at (S-3372). launched_at is the first start only; every
  // later start, fresh or resumed, sets resumed_at.
  const started = new Date().toISOString();
  const launch = db.getAgent(a.id)?.launched_at == null ? { launched_at: started } : { resumed_at: started };
  db.updateAgent(a.id, { lifecycle: held ? 'paused' : 'active', activity: 'starting', activity_detail: prompt ? 'with prompt' : resume ? 'resuming' : null, pending_action: pending, ...launch });
  db.addEvent(a.id, resume ? 'resume' : 'spawn', { argv: spec.argv, prompt: Boolean(prompt), ...mark });
  if (resume) markCold(a, 'wake');
  const text = prompt;
  const gate = () => {
    if (!launchCurrent(a.id, gen)) return false;
    if (admit(a.id, kind).ok) return true;
    db.addEvent(a.id, 'launch-held', { blockers: db.blockerRows(a.id).map((b) => b.kind), late: true });
    if (db.getAgent(a.id)?.activity === 'starting') db.updateAgent(a.id, { activity: 'idle', activity_detail: 'ready' });
    queueNotice(a.id, text!, { idleOnly: true });
    return false;
  };
  // The prompt goes in after launch, through the harness's own channel, never on a command line.
  const launched = adapter.afterLaunch(db.getAgent(a.id)!, prompt, { resume, admit: prompt ? gate : undefined, current: () => launchCurrent(a.id, gen) });
  // S-759: a spawn's first prompt is delivered (or was kept back as a notice) once afterLaunch
  // settles, so record that. A daemon restart mid-spawn leaves it 'starting' with no marker,
  // which the first reconcile pass re-delivers (recoverFirstPrompt).
  launched.then(() => {
    if (kind === 'spawn' && launchCurrent(a.id, gen)) db.addEvent(a.id, 'first-prompt:delivered');
  }).catch(() => {});
  launched.catch((e) => {
    db.addEvent(a.id, 'launch-error', String(e));
    const now = db.getAgent(a.id);
    if (prompt && now?.activity === 'starting') db.updateAgent(a.id, { activity: 'errored', activity_detail: `first prompt not delivered: ${e instanceof Error ? e.message : e}` });
  });
  return { launched };
}

// An agent whose work cost_switch moved to a successor runs nothing while that successor
// is live: not even the human's force brings it back, since two agents would then work
// in one worktree. Archiving the successor lifts this (archiveNow).
export function takenOverBy(a: db.Agent): db.Agent | undefined {
  if (!a.forwarded_to) return undefined;
  const s = db.getAgent(a.forwarded_to);
  return s && s.lifecycle !== 'archived' ? s : undefined;
}

export function assertNotTakenOver(a: db.Agent): void {
  const cur = db.getAgent(a.id) ?? a;
  const s = takenOverBy(cur);
  if (!s) return;
  const p = Object.entries<any>(registry().presets).find(([, v]) => v.harness === cur.harness && (v.model ?? null) === (cur.model ?? null))?.[0] ?? 'PRESET';
  throw new Error(`${cur.name} was taken over by ${s.name}: switch back with \`cost_switch ${s.name} ${p}\`, or archive ${s.name} first`);
}

// The rest ends with the harness: a resting agent shut down or archived keeps its other pause owners, never the rest's,
// so a later resume doesn't come back paused and taken for resting.
function withoutRest(a: db.Agent): string | null {
  const owners = pauseOwners(db.getAgent(a.id) ?? a).filter((o) => o !== REST_OWNER);
  return owners.length ? JSON.stringify(owners) : null;
}

function quitHarness(a: db.Agent, detail: string): void {
  invalidateLaunch(a.id);
  tmux.killSession(a.id);
  db.updateAgent(a.id, { lifecycle: 'shut_down', activity: 'unknown', activity_detail: detail, pending_action: null, paused_by: withoutRest(a) });
  db.addEvent(a.id, 'shutdown', { detail });
  stopTurn(a);
}

// A real stop, not a restart: the agent's pending suggestions are withdrawn with it (S-3830). A restart keeps them.
function stopForGood(a: db.Agent, detail: string): void {
  quitHarness(a, detail);
  withdrawPendingInputs(a, 'the agent was shut down');
}

// One transition at a time per agent: an archive, a cost switch (rollback included) or a resume
// holds the agent's lock for its whole run. acquire() takes it, or throws while another holds it,
// and returns a release bound to its own token, so it can only remove its own lock.
type Transition = 'archive' | 'switch' | 'resume';
const transitions = new Map<string, { kind: Transition }>();
const BEING: Record<Transition, string> = { archive: 'archived', switch: 'switched', resume: 'resumed' };
export function acquire(a: db.Agent, kind: Transition): () => void {
  const held = transitions.get(a.id);
  if (held) throw new Error(`${a.name} is being ${BEING[held.kind]}; try again when it is done`);
  const token = { kind };
  transitions.set(a.id, token);
  let released = false;
  return () => {
    if (!released && transitions.get(a.id) === token) transitions.delete(a.id);
    released = true;
  };
}
function assertNoTransition(a: db.Agent): void {
  const held = transitions.get(a.id);
  if (held) throw new Error(`${a.name} is being ${BEING[held.kind]}; try again when it is done`);
}

// The harness's own server may keep the turn running after its terminal is gone (OpenCode's
// shared server does): the adapter's stop interrupts it and confirms it stopped. One stop is
// in flight per session: a second request joins it, so no two loops interrupt the same
// session. Runs in the background; a failure is recorded as an event.
interface TurnStop {
  p: Promise<void>;
  // Set when the agent runs again: the stop gives up before its next interrupt.
  cancelled: boolean;
}
const turnStops = new Map<string, TurnStop>();
export function stopTurn(a: db.Agent): void {
  const stop = adapters[a.harness]?.stop;
  if (!stop || !a.session_id) return;
  // A stop still in flight is joined; one given up (its agent ran again) is not, so a new shutdown gets its own loop.
  const live = turnStops.get(a.session_id);
  if (live && !live.cancelled) return;
  const sid = a.session_id;
  const entry: TurnStop = { cancelled: false, p: Promise.resolve() };
  entry.p = stop(a, { keep: () => !entry.cancelled });
  turnStops.set(sid, entry);
  entry.p.catch((e) => db.addEvent(a.id, 'stop-error', { error: e instanceof Error ? e.message : String(e) })).finally(() => turnStops.get(sid) === entry && turnStops.delete(sid));
}

// Confirms the agent's turn is stopped: waits for the stop in flight, else runs it. Rejects
// when the harness still runs.
export function awaitTurnStop(a: db.Agent): Promise<void> {
  const entry = a.session_id ? turnStops.get(a.session_id) : undefined;
  // A stop given up was not confirmed: the agent runs again, so its session may still run.
  if (entry) return entry.p.then(() => {
    if (entry.cancelled) throw new Error('the agent was resumed before its session stopped');
  });
  return adapters[a.harness]?.stop?.(a) ?? Promise.resolve();
}

// Before an agent runs again: its stop in flight gives up, and this waits until it has, so
// no interrupt can reach the new turn.
export async function releaseTurnStop(a: db.Agent): Promise<void> {
  const entry = a.session_id ? turnStops.get(a.session_id) : undefined;
  if (!entry) return;
  entry.cancelled = true;
  await entry.p.catch(() => {});
}

// S-4304: the reasons of a compaction that interrupts an agent's work (compact_self, the enforcement threshold).
const INTERRUPTING_REASONS = new Set(['requested by the agent', 'enforcement threshold']);
export const COMPACT_CONTINUE_PROMPT = '[stam] Your context was compacted. Continue your task from your compaction notes.';

// A blocked agent isn't compacted: the compaction is a model turn. It stays pending and
// runs at the end of the agent's first turn after its blockers clear.
async function compactNow(a: db.Agent, p: { instructions?: string; prompt?: string; reason: string; restart?: RestartPending }): Promise<string | void> {
  const adapter = adapterFor(a);
  if (!adapter.compact) {
    // A restart that waited for this compaction still runs.
    if (p.restart) await restartNow(a, p.restart);
    throw new Error(`${a.harness} agents can't be compacted by stam`);
  }
  const ok = admit(a, 'compact');
  if (!ok.ok) {
    const { restart, ...compact } = p;
    // S-2241: a restart that waited for this compaction runs now, as it would have without it (a held
    // agent comes back paused); the compaction stays pending for after the blockers clear.
    if (restart) {
      await restartNow(a, restart);
      db.updateAgent(a.id, { pending_action: JSON.stringify({ type: 'compact', ...compact }) });
      db.addEvent(a.id, 'restart:compaction-held', { reason: restart.reason, blocked: ok.reason });
      return `${a.name} is blocked (${ok.reason}); it restarted and compacts after it runs again`;
    }
    db.updateAgent(a.id, { pending_action: JSON.stringify({ type: 'compact', ...p }) });
    return `${a.name} is blocked (${ok.reason}); it compacts after it runs again`;
  }
  db.updateAgent(a.id, { activity: 'working', activity_detail: `compacting: ${p.reason}` });
  const { restart, ...data } = p;
  // S-4304: a compaction that cut into work ends with a prompt, else the resumed agent sits idle and
  // rests. An idle compaction (cache lifetime, before a long rest) has no work to continue.
  if (!p.prompt && !restart && INTERRUPTING_REASONS.has(p.reason)) p = { ...p, prompt: COMPACT_CONTINUE_PROMPT };
  // S-2241: a harness the compaction quit is launched afresh (its settings, MCP servers, permission
  // mode and binary read again), so that launch is the restart; one still running restarts after.
  let relaunched = false;
  try {
    // The relaunch is inside the tracked run, so the agent counts as compacting until it is back.
    await trackCompaction(a.id, data, async (op) => {
      const { relaunch } = await adapter.compact!(a, p.instructions, { op });
      markCompacted(a.id);
      if (relaunch) {
        const text = restart ? [render('restarted', { reason: restart.reason }), p.prompt].filter(Boolean).join('\n\n') : p.prompt;
        await startHarness(db.getAgent(a.id)!, text, true, 'compact');
        relaunched = true;
        if (restart) db.addEvent(a.id, 'restart:by-compaction', { reason: restart.reason });
      } else if (p.prompt && !restart) await prompt(a, p.prompt, 'compact');
    });
  } catch (e) {
    // A failed compaction never holds the restart back.
    if (restart && !relaunched) await restartNow(db.getAgent(a.id)!, restart);
    throw e;
  }
  // The compaction's prompt goes with the restart, so no turn it starts is cut off.
  if (restart && !relaunched) await restartNow(db.getAgent(a.id)!, restart, p.prompt);
}

// Compacts when the agent's turn ends; without a wrap-up prompt, since the agent
// either asked for it or must not be interrupted.
export async function requestCompaction(a: db.Agent, p: { instructions?: string; prompt?: string; reason: string }): Promise<string> {
  if (compactionBusy(a.id)) {
    db.addEvent(a.id, 'compact:dropped', { reason: p.reason });
    return `${a.name} is already compacting or was just compacted; this request is dropped`;
  }
  // S-257: a shut-down agent has no turn to wait for; it is compacted headless and resumed now.
  if (a.lifecycle === 'shut_down') return compactAndResume(a, p.instructions);
  // S-2241: a restart waiting for this turn's end goes with the compaction, not lost under it.
  const restart = pendingRestart(db.getAgent(a.id) ?? a);
  return whenIdle(a, { type: 'compact', ...p, ...(restart ? { restart } : {}) }, '');
}

// The restart pending for an agent, alone or carried by a pending compaction.
function pendingRestart(a: db.Agent): RestartPending | null {
  const p: Pending | null = a.pending_action ? JSON.parse(a.pending_action) : null;
  if (p?.type === 'restart') return { reason: p.reason, ...(p.permission ? { permission: p.permission } : {}) };
  return p?.type === 'compact' && p.restart ? p.restart : null;
}

// S-273: a compaction that is running, or just finished, isn't repeated. A request that arrives
// meanwhile (a second threshold notice, a queued stam compact) would otherwise cycle the harness
// again. A failed compaction leaves no mark, so its retry goes through.
const COMPACT_DEDUPE_MS = 10_000;
const compactions = new Map<string, { running: boolean; at: number }>();

function compactionBusy(id: string): boolean {
  const c = compactions.get(id);
  return Boolean(c && (c.running || Date.now() - c.at < COMPACT_DEDUPE_MS));
}

// S-273: a compaction is running for this agent: its harness is down on purpose, so the daemon
// reconciler must not read that as an exit.
export function compactionRunning(id: string): boolean {
  return compactions.get(id)?.running === true;
}

// A harness that exits after a compaction is a new cycle, so its next request is no repeat.
export function harnessExited(id: string): void {
  if (compactions.get(id)?.running === false) compactions.delete(id);
}

// Runs one compaction, recorded durably (S-358): a `compact` event with an operation id, then
// `compact:done` or `compact:failed`. A daemon restart loses `compactions`, so these say what it
// cut short. The adapter marks a compactor process it starts with the id.
async function trackCompaction(id: string, data: object, run: (op: string) => Promise<void>): Promise<void> {
  const op = randomUUID();
  compactions.set(id, { running: true, at: 0 });
  db.addEvent(id, 'compact', { ...data, op });
  try {
    await run(op);
  } catch (e) {
    compactions.delete(id);
    db.addEvent(id, 'compact:failed', { op, error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
  compactions.set(id, { running: false, at: Date.now() });
  db.addEvent(id, 'compact:done', { op });
}

// S-257: compacts a shut-down agent's conversation headless on its own session, before any resume: a
// resumed harness that is still near its limit would overflow before it can compact.
async function compactShutDown(a: db.Agent, instructions?: string, reason = 'shut down'): Promise<void> {
  if (!a.session_id) throw new Error(`${a.name} has no session to compact`);
  if (!adapterFor(a).compact) throw new Error(`${a.harness} agents can't be compacted by stam`);
  await trackCompaction(a.id, { reason, headless: true }, async (op) => {
    await adapterFor(a).compact!(a, instructions, { op });
    markCompacted(a.id);
  });
}

async function compactAndResume(a: db.Agent, instructions?: string): Promise<string> {
  const release = acquire(a, 'resume');
  try {
    await compactShutDown(a, instructions);
    return await resume(db.getAgent(a.id)!, render('respawn-context-exit', {}), { locked: true });
  } finally {
    release();
  }
}

// Pushes stam's own prompt into the agent through the admission gate under `kind`; null
// skips the gate, only for the pause notice itself, which tells a held agent to stop.
async function prompt(a: db.Agent, text: string, kind: TurnKind | null = 'prompt'): Promise<boolean> {
  if (kind && !admit(a, kind).ok) return false;
  const ok = (await adapterFor(a).pushPrompt(a, text).catch(() => false)) ?? false;
  // A turn is on its way before any hook says so: the rest sweep waits for it (pushedTurnPending).
  if (ok) db.addEvent(a.id, 'prompt:sent', { kind });
  return ok;
}

// Asks a working agent to wrap up, or runs the action now if it's idle.
async function whenIdle(a: db.Agent, pending: Pending, wrapUp: string): Promise<string> {
  if (a.lifecycle !== 'active' && a.lifecycle !== 'paused') throw new Error(`${a.name} is ${a.lifecycle}`);
  if (isIdle(a)) return (await runPending(a, pending)) || 'done';
  db.updateAgent(a.id, { pending_action: JSON.stringify(pending) });
  if (wrapUp) await prompt(a, wrapUp);
  db.addEvent(a.id, 'pending', pending);
  return `waiting for ${a.name} to finish its step`;
}

// S-1618: a wrap-up pushed mid-turn may be held for the turn after (OpenCode queues it), so the end
// of the running step isn't the round's turn end. With no `retro_final` yet, the stop waits for one
// more turn end, bounded by a fresh final-round deadline (runDueArchives) so a lost prompt can't
// hold it open. True when the pending was put back.
function giveWrapUpTurn(a: db.Agent, p: Pending & { type: 'shutdown' | 'archive' }): boolean {
  if (!p.midTurn || p.waited || db.hasEvent(a.id, 'retro_final')) return false;
  if (a.lifecycle !== 'active' && a.lifecycle !== 'paused') return false;
  const next: Pending = { ...p, waited: true, at: Date.now() + finalRoundMs() };
  db.updateAgent(a.id, { pending_action: JSON.stringify(next) });
  db.addEvent(a.id, 'pending:extra-turn', { at: next.at });
  return true;
}

// An archive that failed where nobody is waiting on the call (the deadline, a turn end, a dead harness)
// leaves its reason on the agent and tells its parent, else the chief of staff. `when` says where it ran.
function archiveFailedNotice(a: db.Agent, msg: string, when: string): void {
  db.updateAgent(a.id, { activity_detail: `archive failed: ${msg}` });
  // A parent may live on another machine: tellAnywhere reaches its daemon.
  const who = db.parentsOf(a).filter((x) => { const o = db.getAgent(x); return !o || o.lifecycle === 'active'; });
  const text = `[stam] The archive of ${a.name} failed ${when}: ${msg}. It is still ${db.getAgent(a.id)?.lifecycle ?? a.lifecycle}.`;
  // A parent that is forgotten or on a machine that is down can't be told: then the chief of staff is.
  const cos = chiefOfStaff()?.id;
  Promise.all(who.map((x) => tellAnywhere(x, text).catch(() => 'unreachable' as const))).then((r) => {
    if (cos && !r.includes('told')) return tellAnywhere(cos, text);
  }).catch(() => {});
}

// S-2201: archiveNow for a pending archive that runs without a caller (a turn end, a dead harness): a
// failure is recorded as `archive:failed` and told to the parent instead of vanishing in the hook.
async function archiveNowPending(a: db.Agent, p: Pending & { type: 'archive' }, when: string): Promise<void> {
  try {
    await archiveNow(a, { force: p.force, discard: p.discard, forceUnpushed: p.forceUnpushed });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    db.addEvent(a.id, 'archive:failed', { at: p.at, tries: p.tries ?? 0, error: msg });
    if (archiveRetryable(msg)) throw e;
    archiveFailedNotice(a, msg, when);
    // At a turn end the agent just did its wrap-up and is still running: tell it too, so it can push.
    if (when === 'when its turn ended' && db.getAgent(a.id)?.lifecycle === 'active') queueNotice(a.id, `[stam] Your archive was refused: ${msg}`);
  }
}

async function runPending(a: db.Agent, p: Pending): Promise<string | void> {
  db.updateAgent(a.id, { pending_action: null });
  if ((p.type === 'shutdown' || p.type === 'archive') && giveWrapUpTurn(a, p)) return `waiting for ${a.name} to finish its step`;
  if (p.type === 'shutdown') {
    // S-1618: the turn ended without `retro_final` after the round was asked for (askShutdownRound
    // sets `at` or `midTurn`); a shutdown that didn't ask, such as a paused agent's, records nothing.
    if (p.midTurn || p.at !== undefined) noteRoundSkipped(a, 'turn_ended_no_round');
    return stopForGood(a, 'shut down');
  }
  if (p.type === 'archive') {
    // The turn ended: the round was asked for in it; no `retro_final` means it wasn't filed.
    noteRoundSkipped(a, 'turn_ended_no_round');
    return archiveNowPending(a, p, 'when its turn ended');
  }
  if (p.type === 'compact') return compactNow(a, p);
  if (p.type === 'recover') return;
  if (p.type === 'restart') await restartNow(a, p);
}

async function restartNow(a: db.Agent, p: RestartPending, then?: string): Promise<void> {
  quitHarness(a, `restarting: ${p.reason}`);
  try {
    await startHarness(db.getAgent(a.id)!, [render('restarted', { reason: p.reason }), then].filter(Boolean).join('\n\n'), true, 'restart');
  } catch (e) {
    if (p.permission) switchFailed(a.id, p.permission, e);
    throw e;
  }
}

// The agents whose MCP client one reconnect replaces, read now: those of the harness in a's
// MCP scope (OpenCode's shared server keeps one client per directory), or a alone.
function mcpSharers(a: db.Agent): db.Agent[] {
  const scope = adapters[a.harness]?.mcpScope;
  if (!scope) return [db.getAgent(a.id) ?? a];
  const key = scope(a);
  // A resting agent has no harness on the client; its next launch loads the servers afresh.
  return db.listAgents().filter((b) => b.harness === a.harness && (b.lifecycle === 'active' || b.lifecycle === 'paused') && !db.restOwned(b) && scope(b) === key);
}

const reconnectPending = (a: db.Agent) => !!a.pending_action && JSON.parse(a.pending_action).type === 'reconnect-mcp';

// Reloads agents' MCP servers without a restart, never mid-turn and without a wrap-up
// prompt: now for a scope (the agents sharing a client) that is all idle, else when the last
// of it goes idle; once per scope. All are marked before any runs, so agents that share a
// client reconnect once. Another pending action on an agent (a restart reconnects too) is
// left in place.
export async function reconnectMcpWhenIdle(ids: string[]): Promise<void> {
  const marked: string[] = [];
  for (const id of ids) {
    const a = db.getAgent(id);
    if (!a || !adapters[a.harness]?.reconnectMcp || (a.lifecycle !== 'active' && a.lifecycle !== 'paused')) continue;
    if (!a.pending_action) db.updateAgent(a.id, { pending_action: JSON.stringify({ type: 'reconnect-mcp' }) });
    marked.push(id);
  }
  for (const id of marked) {
    const a = db.getAgent(id);
    if (a) await reconnectIfQuiet(a).catch((e) => db.addEvent(id, 'mcp:reconnect-error', String(e)));
  }
}

// Scopes whose reconnect is running, so a second idle doesn't start another meanwhile.
const reconnecting = new Set<string>();
const MAX_RECONNECT_TRIES = 5;

// Runs the pending reconnects in a's MCP scope, once for the scope, when all of it is idle.
// The adapter checks `proceed` right before the reload, after its own awaits: a turn that
// started meanwhile puts the reconnect back for the next idle. A failure puts it back too,
// retried after 5 s, then twice as long each time, up to MAX_RECONNECT_TRIES.
async function reconnectIfQuiet(a: db.Agent): Promise<void> {
  const scope = adapters[a.harness]?.mcpScope;
  const key = scope ? `${a.harness}:${scope(a)}` : a.id;
  if (reconnecting.has(key)) return;
  const sharers = mcpSharers(a);
  const due = sharers.filter(reconnectPending);
  if (!due.length || sharers.some((b) => !isIdle(b))) return;
  const pendings = due.map((b) => JSON.parse(b.pending_action!));
  const tries = Math.max(0, ...pendings.map((p) => p.tries ?? 0));
  const after = Math.max(0, ...pendings.map((p) => p.after ?? 0));
  if (Date.now() < after) return;
  // Puts the reconnect back on each agent that has no other pending action by now.
  const putBack = (p: Pending) => {
    for (const b of due) if (db.getAgent(b.id)?.pending_action === null) db.updateAgent(b.id, { pending_action: JSON.stringify(p) });
  };
  reconnecting.add(key);
  for (const b of due) db.updateAgent(b.id, { pending_action: null });
  try {
    db.addEvent(due[0].id, 'mcp:reconnect', { for: due.map((b) => b.id), tries });
    const proceed = () => {
      if (mcpSharers(a).every(isIdle)) return true;
      putBack({ type: 'reconnect-mcp', tries, after });
      db.addEvent(due[0].id, 'mcp:reconnect-deferred');
      return false;
    };
    await adapterFor(a).reconnectMcp?.(due[0], { proceed });
  } catch (e) {
    const n = tries + 1;
    db.addEvent(due[0].id, 'mcp:reconnect-error', { tries: n, error: String(e) });
    if (n < MAX_RECONNECT_TRIES) {
      const wait = 5000 * 2 ** (n - 1);
      putBack({ type: 'reconnect-mcp', tries: n, after: Date.now() + wait });
      // An agent that stays idle has no next idle to retry at.
      setTimeout(() => {
        const cur = db.getAgent(a.id);
        if (cur) reconnectIfQuiet(cur).catch(() => {});
      }, wait).unref();
    }
  } finally {
    reconnecting.delete(key);
  }
}

// Called when an agent's turn ends. It may also be the last of its MCP scope to go idle.
export async function onIdle(agentId: string): Promise<void> {
  restTurnEnded(agentId);
  const a = db.getAgent(agentId);
  if (!a) return;
  // A pending reconnect stays set until reconnectIfQuiet runs it for the whole scope.
  if (a.pending_action && !reconnectPending(a)) await runPending(a, JSON.parse(a.pending_action));
  const now = db.getAgent(agentId);
  if (now && adapters[now.harness]?.reconnectMcp) await reconnectIfQuiet(now);
}

// `owner` is 'human' or the pausing agent's id. Pausing a paused agent only adds the owner,
// so several owners and stam's blockers can hold it together.
export function pause(a: db.Agent, owner: string): Promise<string> {
  return serial(a.id, () => pauseNow(a.id, owner));
}

// Asks the harness to stop its running turn (Claude Code Esc, OpenCode and Codex interrupt
// calls). True when it confirmed; false when the adapter can't, or failed (recorded).
async function interruptTurn(a: db.Agent): Promise<boolean> {
  const adapter = adapters[a.harness];
  if (!adapter?.interrupt) return false;
  const ok = await adapter.interrupt(db.getAgent(a.id) ?? a).catch((e) => (db.addEvent(a.id, 'pause:interrupt-error', String(e)), false));
  db.addEvent(a.id, 'pause:interrupt', { confirmed: ok });
  return ok;
}

// Stops the running turn of an agent that is already paused, when a provider-down blocker
// arrives. Within serial(). True when a turn was stopped.
export async function stopRunningTurn(id: string): Promise<boolean> {
  const a = db.getAgent(id);
  if (!a || a.lifecycle !== 'paused' || !db.isBusy(a)) return false;
  const ok = await interruptTurn(a);
  if (ok) db.addEvent(id, 'pause:notice-skipped');
  return ok;
}

// The resume text's catch-up for an agent whose turn was cut off by a pause before it got the
// pause notice (templates/pause-missed.md); '' otherwise. Reads the newest pause events by type,
// however many other events came since. The caller records it with markMissedGiven once the
// resume succeeded, so a failed resume keeps it for the next attempt.
export function missedPause(id: string): string {
  for (const e of db.listEvents(id, 50, 'pause*').reverse()) {
    if (e.type === 'pause:notice-given') return '';
    if (e.type === 'pause' && !(e.data ?? '').includes('"already"')) return '';
    if (e.type === 'pause:notice-skipped') return render('pause-missed', {});
  }
  return '';
}

export function markMissedGiven(id: string, missed: string): void {
  if (missed) db.addEvent(id, 'pause:notice-given');
}

// Pauses within serial(). A null owner is stam pausing for cost blockers (blockers.ts). The
// state is written before the agent is told, so a transition queued behind this one
// sees it.
export async function pauseNow(id: string, owner: string | null, stopTurn = false): Promise<string> {
  const a = db.getAgent(id)!;
  const owners = pauseOwners(a);
  const next = owner && !owners.includes(owner) ? [...owners, owner] : owners;
  if (a.lifecycle === 'paused') {
    if (next !== owners) db.updateAgent(id, { paused_by: JSON.stringify(next) });
    db.addEvent(id, 'pause', { owner: owner ?? 'stam', already: true });
    return 'paused';
  }
  if (a.lifecycle !== 'active') throw new Error(`${a.name} is ${a.lifecycle}`);
  db.updateAgent(id, { lifecycle: 'paused', paused_by: next.length ? JSON.stringify(next) : null });
  db.addEvent(id, 'pause', { owner: owner ?? 'stam' });
  // S-3631: `stopTurn` (a cost blocker whose provider is unusable, blockers.ts) stops a turn in
  // flight, so the harness makes no more provider calls (a paused agent otherwise kept retrying an
  // exhausted provider). Any other pause keeps today's behaviour: the turn finishes, since cutting
  // it off mid-edit may leave work half done. The pause notice is skipped after a stopped turn,
  // since it would start a turn of its own; the resume text carries it instead (missedPause).
  if (stopTurn && db.isBusy(a) && (await interruptTurn(a))) {
    db.addEvent(id, 'pause:notice-skipped');
    return 'paused';
  }
  await prompt(a, render('pause', {}), null);
  return 'paused';
}

// `by` is 'human' or the unpausing agent's id. An agent releases only its own pause; the
// human releases every agent's and the human's. The agent resumes only when nothing else
// holds it: an agent is told what still does, the human gets an error naming it.
// `force` is the human's alone: it also clears the cost blockers (a 'cost:override' event).
export function unpause(a: db.Agent, opts: { by: string; force?: boolean } = { by: 'human' }): Promise<string> {
  return serial(a.id, async () => {
    assertNotTakenOver(a);
    assertNoTransition(db.getAgent(a.id)!);
    const human = opts.by === 'human';
    if (opts.force && !human) throw new Error('only the human may force an unpause');
    const cur = db.getAgent(a.id)!;
    if (cur.lifecycle !== 'paused') throw new Error(`${cur.name} is ${cur.lifecycle}`);
    const owners = human ? [] : pauseOwners(cur).filter((o) => o !== opts.by);
    db.updateAgent(a.id, { paused_by: owners.length ? JSON.stringify(owners) : null });
    const blockers = db.blockerRows(a.id);
    if (opts.force && blockers.length) {
      db.addEvent(a.id, 'cost:override', { blockers });
      db.deleteBlockers(a.id);
    }
    admit(a, 'unpause');
    const held = heldBy(db.getAgent(a.id)!);
    if (held) {
      db.addEvent(a.id, 'unpause-held', { by: opts.by, held });
      // Only the rest is left: mail that arrived while another pause held it wakes it now.
      if (isResting(db.getAgent(a.id)!)) schedulePush(a.id);
      const msg = `${cur.name} stays paused: ${held}`;
      if (human) throw new Error(`${msg}. Unpause with force to override its cost blockers.`);
      return msg;
    }
    const missed = missedPause(a.id);
    const r = await resumeNow(a.id, render('unpause', { missed }));
    markMissedGiven(a.id, missed);
    return r;
  });
}

// Unpauses within serial(), once nothing holds the agent. `text` is what it is told. Mail
// and notices that waited while it was blocked go in after, as for any idle agent.
// `delivered` waits for the harness to take `text` (or keep it back at the gate) before returning, and
// fails with the launch error otherwise: for a prompt a person typed, whose loss must not read as sent (S-2034).
// `wake` marks a wake of a resting agent: a prompt it doesn't take is a failed wake (see below).
export async function resumeNow(id: string, text: string, delivered = false, wake = false): Promise<string> {
  const release = acquire(db.getAgent(id)!, 'resume');
  try {
    return await resumeNowLocked(id, text, delivered, wake);
  } finally {
    release();
  }
}

async function resumeNowLocked(id: string, text: string, delivered: boolean, wake: boolean): Promise<string> {
  const a = db.getAgent(id)!;
  assertNotTakenOver(a);
  if (a.lifecycle !== 'paused') throw new Error(`${a.name} is ${a.lifecycle}`);
  const ok = admit(a, 'unpause');
  if (!ok.ok) throw new Error(`${a.name} stays paused: ${ok.reason}`);
  db.updateAgent(id, { paused_by: null });
  // Its terminal went down with the tmux server while it was paused: resume it.
  if (a.workspace && !(await tmux.hasSessionAsync(id))) {
    if (!a.session_id) throw new Error(`${a.name} has no session to resume`);
    // A compaction a restart cut off may still write to the session: stopped and repaired first (S-2238).
    await clearInterruptedCompaction(a);
    const { launched } = await startHarness(db.getAgent(id)!, text, true, 'unpause');
    if (delivered) await launched;
    db.addEvent(id, 'unpause');
    schedulePush(id);
    return 'active';
  }
  db.updateAgent(id, { lifecycle: 'active' });
  const gen = launchSeq.get(id) ?? 0;
  // A wake whose prompt isn't taken (prompt() returns false when the push fails) is not a wake: back to
  // rest as it was, so the wake's retry runs. A shutdown or archive that landed meanwhile bumped the
  // launch generation (invalidateLaunch) and has the last word, so nothing is restored. Other callers
  // keep the agent active, as before.
  if (!(await prompt(a, text, 'unpause')) && wake) {
    if (launchCurrent(id, gen)) db.updateAgent(id, { lifecycle: 'paused', paused_by: a.paused_by });
    throw new Error(`${a.name} did not take the prompt`);
  }
  db.addEvent(id, 'unpause');
  schedulePush(id);
  return 'active';
}

// --- Resting (S-897, S-1982) ----------------------------------------------------------------
// An idle agent whose next wake is far off rests: paused with the owner REST_OWNER and its harness
// stopped, as a shutdown does, so no turn is spent telling it. The conversation and the workspace
// stay; resumeNowLocked starts the harness again on a resume. Only REST_OWNER holds it: a human or
// agent pause, or a cost blocker, also keeps it down, and a wake never lifts those.
// The owner keeps its S-897 name, so agents resting across the upgrade still wake.
export const REST_OWNER = 'standing-idle'; // db.REST_PAUSED_BY is its paused_by

export function isResting(a: db.Agent): boolean {
  const owners = pauseOwners(a);
  return a.lifecycle === 'paused' && owners.length === 1 && owners[0] === REST_OWNER;
}

// STAM_STANDING_IDLE_HOURS overrides the setting (tests use a fraction).
function standingIdleMs(): number {
  const env = Number(envVar('STANDING_IDLE_HOURS'));
  return (env > 0 ? env : settings().standing.idleHours) * 3_600_000;
}

// STAM_REST_AFTER_MINUTES and STAM_REST_GRACE_MINUTES override the settings (tests use fractions).
function restMs(): { after: number; grace: number } {
  const r = settings().rest;
  const env = (k: string, v: number) => {
    const n = Number(envVar(k.slice('STAM_'.length)));
    return (n > 0 ? n : v) * 60_000;
  };
  return { after: env('STAM_REST_AFTER_MINUTES', r.afterMinutes), grace: env('STAM_REST_GRACE_MINUTES', r.graceMinutes) };
}

// STAM_REST_ENABLED (1 or 0) overrides rest.enabled: test daemons turn it off (test/lib.sh), so an agent
// in an e2e test never rests mid-test; the standing rule is separate.
function restEnabled(): boolean {
  const env = envVar('REST_ENABLED');
  return env === '1' ? true : env === '0' ? false : settings().rest.enabled;
}

// A prompt, mail or web-view push since it went idle starts a turn the hooks haven't reported yet: the push returns
// before the harness's turn-start hook, and the push consumed the mail or notices, so a rest now would lose
// them. Its turn moves idle_since past the push. A push that never starts a turn keeps the agent up until
// its next turn: up costs memory, a rest would cost the work.
function pushedTurnPending(a: db.Agent): boolean {
  const at = db.lastEventAt(a.id, ['pushed', 'prompt:sent', 'view-prompt']);
  return at != null && at >= a.idle_since!;
}

// An agent woken this many times within an hour stays up for an hour after that (churn guard).
const CHURN_WAKES = 3;
const HOUR = 3_600_000;

function churning(id: string, now: number): boolean {
  const wakes = db.eventTimes(id, 'standing:wake', new Date(now - 2 * HOUR).toISOString()).map(Date.parse);
  // The third wake within an hour of the first, that last one less than an hour ago.
  for (let i = CHURN_WAKES - 1; i < wakes.length; i++) if (now - wakes[i] < HOUR && wakes[i] - wakes[i - CHURN_WAKES + 1] < HOUR) return true;
  return false;
}

// The soonest future time a stam-held wait is expected to wake the agent: a wake_me's fire time, a
// wait_for timeout, or its expect_minutes. Null with no known time.
function expectedWake(waits: db.Wait[], now: number): number | null {
  let soonest: number | null = null;
  for (const w of waits) {
    let data: { expect_at?: string } = {};
    try {
      data = w.data ? JSON.parse(w.data) : {};
    } catch {}
    for (const t of [w.until, data.expect_at]) {
      const ms = t ? Date.parse(t) : NaN;
      if (ms > now && (soonest == null || ms < soonest)) soonest = ms;
    }
  }
  return soonest;
}

// What the API reports for a resting agent (S-2034): why it rests, what it waits for and when it is
// expected to wake (ISO, null with no known time). Null for any other agent. Read live from its waits,
// so a wait added or cleared while it rests shows at once.
export type Resting = { reason: 'idle' | 'wait'; waits: { id: string; kind: string; target: string | null; detail: string | null; since: string; until: string | null }[]; expected_wake: string | null };

export function restingOf(a: db.Agent, waits: db.Wait[]): Resting | null {
  if (!isResting(a)) return null;
  const wake = expectedWake(waits, Date.now());
  return {
    reason: waits.length ? 'wait' : 'idle',
    waits: waits.map((w) => ({ id: w.id, kind: w.kind, target: w.target, detail: w.detail, since: w.since, until: w.until })),
    expected_wake: wake ? new Date(wake).toISOString() : null,
  };
}

const restTypeKey = (a: db.Agent): string => {
  const t = typeOf(a, settings().chiefOfStaff);
  return t === 'chief-of-staff' ? 'cos' : t;
};

export type RestPlan = { reason: 'idle' | 'wait'; wake: number | null };

// Whether the agent may rest now, and why. Null keeps it up.
function restPlan(a: db.Agent, now = Date.now()): RestPlan | null {
  if (a.lifecycle !== 'active' || (a.activity !== 'idle' && a.activity !== 'waiting') || !a.idle_since || !a.workspace || !a.session_id) return null;
  if (a.pending_action || a.forwarded_to || transitions.has(a.id) || compactionRunning(a.id)) return null;
  const waits = db.listWaits(a.id);
  // An open wake_me or wait_for keeps the activity 'waiting': its firing or answer is a notice or mail that wakes it. A wait the harness holds (a hook's) would die with the harness.
  if (waits.some((w) => w.source !== 'declared' && w.source !== 'stam')) return null;
  // Mail or a notice that hasn't reached it yet means it has work. A passive notice (S-1744) is
  // meant to wait for a real wake, so it doesn't count.
  if (db.hasPendingPermission(a.id) || db.unpushedCount(a.id) > 0 || wakeableNoticeCount(a.id) > 0 || heldBy(a) !== null) return null;
  if (pushedTurnPending(a)) return null;
  if (settings().rest.types[restTypeKey(a)] === false) return null;
  const plan = restRule(a, waits, now);
  // Someone at its terminal (`stam attach`, a web terminal) is using it.
  return plan && !tmux.hasClients(a.id) ? plan : null;
}

// S-2158: the rest rules count idle time from the agent's last turn that acted, so a manager whose
// turns only read a child's notice or a mail still rests. A turn acts when it calls a tool outside
// QUIET_TOOLS; one whose start no hook reported (OpenCode, a daemon restart) counts as acting, so its
// clock is idle_since as before. idle_since itself keeps its meaning for its other readers.
const QUIET_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'ToolSearch', 'TodoWrite', 'WebFetch', 'WebSearch', 'Skill',
  'read_mail', 'list_inbox', 'read_thread', 'search', 'search_mail', 'find_agents', 'whoami', 'registry_info', 'usage_info', 'activity_info', 'itsa_get', 'itsa_list', 'layout_get', 'list_subscriptions',
  // A wait it declares is read by restPlan already; declaring one is no action.
  'wait_for', 'wait_done', 'wake_me', 'watch_pr', 'unwatch_pr', 'subscribe', 'unsubscribe',
]);
const quietTool = (tool: string) => QUIET_TOOLS.has(/^mcp__stam__(.+)$/.exec(tool)?.[1] ?? tool);
// The time each agent's rest clock counts from, when a quiet turn left it before idle_since.
const restClocks = new Map<string, string>();
// The clock a running turn carries while it has called only quiet tools.
const quietTurns = new Map<string, string | null>();

// A turn starts: idleSince is the agent's idle_since before it, null if it wasn't idle.
export function restTurnStarted(id: string, idleSince: string | null): void {
  if (quietTurns.has(id)) return; // a prompt typed into a running turn
  quietTurns.set(id, restClocks.get(id) ?? idleSince);
  restRequests.delete(id); // a new turn makes its own request, if any
}

export function restToolUsed(id: string, tool: string): void {
  if (quietTool(tool)) return;
  quietTurns.set(id, null);
  // Should its turn end go unreported, the older clock is gone already.
  restClocks.delete(id);
}

// A turn ends, on any harness's authoritative turn end (onIdle): closes its rest-clock state, and
// starts the delay of a rest its turn requested.
export function restTurnEnded(id: string, delayMs = REST_REQUEST_DELAY_MS): void {
  const clock = quietTurns.get(id);
  quietTurns.delete(id);
  if (clock) restClocks.set(id, clock);
  else restClocks.delete(id);
  const r = restRequests.get(id);
  if (!r) return;
  r.notBefore = Date.now() + delayMs;
  const t = setTimeout(() => {
    rest(id).catch((e) => db.addEvent(id, 'standing:rest-error', String(e)));
  }, delayMs);
  t.unref?.();
}

// An archived or forgotten agent's turns are over.
export function restForget(id: string): void {
  restClocks.delete(id);
  quietTurns.delete(id);
  restRequests.delete(id);
}

// S-2237: `rest: true` on wait_for or wake_me asks stam to rest the agent when its turn ends, skipping
// rest.graceMinutes and rest.afterMinutes. Every restPlan guard and the churn guard still hold; a held
// request waits for the sweep. It counts from REST_REQUEST_DELAY_MS after the turn end, and lasts until
// the agent's next turn starts (restTurnStarted, dropRestRequest) or its wait clears or fires (a repeating
// wake_me moves its `until`). It lives in memory: a daemon restart drops it, and the timing rules rest
// the agent as before.
type RestRequest = { wait: string; until: string | null; notBefore: number | null };
const restRequests = new Map<string, RestRequest>();
const REST_REQUEST_DELAY_MS = 3_000; // lets the harness finish its turn-end hook before it stops

export function requestRest(id: string, w: db.Wait): void {
  restRequests.set(id, { wait: w.id, until: w.until, notBefore: null });
  db.addEvent(id, 'standing:rest-requested', { wait: w.id });
}

// A turn starts on a harness whose turns stam doesn't follow tool by tool (Codex's app server, OpenCode).
export function dropRestRequest(id: string): void {
  restRequests.delete(id);
}

// The agent's open rest request, for tests.
export const restRequestOf = (id: string): Readonly<RestRequest> | undefined => restRequests.get(id);

function restRequested(id: string, waits: db.Wait[], now: number): boolean {
  const r = restRequests.get(id);
  return !!r && r.notBefore != null && now >= r.notBefore && waits.some((w) => w.id === r.wait && w.until === r.until);
}

// When the rest rules count its idle time from.
export function restClock(a: db.Agent): string {
  const clock = restClocks.get(a.id);
  return clock && clock < a.idle_since! ? clock : a.idle_since!;
}

// The timing rules, for an agent nothing else keeps up.
function restRule(a: db.Agent, waits: db.Wait[], now: number): RestPlan | null {
  const idle = now - Date.parse(restClock(a));
  const reason = waits.length ? 'wait' : 'idle';
  const wake = expectedWake(waits, now);
  // Woken this often lately: chatty notices would restart it again and again. Standing agents too.
  if (churning(a.id, now)) return null;
  // S-897: a standing agent idle this long rests whatever it waits for.
  if (a.standing && idle >= standingIdleMs()) return { reason, wake };
  if (!restEnabled()) return null;
  if (restRequested(a.id, waits, now)) return { reason, wake };
  const { after, grace } = restMs();
  // A manager with children at work (stam's 'children' wait) hears from them at any time, so its wake times say little.
  const busyChildren = waits.some((w) => w.kind === 'children' && w.source === 'stam');
  if (wake != null && !busyChildren) {
    if (wake - now <= after) return null; // it wakes soon anyway
    return idle >= grace ? { reason, wake } : null;
  }
  if (a.standing && reason === 'idle') return null; // only its standing rule above
  return idle >= after ? { reason, wake } : null;
}

// Rests every agent that may rest now. Called every minute.
export function restSweep(): void {
  const now = Date.now();
  for (const a of db.listAgents()) if (restPlan(a, now)) rest(a.id).catch((e) => db.addEvent(a.id, 'standing:rest-error', String(e)));
}

const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16);

// S-2238: a resting agent's prompt cache expires with no harness to see it: the idle sweep compacts
// it headless on its session while the cache is still warm, and it stays resting. In the agent's
// serial queue, so a wake waits for the compaction rather than resuming the session under it. Claude
// Code only (compactQuits): Codex's app server dies with its tmux session, and OpenCode's compaction
// runs in its server and may set a resting agent working.
export function compactResting(id: string, reason: string): Promise<string> {
  return serial(id, async () => {
    const a = db.getAgent(id);
    if (!a || !isResting(a)) return 'not resting';
    if (cacheCompactionHeld(a) || db.unpushedCount(id) > 0 || wakeableNoticeCount(id) > 0) return 'held';
    if (compactionBusy(id) || !adapterFor(a).compactQuits || !adapterFor(a).compact || !a.session_id) return 'not compacting';
    await clearInterruptedCompaction(a);
    try {
      await compactShutDown(a, undefined, reason);
    } catch (e) {
      // A failed or timed-out compactor may have cut the session's last row short: repaired before any resume.
      await adapterFor(a).repairSession?.(a);
      throw e;
    }
    // The size before the compaction no longer holds; the next report after the wake measures it.
    db.updateAgent(id, { context_tokens: null });
    return 'compacted';
  });
}

// S-2238: a compaction a daemon restart cut off (its compactor survives a restart, KillMode=process)
// on an agent that isn't active, so recoverOne never sees it: the leftover compactor is stopped and
// confirmed gone, and the session repaired, before the agent is compacted again (compactResting) or its
// harness resumed (resumeNowLocked: a wake, an unpause, a lifted cost blocker or probe).
async function clearInterruptedCompaction(a: db.Agent): Promise<void> {
  if (compactionRunning(a.id) || !a.session_id) return;
  const op = compactionInterrupted(a);
  if (op === null) return;
  const left = compactorProcesses(a.id, a.session_id, a.cwd);
  if (left.size) {
    db.addEvent(a.id, 'compact:killed', { pids: [...left.keys()] });
    await stopAndConfirm(left);
  }
  await adapterFor(a).repairSession?.(a);
  db.addEvent(a.id, 'compact:failed', { op, error: 'cut off by a daemon restart' });
}

// What keeps the idle compaction off an agent (S-2238): woken this often lately (it would compact
// again and again), or a push whose turn hasn't run.
export function cacheCompactionHeld(a: db.Agent, now = Date.now()): boolean {
  return churning(a.id, now) || (!!a.idle_since && pushedTurnPending(a));
}

export function rest(id: string): Promise<string> {
  return serial(id, async () => {
    const a = db.getAgent(id);
    const plan = a && restPlan(a);
    if (!a || !plan) return 'not resting';
    // A rest predicted to outlast the prompt cache compacts first, if the idle compaction would; the
    // agent rests on a later sweep, once idle again. The cache ages from its last call, when it went idle.
    const long = plan.wake == null || plan.wake - Date.parse(a.idle_since!) > settings().idleCompaction.idleMinutes * 60_000;
    if (long && idleCompactIfDue(a, 'before a long rest')) return 'compacting first';
    const detail = plan.reason === 'idle' ? 'resting: idle; mail or a notice wakes it' : `resting: waiting${plan.wake ? `, expected wake ${clock(plan.wake)} UTC` : ''}; mail or a notice wakes it`;
    // idle_since stays: the tree-idle notice its parents may still be owed is keyed by it (org.needsTreeIdleNotice).
    db.updateAgent(id, { lifecycle: 'paused', paused_by: JSON.stringify([REST_OWNER]), activity: 'unknown', activity_detail: detail, pending_action: null, idle_since: a.idle_since });
    db.addEvent(id, 'standing:rest', { idleSince: a.idle_since, reason: plan.reason, expectedWake: plan.wake ? new Date(plan.wake).toISOString() : null });
    invalidateLaunch(id);
    harnessExited(id);
    tmux.killSession(id);
    stopTurn(a);
    return 'resting';
  });
}

// A failed wake is retried after these delays (S-922), then given up with one note to the parent.
// Held in memory: a daemon restart drops it, and the next mail wakes the agent as before.
let wakeRetryDelays = [60_000, 300_000, 900_000];
type WakeTimer = (fn: () => void, ms: number) => () => void;
const realTimer: WakeTimer = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};
let wakeTimer: WakeTimer = realTimer;
const wakeRetries = new Map<string, { attempt: number; cancel: () => void }>();

// Tests inject the delays and a timer; no argument restores the defaults.
export function setWakeRetry(opts?: { delays?: number[]; timer?: WakeTimer }): void {
  for (const id of [...wakeRetries.keys()]) cancelWakeRetry(id);
  wakeRetryDelays = opts?.delays ?? [60_000, 300_000, 900_000];
  wakeTimer = opts?.timer ?? realTimer;
}

export function cancelWakeRetry(id: string): void {
  wakeRetries.get(id)?.cancel();
  wakeRetries.delete(id);
}

function retryWake(a: db.Agent, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  const attempt = wakeRetries.get(a.id)?.attempt ?? 0;
  cancelWakeRetry(a.id);
  if (attempt >= wakeRetryDelays.length) {
    db.addEvent(a.id, 'standing:wake-gave-up', { attempts: attempt });
    tellStopped(a, `${a.name} is resting and stays down: ${attempt} wake retries failed (last error: ${msg}). It wakes on the next mail.`);
    return;
  }
  if (attempt === 0) tellStopped(a, `${a.name} is resting and could not be woken: ${msg}. Retrying.`);
  const cancel = wakeTimer(() => {
    wakeResting(a.id, 'a retry after a failed wake', true).catch(() => {});
  }, wakeRetryDelays[attempt]);
  wakeRetries.set(a.id, { attempt: attempt + 1, cancel });
  db.addEvent(a.id, 'standing:wake-retry', { attempt: attempt + 1, afterMs: wakeRetryDelays[attempt] });
}

// Starts a resting agent again, for mail, a notice or an assigned ITSA waiting for it. A hold
// besides the rest (a pause, a cost blocker) keeps it down. `timed` marks a backoff retry: a
// wake for mail while a retry is pending is skipped, so only timed retries count toward the limit.
// `text` is what it is told instead of the standing-wake prompt: the human's prompt from the web view (S-2034),
// which the wake waits to see delivered, failing with the launch error if it isn't.
export function wakeResting(id: string, why: string, timed = false, text?: string): Promise<string> {
  return serial(id, async () => {
    if (!timed && wakeRetries.has(id)) return 'retry pending';
    const a = db.getAgent(id);
    // Woken another way, archived, or unpaused by hand: nothing left to retry.
    if (!a || !isResting(a)) {
      cancelWakeRetry(id);
      return 'not resting';
    }
    const held = heldBy({ ...a, paused_by: null });
    if (held) {
      cancelWakeRetry(id);
      db.addEvent(id, 'standing:wake-held', { why, held });
      return `stays down: ${held}`;
    }
    db.addEvent(id, 'standing:wake', { why });
    try {
      const r = await resumeNow(id, text ?? render('standing-wake', { why, cwd: a.cwd }), text != null, true);
      cancelWakeRetry(id);
      return r;
    } catch (e) {
      // Still resting, if the launch left it paused.
      const cur = db.getAgent(id);
      if (cur?.lifecycle === 'paused' && !cur.paused_by) db.updateAgent(id, { paused_by: JSON.stringify([REST_OWNER]) });
      db.addEvent(id, 'standing:wake-error', String(e));
      // The prompt failed after the agent went active: it is running, so a retry would find
      // nothing resting. Tell the parent instead.
      if (cur && cur.lifecycle !== 'paused') {
        cancelWakeRetry(id);
        // Only an agent still running is said to be running: a shutdown or archive has already told the parent.
        if (cur.lifecycle === 'active') tellStopped(a, `${a.name} was woken but its wake prompt failed: ${e instanceof Error ? e.message : String(e)}. It is running; send it mail.`);
        throw e;
      }
      retryWake(a, e);
      throw e;
    }
  });
}

// Called once by the daemon at start (not at import: lifecycle and mail import each other).
export function startRestWaking(): void {
  onRestWake((id) => {
    const a = db.getAgent(id);
    if (a && isResting(a)) wakeResting(id, 'mail or a notice is waiting for you').catch(() => {});
  });
  // An ITSA given to a resting agent as owner (created with one, or set) wakes it. The notice
  // carries the ITSA to the agent, and queueing it wakes the agent (mail.schedulePush).
  itsa.onChange((c) => {
    if (c.type !== 'owner' || !c.to) return;
    const a = db.getAgent(c.to);
    if (a && isResting(a)) queueNotice(a.id, `[stam] ${c.itsa.key} "${c.itsa.title}" was assigned to you.`);
  });
}

// The shutdown and kill actions of an agent: they end its cost fallbacks too (S-2458). The internal
// stops (a take-over's own stop, the chief of staff's restart) call shutdown, which doesn't.
export function explicitShutdown(a: db.Agent, now = false): Promise<string> {
  costFallback.cancelPending(a.id, 'the agent was shut down');
  return shutdown(a, now);
}

export function shutdown(a: db.Agent, now = false): Promise<string> {
  if (now) {
    stopForGood(a, 'shut down');
    return Promise.resolve('done');
  }
  // S-1402: an active agent that hasn't filed its final round is asked for it, idle or not: the
  // shutdown is the last moment its context is live (an archive 12h later finds it stopped). The
  // pending shutdown runs at its next turn end or at the deadline (runDueArchives).
  if (a.lifecycle === 'active' && !db.hasEvent(a.id, 'retro_final')) return askShutdownRound(a);
  return whenIdle(a, { type: 'shutdown' }, withRetroReminder(render('shutdown-prepare', {})));
}

async function askShutdownRound(a: db.Agent): Promise<string> {
  // An idle agent has no step to wait for, so the round is bounded by the deadline. A working one
  // finishes its step first, as a shutdown always waited: no deadline, it stops at its turn end.
  const pending: Pending = isIdle(a) ? { type: 'shutdown', at: Date.now() + finalRoundMs() } : { type: 'shutdown', midTurn: true };
  db.updateAgent(a.id, { pending_action: JSON.stringify(pending) });
  await prompt(a, archiveWrapUp()).catch(() => false);
  db.addEvent(a.id, 'pending', pending);
  return `waiting for ${a.name} to finish its step`;
}

// The wrap-up an archive asks a running agent for: the shutdown's, plus the final retro round
// (S-159). Every archive sends it now, forced or not (S-1043); only a plain shutdown doesn't.
export function archiveWrapUp(): string {
  return `${render('shutdown-prepare', {})}\n\n${render('shutdown-archive', {})}`;
}

// Whether the agent's harness terminal is there with a live pane. A registered agent (no
// workspace) runs outside stam, so there is no terminal stam can check.
export function harnessRunning(a: db.Agent): boolean {
  return Boolean(a.workspace) && tmux.hasSession(a.id) && !tmux.isDead(a.id);
}

// Whether the harness is still executing the agent's turn with no tmux pane to show it (S-578):
// a server-backed harness (OpenCode's shared server) can keep a turn after its TUI exits, so a
// lost terminal is no proof the agent is dead. Returns true (a turn runs), false (the adapter
// answered that none does), or undefined when the adapter can't be asked (a timeout, an error):
// undefined must never be read as death, so a destructive decision waits and retries.
export async function harnessTurnAlive(a: db.Agent): Promise<boolean | undefined> {
  const adapter = adapters[a.harness];
  // No server turn to ask about: the pane is authoritative.
  if (!adapter?.turnRunning) return false;
  return adapter.turnRunning(a).catch(() => undefined);
}

// Whether the agent's harness is alive: a live tmux pane (true), else the harness's own turn
// state (true, false, or undefined when it couldn't be asked, S-578).
export async function harnessAlive(a: db.Agent): Promise<boolean | undefined> {
  return harnessRunning(a) || (await harnessTurnAlive(a));
}

// The pending stop action (archive or shutdown) on this agent, or null.
export function pendingStop(a: db.Agent): Pending | null {
  const p = a.pending_action ? (JSON.parse(a.pending_action) as Pending) : null;
  return p && (p.type === 'archive' || p.type === 'shutdown') ? p : null;
}

// S-1043: whether a pending archive's final-round deadline has passed. Reconcile runs such an
// archive through runDueArchives instead of the dead-harness path, so the two never race for the
// same agent, whatever its turn state.
export function pendingStopDue(a: db.Agent, now = Date.now()): boolean {
  const p = pendingStop(a);
  return p?.type === 'archive' && typeof p.at === 'number' && p.at <= now;
}

// S-578: an agent whose harness is gone has no step to wait for, so a pending stop (archive or
// shutdown) runs at once instead of waiting for a turn that never ends. An unforced archive is
// deferred when the harness still runs a turn with no pane, or when that can't be told, rather
// than interrupting a live step on a guess.
export async function runPendingOnDead(a: db.Agent): Promise<void> {
  const p = pendingStop(a);
  if (!p) return;
  if (p.type === 'archive' && !p.force) {
    const alive = await harnessTurnAlive(a);
    if (alive !== false) {
      db.addEvent(a.id, 'archive:deferred', { reason: alive ? 'harness still runs a turn with no pane' : 'harness turn state unknown' });
      return;
    }
  }
  db.updateAgent(a.id, { pending_action: null });
  if (p.type === 'archive') noteRoundSkipped(a, 'harness_gone');
  if (p.type === 'archive') return archiveNowPending(db.getAgent(a.id)!, p, 'because its harness is gone');
  stopForGood(db.getAgent(a.id)!, 'shut down');
}

// S-578: whether an agent has sat in 'starting' past settings.startingTimeoutMinutes with no
// live tmux pane. The caller checks harnessTurnAlive too, since a harness can outlive its pane.
export function startingStuck(a: db.Agent, paneAlive: boolean, now = Date.now()): boolean {
  if (a.activity !== 'starting' || paneAlive) return false;
  const since = Date.parse(a.created_at);
  return Number.isFinite(since) && now - since >= settings().startingTimeoutMinutes * 60_000;
}

// Called with an agent markStartingDead has just marked never started (S-3070): the daemon registers
// the ring's reaction, which lifecycle can't import (a ring may fall back to spawning a reviewer).
export const startingDeadListeners: ((a: db.Agent) => void)[] = [];

// Marks such an agent stopped, tells its parent, and runs a pending archive at once. A harness
// still running a turn with no pane, or one that can't be asked, is left alone.
export async function markStartingDead(a: db.Agent): Promise<void> {
  // The generation before the probe: a launch starting or finishing meanwhile makes our view
  // stale (S-578 review).
  const gen = launchSeq.get(a.id) ?? 0;
  // Only a successful inactive answer lets us proceed; a live turn or an unknown probe defers.
  if ((await harnessTurnAlive(a)) !== false) return;
  // Re-read after the probe: a launch may have finished meanwhile, leaving a live pane and an
  // active agent, or the agent may have moved on.
  const now = db.getAgent(a.id);
  if (!now || (launchSeq.get(a.id) ?? 0) !== gen) return;
  if (now.lifecycle !== 'active' && now.lifecycle !== 'paused') return;
  if (!startingStuck(now, harnessRunning(now))) return;
  // A launch still in flight must not create a pane after the agent is marked stopped; there is
  // no await between this and the marking below, so none can slip between them.
  invalidateLaunch(now.id);
  const since = Date.parse(now.created_at);
  db.updateAgent(now.id, { lifecycle: 'shut_down', activity: 'unknown', activity_detail: 'never started: no harness process' });
  db.addEvent(now.id, 'starting:dead', { after_ms: Number.isFinite(since) ? Date.now() - since : null });
  const parent = db.parentsOf(now)[0] ?? chiefOfStaff()?.id;
  if (parent) queueNotice(parent, `${now.name} never started: no harness process after ${Math.round(settings().startingTimeoutMinutes)} minutes; stam marked it stopped.`);
  for (const f of startingDeadListeners) {
    try {
      f(db.getAgent(now.id)!);
    } catch (e) {
      db.addEvent(now.id, 'pending-error', String(e));
    }
  }
  await runPendingOnDead(db.getAgent(now.id)!);
}

// S-3250: a launch with no prompt (a resume, or a spawn without one) leaves 'starting' on the harness's
// SessionStart hook. A daemon restart seconds after the launch lost that hook (it retries only a refused
// connection): the launch's afterLaunch died with the old daemon, and the agent sat 'starting / resuming'
// for hours, its mail unread. Once no launch of it runs in this daemon and the harness sits at an empty
// prompt (adapter.atPrompt), it is ready: it goes idle as SessionStart would, and its mail goes in.
// It does only what SessionStart does (no onIdle: no pending action runs, the rest clock stays), and
// only for an agent the watchdog would also act on: active, not held, taken over, stopping or compacting.
export async function settleStart(a: db.Agent, paneAlive: boolean): Promise<boolean> {
  if (a.activity !== 'starting' || a.activity_detail === 'with prompt' || !paneAlive || launching.has(a.id)) return false;
  if (!restartable(a)) return false;
  // A relaunch during the probe starts another harness: the screen read belongs to the one before it.
  const gen = launchSeq.get(a.id) ?? 0;
  if (!(await adapters[a.harness]?.atPrompt?.(a))) return false;
  // The screen was read while the loop ran on: settle only an agent still as it was.
  const cur = db.getAgent(a.id);
  if (!cur || (launchSeq.get(a.id) ?? 0) !== gen || cur.activity !== 'starting' || cur.activity_detail === 'with prompt' || launching.has(a.id) || !restartable(cur)) return false;
  a = cur;
  db.addEvent(a.id, 'starting:settled', { detail: a.activity_detail });
  db.updateAgent(a.id, { activity: 'idle', activity_detail: 'ready' });
  schedulePush(a.id);
  return true;
}

function restartable(a: db.Agent): boolean {
  return a.lifecycle === 'active' && !isHeld(a) && !takenOverBy(a) && !pendingStop(a) && !compactionRunning(a.id);
}

// S-3250: the safety net for any other start that never reaches a turn. Past settings.stuckStartMinutes
// since its last launch (or a restart of it), still 'starting' with a live pane, the agent is restarted
// once; a start that the restart made and that gets stuck too leaves it errored, which tells its parents.
// The count lives in events, so it survives a daemon restart and resets with each launch it didn't make.
// A paused, held (a pause owner or a cost blocker), taken-over or compacting agent, one with a pending
// stop, or one on another machine is left alone. S-3250: a launch still in its afterLaunch here is left
// alone until twice the bound, so a slow but live start is not restarted under itself; a hung one is not.
const START_MARKS = ['spawn', 'resume', 'starting:restart'];
export function startStalled(a: db.Agent, paneAlive: boolean, now = Date.now()): boolean {
  const minutes = settings().stuckStartMinutes;
  if (!minutes || a.activity !== 'starting' || !paneAlive || a.machine !== MACHINE || !restartable(a)) return false;
  const since = Date.parse(db.lastEventAt(a.id, START_MARKS) ?? a.updated_at);
  if (!Number.isFinite(since)) return false;
  const bound = minutes * 60_000;
  if (launching.has(a.id) && now - since < 2 * bound) return false;
  return now - since >= bound;
}

// In the agent's serial queue, rechecked there: of two calls (reconcile ticks every 5 s), the second sees the first's launch.
export function restartStalledStart(a: db.Agent, now = Date.now()): Promise<void> {
  return serial(a.id, async () => {
    const cur = db.getAgent(a.id);
    if (!cur || !startStalled(cur, harnessRunning(cur), now)) return;
    const minutes = settings().stuckStartMinutes;
    const last = db.lastEvent(cur.id, START_MARKS);
    const data = last?.data ? JSON.parse(last.data) : null;
    // This start is the restart's own, or one a daemon restart cut off before it launched.
    if (last?.type === 'starting:restart' || data?.stuck) {
      db.addEvent(cur.id, 'starting:stuck', { restarted: true, minutes });
      db.updateAgent(cur.id, { activity: 'errored', activity_detail: `never reached a turn, even after a restart (${minutes} min each)` });
      return;
    }
    db.addEvent(cur.id, 'starting:restart', { minutes, detail: cur.activity_detail });
    // A spawn whose first prompt never went in has no conversation to resume: it starts afresh with it.
    const fresh = last?.type === 'spawn' && !db.hasEvent(cur.id, 'first-prompt:delivered');
    const text = fresh ? (cur.first_prompt ?? undefined) : render('restarted', { reason: `it never reached a turn in ${minutes} minutes of starting` });
    await startHarness(cur, text, !fresh, fresh ? 'spawn' : 'restart', { stuck: true });
  });
}

// S-759: whether a spawn's first prompt was never delivered. A daemon restart during the spawn
// leaves the agent 'starting' with the prompt stored (spawnAgent writes 'first-prompt:pending')
// and no delivery marker; after a restart no launch is in flight, so only the marker can tell.
// A held or taken-over agent is left to its notice queue and its successor.
export function firstPromptLost(a: db.Agent): boolean {
  if (a.activity !== 'starting' || a.lifecycle !== 'active' || !a.first_prompt) return false;
  if (isHeld(a) || takenOverBy(a)) return false;
  return db.hasEvent(a.id, 'first-prompt:pending') && !db.hasEvent(a.id, 'first-prompt:delivered');
}

// Re-delivers that first prompt, called on the daemon's first reconcile pass: a fresh launch
// carrying it, since an agent whose prompt never went in has no conversation to resume. A
// launch that fails leaves the agent errored (startHarness records it) and tells its parent.
export async function recoverFirstPrompt(a: db.Agent): Promise<void> {
  db.addEvent(a.id, 'first-prompt:recover');
  try {
    const { launched } = await startHarness(a, a.first_prompt!, false, 'spawn');
    await launched;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    db.updateAgent(a.id, { lifecycle: 'shut_down', activity: 'errored', activity_detail: `first prompt not delivered: ${msg}` });
    db.addEvent(a.id, 'first-prompt:failed', { error: msg });
    const parent = db.parentsOf(a)[0] ?? chiefOfStaff()?.id;
    if (parent) queueNotice(parent, `${a.name} never got its first prompt (${msg}); respawn it.`);
  }
}

// `discard` removes uncommitted worktree changes; `force` means "don't wait for the agent's
// current step" and implies `discard` (S-1043). Neither skips the final round any more: every
// archive asks for it and waits for the agent's next turn end, at most
// settings.archive.finalRoundMinutes, then archives regardless (runDueArchives). Only a stopped
// agent, or one whose harness is already gone, archives at once.
export async function archive(a: db.Agent, force = false, discard = force, forceUnpushed = false): Promise<string> {
  if (a.lifecycle === 'archived') throw new Error(`${a.name} is already archived`);
  assertNoTransition(a);
  // S-2201: unpushed commits refuse the archive now, before the final round is asked for or anything is
  // stopped, so the caller hears it at once and the agent keeps running and can push.
  if (!forceUnpushed) unpushedGuard(a);
  // S-2458: an archive ends the agent's pending cost fallbacks, even while its final round is still asked for.
  costFallback.cancelPending(a.id, 'the agent was archived');
  // A stopped or paused agent can't take the wrap-up: archive it at once (S-1043 review). A paused
  // agent isn't running a step, so nothing is interrupted.
  if (a.lifecycle === 'shut_down' || a.lifecycle === 'paused') {
    noteRoundSkipped(a, a.lifecycle);
    await archiveNow(a, { force, discard, forceUnpushed });
    return 'done';
  }
  // A workspaced agent whose harness is gone (no live pane, and the harness answered that no turn
  // runs) has no step to wait for either, unless it is still starting: a launch may not have
  // created its session yet, so reconcile handles that case at the starting timeout (S-578).
  if (a.workspace && a.activity !== 'starting') {
    const alive = await harnessAlive(a);
    if (alive === false) {
      noteRoundSkipped(a, 'harness_gone');
      await archiveNow(a, { force, discard, forceUnpushed });
      return 'done';
    }
  }
  // Everything else asks for the final round: the wrap-up goes in now (queued by a working agent),
  // and the pending archive runs at the agent's next turn end or at its deadline. An agent whose
  // turn state can't be told (S-578) gets the deadline too, so it never waits forever.
  return askFinalRound(a, { force, discard, forceUnpushed });
}

// S-2201: throws the unpushed-commits refusal for an agent whose worktree would be removed by its archive. A
// worktree another agent still works in stays (the last user removes it), so it has nothing to lose yet.
function unpushedGuard(a: db.Agent): void {
  const ws: Workspace | null = a.workspace ? JSON.parse(a.workspace) : null;
  if (!ws?.worktree || worktreeUsers(ws.worktree.path, a.id).length) return;
  const why = workspaceUnpushedRefusal(ws);
  if (why) throw new Error(`can't archive ${a.name}: ${why}`);
}

// S-1373: archiving an agent with children archives each idle or shut-down child the same way,
// recursively. The agent's own archive goes first, so its preconditions fail before any child is
// touched. A child that works or waits on something real, one with another live parent, and one
// whose archive failed is left running and reparented to the archived agent's live parents (else
// the chief of staff), so it isn't orphaned. The result names every child archived and kept.
// `discard` and `force` apply to the named agent only: a child never loses uncommitted work.
export interface CascadeReport {
  archived: string[];
  archiving: string[];
  kept: string[];
  failed: string[];
  // S-2452: standing children moved to their new parents, and standing children kept unarchived with the reason.
  moved: string[];
  stayed: string[];
  // Ids of the children archived or asked for their final round, so the cascade can follow their own children (S-1378).
  ids: string[];
}

// `remote` asks the other machines to run the cascade over the children they hold of this agent
// (S-1378): a child lives in the DB of the machine it runs on, with its parent's id only.
export type RemoteCascade = (parents: string[], fallback: string[]) => Promise<{ machine: string; report?: CascadeReport; error?: string }[]>;

export async function archiveCascade(a: db.Agent, force = false, discard = force, remote?: RemoteCascade, forceUnpushed = false): Promise<string> {
  const base = await archive(a, force, discard, forceUnpushed);
  const live = db.parentsOf(a).filter((p) => db.getAgent(p)?.lifecycle !== 'archived');
  const fallback = live.length ? live : [chiefOfStaff()?.id].filter((p): p is string => Boolean(p) && p !== a.id);
  const rep: CascadeReport = { archived: [], archiving: [], kept: [], failed: [], moved: [], stayed: [], ids: [] };
  // Each round cascades over the children of the ids archived in the last one, here and on every
  // peer, so a grandchild on another machine than its parent is reached too.
  const done = new Set<string>();
  const seen = new Set([a.id]);
  let frontier = [a.id];
  for (let round = 0; frontier.length && round < 10; round++) {
    const ids = frontier.filter((id) => !done.has(id));
    ids.forEach((id) => done.add(id));
    if (!ids.length) break;
    const from = rep.ids.length;
    for (const id of ids) await cascadeChildren(id, fallback, rep, seen);
    const next = rep.ids.slice(from);
    const answers: Awaited<ReturnType<RemoteCascade>> = remote ? await remote(ids, fallback).catch((e) => [{ machine: 'peers', error: e instanceof Error ? e.message : String(e) }]) : [];
    for (const r of answers) {
      if (r.report) {
        for (const k of ['archived', 'archiving', 'kept', 'failed', 'moved', 'stayed'] as const) rep[k].push(...(r.report[k] ?? []).map((x) => `${x} on ${r.machine}`));
        next.push(...r.report.ids);
        rep.ids.push(...r.report.ids);
      } else rep.failed.push(`children on ${r.machine} (${r.error ?? 'no answer'}; it may still be running there)`);
    }
    frontier = next;
  }
  const notes: string[] = [];
  if (rep.archived.length) notes.push(`also archived idle ${rep.archived.join(', ')}`);
  if (rep.archiving.length) notes.push(`asked idle ${rep.archiving.join(', ')} for their final round`);
  if (rep.kept.length) notes.push(`left alone, now reporting to ${fallback.map((p) => db.getAgent(p)?.name ?? p).join(', ') || 'nobody'}: ${rep.kept.join(', ')}`);
  if (rep.moved.length) notes.push(`moved standing ${rep.moved.join(', ')}`);
  if (rep.stayed.length) notes.push(`kept standing ${rep.stayed.join(', ')} unarchived`);
  if (rep.failed.length) notes.push(`couldn't archive ${rep.failed.join(', ')}`);
  return notes.length ? `${base}; ${notes.join('; ')}` : base;
}

// What a peer runs for POST /api/archive-children: the cascade over the children this machine
// holds of each parent id. A parent that is a live agent here is skipped: its own children were
// cascaded when it was archived.
export async function cascadeForPeer(parents: string[], fallback: string[]): Promise<CascadeReport> {
  const rep: CascadeReport = { archived: [], archiving: [], kept: [], failed: [], moved: [], stayed: [], ids: [] };
  const seen = new Set(parents);
  for (const p of parents) {
    const here = db.getAgent(p);
    if (here && here.lifecycle !== 'archived') continue;
    await cascadeChildren(p, fallback, rep, seen);
  }
  return rep;
}

// A parent is live when it is here and not archived, or a peer machine's agent last seen not
// archived. One in neither the registry nor the peer directory is gone.
function parentLive(id: string): boolean {
  const o = db.getAgent(id);
  if (o) return o.lifecycle !== 'archived';
  const l = db.peerAgentLifecycle(id);
  return l !== undefined ? l !== 'archived' : Boolean(db.peerAgentById(id));
}

// S-2452: whether a parent may control a child on this machine. This is the rule daemon.ts's mayActAs applies
// (it can't be imported here: daemon.ts imports this module): the chief of staff and the assistant act for any
// agent, and any other parent acts for a child only when it is registered here. A parent on a peer machine
// can't hold a child that lives here.
function canControl(parentId: string): boolean {
  return chiefOfStaff()?.id === parentId || isAssistant(parentId) || Boolean(db.getAgent(parentId));
}

export async function cascadeChildren(parentId: string, fallback: string[], rep: CascadeReport, seen: Set<string>): Promise<void> {
  // A child leaving later (final round pending) is reparented too: if its archive then fails it still has a live parent.
  const reparent = (c: db.Agent, rest: string[], parents = fallback) => {
    db.setParents(c.id, [...new Set([...rest, ...parents])]);
    db.addEvent(c.id, 'parents', { parents: db.parentsOf(db.getAgent(c.id)!), by: parentId, reason: 'parent archived' });
    for (const p of parents) {
      const text = `[stam] ${c.name} now reports to you: its parent was archived and ${c.name} is still ${c.activity}.`;
      if (!db.getAgent(p)) {
        // A fallback parent on another machine: its daemon queues the notice.
        tellAnywhere(p, text).catch(() => {});
        continue;
      }
      queueNotice(p, text, { idleOnly: true });
      syncChildrenWaits(p);
    }
  };
  const keep = (c: db.Agent, label: string, rest: string[]) => {
    reparent(c, rest);
    rep.kept.push(label);
  };
  for (const id of tree.childrenOf(parentId)) {
    const c = db.getAgent(id);
    if (!c || c.lifecycle === 'archived' || seen.has(c.id)) continue;
    seen.add(c.id);
    const rest = db.parentsOf(c).filter((p) => p !== parentId);
    // Another live parent keeps the child; only this parent is dropped.
    if (rest.some(parentLive)) {
      db.setParents(c.id, rest);
      db.addEvent(c.id, 'parents', { parents: rest, by: parentId, reason: 'parent archived' });
      rep.kept.push(`${c.name} (also reports to ${rest.map((p) => db.getAgent(p)?.name ?? p).join(', ')})`);
      continue;
    }
    // S-2452: a standing child is never archived with its parent. It moves to the new parents that can control it
    // here, or stays unarchived and is reported; its own children stay with it.
    if (c.standing) {
      const can = fallback.filter(canControl);
      const names = (ps: string[]) => ps.map((p) => db.getAgent(p)?.name ?? p).join(', ');
      if (can.length) {
        reparent(c, rest, can);
        rep.moved.push(`${c.name} to ${names(can)}`);
      } else {
        rep.stayed.push(`${c.name} (${fallback.length ? `${names(fallback)} can't control it on this machine` : 'no chief of staff or live parent to take it'})`);
      }
      continue;
    }
    // A resting child with no wait is as idle as an idle one (S-1982).
    const idle = c.lifecycle === 'shut_down' || ((c.lifecycle === 'active' || c.lifecycle === 'paused') && c.activity === 'idle') || (db.restOwned(c) && !db.isBusy(c));
    if (!idle) {
      keep(c, `${c.name} (${c.activity})`, rest);
      continue;
    }
    try {
      const r = await archive(c, false, false);
      if (r === 'done') rep.archived.push(c.name);
      else {
        reparent(c, rest);
        rep.archiving.push(c.name);
      }
      rep.ids.push(c.id);
    } catch (e) {
      rep.failed.push(`${c.name} (${e instanceof Error ? e.message : e})`);
      keep(c, `${c.name} (${c.activity}, archive failed)`, rest);
      continue;
    }
    await cascadeChildren(c.id, fallback, rep, seen);
  }
}

// S-1402: an archive that leaves without the agent's final round records why, as one
// `archive:round-skipped` event, so a missing round is never silent. Skipped when the agent
// already filed one, or when this run of the harness already recorded a reason (S-1618: a
// shutdown's precise reason isn't overwritten by the later archive's `shut_down`). An agent
// archived again after a resume gets a fresh event.
function noteRoundSkipped(a: db.Agent, reason: 'shut_down' | 'paused' | 'harness_gone' | 'deadline_no_round' | 'turn_ended_no_round'): void {
  if (db.hasEvent(a.id, 'retro_final')) return;
  if (db.hasEventSinceStart(a.id, 'archive:round-skipped')) return;
  db.addEvent(a.id, 'archive:round-skipped', { reason });
}

// The final-round window: how long an archive waits for the agent's next turn end.
function finalRoundMs(): number {
  return Math.max(0, settings().archive.finalRoundMinutes) * 60_000;
}

// Sends the archive's wrap-up and stores the pending archive with its deadline. Idle or not, the
// agent gets the same ask; the deadline bounds the wait (S-1043).
async function askFinalRound(a: db.Agent, opts: { force?: boolean; discard?: boolean; forceUnpushed?: boolean }): Promise<string> {
  if (a.lifecycle !== 'active' && a.lifecycle !== 'paused') throw new Error(`${a.name} is ${a.lifecycle}`);
  const at = Date.now() + finalRoundMs();
  const pending: Pending = { type: 'archive', ...opts, at, midTurn: !isIdle(a) };
  db.updateAgent(a.id, { pending_action: JSON.stringify(pending) });
  // A harness that can't take the prompt (blocked, gone, unknown) leaves the deadline to archive.
  if (opts.force) db.addEvent(a.id, 'archive:forced', { at });
  await prompt(a, archiveWrapUp()).catch(() => false);
  db.addEvent(a.id, 'pending', pending);
  return `waiting for ${a.name} to finish its step`;
}

// S-1043: archives whose final-round deadline has passed, even when their harness still runs a
// turn or can't be asked, so a pending archive can't wait forever. Called each reconcile tick.
// A failure is recorded and the pending is cleared (no retry loop); only a stop that couldn't be
// confirmed yet — a session that may still stop on its own — is put back, backing off.
export async function runDueArchives(now = Date.now(), agents: db.Agent[] = db.listPendingAgents()): Promise<void> {
  for (const a of agents) {
    const p = pendingStop(a);
    if (p?.type === 'shutdown') {
      // S-1402: a shutdown past its final-round deadline stops the harness whatever its turn does.
      if (typeof p.at === 'number' && p.at <= now) {
        // Re-read: the pending may have run or been replaced since the list was read.
        const fresh = db.getAgent(a.id);
        const cur = fresh && pendingStop(fresh);
        if (!fresh || cur?.type !== 'shutdown' || cur.at !== p.at) continue;
        db.updateAgent(a.id, { pending_action: null });
        db.addEvent(a.id, 'shutdown:final-round-timeout', { at: p.at });
        noteRoundSkipped(fresh, 'deadline_no_round');
        stopForGood(fresh, 'shut down');
      }
      continue;
    }
    if (p?.type !== 'archive') continue;
    // A pending archive from before the deadline existed gets one now, not archived on sight.
    if (p.at === undefined) {
      const cur = db.getAgent(a.id);
      if (cur && pendingStop(cur)?.type === 'archive') {
        db.updateAgent(a.id, { pending_action: JSON.stringify({ ...p, at: Date.now() + finalRoundMs() }) });
      }
      continue;
    }
    if (p.at > now) continue;
    const cur = db.getAgent(a.id);
    if (!cur || cur.lifecycle === 'archived') continue;
    // Re-read: the pending may have been replaced or cleared since the list was read.
    const fresh = pendingStop(cur);
    if (fresh?.type !== 'archive' || fresh.at !== p.at) continue;
    db.updateAgent(a.id, { pending_action: null });
    try {
      await archiveNow(cur, { force: fresh.force, discard: fresh.discard, forceUnpushed: fresh.forceUnpushed });
      db.addEvent(a.id, 'archive:final-round-timeout', { at: fresh.at });
      noteRoundSkipped(cur, 'deadline_no_round');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      db.addEvent(a.id, 'archive:failed', { at: fresh.at, tries: fresh.tries ?? 0, error: msg });
      const tries = (fresh.tries ?? 0) + 1;
      if (archiveRetryable(msg) && tries <= ARCHIVE_RETRY_TRIES) {
        const after = Math.min(ARCHIVE_RETRY_MS * 2 ** (tries - 1), ARCHIVE_RETRY_MAX_MS);
        db.updateAgent(a.id, { pending_action: JSON.stringify({ ...fresh, tries, at: Date.now() + after }) });
      } else {
        // A cleanup failure (a dirty worktree without discard) needs a person, not a retry loop.
        archiveFailedNotice(a, msg, 'at its final-round deadline');
      }
    }
  }
}

// A stop that couldn't be confirmed may still finish on its own; a failed cleanup won't.
// S-1393: an agent shut down for settings.archive.idleShutdownHours, that owns no open ITSA, is not
// standing, cos or the assistant, and whose worktree (if it has one) is clean with its head in
// origin/main, is archived through the normal path. A check that can't be made (git or the home
// failing) skips the agent, and each reason is logged once. Each daemon sweeps its own agents.
const idleSkipLogged = new Set<string>();
function idleSkip(a: db.Agent, why: string, debug = false): void {
  const key = `${a.id}:${why}`;
  if (idleSkipLogged.has(key)) return;
  idleSkipLogged.add(key);
  // S-908: a skip of the short-grace rule is expected and retried, so it logs only with STAM_DEBUG set.
  if (debug && !envVar('DEBUG')) return;
  console.error(`idle shut-down ${a.name}: not archived: ${why}`);
}

// When the agent went to shut_down: its last update. Every change to a row moves updated_at forward,
// so it is never earlier than the stop, and a stop after a resume is dated from that stop. Unrelated
// updates while shut down only delay the archive, so the grace period is never cut short.
function shutDownSince(a: db.Agent): number {
  return Date.parse(a.updated_at);
}

// The worktree is clean and its HEAD is contained in origin/main (so a branch with no commits of
// its own passes too). Throws when git can't say.
const execFileP = promisify(execFile);
async function worktreeMerged(path: string, repo: string): Promise<boolean> {
  const git = async (dir: string, ...args: string[]) => (await execFileP('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 10_000 })).stdout.trim();
  if (await git(path, 'status', '--porcelain')) return false;
  const head = await git(path, 'rev-parse', 'HEAD');
  try {
    await execFileP('git', ['-C', repo, 'merge-base', '--is-ancestor', head, 'origin/main'], { timeout: 10_000 });
    return true;
  } catch (e) {
    // Exit 1 is "not an ancestor"; anything else (no origin/main, a missing repo) is a failed check.
    if ((e as { code?: unknown }).code === 1) return false;
    throw new Error(`git merge-base: ${(e as { stderr?: string }).stderr?.trim() || (e instanceof Error ? e.message : e)}`);
  }
}

// S-1393: the agents found ineligible, with the updated_at they had and when they were checked. An
// entry skips its agent until the row changes or an hour passes, so an unmerged or dirty branch is
// checked again (its PR may merge later, with no change to the row).
const idleIneligible = new Map<string, { updated_at: string; at: number }>();
const IDLE_RECHECK_MS = 3_600_000;
// Git and home checks per pass, at most: the rest wait for the next pass.
export const IDLE_CHECKS_PER_PASS = 10;

// S-908: the ITSA statuses of work approved and queued for merge, or merged and deploying. The
// manager sets them only after the PR's review approved, so they stand for "approved and queued".
const QUEUED_STATUSES = new Set(['ready_to_merge', 'merging', 'deploying']);

// Clean, and every commit reachable from the worktree's HEAD is on some remote: archive()'s guard checks
// the workspace's branch ref, so a detached HEAD or another branch would slip past it. Throws on a git error.
const gitCleanAndPushed = async (path: string): Promise<boolean> => {
  const git = async (...args: string[]) => (await execFileP('git', ['-C', path, ...args], { encoding: 'utf8', timeout: 10_000 })).stdout.trim();
  return !(await git('status', '--porcelain')) && !(await git('rev-list', 'HEAD', '--not', '--remotes'));
};

// Whether nothing is owed to or from a shut-down agent right now: not resting or paused (only
// shut_down passes), no open wait, no unread mail, no pending action or queued notice, no hold.
// The agent's waits, less (with `staleBefore`) the ones a stale permission request put there: its ask wait
// stays until the request is settled, so it would keep the agent for good.
function openWaits(a: db.Agent, staleBefore?: string): db.Wait[] {
  const waits = db.listWaits(a.id);
  if (!staleBefore || !waits.length) return waits;
  const stale = new Set(db.stalePendingPermissions(a.id, staleBefore).map((r) => r.id));
  // The same waits clearRequestWaits deletes: the stam wait on the request, and the agent's wait_for on the human tied to it (S-3016).
  return waits.filter((w) => !((w.source === 'stam' && ((w.target && stale.has(w.target)) || (w.data && stale.has(w.data)))) || (w.kind === 'human' && w.target && stale.has(w.target))));
}

// S-2885: `staleBefore` (the 12 h rule only) lets a permission request created at or before it stand aside:
// a request stuck that long will not be answered, and must not keep the agent for good.
function shutDownQuiet(a: db.Agent, staleBefore?: string): boolean {
  return a.lifecycle === 'shut_down' && !a.pending_action && !openWaits(a, staleBefore).length && db.unreadCount(a.id) === 0 && !db.hasPendingPermission(a.id, staleBefore) && wakeableNoticeCount(a.id) === 0 && heldBy(a) === null;
}

export async function archiveIdleShutdowns(now = Date.now()): Promise<string[]> {
  const { idleShutdownHours, archiveWhenQueued, queuedShutdownMinutes } = settings().archive;
  const cosName = settings().chiefOfStaff;
  const cosId = cosName ? db.getAgent(cosName)?.id : undefined;
  const archived: string[] = [];
  let checks = 0;
  for (const a of db.listAgents()) {
    if (a.lifecycle !== 'shut_down' || a.pending_action) continue;
    const age = now - shutDownSince(a);
    // After the idle hours, the S-1393 rule; after the short grace, the S-908 rule (merged, or approved and queued).
    const idle = age > idleShutdownHours * 3_600_000;
    if (!idle && !(archiveWhenQueued && age > queuedShutdownMinutes * 60_000)) continue;
    if (a.standing || a.kind === 'assistant' || a.id === cosId) continue;
    const seen = idleIneligible.get(a.id);
    if (seen && seen.updated_at === a.updated_at && now - seen.at < IDLE_RECHECK_MS) continue;
    // A local check, free of git and the home, so it costs no slot of the pass.
    const staleBefore = idle ? new Date(now - idleShutdownHours * 3_600_000).toISOString() : undefined;
    if (!shutDownQuiet(a, staleBefore)) continue;
    if (checks >= IDLE_CHECKS_PER_PASS) break;
    checks++;
    const owned = await openOwnedItsas(a.id);
    if (!owned) {
      idleSkip(a, "the home couldn't say which ITSAs it owns", !idle);
      continue;
    }
    // Under the idle hours an owned ITSA must be queued for merge or later; after them, none may be open.
    // The short grace also needs at least one queued ITSA: an agent that owns none (a reviewer, or a
    // developer that hasn't committed yet) waits the idle hours.
    if (idle ? owned.length : !owned.length || !owned.every((x) => QUEUED_STATUSES.has(x.status))) {
      idleIneligible.set(a.id, { updated_at: a.updated_at, at: now });
      continue;
    }
    const ws: Workspace | null = a.workspace ? JSON.parse(a.workspace) : null;
    // The short grace is for developers with a branch; an agent without a worktree waits the idle hours.
    if (!idle && !ws?.worktree) {
      idleIneligible.set(a.id, { updated_at: a.updated_at, at: now });
      continue;
    }
    if (ws?.worktree) {
      try {
        // Merged into origin/main, or (queued only) clean with an owned queued ITSA; archive()'s
        // unpushed guard then refuses a branch whose head isn't on a remote.
        const ok = (await worktreeMerged(ws.worktree.path, ws.worktree.repo)) || (!idle && (await gitCleanAndPushed(ws.worktree.path)));
        if (!ok) {
          idleIneligible.set(a.id, { updated_at: a.updated_at, at: now });
          continue;
        }
      } catch (e) {
        idleSkip(a, `couldn't check its worktree: ${e instanceof Error ? e.message : e}`, !idle);
        idleIneligible.set(a.id, { updated_at: a.updated_at, at: now });
        continue;
      }
    }
    // Re-read from the row the checks started from: a resume, a mail, a wait or any other change in
    // between moves updated_at or fails the quiet test, and the agent is left for the next pass.
    // archive() then runs with no await before it takes the archive lock, so nothing slips in.
    const cur = db.getAgent(a.id);
    if (!cur || cur.updated_at !== a.updated_at || !shutDownQuiet(cur, staleBefore)) continue;
    try {
      await archive(cur);
      db.addEvent(a.id, 'archive:idle-shutdown', idle ? { hours: idleShutdownHours, rule: 'idle' } : { minutes: queuedShutdownMinutes, rule: 'queued' });
      archived.push(a.name);
      // The agent is archived by now: a failure here only leaves a stale request, never undoes the archive.
      if (staleBefore) {
        try {
          withdrawStaleRequests(cur, staleBefore, `the agent was archived after ${idleShutdownHours} h shut down`);
        } catch (e) {
          console.error(`idle shut-down ${a.name}: couldn't withdraw its stale permission requests: ${e instanceof Error ? e.message : e}`);
        }
      }
      if (!idle) {
        const parent = db.parentsOf(cur)[0];
        if (parent) tellAnywhere(parent, `${cur.name} was archived automatically: shut down, its work merged or queued for merge, and its branch pushed.`).catch(() => {});
      }
    } catch (e) {
      // A refusal (the unpushed guard) is checked again in an hour, or when the row changes.
      idleIneligible.set(a.id, { updated_at: a.updated_at, at: now });
      idleSkip(a, `archive failed: ${e instanceof Error ? e.message : e}`, !idle);
    }
  }
  return archived;
}

function archiveRetryable(msg: string): boolean {
  return /its session still runs|it was started again while archiving/.test(msg);
}
const ARCHIVE_RETRY_MS = 30_000;
const ARCHIVE_RETRY_MAX_MS = 10 * 60_000;
const ARCHIVE_RETRY_TRIES = 5;

async function archiveNow(a: db.Agent, opts: { force?: boolean; discard?: boolean; forceUnpushed?: boolean } = {}): Promise<void> {
  const release = acquire(a, 'archive');
  try {
    return await archiveLocked(a, opts);
  } finally {
    release();
  }
}

async function archiveLocked(a: db.Agent, opts: { force?: boolean; discard?: boolean; forceUnpushed?: boolean }): Promise<void> {
  // S-1043: a second caller (the deadline sweep and the dead-harness path) that lost the race
  // must not archive an agent twice.
  if (db.getAgent(a.id)?.lifecycle === 'archived') return;
  // S-2201: the backstop for the paths that reach here without archive() (a pending archive at a turn end
  // or deadline). Before the harness is stopped, so a refusal leaves the agent running, not half-archived.
  if (!opts.forceUnpushed) {
    try {
      unpushedGuard(a);
    } catch (e) {
      db.updateAgent(a.id, { activity_detail: `archive failed: ${e instanceof Error ? e.message : e}` });
      throw e;
    }
  }
  // A launch in flight for this agent must not revive it once the archive is under way (S-578).
  invalidateLaunch(a.id);
  if (tmux.hasSession(a.id)) quitHarness(a, 'archiving');
  else {
    // Shut down earlier, it may still have left processes behind (S-323).
    tmux.killSession(a.id);
    stopTurn(a);
  }
  // The session must be confirmed stopped before anything is cleaned up or released.
  await awaitTurnStop(a).catch((e) => {
    throw new Error(`can't archive ${a.name}: its session still runs (${e instanceof Error ? e.message : e}); archive again once it stops`);
  });
  if (tmux.hasSession(a.id)) throw new Error(`can't archive ${a.name}: it was started again while archiving`);
  const ws: Workspace | null = a.workspace ? JSON.parse(a.workspace) : null;
  // `ws` describes the working directory: what archive may clean up (a worktree). An agent's
  // personal workspace (a.personal_workspace, S-894) is a separate folder and is never touched
  // here — it outlives the archive so a respawned specialist adopts it.
  let result = 'nothing to clean up';
  // A worktree another agent still works in (a cost_switch successor, or the paused
  // predecessor it took over from) stays; the last of them to be archived removes it.
  const sharer = ws?.worktree ? worktreeUsers(ws.worktree.path, a.id)[0] : undefined;
  // What the agent left running in its worktree (a test daemon, a fake harness) goes before the
  // worktree does (S-428); with a sharer it stays, as the worktree does.
  if (ws?.worktree && !sharer) await stopAndConfirm(dirProcesses(ws.worktree.path, a.id)).catch((e) => console.error(`archive ${a.name}: ${e.message}`));
  try {
    if (sharer) result = `kept worktree ${ws!.worktree!.path}: ${sharer.name} still uses it`;
    else if (ws) result = cleanupWorkspace(ws, Boolean(opts.discard), Boolean(opts.forceUnpushed), branchIsBase(ws, db.listAgents().filter((b) => b.id !== a.id && b.lifecycle !== 'archived').map((b) => b.workspace)));
  } catch (e) {
    db.updateAgent(a.id, { activity_detail: `archive failed: ${e instanceof Error ? e.message : e}` });
    const msg = e instanceof Error ? e.message : String(e);
    // S-2201: the unpushed-commits refusal names its own way out; the dirty-tree hint would mislead.
    throw new Error(`can't archive ${a.name}: ${msg}${/ is pushed|not on any remote/.test(msg) ? '' : '. Commit or discard its changes (archive with discard, or force).'}`);
  }
  // The pending unown is written with the lifecycle change, so a crash before it is sent
  // can't lose it; startup and a timer retry it.
  const d = db.open();
  d.exec('BEGIN');
  try {
    db.updateAgent(a.id, { lifecycle: 'archived', activity: 'unknown', activity_detail: result, pending_action: null, paused_by: withoutRest(a) });
    forgetAgentNotices(a.id);
    forgetLessons(a.id);
    restForget(a.id);
    // An archived grantee loses the workspaces shared with it; an archived owner's grants stay (S-896).
    db.open().prepare('DELETE FROM workspace_grants WHERE grantee_id = ?').run(a.id);
  // An archived successor no longer holds the agent it took over from: that one gets its
  // own mail again and may be resumed.
  for (const p of db.listAgents().filter((b) => b.forwarded_to === a.id)) {
    db.updateAgent(p.id, { forwarded_to: null });
    db.open().prepare("DELETE FROM blockers WHERE agent_id = ? AND kind = 'taken-over'").run(p.id);
    db.addEvent(p.id, 'cost:switch', { step: 'released', successor: a.name });
  }
    // An archived agent runs nothing; its cost blockers would only linger on the Usage page.
    db.deleteBlockers(a.id);
    db.addEvent(a.id, 'archive', { result });
    queueUnown(a, 'archived');
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  withdrawPendingInputs(a, 'the agent was archived');
  // The agent's Claude Code scratch dir under /tmp/claude-<uid>, once the archive has gone through (S-604).
  if (a.harness === 'claude') {
    const msg = removeClaudeScratch(a.cwd, db.listAgents().filter((b) => b.id !== a.id && b.lifecycle !== 'archived').map((b) => b.cwd));
    if (msg !== 'no scratch dir') console.error(`archive ${a.name}: ${msg}`);
  }
  // The worktrees and scratch clones the agent made under ~/.cache/stam-wt and ~/.cache/stam-test (S-733).
  {
    const live = db.listAgents().filter((b) => b.id !== a.id && b.lifecycle !== 'archived');
    const dirs = live.flatMap((b) => {
      const w: Workspace | null = b.workspace ? JSON.parse(b.workspace) : null;
      return [b.cwd, w?.cwd, w?.worktree?.path].filter((p): p is string => Boolean(p));
    });
    for (const m of await removeAgentScratchDirs(a, dirs)) console.error(`archive ${a.name}: ${m}`);
  }
  // A reviewer's clone under ~/.cache/stam-review/<name> (S-912).
  if (a.type && isReviewerType(a.type)) {
    const live = db.listAgents().filter((b) => b.id !== a.id && b.lifecycle !== 'archived');
    const dirs = live.flatMap((b) => {
      const w: Workspace | null = b.workspace ? JSON.parse(b.workspace) : null;
      return [b.cwd, w?.cwd, w?.worktree?.path].filter((p): p is string => Boolean(p));
    });
    console.error(`archive ${a.name}: ${await removeReviewDir(a, dirs)}`);
    console.error(`archive ${a.name}: ${await removeReviewTmpDir(a, dirs)}`);
  }
  await unownAgent(a, 'archived').catch((e) => console.error(`ITSA owners: couldn't unown ${a.name}'s ITSAs: ${e.message}`));
}

// The agents other than `except`, not archived, that work in the worktree at `path`: their
// cwd or workspace is the worktree or inside it, compared as canonical paths.
export function worktreeUsers(path: string, except?: string): db.Agent[] {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const root = real(path);
  const inside = (p: string) => {
    const r = real(p);
    return r === root || r.startsWith(root + sep);
  };
  return db.listAgents().filter((b) => {
    if (b.id === except || b.lifecycle === 'archived') return false;
    const w: Workspace | null = b.workspace ? JSON.parse(b.workspace) : null;
    return [b.cwd, w?.cwd, w?.worktree?.path].some((p) => p && inside(p));
  });
}

// Brings a shut-down or archived agent back with its conversation.
// `locked`: the caller holds the agent's lock already (a switch's rollback), so resume doesn't take it.
export async function resume(a: db.Agent, note = '', opts: { locked?: boolean } = {}): Promise<string> {
  if (opts.locked) return resumeLocked(a, note);
  const release = acquire(a, 'resume');
  try {
    return await resumeLocked(a, note);
  } finally {
    release();
  }
}

async function resumeLocked(a: db.Agent, note: string): Promise<string> {
  assertNotTakenOver(a);
  if (a.lifecycle !== 'shut_down' && a.lifecycle !== 'archived') throw new Error(`${a.name} is ${a.lifecycle}`);
  if (!a.session_id) throw new Error(`${a.name} has no session to resume`);
  let superseded = false;
  if (a.lifecycle === 'archived') {
    const ws: Workspace | null = a.workspace ? JSON.parse(a.workspace) : null;
    if (!existsSync(a.cwd)) {
      const cwd = ws?.worktree?.repo ?? join(agentDir(a.id), 'work');
      mkdirSync(cwd, { recursive: true });
      db.updateAgent(a.id, { cwd });
    }
    const b = db.getAgent(a.id)!;
    await restoreTranscript(b.id, b.transcript_path);
    ({ superseded = false } = await startHarness(b, render('respawn-archived', { cleanup: a.activity_detail ?? 'workspace removed', cwd: b.cwd, note }), true));
  } else {
    await restoreTranscript(a.id, a.transcript_path);
    ({ superseded = false } = await startHarness(a, render('respawn', { cwd: a.cwd, note }), true));
  }
  // Active again, it keeps its ITSAs: a pending unown from its archive is void. Only once the
  // launch succeeded; after a failed one the agent is still archived and the unown must go on,
  // and a launch superseded by an archive is no launch at all.
  if (!superseded) dropPendingUnown(a.id);
  return 'resuming';
}

// Upgrades a harness, then restarts each of its running agents when its turn ends,
// resuming the conversation and telling the agent what changed.
export async function upgradeHarness(name: string, command?: string): Promise<{ from: string; to: string; output: string; agents: string[] }> {
  const adapter = adapters[name];
  if (!adapter) throw new Error(`unknown harness ${name}`);
  const from = adapter.version();
  const r = spawnSync('sh', ['-c', command ?? adapter.upgradeCommand], { encoding: 'utf8', timeout: 600_000 });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (r.status !== 0) throw new Error(`upgrade failed: ${output.slice(-500)}`);
  const to = adapter.version();
  await adapter.afterUpgrade?.();
  const reason = render('harness-upgraded', { harness: name, from, to });
  const agents: string[] = [];
  for (const a of db.listAgents()) {
    if (a.harness !== name || (a.lifecycle !== 'active' && a.lifecycle !== 'paused')) continue;
    await restart(a, reason).catch((e) => db.addEvent(a.id, 'upgrade-error', String(e)));
    agents.push(a.name);
  }
  return { from, to, output, agents };
}

export async function restart(a: db.Agent, reason: string, permission?: SwitchUndo): Promise<string> {
  const pending: Pending = { type: 'restart', reason, ...(permission ? { permission } : {}) };
  const cur = db.getAgent(a.id) ?? a;
  const p: Pending | null = cur.pending_action ? JSON.parse(cur.pending_action) : null;
  // A restart asked for while a handoff restart waits joins it: no second ask, the same deadline.
  if ((p?.type === 'restart' && p.handoff) || (p?.type === 'compact' && p.restart)) {
    const was = p.type === 'restart' ? p : p.restart!;
    const merged: RestartPending = { reason: was.reason.split('; ').includes(reason) ? was.reason : `${was.reason}; ${reason}`, ...(permission ?? was.permission ? { permission: permission ?? was.permission } : {}) };
    const next: Pending = p.type === 'restart' ? { ...p, ...merged } : { ...p, restart: merged };
    db.updateAgent(a.id, { pending_action: JSON.stringify(next) });
    db.addEvent(a.id, 'restart:merged', { reason });
    return `waiting for ${a.name} to finish its step`;
  }
  if (handoffWanted(cur)) return askHandoff(cur, { ...pending, handoff: true });
  return whenIdle(a, pending, render('restart-prepare', { reason }));
}

// S-2241: a restart throws the prompt cache away, and the agent re-reads its whole context
// uncached. A harness whose compaction relaunches it (Claude Code), running, not compacting,
// with its context over the compaction threshold, is first asked to hand off with compact_self
// while the cache is warm. Only restart() asks: never the idle or rest sweeps.
function handoffWanted(a: db.Agent): boolean {
  if (a.lifecycle !== 'active' && a.lifecycle !== 'paused') return false;
  if (!adapters[a.harness]?.compactQuits || db.restOwned(a) || compactionBusy(a.id)) return false;
  return overCompactionThreshold(a);
}

// The handoff window: as long as a cost switch gives an agent to wrap up.
function handoffMs(): number {
  return Math.max(0, settings().cost.softStopMinutes ?? 10) * 60_000;
}

// Asks for the handoff, idle or working, and stores the restart with its deadline. Fails open: an
// ask that can't be sent to an idle agent restarts it now, and runDueRestarts restarts an agent
// still idle at the deadline.
async function askHandoff(a: db.Agent, pending: Pending & { type: 'restart' }): Promise<string> {
  const minutes = handoffMs() / 60_000;
  const p: Pending = { ...pending, at: Date.now() + handoffMs() };
  db.updateAgent(a.id, { pending_action: JSON.stringify(p) });
  const text = `${render('restart-prepare', { reason: pending.reason })}\n\n${render('restart-handoff', { tokens: `${Math.round((a.context_tokens ?? 0) / 1000)}k`, minutes })}`;
  const sent = await prompt(a, text).catch(() => false);
  db.addEvent(a.id, 'restart:handoff', { reason: pending.reason, tokens: a.context_tokens, at: p.at, sent });
  const now = db.getAgent(a.id);
  if (!sent && now && isIdle(now) && now.pending_action === JSON.stringify(p)) return (await runPending(now, p)) || 'done';
  return `waiting for ${a.name} to hand off and finish its step`;
}

// Handoff restarts past their deadline whose agent is idle: the ask got no turn. A working agent
// restarts when its turn ends, as any restart does. Called each reconcile tick.
export async function runDueRestarts(now = Date.now(), agents: db.Agent[] = db.listPendingAgents()): Promise<void> {
  for (const a of agents) {
    const p: Pending | null = a.pending_action ? JSON.parse(a.pending_action) : null;
    if (p?.type !== 'restart' || !p.handoff || typeof p.at !== 'number' || p.at > now) continue;
    // Re-read: the pending may have run or been replaced since the list was read.
    const fresh = db.getAgent(a.id);
    if (!fresh || fresh.pending_action !== a.pending_action || !isIdle(fresh)) continue;
    db.addEvent(a.id, 'restart:handoff-timeout', { at: p.at });
    await runPending(fresh, p).catch((e) => db.addEvent(a.id, 'restart-error', String(e)));
  }
}

// --- Coming back after the tmux server went down (a reboot, or the server crashing) ---

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Between launches, so many harnesses don't start at once.
const STAGGER_MS = 3000;

// An active agent whose terminal went down with the tmux server. It is marked shut down
// with a pending recover action at once, so a daemon restart before recoverLost gets to
// it still resumes it. Without a session id there is no conversation to resume.
export function markLost(a: db.Agent, reason: string, opts: { compact?: boolean; tokens?: number; interrupted?: string } = {}): void {
  // A launch in flight must not revive an agent the lost server took down (S-578).
  invalidateLaunch(a.id);
  if (!a.session_id) {
    db.updateAgent(a.id, { lifecycle: 'shut_down', activity: 'unknown', activity_detail: `${reason}; not resumed: no session to resume`, pending_action: null });
    db.addEvent(a.id, 'tmux-lost', { reason, resume: false });
    return;
  }
  const pending: Pending = { type: 'recover', reason, ...(opts.compact ? { compact: true, tokens: opts.tokens } : {}), ...(opts.interrupted !== undefined ? { interrupted: opts.interrupted } : {}) };
  // S-273: a compaction-resume shows as compacting, not as the harness exiting.
  const detail = opts.compact ? 'compacting, then resuming' : `${reason}; resuming`;
  db.updateAgent(a.id, { lifecycle: 'shut_down', activity: 'unknown', activity_detail: detail, pending_action: JSON.stringify(pending) });
  db.addEvent(a.id, 'tmux-lost', { reason, resume: true });
}

const isLost = (a: db.Agent) => a.lifecycle === 'shut_down' && Boolean(a.pending_action) && JSON.parse(a.pending_action!).type === 'recover';

let recovering = false;

// S-220: an agent whose harness exits near its context limit is resumed once, with a note to run
// compact_self first. Tells its parent either way, and returns true when the agent is resumed.
// A second exit within repeatMinutes isn't resumed, so a context that keeps overflowing can't loop.
export function contextExit(a: db.Agent): boolean {
  const s = settings().exitRecovery;
  const tokens = a.context_tokens ?? 0;
  if (tokens < (s.windowTokens * s.percentOfWindow) / 100) return false;
  const since = new Date(Date.now() - s.repeatMinutes * 60_000).toISOString();
  const again = db.open().prepare(`SELECT 1 FROM events WHERE agent_id = ? AND type = 'exit:context' AND json_extract(data, '$.resumed') = 1 AND ts > ?`).get(a.id, since);
  const resume = !again && Boolean(a.session_id);
  db.addEvent(a.id, 'exit:context', { tokens, resumed: resume });
  // A resumed agent's parent hears the outcome from recoverOne, once the compaction has run.
  if (resume) markLost(a, 'harness exited', { compact: true, tokens });
  else {
    const parent = db.parentsOf(a)[0] ?? chiefOfStaff()?.id;
    if (parent) queueNotice(parent, `${a.name} exited at ${Math.round(tokens / 1000)}k context again; not resumed.`);
  }
  return resume;
}

// S-358: the compaction that ran when the daemon stopped. Which compactions run is kept in
// memory, so on the daemon's first reconcile an active agent whose harness is down and whose
// last launch or compaction event is a `compact` (not done, not failed, no relaunch after it)
// was being compacted, not exiting. Returns that compaction's operation id.
export function compactionInterrupted(a: db.Agent): string | null {
  const r = db
    .open()
    .prepare(`SELECT type, data FROM events WHERE agent_id = ? AND type IN ('compact', 'compact:done', 'compact:failed', 'spawn', 'resume', 'exited', 'tmux-lost') ORDER BY id DESC LIMIT 1`)
    .get(a.id) as { type: string; data: string | null } | undefined;
  if (r?.type !== 'compact') return null;
  return (r.data && JSON.parse(r.data).op) || '';
}

// S-358: such an agent is compacted headless and resumed, as after a context exit, but quietly: an
// idle compaction tells no one. Returns true when it was one, so the reconciler doesn't mark it exited.
export function compactionExit(a: db.Agent): boolean {
  // A compaction that keeps its harness up (Codex, OpenCode) isn't cut short by a restart.
  if (!adapters[a.harness]?.compactQuits) return false;
  const op = compactionInterrupted(a);
  if (op === null) return false;
  db.addEvent(a.id, 'exit:compaction', { tokens: a.context_tokens ?? 0, op });
  markLost(a, 'stam restarted during a compaction', { compact: true, tokens: a.context_tokens ?? 0, interrupted: op });
  return true;
}

// Resumes every agent marked by markLost, one at a time, once the network is up.
export async function recoverLost(): Promise<void> {
  if (recovering) return;
  recovering = true;
  try {
    for (let waited = false; ; ) {
      const lost = db.listAgents().filter(isLost);
      if (!lost.length) break;
      if (!waited) await waitForNetwork();
      waited = true;
      for (const a of lost) {
        await recoverOne(a.id);
        await sleep(STAGGER_MS);
      }
    }
  } finally {
    recovering = false;
  }
}

async function recoverOne(id: string): Promise<void> {
  // A human may have resumed or archived it meanwhile.
  const a = db.getAgent(id);
  if (!a || !isLost(a)) return;
  // S-358: the recover action stays set until the resume launches (startHarness clears it), so a
  // daemon restart meanwhile still recovers the agent; a failure clears it below.
  let intent = a.pending_action!;
  const p = JSON.parse(intent) as Extract<Pending, { type: 'recover' }>;
  const interrupted = p.interrupted !== undefined;
  // S-257: a context exit is compacted headless before the resume, when the adapter can compact.
  const compacting = Boolean(p.compact && adapterFor(a).compact);
  const parent = db.parentsOf(a)[0] ?? chiefOfStaff()?.id;
  const size = `${Math.round((p.tokens ?? 0) / 1000)}k`;
  let stage: 'compaction' | 'resume' = 'resume';
  try {
    if (!existsSync(a.cwd)) throw new Error(`its workspace ${a.cwd} is gone`);
    if (compacting) {
      stage = 'compaction';
      // S-358: a compactor a restart cut off from the daemon (an idle compaction's, or this recovery's
      // own before the restart) may still run on the session; it is stopped, and confirmed gone, before
      // this compaction starts, so there are never two.
      if (a.session_id) {
        const left = compactorProcesses(a.id, a.session_id, a.cwd);
        if (left.size) {
          db.addEvent(id, 'compact:killed', { pids: [...left.keys()] });
          await stopAndConfirm(left);
        }
        await adapterFor(a).repairSession?.(a);
      }
      await compactShutDown(a);
      stage = 'resume';
      // S-358: compacted; a restart before the resume below resumes without compacting again.
      const cur = db.getAgent(id);
      if (cur?.pending_action === intent) {
        const { compact: _done, ...rest } = p;
        intent = JSON.stringify({ ...rest, compacted: true });
        db.updateAgent(id, { pending_action: intent });
      }
    }
    // S-358: a human may have resumed, paused, or archived it while it compacted.
    const now = db.getAgent(id);
    if (!now || now.pending_action !== intent || !isLost(now)) {
      if (now?.pending_action === intent) db.updateAgent(id, { pending_action: null });
      db.addEvent(id, 'recover:cancelled', { lifecycle: now?.lifecycle });
      return;
    }
    // Only an adapter that compacts logs a compaction, so an interrupted one is compacting here.
    const compacted = compacting || Boolean(p.compacted);
    const note = interrupted
      ? render('respawn-compaction-restart', {})
      : compacted ? render('respawn-context-exit', {}) : p.compact ? renderWithRetro('respawn-context-exit-self', {}) : render('respawn-reboot', { reason: p.reason });
    await resume(db.getAgent(id)!, note);
    db.addEvent(id, 'recover', { reason: p.reason, ...(compacted ? { compacted: true } : {}) });
    if (parent && (p.compact || p.compacted) && !interrupted) queueNotice(parent, `${a.name} exited at ${size} context; ${compacted ? 'compacted and resumed' : 'resumed'}.`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const now = db.getAgent(id);
    db.updateAgent(id, { activity_detail: `${p.reason}; not resumed: ${msg}`, ...(now?.pending_action === intent ? { pending_action: null } : {}) });
    db.addEvent(id, 'recover-error', msg);
    if (parent && (p.compact || p.compacted)) {
      const failed = stage === 'compaction' ? `compaction failed: ${msg}; still shut down, run \`stam compact ${a.name}\` to retry` : `resume failed: ${msg}; still shut down`;
      queueNotice(parent, `${a.name} exited at ${size} context; ${failed}.`);
    }
  }
}

// At boot the daemon can start before the network is up. Waits up to ten minutes,
// then lets the launches try anyway.
async function waitForNetwork(): Promise<void> {
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    if (await networkUp()) return;
    await sleep(5000);
  }
}
