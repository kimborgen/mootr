// Switch with handover (docs/cost-policy.md, build step 13): a manager moves an agent's work
// to another preset, for example when its account is exhausted.
//
//   1. check     the manager may manage the agent's tree (cost-auth.ts), and the preset's
//                account passes spawn admission, so work never moves onto a blocked account.
//   2. quiesce   a working agent (active or paused) gets cost-prepare.md (finish the step,
//                update HANDOVER.md) and up to softStopMinutes to end its turn. At the
//                deadline the adapter's interrupt() is tried, as a courtesy only.
//   3. stop      the predecessor's harness is stopped through the shutdown path, keeping its
//                session, and the adapter's stop() confirms nothing of it still runs (no
//                tmux session, no Codex app-server, no OpenCode server-side turn). Only then
//                does a successor start, so one agent at a time edits the worktree. The
//                predecessor keeps a 'taken-over' blocker and is never archived here.
//   4. move      in one transaction: a successor NAME-t2 (-t3, ... unique even among archived
//                agents) with the same role, cwd, workspace, machine, visibility and parents;
//                the predecessor's children, unread mail, open threads and open ITSAs move to
//                it, and mail to the predecessor forwards to it (agents.forwarded_to).
//   5. launch    the successor starts with takeover.md: the original spawn prompt, HANDOVER.md,
//                the predecessor's transcript path, its last compaction summary, the threads.
//   6. tell      the successor's parents hear it (cost-notices.switched), and the
//                predecessor's open cost notices are acknowledged. Its queued ring turns move
//                to the successor after the launch, once (mail.moveRingNotices, S-2490).
//
// If anything after the stop fails, including the successor's startup and the delivery of its
// takeover prompt (startupMs, 3 minutes), the move is undone in one transaction, every mail
// the successor got goes back, the successor is forgotten, and the predecessor is resumed if
// it ran before. While its successor lives, the predecessor runs nothing (lifecycle's
// assertNotTakenOver, admission); archiving the successor releases it. Both agents share the
// worktree; lifecycle's archive keeps a worktree while another agent still works in it.
import { existsSync, statSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { typeTarget } from './reviewer-chain.ts';
import { randomUUID } from 'node:crypto';
import * as db from './db.ts';
import * as lifecycle from './lifecycle.ts';
import * as blockers from './blockers.ts';
import * as costNotices from './cost-notices.ts';
import * as costPause from './cost-pause.ts';
import * as tmux from './tmux.ts';
import { syncChildrenWaits } from './org.ts';
import { adapters } from './adapters/index.ts';
import { admitSpawn } from './admission.ts';
import { assertMayManageTree } from './cost-auth.ts';
import { copyGrants } from './workspace-share.ts';
import { preset as presetOf, capabilitiesFor } from './registry.ts';
import { render } from './templates.ts';
import { queueNotice, dropNotice, moveRingNotices, HUMAN } from './mail.ts';
import { settings } from './settings.ts';
import { effectiveMode, permissionSource } from './permission-modes.ts';
import type { Workspace } from './workspace.ts';

const TAKEN_OVER = 'taken-over' as const;
// How many of the predecessor's most recent open threads move.
const THREADS = 50;
const SUMMARY_CHARS = 8000;

export interface SwitchOptions {
  // The agent whose work moves: an id or name.
  agent: string;
  // Shown in notices and events. Resolved through the registry's presets, unless `toType` is set.
  preset: string;
  // Internal, set only by the cost fallback and never read from public input: the agent type
  // whose harness, model, and effort the agent moves to, and the type its successor records.
  toType?: string;
  // The manager: an agent id, or 'human'.
  by: string;
  // Overrides settings.cost.softStopMinutes.
  softStopMinutes?: number;
  // How often the quiesce checks for the end of the turn; tests shorten it.
  pollMs?: number;
  // How long the successor gets to start and take its takeover prompt.
  startupMs?: number;
  // The cost fallback's re-check: a reason to cancel (a manager acted meanwhile), or null.
  // Asked inside lifecycle.serial right before the stop, and again before the move.
  stillWanted?: () => string | null;
}

export interface SwitchPlan {
  agent: db.Agent;
  preset: string;
  toType?: string;
  harness: string;
  model: string | null;
  effort: string | null;
  by: string;
  successor: string;
}

export interface SwitchResult {
  from: string;
  to: string;
  preset: string;
  // The agent was working, and stam waited for its turn to end.
  waited: boolean;
  // The deadline passed and stam stopped the turn.
  interrupted: boolean;
  handover: string | null;
  moved: { children: string[]; threads: number; unread: number; itsas: number };
  acked: string[];
}

// What the transaction moved, so a failed launch can put it back.
interface Moved {
  // Children whose spawning parent (agents.parent_id) was the predecessor.
  spawned: string[];
  // Children that had the predecessor as an adopting parent (agent_parents).
  adopted: string[];
  unread: string[];
  // Mail still owed to the predecessor by a read batch (S-357), with its read state, which moves
  // to the successor as unread; the rollback puts the read state back.
  owed: { mail_id: string; read_at: string | null }[];
  // Read mail of open threads that the successor got a read copy of.
  copies: string[];
  itsaOwned: string[];
  itsaJoined: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const busy = (a: db.Agent) => a.activity === 'working' || a.activity === 'starting';
const nameOf = (by: string) => (by === HUMAN ? 'the human' : by === 'stam' ? "stam's cost fallback" : (db.getAgent(by)?.name ?? by));
const switching = new Set<string>();

// The target of a switch: the agent type `toType` when set (a reviewer fallback), else the registry preset.
export function switchTarget(opts: { preset: string; toType?: string }): { harness: string; model: string | null; effort: string | null } {
  if (!opts.toType) return presetOf(opts.preset);
  const t = typeTarget(opts.toType);
  if (!t) throw new Error(`no agent type ${opts.toType} with a harness`);
  return t;
}

// NAME-t2, NAME-t3, ...: the first free one, counting every agent ever stored, archived too.
// A successor's successor counts on from the original name (x-t2 becomes x-t3).
export function successorName(name: string): string {
  const base = name.replace(/-t\d+$/, '');
  for (let n = 2; ; n++) if (!db.getAgent(`${base}-t${n}`)) return `${base}-t${n}`;
}

// Everything that can refuse the switch before anything changes. Throws the reason; a
// permission refusal is a cost-auth Forbidden.
// `again` is the re-check after the quiesce, of the switch already under way.
export function check(opts: SwitchOptions, again = false): SwitchPlan {
  const a = db.getAgent(opts.agent);
  if (!a) throw new Error(`no agent ${opts.agent}`);
  assertMayManageTree(opts.by, a);
  if (a.lifecycle === 'archived') throw new Error(`${a.name} is archived`);
  if (a.forwarded_to) throw new Error(`${a.name} was already taken over by ${db.getAgent(a.forwarded_to)?.name ?? a.forwarded_to}`);
  if (!again && switching.has(a.id)) throw new Error(`${a.name} is already being switched`);
  const p = switchTarget(opts);
  if (!adapters[p.harness]) throw new Error(`preset ${opts.preset} runs ${p.harness}, which stam can't control`);
  const successor = successorName(a.name);
  // The spawn gate: an account-wide blocker on the preset's account refuses with its reason.
  admitSpawn({ name: successor, harness: p.harness, model: p.model, by: opts.by === HUMAN ? undefined : opts.by, human: false });
  return { agent: a, preset: opts.preset, toType: opts.toType, harness: p.harness, model: p.model, effort: p.effort, by: opts.by, successor };
}

// Lets a working agent finish its step, whatever its lifecycle: a paused agent can still be
// mid-turn. At the deadline the harness is asked to interrupt, best effort; stop() follows
// either way. Returns whether it waited, and whether the deadline passed.
async function quiesce(a: db.Agent, opts: SwitchOptions): Promise<{ waited: boolean; interrupted: boolean }> {
  let cur = db.getAgent(a.id)!;
  const minutes = opts.softStopMinutes ?? settings().cost.softStopMinutes ?? 10;
  const deadline = Date.now() + minutes * 60_000;
  // Written for every switch, idle ones too: the deadline and the switch's parameters are kept
  // in the events, so a daemon restart can re-arm it (resumeSwitches).
  db.addEvent(a.id, 'cost:switch', { step: 'quiesce', minutes, deadline: new Date(deadline).toISOString(), preset: opts.preset, toType: opts.toType, by: opts.by });
  if (cur.lifecycle === 'shut_down' || !busy(cur)) return { waited: false, interrupted: false };
  const text = render('cost-prepare', { cwd: cur.cwd, minutes: String(minutes) });
  queueNotice(a.id, text);
  const poll = opts.pollMs ?? 1000;
  try {
    while (Date.now() < deadline) {
      await sleep(Math.min(poll, Math.max(0, deadline - Date.now())));
      cur = db.getAgent(a.id)!;
      if (!busy(cur)) return { waited: true, interrupted: false };
    }
    const adapter = adapters[cur.harness];
    const ok = adapter?.interrupt ? await adapter.interrupt(cur).catch((e) => (db.addEvent(a.id, 'cost:interrupt-error', String(e)), false)) : false;
    db.addEvent(a.id, 'cost:switch', { step: 'interrupt', confirmed: ok });
    return { waited: true, interrupted: true };
  } finally {
    // A turn that ended before its next tool call never saw the request; it no longer applies.
    dropNotice(a.id, text);
  }
}

// Stops the predecessor's harness as a shutdown does (its session stays, to resume), then
// has the adapter confirm nothing of it still runs. Throws when that can't be confirmed.
// Returns whether it was running, so a rollback knows to resume it.
async function stop(a: db.Agent): Promise<boolean> {
  const cur = db.getAgent(a.id)!;
  const running = cur.lifecycle === 'active' || cur.lifecycle === 'paused';
  if (running || tmux.hasSession(a.id)) await lifecycle.shutdown(cur, true);
  for (let i = 0; i < 20 && tmux.hasSession(a.id); i++) await sleep(250);
  if (tmux.hasSession(a.id)) throw new Error(`${a.name}'s terminal didn't close`);
  await lifecycle.awaitTurnStop(cur);
  db.addEvent(a.id, 'cost:switch', { step: 'stopped', was: cur.lifecycle });
  return running;
}

// The threads the predecessor takes part in and hasn't archived, newest first.
function openThreads(a: db.Agent): { thread_id: string; subject: string }[] {
  const all = db.threads(a.id, THREADS);
  return db.splitArchived(a.id, all).active.map((t) => ({ thread_id: t.thread_id, subject: t.mails[0]?.subject ?? '' }));
}

// Creates the successor and moves the predecessor's place in the org to it. Runs in one
// transaction: on any error nothing is written.
function move(plan: SwitchPlan, threads: { thread_id: string }[]): { successor: db.Agent; moved: Moved } {
  const a = db.getAgent(plan.agent.id)!;
  return db.transaction(() => {
    const d = db.open();
    const name = successorName(a.name);
    const id = db.newAgentId();
    db.createAgent({ id, name, role: a.role, machine: a.machine, harness: plan.harness, model: plan.model, effort: plan.effort, cwd: a.cwd, parent_id: a.parent_id, session_id: randomUUID() });
    for (const p of db.parentsOf(a)) if (p !== a.parent_id) db.addParent(id, p);
    db.updateAgent(id, {
      workspace: a.workspace,
      // A specialist's personal workspace and standing flag go to its successor (S-894).
      personal_workspace: a.personal_workspace,
      standing: a.standing,
      capabilities: JSON.stringify(capabilitiesFor(plan.harness, plan.model)),
      // A successor that follows the settings takes their mode for its own harness (S-1967).
      permission_mode: permissionSource(a) === 'settings' ? effectiveMode(plan.harness, plan.toType ?? a.type) : a.permission_mode,
      permission_source: permissionSource(a),
      visibility: a.visibility,
      child_notices: a.child_notices,
      kind: a.kind,
      // A take-over to a type makes the successor that type.
      type: plan.toType ?? a.type,
      // The original spawn prompt, so a later switch of the successor hands it on too.
      first_prompt: a.first_prompt,
    });

    const moved: Moved = { spawned: [], adopted: [], unread: [], owed: [], copies: [], itsaOwned: [], itsaJoined: [] };
    moved.spawned = (d.prepare('SELECT id FROM agents WHERE parent_id = ? AND id != ?').all(a.id, id) as { id: string }[]).map((r) => r.id);
    d.prepare('UPDATE agents SET parent_id = ? WHERE parent_id = ? AND id != ?').run(id, a.id, id);
    moved.adopted = (d.prepare('SELECT child_id FROM agent_parents WHERE parent_id = ?').all(a.id) as { child_id: string }[]).map((r) => r.child_id);
    for (const c of moved.adopted) {
      d.prepare('DELETE FROM agent_parents WHERE child_id = ? AND parent_id = ?').run(c, a.id);
      db.addParent(c, id);
    }

    // Owed mail is moved as unread, so the successor sees it, with its batches (mail_deliveries).
    const owedIn = '(SELECT mail_id FROM mail_deliveries WHERE agent_id = ?)';
    moved.owed = d.prepare(`SELECT mail_id, read_at FROM mail_recipients WHERE agent_id = ? AND read_at IS NOT NULL AND mail_id IN ${owedIn}`).all(a.id, a.id) as Moved['owed'];
    moved.unread = (d.prepare(`SELECT mail_id FROM mail_recipients WHERE agent_id = ? AND (read_at IS NULL OR mail_id IN ${owedIn})`).all(a.id, a.id) as { mail_id: string }[]).map((r) => r.mail_id);
    d.prepare(`UPDATE mail_recipients SET read_at = NULL WHERE agent_id = ? AND mail_id IN ${owedIn}`).run(a.id, a.id);
    d.prepare('UPDATE mail_recipients SET agent_id = ? WHERE agent_id = ? AND read_at IS NULL').run(id, a.id);
    d.prepare('UPDATE mail_deliveries SET agent_id = ? WHERE agent_id = ?').run(id, a.id);
    // The read mail of open threads stays the predecessor's too; the successor gets a read
    // copy, so the threads list, read_thread and reply guessing work for it.
    const now = new Date().toISOString();
    const copy = d.prepare('INSERT OR IGNORE INTO mail_recipients (mail_id, agent_id, read_at, pushed_at) VALUES (?, ?, ?, ?)');
    for (const t of threads) {
      const rows = d.prepare('SELECT r.mail_id FROM mail_recipients r JOIN mail m ON m.id = r.mail_id WHERE m.thread_id = ? AND r.agent_id = ?').all(t.thread_id, a.id) as { mail_id: string }[];
      for (const r of rows) if (Number(copy.run(r.mail_id, id, now, now).changes) > 0) moved.copies.push(r.mail_id);
    }

    moved.itsaOwned = (d.prepare('SELECT id FROM itsas WHERE owner = ? AND closed_at IS NULL').all(a.id) as { id: string }[]).map((r) => r.id);
    d.prepare('UPDATE itsas SET owner = ?, updated_at = ? WHERE owner = ? AND closed_at IS NULL').run(id, new Date().toISOString(), a.id);
    const join = d.prepare('INSERT OR IGNORE INTO itsa_participants (itsa_id, agent_id) VALUES (?, ?)');
    for (const r of d.prepare('SELECT p.itsa_id FROM itsa_participants p JOIN itsas i ON i.id = p.itsa_id WHERE p.agent_id = ? AND p.left_at IS NULL AND i.closed_at IS NULL').all(a.id) as { itsa_id: string }[])
      if (Number(join.run(r.itsa_id, id).changes) > 0) moved.itsaJoined.push(r.itsa_id);

    // The workspaces shared with the predecessor are shared with the successor too (S-896);
    // forgetAgent drops them again if the switch is undone.
    copyGrants(a.id, id);

    db.updateAgent(a.id, { forwarded_to: id });
    db.addEvent(a.id, 'cost:switch', { step: 'moved', to: name, preset: plan.preset, children: moved.spawned.length + moved.adopted.length, unread: moved.unread.length, threads: threads.length });
    db.addEvent(id, 'cost:switch', { step: 'created', from: a.name, preset: plan.preset });
    return { successor: db.getAgent(id)!, moved };
  });
}

// Puts back what move() moved and forgets the successor, in one transaction.
function unmove(a: db.Agent, s: db.Agent, moved: Moved): void {
  db.transaction(() => {
    const d = db.open();
    for (const c of moved.spawned) d.prepare('UPDATE agents SET parent_id = ? WHERE id = ? AND parent_id = ?').run(a.id, c, s.id);
    for (const c of moved.adopted) {
      d.prepare('DELETE FROM agent_parents WHERE child_id = ? AND parent_id = ?').run(c, s.id);
      db.addParent(c, a.id);
    }
    // Every delivery the successor got goes back, the moved unread mail and anything sent to it
    // since; only the read copies made for it are dropped. Where the predecessor has its own
    // copy, the two merge, unread if either was.
    const copies = new Set(moved.copies);
    const rows = d.prepare('SELECT mail_id, read_at, pushed_at, quiet FROM mail_recipients WHERE agent_id = ?').all(s.id) as { mail_id: string; read_at: string | null; pushed_at: string | null; quiet: number }[];
    for (const r of rows) {
      if (copies.has(r.mail_id)) continue;
      const mine = d.prepare('SELECT read_at FROM mail_recipients WHERE agent_id = ? AND mail_id = ?').get(a.id, r.mail_id) as { read_at: string | null } | undefined;
      if (mine) {
        if (mine.read_at && !r.read_at) d.prepare('UPDATE mail_recipients SET read_at = NULL, pushed_at = NULL WHERE agent_id = ? AND mail_id = ?').run(a.id, r.mail_id);
      } else {
        d.prepare('INSERT INTO mail_recipients (mail_id, agent_id, read_at, pushed_at, quiet) VALUES (?, ?, ?, ?, ?)').run(r.mail_id, a.id, r.read_at, r.pushed_at, r.quiet);
      }
    }
    // The owed mail and its batches go back, with the read state the predecessor had.
    d.prepare('UPDATE mail_deliveries SET agent_id = ? WHERE agent_id = ?').run(a.id, s.id);
    for (const o of moved.owed) d.prepare('UPDATE mail_recipients SET read_at = ? WHERE agent_id = ? AND mail_id = ? AND read_at IS NULL').run(o.read_at, a.id, o.mail_id);
    for (const i of moved.itsaOwned) d.prepare('UPDATE itsas SET owner = ?, updated_at = ? WHERE id = ? AND owner = ?').run(a.id, new Date().toISOString(), i, s.id);
    d.prepare('DELETE FROM itsa_participants WHERE agent_id = ?').run(s.id);
    d.prepare('DELETE FROM agent_parents WHERE child_id = ? OR parent_id = ?').run(s.id, s.id);
    db.updateAgent(a.id, { forwarded_to: null });
    // Also drops the successor's own rows, the read copies among them.
    db.forgetAgent(s.id);
  });
}

// The newest compaction summary in the predecessor's transcript, when the harness writes one
// there: Claude Code marks it isCompactSummary, Codex's rollout stores a 'compacted' item.
export function lastCompactionSummary(path: string | null): string | null {
  if (!path || !existsSync(path)) return null;
  let lines: string[];
  try {
    if (statSync(path).size > 200 * 1024 * 1024) return null;
    lines = readFileSync(path, 'utf8').split('\n');
  } catch {
    return null;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.includes('isCompactSummary') && !l.includes('"compacted"')) continue;
    try {
      const e = JSON.parse(l);
      let text: unknown;
      if (e.isCompactSummary) {
        const c = e.message?.content;
        text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: any) => x?.text ?? '').join('\n') : undefined;
      } else if (e.type === 'compacted') text = e.payload?.message;
      if (typeof text === 'string' && text.trim()) return text.trim().slice(0, SUMMARY_CHARS);
    } catch {}
  }
  return null;
}

// What the successor is told about the predecessor's work: its HANDOVER.md when it wrote one
// (the wrap-up asks for it), else a brief stam generates from what it knows.
const HANDOVER_CHARS = 12000;
export function handoverOf(a: db.Agent): { text: string; file: boolean } {
  const file = join(a.cwd, 'HANDOVER.md');
  if (existsSync(file)) {
    const body = readFileSync(file, 'utf8');
    const clipped = body.length > HANDOVER_CHARS ? `${body.slice(0, HANDOVER_CHARS)}\n[... clipped; the rest is in ${file}]` : body;
    return { text: `${clipped.trim()}\n\n(${file}, last updated ${statSync(file).mtime.toISOString()}; ${a.name}'s last activity ${a.updated_at})`, file: true };
  }
  const ws: Workspace | null = a.workspace ? JSON.parse(a.workspace) : null;
  let head = '(not a git checkout)';
  try {
    head = execFileSync('git', ['-C', a.cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {}
  const itsas = (db.open().prepare('SELECT key FROM itsas WHERE owner = ? AND closed_at IS NULL').all(a.id) as { key: string }[]).map((r) => r.key);
  const text = [
    `Generated by stam: ${a.name} left no HANDOVER.md, so this brief is all there is.`,
    `- Branch: ${ws?.worktree?.branch ?? '(none)'}`,
    `- Head: ${head}`,
    `- Worktree: ${ws?.worktree?.path ?? a.cwd}`,
    `- ITSAs it owned: ${itsas.length ? itsas.join(', ') : '(none)'}`,
    `- Its last message: ${(a.last_message ?? '(not reported)').replace(/\s+/g, ' ').slice(0, 2000)}`,
  ].join('\n');
  return { text, file: false };
}

function takeoverPrompt(a: db.Agent, s: db.Agent, plan: SwitchPlan, threads: { thread_id: string; subject: string }[]): { text: string; handover: string | null } {
  const ws: Workspace | null = a.workspace ? JSON.parse(a.workspace) : null;
  const summary = lastCompactionSummary(a.transcript_path);
  const { text: handover, file } = handoverOf(a);
  const text = render('takeover', {
    name: s.name,
    predecessor: a.name,
    by: nameOf(plan.by),
    preset: plan.preset,
    cwd: s.cwd,
    branch: ws?.worktree ? `, on branch ${ws.worktree.branch}` : '',
    handover: file ? `${a.name}'s HANDOVER.md:\n\n<handover>\n${handover}\n</handover>` : handover,
    transcript: a.transcript_path ?? '(not recorded)',
    prompt: a.first_prompt ?? '(not recorded)',
    summary: summary ? `The last compaction summary of ${a.name}'s conversation:\n\n<summary>\n${summary}\n</summary>` : '',
    threads: threads.length ? threads.map((t) => `- ${t.thread_id}: ${t.subject}`).join('\n') : '(none)',
  });
  return { text, handover: file ? join(a.cwd, 'HANDOVER.md') : null };
}

// Starts the successor as spawnAgent does (a tree paused for cost holds it too, and a held
// agent's first prompt waits as a notice), then waits for its real startup: the adapter's
// afterLaunch done, the agent out of 'starting' (its takeover prompt taken, or it came up
// held), and its terminal alive. Throws on an error or after startupMs.
async function launch(s: db.Agent, prompt: string, opts: SwitchOptions): Promise<void> {
  await costPause.attachSpawn(db.getAgent(s.id)!);
  let text: string | undefined = prompt;
  if (lifecycle.isHeld(db.getAgent(s.id)!)) {
    queueNotice(s.id, prompt, { idleOnly: true });
    text = undefined;
  }
  const deadline = Date.now() + (opts.startupMs ?? 180_000);
  const { launched } = await lifecycle.startHarness(db.getAgent(s.id)!, text, false, 'spawn');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${s.name} didn't start within ${Math.round((opts.startupMs ?? 180_000) / 1000)} s`)), Math.max(0, deadline - Date.now()))));
  try {
    await Promise.race([launched, timeout]);
    for (;;) {
      const cur = db.getAgent(s.id)!;
      if (!tmux.hasSession(s.id) || tmux.isDead(s.id)) throw new Error(`${s.name}'s harness exited during startup`);
      if (cur.activity === 'errored') throw new Error(`${s.name} failed to start: ${cur.activity_detail ?? 'error'}`);
      if (cur.activity !== 'starting') return;
      await Promise.race([sleep(Math.min(opts.pollMs ?? 500, 500)), timeout]);
    }
  } finally {
    clearTimeout(timer);
  }
}

// A switch its requester no longer wants; the rollback marks the error `cancelled`.
class Cancelled extends Error {}
function cancelIfUnwanted(opts: SwitchOptions): void {
  const why = opts.stillWanted?.();
  if (why) throw new Cancelled(`cancelled: ${why}`);
}

// The whole switch, from the check to the notices. Resolves once the successor is launched;
// with a working agent that is up to softStopMinutes later.
export async function costSwitch(opts: SwitchOptions, plan: SwitchPlan = check(opts)): Promise<SwitchResult> {
  const a = plan.agent;
  // Throws, before anything is set, when another transition of the agent is under way. The
  // lock is held through the rollback's resume.
  const releaseLock = lifecycle.acquire(a, 'switch');
  switching.add(a.id);
  try {
    db.addEvent(a.id, 'cost:switch', { step: 'start', by: plan.by, preset: plan.preset });
    // The manager acted: its open notices stop their fallbacks now, not after the soft-stop.
    // The fallback's own switch acks nothing: its claim is separate from managers' acks.
    const ackOpen = () => (plan.by === 'stam' ? [] : costNotices.openNotices([a.id]).filter((n) => costNotices.ack(n.id, plan.by, 'cost_switch').ok).map((n) => n.id));
    const acked = ackOpen();
    const { waited, interrupted } = await quiesce(a, opts);
    let wasRunning = false;
    let s: db.Agent | undefined;
    let moved: Moved | undefined;
    try {
      // In serial, so a pause or unpause either lands before the re-check or after the stop.
      wasRunning = await lifecycle.serial(a.id, async () => {
        cancelIfUnwanted(opts);
        return stop(a);
      });
      // The stop was confirmed, but the agent may have been started again meanwhile.
      if (tmux.hasSession(a.id) || db.getAgent(a.id)!.lifecycle === 'active') throw new Error(`${a.name} was started again during the stop`);
      // Stopped, it only records the blocker (no pause turn); the blocker keeps stam from
      // resuming it on its own.
      await blockers.addBlocker(a.id, { kind: TAKEN_OVER, reason: `${nameOf(plan.by)} is moving its work to preset ${plan.preset}` });
      // The account may have been blocked while the agent finished its step.
      const fresh = check({ ...opts, agent: a.id }, true);
      // The preset (a type preset follows the registry) changed during the quiesce: admit only the plan that moves.
      if (fresh.harness !== plan.harness || fresh.model !== plan.model || fresh.effort !== plan.effort) throw new Error(`the target of ${plan.preset} changed while ${a.name} finished its step`);
      cancelIfUnwanted(opts);
      const threads = openThreads(db.getAgent(a.id)!);
      ({ successor: s, moved } = move(plan, threads));
      const { text, handover } = takeoverPrompt(db.getAgent(a.id)!, s, plan, threads);
      await launch(s, text, opts);
      // The ring turns queued to the predecessor are the successor's now, once (S-2490).
      moveRingNotices(a.id, s.id);
      await blockers.addBlocker(a.id, { kind: TAKEN_OVER, reason: `taken over by ${s.name} on preset ${plan.preset}` });
      acked.push(...ackOpen());
      costNotices.switched(db.getAgent(a.id)!, db.getAgent(s.id)!, plan.preset, plan.by);
      syncChildrenWaits(s.id);
      db.addEvent(a.id, 'cost:switch', { step: 'done', to: s.name });
      return {
        from: a.name,
        to: s.name,
        preset: plan.preset,
        waited,
        interrupted,
        handover,
        moved: { children: [...moved.spawned, ...moved.adopted].map((c) => db.getAgent(c)?.name ?? c), threads: threads.length, unread: moved.unread.length, itsas: moved.itsaOwned.length },
        acked,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      let restored = 'restored';
      if (s && moved) {
        const succ = db.getAgent(s.id);
        tmux.killSession(s.id);
        if (succ) await adapters[succ.harness]?.stop?.(succ).catch((x) => db.addEvent(a.id, 'cost:switch-stop-error', String(x)));
        // The ring turns go back to the predecessor, which is resumed or stays held.
        moveRingNotices(s.id, a.id);
        unmove(db.getAgent(a.id)!, s, moved);
      }
      db.open().prepare('DELETE FROM blockers WHERE agent_id = ? AND kind = ?').run(a.id, TAKEN_OVER);
      if (wasRunning) {
        // Under the switch's lock: nothing else may move the agent until the rollback's resume is done.
        await lifecycle.resume(db.getAgent(a.id)!, render('cost-switch-failed', { reason: msg }), { locked: true }).catch((x) => {
          restored = `left shut down (${x instanceof Error ? x.message : x})`;
          db.addEvent(a.id, 'cost:switch-resume-error', String(x));
        });
      }
      db.addEvent(a.id, 'cost:switch', { step: 'rolled-back', error: msg });
      const err = new Error(`switching ${a.name} to ${plan.preset} failed, and ${a.name} was ${restored}: ${msg}`);
      if (e instanceof Cancelled) Object.assign(err, { cancelled: true });
      throw err;
    }
  } finally {
    switching.delete(a.id);
    releaseLock();
  }
}

// A switch a daemon restart cut short: its latest cost:switch event is still the quiesce or the
// interrupt (the stop not yet recorded). The switch goes on with what is
// left of the soft stop, so the working agent is interrupted at the original deadline.
// Returns the agents whose switch was resumed.
export function resumeSwitches(): string[] {
  const resumed: string[] = [];
  for (const a of db.listAgents()) {
    if (a.lifecycle === 'archived' || a.forwarded_to || switching.has(a.id)) continue;
    const events = db.listEvents(a.id, 500).filter((e) => e.type === 'cost:switch');
    const last = events.at(-1);
    const step = last ? (JSON.parse(last.data ?? 'null') as { step?: string } | null)?.step : undefined;
    if (step !== 'quiesce' && step !== 'interrupt') continue;
    // The newest quiesce belongs to the switch in progress: every switch writes one first.
    const q = events.findLast((e) => (JSON.parse(e.data ?? 'null') as { step?: string } | null)?.step === 'quiesce');
    const ev = q ? (JSON.parse(q.data ?? 'null') as { deadline?: string; preset?: string; toType?: string; by?: string }) : null;
    if (!ev?.preset || !ev.by || !ev.deadline) continue;
    const remaining = Math.max(0, new Date(ev.deadline).getTime() - Date.now()) / 60_000;
    const opts: SwitchOptions = { agent: a.id, preset: ev.preset, toType: ev.toType, by: ev.by, softStopMinutes: remaining };
    // Each switch runs on its own, with its own deadline: none waits for another.
    const fail = (e: unknown) => db.addEvent(a.id, 'cost:switch', { step: 'resume-failed', error: e instanceof Error ? e.message : String(e) });
    try {
      costSwitch(opts, check(opts)).catch(fail);
      resumed.push(a.name);
    } catch (e) {
      fail(e);
    }
  }
  return resumed;
}

// For the API: checks at once, then switches. An agent that isn't working switches before
// this returns; a working one gets up to softStopMinutes, so the switch goes on in the
// background and its outcome reaches the manager as a notice.
export async function startSwitch(opts: SwitchOptions): Promise<SwitchResult | { status: 'quiescing'; from: string; to: string; preset: string; minutes: number }> {
  const plan = check(opts);
  const a = db.getAgent(plan.agent.id)!;
  if (a.lifecycle === 'shut_down' || !busy(a)) return costSwitch(opts, plan);
  const minutes = opts.softStopMinutes ?? settings().cost.softStopMinutes ?? 10;
  costSwitch(opts, plan).catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    if (plan.by !== HUMAN) costNotices.deliver(plan.by, `[stam] cost_switch of ${a.name} failed`, `[stam] ${msg}`);
  });
  return { status: 'quiescing', from: a.name, to: plan.successor, preset: plan.preset, minutes };
}
