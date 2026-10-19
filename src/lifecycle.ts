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
import { STAM_URL, agentDir } from './config.ts';
import { mintAgentToken } from './agent-token.ts';
import * as db from './db.ts';
import * as tree from './tree.ts';
import * as tmux from './tmux.ts';
import { adapters } from './adapters/index.ts';
import { render, renderWithRetro, withRetroReminder } from './templates.ts';
import { cleanupWorkspace, type Workspace } from './workspace.ts';
import { markCompacted } from './context.ts';
import { compactorProcesses, dirProcesses, removeAgentScratchDirs, removeClaudeScratch, removeReviewDir, removeReviewTmpDir, reviewDirOf, reviewTmpForSpawn, stopAndConfirm } from './proctree.ts';
import { isReviewerType } from './agent-types.ts';
import { admit, heldBy, type TurnKind } from './admission.ts';
import { schedulePush, queueNotice, tellAnywhere, queuedNoticeCount, onRestWake, tellStopped } from './mail.ts';
import { failLaunch } from './test-hooks.ts';
import { registry } from './registry.ts';
import { settings } from './settings.ts';
import { chiefOfStaff, syncChildrenWaits } from './org.ts';
import * as itsa from './itsa.ts';

type Pending =
  // `at` (epoch ms, S-1402): the deadline for the final round a plain shutdown now asks for.
  // `midTurn` (S-1618): the wrap-up was pushed while the agent ran a step, so a harness that queues it
  // ends that step before the wrap-up turn starts. `waited`: that step's end already passed.
  | { type: 'shutdown'; at?: number; midTurn?: boolean; waited?: boolean }
  // `force` no longer skips the final-round wrap-up (S-1043): it means "don't wait for the
  // agent's current step", and still implies `discard` for older callers. `discard` removes
  // uncommitted worktree changes. `at` (epoch ms) is the deadline for the final round: past it,
  // the sweep archives regardless of the agent's turn. `tries` counts deadline retries.
  | { type: 'archive'; force?: boolean; discard?: boolean; at?: number; tries?: number; midTurn?: boolean; waited?: boolean }
  | { type: 'restart'; reason: string }
  | { type: 'compact'; instructions?: string; prompt?: string; reason: string }
  // Set on a shut-down agent whose terminal went down with the tmux server; see recoverLost.
  // `interrupted`: the operation id of a compaction a daemon restart cut short (S-358), not a context exit.
  // `compacted`: its compaction already ran, so only the resume is left.
  | { type: 'recover'; reason: string; compact?: boolean; tokens?: number; interrupted?: string; compacted?: boolean }
  // Reloads its MCP servers after a deploy changed stam's tools (tool-changes.ts).
  // `tries` failed so far; the next waits until `after` (ms since the epoch).
  | { type: 'reconnect-mcp'; tries?: number; after?: number };

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
  return launchSeq.get(id) === gen;
}
// Cancels any launch in flight for this agent, so one that resolves later does nothing.
export function invalidateLaunch(id: string): void {
  launchSeq.set(id, (launchSeq.get(id) ?? 0) + 1);
}

// Starts the harness in a new tmux session: a fresh launch, or a resume of the
// agent's conversation when `resume` is set. An agent that is held (isHeld) comes back
// paused, without the prompt, so a restart or resume never starts a turn it may not run.
// `kind` names the turn for the admission gate, which the adapter asks again right before
// it delivers the prompt: a blocker added during the launch keeps the prompt back, queued
// as a notice that goes in once the blockers clear. A deferred compaction stays pending
// across the launch and runs when the agent next goes idle. `launched` settles when the
// adapter's afterLaunch does: the prompt delivered (or kept back by the gate), or the error.
export async function startHarness(a: db.Agent, prompt: string | undefined, resume: boolean, kind: TurnKind = resume ? 'resume' : 'spawn'): Promise<{ launched: Promise<void>; superseded?: boolean }> {
  assertNotTakenOver(a);
  const gen = (launchSeq.get(a.id) ?? 0) + 1;
  launchSeq.set(a.id, gen);
  await releaseTurnStop(a);
  const adapter = adapterFor(a);
  const held = isHeld(a);
  if (held && prompt) {
    // Records the refusal when cost blockers are among what holds it.
    admit(a, kind);
    db.addEvent(a.id, 'launch-held', { owners: pauseOwners(a), blockers: db.blockerRows(a.id).map((b) => b.kind) });
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
  const reviewDir = a.type && isReviewerType(a.type) ? reviewDirOf(a.name) : null;
  const reviewTmp = reviewDir ? reviewTmpForSpawn(a.name, spec.env) : null;
  if (reviewTmp) mkdirSync(reviewTmp, { recursive: true });
  tmux.newSession(a.id, a.cwd, { ...spec.env, ...(reviewDir ? { STAM_REVIEW_DIR: reviewDir } : {}), ...(reviewTmp ? { STAM_TEST_TMPDIR: reviewTmp } : {}), STAM_AGENT_ID: a.id, STAM_URL, STAM_TOKEN: token }, spec.argv);
  if (!launchCurrent(a.id, gen)) {
    tmux.killSession(a.id);
    return { launched: Promise.resolve(), superseded: true };
  }
  // 'with prompt' keeps the agent 'starting' until its first turn begins, so it never looks idle in between.
  const pending = a.pending_action && JSON.parse(a.pending_action).type === 'compact' ? a.pending_action : null;
  db.updateAgent(a.id, { lifecycle: held ? 'paused' : 'active', activity: 'starting', activity_detail: prompt ? 'with prompt' : resume ? 'resuming' : null, pending_action: pending });
  db.addEvent(a.id, resume ? 'resume' : 'spawn', { argv: spec.argv, prompt: Boolean(prompt) });
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
  const launched = adapter.afterLaunch(db.getAgent(a.id)!, prompt, { resume, admit: prompt ? gate : undefined });
  // S-759: a spawn's first prompt is delivered (or was kept back as a notice) once afterLaunch
  // settles, so record that. A daemon restart mid-spawn leaves it 'starting' with no marker,
  // which the first reconcile pass re-delivers (recoverFirstPrompt).
  launched.then(() => {
    if (kind === 'spawn') db.addEvent(a.id, 'first-prompt:delivered');
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

function quitHarness(a: db.Agent, detail: string): void {
  invalidateLaunch(a.id);
  tmux.killSession(a.id);
  db.updateAgent(a.id, { lifecycle: 'shut_down', activity: 'unknown', activity_detail: detail, pending_action: null });
  db.addEvent(a.id, 'shutdown', { detail });
  stopTurn(a);
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

// A blocked agent isn't compacted: the compaction is a model turn. It stays pending and
// runs at the end of the agent's first turn after its blockers clear.
async function compactNow(a: db.Agent, p: { instructions?: string; prompt?: string; reason: string }): Promise<string | void> {
  const adapter = adapterFor(a);
  if (!adapter.compact) throw new Error(`${a.harness} agents can't be compacted by stam`);
  const ok = admit(a, 'compact');
  if (!ok.ok) {
    db.updateAgent(a.id, { pending_action: JSON.stringify({ type: 'compact', ...p }) });
    return `${a.name} is blocked (${ok.reason}); it compacts after it runs again`;
  }
  db.updateAgent(a.id, { activity: 'working', activity_detail: `compacting: ${p.reason}` });
  // The relaunch is inside the tracked run, so the agent counts as compacting until it is back.
  await trackCompaction(a.id, p, async (op) => {
    const { relaunch } = await adapter.compact!(a, p.instructions, { op });
    markCompacted(a.id);
    if (relaunch) await startHarness(db.getAgent(a.id)!, p.prompt, true, 'compact');
    else if (p.prompt) await prompt(a, p.prompt, 'compact');
  });
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
  return whenIdle(a, { type: 'compact', ...p }, '');
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
async function compactShutDown(a: db.Agent, instructions?: string): Promise<void> {
  if (!a.session_id) throw new Error(`${a.name} has no session to compact`);
  if (!adapterFor(a).compact) throw new Error(`${a.harness} agents can't be compacted by stam`);
  await trackCompaction(a.id, { reason: 'shut down', headless: true }, async (op) => {
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
  return (await adapterFor(a).pushPrompt(a, text).catch(() => false)) ?? false;
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

async function runPending(a: db.Agent, p: Pending): Promise<string | void> {
  db.updateAgent(a.id, { pending_action: null });
  if ((p.type === 'shutdown' || p.type === 'archive') && giveWrapUpTurn(a, p)) return `waiting for ${a.name} to finish its step`;
  if (p.type === 'shutdown') {
    // S-1618: the turn ended without `retro_final` after the round was asked for (askShutdownRound
    // sets `at` or `midTurn`); a shutdown that didn't ask, such as a paused agent's, records nothing.
    if (p.midTurn || p.at !== undefined) noteRoundSkipped(a, 'turn_ended_no_round');
    return quitHarness(a, 'shut down');
  }
  if (p.type === 'archive') {
    // The turn ended: the round was asked for in it; no `retro_final` means it wasn't filed.
    noteRoundSkipped(a, 'turn_ended_no_round');
    return archiveNow(a, { force: p.force, discard: p.discard });
  }
  if (p.type === 'compact') return compactNow(a, p);
  if (p.type === 'recover') return;
  if (p.type === 'restart') {
    quitHarness(a, `restarting: ${p.reason}`);
    await startHarness(db.getAgent(a.id)!, render('restarted', { reason: p.reason }), true, 'restart');
  }
}

// The agents whose MCP client one reconnect replaces, read now: those of the harness in a's
// MCP scope (OpenCode's shared server keeps one client per directory), or a alone.
function mcpSharers(a: db.Agent): db.Agent[] {
  const scope = adapters[a.harness]?.mcpScope;
  if (!scope) return [db.getAgent(a.id) ?? a];
  const key = scope(a);
  return db.listAgents().filter((b) => b.harness === a.harness && (b.lifecycle === 'active' || b.lifecycle === 'paused') && scope(b) === key);
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

// Pauses within serial(). A null owner is stam pausing for cost blockers (blockers.ts). The
// state is written before the agent is told, so a transition queued behind this one
// sees it.
export async function pauseNow(id: string, owner: string | null): Promise<string> {
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
    return resumeNow(a.id, render('unpause', {}));
  });
}

// Unpauses within serial(), once nothing holds the agent. `text` is what it is told. Mail
// and notices that waited while it was blocked go in after, as for any idle agent.
export async function resumeNow(id: string, text: string): Promise<string> {
  const release = acquire(db.getAgent(id)!, 'resume');
  try {
    return await resumeNowLocked(id, text);
  } finally {
    release();
  }
}

async function resumeNowLocked(id: string, text: string): Promise<string> {
  const a = db.getAgent(id)!;
  assertNotTakenOver(a);
  if (a.lifecycle !== 'paused') throw new Error(`${a.name} is ${a.lifecycle}`);
  const ok = admit(a, 'unpause');
  if (!ok.ok) throw new Error(`${a.name} stays paused: ${ok.reason}`);
  db.updateAgent(id, { paused_by: null });
  // Its terminal went down with the tmux server while it was paused: resume it.
  if (a.workspace && !tmux.hasSession(id)) {
    if (!a.session_id) throw new Error(`${a.name} has no session to resume`);
    await startHarness(db.getAgent(id)!, text, true, 'unpause');
    db.addEvent(id, 'unpause');
    schedulePush(id);
    return 'active';
  }
  db.updateAgent(id, { lifecycle: 'active' });
  db.addEvent(id, 'unpause');
  await prompt(a, text, 'unpause');
  schedulePush(id);
  return 'active';
}

// --- Resting standing agents (S-897) --------------------------------------------------------
// A standing agent idle past standing.idleHours rests: paused with the owner REST_OWNER and its
// harness stopped, as a shutdown does, so no turn is spent telling it. The conversation and the
// workspace stay; resumeNowLocked starts the harness again on a resume. Only REST_OWNER holds it:
// a human or agent pause, or a cost blocker, also keeps it down, and a wake never lifts those.
export const REST_OWNER = 'standing-idle';

export function isResting(a: db.Agent): boolean {
  const owners = pauseOwners(a);
  return a.standing === 1 && a.lifecycle === 'paused' && owners.length === 1 && owners[0] === REST_OWNER;
}

// STAM_STANDING_IDLE_HOURS overrides the setting (tests use a fraction).
function restAfterMs(): number {
  const env = Number(process.env.STAM_STANDING_IDLE_HOURS);
  return (env > 0 ? env : settings().standing.idleHours) * 3_600_000;
}

function restable(a: db.Agent): boolean {
  if (!a.standing || a.lifecycle !== 'active' || (a.activity !== 'idle' && a.activity !== 'waiting') || !a.idle_since || !a.workspace || !a.session_id) return false;
  if (Date.now() - Date.parse(a.idle_since) < restAfterMs()) return false;
  if (a.pending_action || a.forwarded_to || transitions.has(a.id) || compactionRunning(a.id)) return false;
  // An open wake_me or wait_for keeps the activity 'waiting': its firing or answer is a notice or mail that wakes it. A wait the harness holds (a hook's) would die with the harness.
  if (db.listWaits(a.id).some((w) => w.source !== 'declared' && w.source !== 'stam')) return false;
  // Mail or a notice that hasn't reached it yet means it has work.
  return !db.hasPendingPermission(a.id) && db.unpushedCount(a.id) === 0 && queuedNoticeCount(a.id) === 0 && heldBy(a) === null;
}

// Rests every standing agent that has been idle long enough. Called every minute.
export function restSweep(): void {
  for (const a of db.listAgents()) if (restable(a)) rest(a.id).catch((e) => db.addEvent(a.id, 'standing:rest-error', String(e)));
}

export function rest(id: string): Promise<string> {
  return serial(id, async () => {
    const a = db.getAgent(id);
    if (!a || !restable(a)) return 'not resting';
    db.updateAgent(id, { lifecycle: 'paused', paused_by: JSON.stringify([REST_OWNER]), activity: 'unknown', activity_detail: 'resting: standing agent idle; unpause to resume', pending_action: null });
    db.addEvent(id, 'standing:rest', { idleSince: a.idle_since });
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
export function wakeResting(id: string, why: string, timed = false): Promise<string> {
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
      const r = await resumeNow(id, render('standing-wake', { why, cwd: a.cwd }));
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
        tellStopped(a, `${a.name} was woken but its wake prompt failed: ${e instanceof Error ? e.message : String(e)}. It is running; send it mail.`);
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

export function shutdown(a: db.Agent, now = false): Promise<string> {
  if (now) {
    quitHarness(a, 'shut down');
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
  if (p.type === 'archive') return archiveNow(db.getAgent(a.id)!, { force: p.force, discard: p.discard });
  quitHarness(db.getAgent(a.id)!, 'shut down');
}

// S-578: whether an agent has sat in 'starting' past settings.startingTimeoutMinutes with no
// live tmux pane. The caller checks harnessTurnAlive too, since a harness can outlive its pane.
export function startingStuck(a: db.Agent, paneAlive: boolean, now = Date.now()): boolean {
  if (a.activity !== 'starting' || paneAlive) return false;
  const since = Date.parse(a.created_at);
  return Number.isFinite(since) && now - since >= settings().startingTimeoutMinutes * 60_000;
}

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
  await runPendingOnDead(db.getAgent(now.id)!);
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
export async function archive(a: db.Agent, force = false, discard = force): Promise<string> {
  if (a.lifecycle === 'archived') throw new Error(`${a.name} is already archived`);
  assertNoTransition(a);
  // A stopped or paused agent can't take the wrap-up: archive it at once (S-1043 review). A paused
  // agent isn't running a step, so nothing is interrupted.
  if (a.lifecycle === 'shut_down' || a.lifecycle === 'paused') {
    noteRoundSkipped(a, a.lifecycle);
    await archiveNow(a, { force, discard });
    return 'done';
  }
  // A workspaced agent whose harness is gone (no live pane, and the harness answered that no turn
  // runs) has no step to wait for either, unless it is still starting: a launch may not have
  // created its session yet, so reconcile handles that case at the starting timeout (S-578).
  if (a.workspace && a.activity !== 'starting') {
    const alive = await harnessAlive(a);
    if (alive === false) {
      noteRoundSkipped(a, 'harness_gone');
      await archiveNow(a, { force, discard });
      return 'done';
    }
  }
  // Everything else asks for the final round: the wrap-up goes in now (queued by a working agent),
  // and the pending archive runs at the agent's next turn end or at its deadline. An agent whose
  // turn state can't be told (S-578) gets the deadline too, so it never waits forever.
  return askFinalRound(a, { force, discard });
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
  // Ids of the children archived or asked for their final round, so the cascade can follow their own children (S-1378).
  ids: string[];
}

// `remote` asks the other machines to run the cascade over the children they hold of this agent
// (S-1378): a child lives in the DB of the machine it runs on, with its parent's id only.
export type RemoteCascade = (parents: string[], fallback: string[]) => Promise<{ machine: string; report?: CascadeReport; error?: string }[]>;

export async function archiveCascade(a: db.Agent, force = false, discard = force, remote?: RemoteCascade): Promise<string> {
  const base = await archive(a, force, discard);
  const live = db.parentsOf(a).filter((p) => db.getAgent(p)?.lifecycle !== 'archived');
  const fallback = live.length ? live : [chiefOfStaff()?.id].filter((p): p is string => Boolean(p) && p !== a.id);
  const rep: CascadeReport = { archived: [], archiving: [], kept: [], failed: [], ids: [] };
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
        for (const k of ['archived', 'archiving', 'kept', 'failed'] as const) rep[k].push(...r.report[k].map((x) => `${x} on ${r.machine}`));
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
  if (rep.failed.length) notes.push(`couldn't archive ${rep.failed.join(', ')}`);
  return notes.length ? `${base}; ${notes.join('; ')}` : base;
}

// What a peer runs for POST /api/archive-children: the cascade over the children this machine
// holds of each parent id. A parent that is a live agent here is skipped: its own children were
// cascaded when it was archived.
export async function cascadeForPeer(parents: string[], fallback: string[]): Promise<CascadeReport> {
  const rep: CascadeReport = { archived: [], archiving: [], kept: [], failed: [], ids: [] };
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

export async function cascadeChildren(parentId: string, fallback: string[], rep: CascadeReport, seen: Set<string>): Promise<void> {
  // A child leaving later (final round pending) is reparented too: if its archive then fails it still has a live parent.
  const reparent = (c: db.Agent, rest: string[]) => {
    db.setParents(c.id, [...new Set([...rest, ...fallback])]);
    db.addEvent(c.id, 'parents', { parents: db.parentsOf(db.getAgent(c.id)!), by: parentId, reason: 'parent archived' });
    for (const p of fallback) {
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
    const idle = c.lifecycle === 'shut_down' || ((c.lifecycle === 'active' || c.lifecycle === 'paused') && c.activity === 'idle');
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
async function askFinalRound(a: db.Agent, opts: { force?: boolean; discard?: boolean }): Promise<string> {
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
export async function runDueArchives(now = Date.now(), agents: db.Agent[] = db.listAgents()): Promise<void> {
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
        quitHarness(fresh, 'shut down');
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
      await archiveNow(cur, { force: fresh.force, discard: fresh.discard });
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
        db.updateAgent(a.id, { activity_detail: `archive failed: ${msg}` });
        // Nobody else sees a deadline failure: tell its parent, else the chief of staff.
        // A parent may live on another machine: tellAnywhere reaches its daemon.
        const who = db.parentsOf(a).filter((x) => { const o = db.getAgent(x); return !o || o.lifecycle === 'active'; });
        const text = `[stam] The archive of ${a.name} failed at its final-round deadline: ${msg}. It is still ${a.lifecycle}.`;
        // A parent that is forgotten or on a machine that is down can't be told: then the chief of staff is.
        const cos = chiefOfStaff()?.id;
        Promise.all(who.map((x) => tellAnywhere(x, text).catch(() => 'unreachable' as const))).then((r) => {
          if (cos && !r.includes('told')) return tellAnywhere(cos, text);
        }).catch(() => {});
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
function idleSkip(a: db.Agent, why: string): void {
  const key = `${a.id}:${why}`;
  if (idleSkipLogged.has(key)) return;
  idleSkipLogged.add(key);
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

export async function archiveIdleShutdowns(now = Date.now()): Promise<string[]> {
  const { idleShutdownHours } = settings().archive;
  const cosName = settings().chiefOfStaff;
  const cosId = cosName ? db.getAgent(cosName)?.id : undefined;
  const archived: string[] = [];
  let checks = 0;
  for (const a of db.listAgents()) {
    if (a.lifecycle !== 'shut_down' || a.pending_action) continue;
    if (now - shutDownSince(a) <= idleShutdownHours * 3_600_000) continue;
    if (a.standing || a.kind === 'assistant' || a.id === cosId) continue;
    const seen = idleIneligible.get(a.id);
    if (seen && seen.updated_at === a.updated_at && now - seen.at < IDLE_RECHECK_MS) continue;
    if (checks >= IDLE_CHECKS_PER_PASS) break;
    checks++;
    const owned = await openOwnedItsas(a.id);
    if (!owned) {
      idleSkip(a, "the home couldn't say which ITSAs it owns");
      continue;
    }
    if (owned.length) {
      idleIneligible.set(a.id, { updated_at: a.updated_at, at: now });
      continue;
    }
    const ws: Workspace | null = a.workspace ? JSON.parse(a.workspace) : null;
    if (ws?.worktree) {
      try {
        if (!(await worktreeMerged(ws.worktree.path, ws.worktree.repo))) {
          idleIneligible.set(a.id, { updated_at: a.updated_at, at: now });
          continue;
        }
      } catch (e) {
        idleSkip(a, `couldn't check its worktree: ${e instanceof Error ? e.message : e}`);
        idleIneligible.set(a.id, { updated_at: a.updated_at, at: now });
        continue;
      }
    }
    // Re-read: the agent may have changed while the ITSA home was asked.
    const cur = db.getAgent(a.id);
    if (!cur || cur.lifecycle !== 'shut_down') continue;
    try {
      db.addEvent(a.id, 'archive:idle-shutdown', { hours: idleShutdownHours });
      await archive(cur);
      archived.push(a.name);
    } catch (e) {
      idleSkip(a, `archive failed: ${e instanceof Error ? e.message : e}`);
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

async function archiveNow(a: db.Agent, opts: { force?: boolean; discard?: boolean } = {}): Promise<void> {
  const release = acquire(a, 'archive');
  try {
    return await archiveLocked(a, opts);
  } finally {
    release();
  }
}

async function archiveLocked(a: db.Agent, opts: { force?: boolean; discard?: boolean }): Promise<void> {
  // S-1043: a second caller (the deadline sweep and the dead-harness path) that lost the race
  // must not archive an agent twice.
  if (db.getAgent(a.id)?.lifecycle === 'archived') return;
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
    else if (ws) result = cleanupWorkspace(ws, Boolean(opts.discard));
  } catch (e) {
    db.updateAgent(a.id, { activity_detail: `archive failed: ${e instanceof Error ? e.message : e}` });
    throw new Error(`can't archive ${a.name}: ${e instanceof Error ? e.message : e}. Commit or discard its changes (archive with discard, or force).`);
  }
  // The pending unown is written with the lifecycle change, so a crash before it is sent
  // can't lose it; startup and a timer retry it.
  const d = db.open();
  d.exec('BEGIN');
  try {
    db.updateAgent(a.id, { lifecycle: 'archived', activity: 'unknown', activity_detail: result, pending_action: null });
    forgetLessons(a.id);
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
  // The agent's Claude Code scratch dir under /tmp/claude-<uid>, once the archive has gone through (S-604).
  if (a.harness === 'claude') {
    const msg = removeClaudeScratch(a.cwd, db.listAgents().filter((b) => b.id !== a.id && b.lifecycle !== 'archived').map((b) => b.cwd), settings().itsa?.repos?.stam2);
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
    ({ superseded = false } = await startHarness(b, render('respawn-archived', { cleanup: a.activity_detail ?? 'workspace removed', cwd: b.cwd, note }), true));
  } else {
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

export function restart(a: db.Agent, reason: string): Promise<string> {
  return whenIdle(a, { type: 'restart', reason }, render('restart-prepare', { reason }));
}

// --- Coming back after the tmux server went down (a reboot, or the server crashing) ---

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Between launches, so many harnesses don't start at once.
const STAGGER_MS = 3000;
// Any answer from one of these means the network is up; the harnesses need it to resume.
const NETWORK_PROBES = ['https://api.anthropic.com', 'https://api.openai.com', 'https://openrouter.ai'];

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
    const up = await Promise.any(NETWORK_PROBES.map((url) => fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) }))).then(() => true, () => false);
    if (up) return;
    await sleep(5000);
  }
}
