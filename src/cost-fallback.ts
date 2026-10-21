// Fallback (docs/cost-policy.md, build step 14): when a cost notice about a blocked agent goes
// cost.fallbackMinutes without its manager acting on that agent, stam applies the account's
// configured action and tells the chief of staff.
//
// A manager acts by cost_ack, cost_pause, cost_switch or cost_allocate on the tree, or by a
// pause or unpause from anyone who may manage the agent's tree (cost-auth.mayManageTree);
// each records an ack on the notice (cost-notices.ack), and an acked notice's fallback never
// runs. A take-over already under way re-checks inside lifecycle.serial right before it stops
// the agent, and again before the move, and cancels if a manager acked, the blocker changed,
// someone new paused the agent since the claim, or an archive or shut-down is pending on it.
// An explicit archive or shut-down cancels the agent's pending rows at once (cancelPending),
// and the claim refuses an archived agent or one with an archive or shut-down pending, in the
// same statement that claims the row, so a fallback never creates a successor for an agent
// being archived (S-2458).
//
// Each blocker-set notice whose blocker kind has an action field gets a row in
// cost_fallbacks with its due time and the blocker's generation (its `since`), so the timer
// survives a daemon restart and never applies to a later blocker of the same kind; clearing
// the blocker retires the row. A row moves pending -> claimed -> running -> done; the claim is
// the fallback's own, separate from managers' acks. At daemon start, recover() puts a claimed
// row back to pending (nothing happened yet) and reconciles a running one: a successor that
// exists makes it done; otherwise the predecessor's taken-over blocker is dropped, a stop is
// undone, and the row retries once.
//
//   window, paid-forbidden  onSubExhausted
//   budget                  onBudgetExhausted (a budget scope with no account: global.onExhausted)
//   credits-out             onCreditsOut
//   billing-unknown         onBillingUnknown
//   error                   the account's onError, else cost.onError
//
// The actions:
//   wait         the default: nothing beyond the blockers; the agent stays held until it clears.
//   take-over    cost_switch to the first preset in `to` whose account passes cost_switch's
//                check; with none eligible, or a switch that fails, the `else` action.
//   soft-stop,   the admission gate already holds a blocked agent, so these work as wait, with
//   hard-stop    a note saying so.
//   continue     on a `paid: true` account, removes the blocker (a cost:override event). On any
//                other account accounts.validate refuses it; cost.onError naming it works as wait.
//
// Every fallback that runs is told to the chief of staff: what ran, on which agent, and the
// result. When the chief of staff is the blocked agent, or isn't active and unblocked, the
// human gets it as mail from stam instead (humanMailAllows('necessary')).
import * as db from './db.ts';
import { isReviewerType, defaultReviewer } from './agent-types.ts';
import { freeFallback } from './reviewer-chain.ts';
import { settings, humanMailAllows, type CostAction, type CostAccount } from './settings.ts';
import { render } from './templates.ts';
import { sendFromStam, HUMAN } from './mail.ts';
import { chiefOfStaff } from './org.ts';
import { registry } from './registry.ts';
import { resolveTarget, accountFor } from './accounts.ts';
import { mayManageTree } from './cost-auth.ts';
import { pauseOwners } from './lifecycle.ts';
import * as costNotices from './cost-notices.ts';
import type { CostNotice } from './cost-notices.ts';
import type { BlockerKind } from './blockers.ts';

// The actor a fallback's cost_switch runs as: stam itself, on the user's configured action.
export const STAM = 'stam';
const MIN_MS = 60_000;

type Field = 'onSubExhausted' | 'onBudgetExhausted' | 'onCreditsOut' | 'onBillingUnknown' | 'onError';
const FIELD: Partial<Record<BlockerKind, Field>> = {
  window: 'onSubExhausted',
  'paid-forbidden': 'onSubExhausted',
  budget: 'onBudgetExhausted',
  'credits-out': 'onCreditsOut',
  'billing-unknown': 'onBillingUnknown',
  error: 'onError',
};

export interface FallbackAction {
  action: string;
  to: string[];
  // Internal, never from config: a reviewer's take-over to the first free type of its own chain.
  toType?: string;
  else: string;
  // The config field it came from, for the notices; '' for the default.
  field: string;
}

export type FallbackState = 'pending' | 'claimed' | 'running' | 'done';

export interface FallbackRow {
  notice_id: string;
  agent_id: string;
  kind: BlockerKind;
  account: string;
  // The blocker's generation: its `since` when the notice was raised.
  blocker_since: string;
  due_at: number; // ms
  state: FallbackState;
  // Runs interrupted by a restart; one retry, then it gives up.
  attempts: number;
  // Why an explicit archive or shut-down ended the agent's claimed or running fallback (S-2458); read by unwanted.
  cancel: string | null;
  // At the claim, JSON: { lifecycle, owners }, what a cancel and a recovery compare against.
  prior: string | null;
  ran_at: string | null;
  result: string | null;
}

let ready = false;
function table(): void {
  if (ready) return;
  db.open().exec(`CREATE TABLE IF NOT EXISTS cost_fallbacks (
    notice_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    account TEXT NOT NULL DEFAULT '',
    blocker_since TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    prior TEXT,
    ran_at TEXT,
    result TEXT
  )`);
  // A table made before the cancel column existed gets it on first use (S-2458).
  if (!(db.open().prepare('PRAGMA table_info(cost_fallbacks)').all() as { name: string }[]).some((c) => c.name === 'cancel')) {
    db.open().exec('ALTER TABLE cost_fallbacks ADD COLUMN cancel TEXT');
  }
  ready = true;
}

const minutes = () => settings().cost.fallbackMinutes ?? 15;

// Whether a blocker kind has a fallback; manual pauses and take-overs are a manager's own act.
export function covers(kind: BlockerKind): boolean {
  return FIELD[kind] != null;
}

function normalize(raw: CostAction | undefined | null, field: string): FallbackAction {
  if (raw == null) return { action: 'wait', to: [], else: 'wait', field: '' };
  if (typeof raw === 'string') return { action: raw, to: [], else: 'wait', field };
  return { action: raw.action, to: raw.to ?? [], else: raw.else ?? 'wait', field };
}

// The action configured for a blocker of this kind on this account.
export function actionFor(account: string, kind: BlockerKind): FallbackAction {
  const cost = settings().cost;
  const field = FIELD[kind];
  if (!field) return normalize(null, '');
  const acct: CostAccount | undefined = cost.accounts?.[account];
  if (acct?.[field] != null) return normalize(acct[field], `${account}.${field}`);
  if (kind === 'error' && cost.onError != null) return normalize(cost.onError, 'onError');
  if (kind === 'budget' && !acct && cost.global?.onExhausted) return normalize(cost.global.onExhausted, 'global.onExhausted');
  return normalize(null, '');
}

function phrase(f: FallbackAction): string {
  if (f.action === 'take-over') return `take over to ${f.toType ? `the reviewer fallback type ${f.toType}` : f.to.join(', ') || '(no preset)'}, else ${f.else}`;
  return f.action;
}

// A reviewer: its type is a reviewer type, or with no type, the legacy role (S-360).
export function isReviewer(a: { type?: string | null; role?: string | null }): boolean {
  return a.type ? isReviewerType(a.type) : a.role === 'reviewer';
}

// The reviewer type whose fallback chain an agent follows: its own type, or the default reviewer for the legacy role.
const reviewerTypeOf = (a: { type?: string | null }): string => a.type || defaultReviewer();

// The action for a blocker of this kind on this agent's account. A reviewer with no action of its
// own on the account takes over to the first free type of its own type's fallback chain (S-412).
export function actionForAgent(a: { type?: string | null; role?: string | null }, account: string, kind: BlockerKind): FallbackAction {
  const f = actionFor(account, kind);
  if (f.field === '' && isReviewer(a) && ['window', 'paid-forbidden', 'budget'].includes(kind) && freeFallback(reviewerTypeOf(a), account).type) {
    return { action: 'take-over', to: [], toType: freeFallback(reviewerTypeOf(a), account).type!, else: 'wait', field: 'review.fallback' };
  }
  return f;
}

// A sentence for the notice: what runs if nobody acts.
export function describe(account: string, kind: BlockerKind, agent?: { type?: string | null; role?: string | null } | null): string {
  if (!covers(kind)) return '';
  const f = actionForAgent(agent ?? {}, account, kind);
  return `If no manager acts on this agent within ${minutes()} minutes, stam applies the fallback: ${phrase(f)}${f.field ? ` (${f.field})` : ' (the default)'}.`;
}

// Starts the timer for a blocker-set notice, for the blocker generation `since`. Called by
// cost-notices.blockerChanged.
export function arm(n: CostNotice, kind: BlockerKind, since: string, now: number = Date.now()): void {
  if (!n.agent_id || !covers(kind)) return;
  table();
  db.open()
    .prepare('INSERT OR IGNORE INTO cost_fallbacks (notice_id, agent_id, kind, account, blocker_since, due_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(n.id, n.agent_id, kind, n.account, since, Math.round(now + minutes() * 60_000));
  schedule(now);
}

// The blocker cleared: its pending fallbacks are retired. Called by cost-notices.blockerChanged.
export function retire(agentId: string, kind: BlockerKind, account: string): void {
  if (!covers(kind)) return;
  table();
  db.open()
    .prepare("UPDATE cost_fallbacks SET state = 'done', result = 'skipped: the blocker cleared' WHERE agent_id = ? AND kind = ? AND account = ? AND state = 'pending'")
    .run(agentId, kind, account);
}

// An explicit archive or shut-down ends the agent's fallbacks (S-2458). A pending row is retired
// now, so its timer finds nothing to run. A claimed or running row gets the reason, which unwanted
// reads at its next check, so its take-over cancels before the stop. Called by lifecycle.archive
// and lifecycle.explicitShutdown.
export function cancelPending(agentId: string, why: string): void {
  table();
  const d = db.open();
  d.prepare("UPDATE cost_fallbacks SET state = 'done', result = ? WHERE agent_id = ? AND state = 'pending'").run(`skipped: ${why}`, agentId);
  d.prepare("UPDATE cost_fallbacks SET cancel = ? WHERE agent_id = ? AND state IN ('claimed', 'running')").run(why, agentId);
}

// An archive or shut-down is pending on the agent (its pending_action), so no fallback runs for it.
const endingPending = (a: db.Agent): boolean => !!a.pending_action && ['archive', 'shutdown'].includes(JSON.parse(a.pending_action).type);

// A manager acted on an agent (`via` names how): its open notices are acknowledged, which
// stops their fallbacks. Returns the acknowledged notice ids.
export function ackAgent(agentId: string, by: string, via: string): string[] {
  return costNotices
    .openNotices([agentId])
    .filter((n) => costNotices.ack(n.id, by, via).ok)
    .map((n) => n.id);
}

// Whether `by` pausing or unpausing the agent counts as its manager acting: anyone who may
// manage its tree (the human, the assistant, the chief of staff, an ancestor).
export function isManagerOf(agentId: string, by: string): boolean {
  const a = db.getAgent(agentId);
  return !!a && mayManageTree(by, a);
}

export function row(noticeId: string): FallbackRow | undefined {
  table();
  return db.open().prepare('SELECT * FROM cost_fallbacks WHERE notice_id = ?').get(noticeId) as FallbackRow | undefined;
}

// The presets a take-over target names: the preset itself, or every preset on the account
// or harness it names.
function presetsFor(target: string): string[] {
  const presets: Record<string, unknown> = registry().presets ?? {};
  if (Object.hasOwn(presets, target)) return [target];
  const cost = settings().cost;
  const account = resolveTarget(cost, target);
  if (!account) return [];
  return Object.keys(presets).filter((p) => resolveTarget(cost, p) === account);
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// A plain action, one with no targets. Returns the result sentence.
async function plain(name: string, a: db.Agent, r: FallbackRow): Promise<string> {
  const held = `${a.name} stays held until its ${r.kind} blocker clears`;
  if (name === 'soft-stop' || name === 'hard-stop') return `waited: the admission gate already holds ${a.name}, so ${name} works as wait; ${held}`;
  if (name === 'continue') {
    // A spent budget lifts only on a rollover or a raise by the human, never by a fallback.
    if (r.kind === 'budget') return `waited: a spent budget is lifted only by a period rollover or a raise by the human, so continue works as wait; ${held}`;
    if (settings().cost.accounts?.[r.account]?.paid !== true) return `waited: continue needs paid: true on ${r.account || 'the account'}, so it works as wait; ${held}`;
    const blockers = await import('./blockers.ts');
    db.addEvent(a.id, 'cost:override', { blockers: [{ kind: r.kind, account: r.account }], by: STAM, fallback: r.notice_id });
    await blockers.clearBlocker(a.id, r.kind, r.account, `the cost fallback continued on paid account ${r.account}`);
    return `continued: removed ${a.name}'s ${r.kind} blocker on paid account ${r.account} (cost:override)`;
  }
  if (name !== 'wait') return `waited: unknown action ${name} works as wait; ${held}`;
  return `waited: ${held}`;
}

// One cost_switch of a take-over: its result sentence, or null when the check refused (the reason goes to `refused`).
async function switchTo(a: db.Agent, r: FallbackRow, target: { preset: string; toType?: string }, f: FallbackAction, refused: string[] = []): Promise<string | null> {
  const costSwitch = await import('./cost-switch.ts');
  const opts = { agent: a.id, ...target, by: STAM };
  let plan;
  try {
    plan = costSwitch.check(opts);
  } catch (e) {
    refused.push(`${target.preset}: ${msg(e)}`);
    return target.toType ? `take-over to ${target.preset} refused (${msg(e)}); then ${await plain(f.else, a, r)}` : null;
  }
  try {
    const res = await costSwitch.costSwitch({ ...opts, stillWanted: () => unwanted(r) }, plan);
    const onto = target.toType ? `on the reviewer fallback type ${target.toType}` : `on preset ${target.preset}`;
    return `took over: ${res.from} now continues as ${res.to} ${onto}`;
  } catch (e) {
    if ((e as { cancelled?: boolean }).cancelled) return `cancelled: ${msg(e)}`;
    return `take-over to ${target.preset} failed (${msg(e)}); then ${await plain(f.else, db.getAgent(a.id) ?? a, r)}`;
  }
}

// take-over: cost_switch to the first eligible preset, else the `else` action.
async function takeOver(f: FallbackAction, a: db.Agent, r: FallbackRow): Promise<string> {
  const refused: string[] = [];
  const cost = settings().cost;
  if (f.toType) {
    // The agent's own chain decides again now; the type must still be the first free one.
    const fb = freeFallback(reviewerTypeOf(a), r.account);
    if (fb.type !== f.toType) return `no take-over type was eligible (${f.toType}: ${fb.reasons.join('; ') || 'no longer the first free type'}); then ${await plain(f.else, a, r)}`;
    return (await switchTo(a, r, { preset: `type:${f.toType}`, toType: f.toType }, f))!;
  }
  for (const target of f.to) {
    // An inherited cost.onError may name the agent's own account (accounts.validate allows
    // that only there); work never moves onto the account it is blocked on.
    const presets = presetsFor(target).filter((p) => resolveTarget(cost, p) !== r.account);
    if (!presets.length) refused.push(`${target}: no preset off ${r.account || 'this account'}`);
    for (const preset of presets) {
      const done = await switchTo(a, r, { preset }, f, refused);
      if (done) return done;
    }
  }
  return `no take-over preset was eligible (${refused.join('; ') || 'none named'}); then ${await plain(f.else, a, r)}`;
}

// A reviewer that hits a usage limit this soon after it was created never got going (S-381).
export const SPAWN_WINDOW_MS = 5 * MIN_MS;
const relaunched = new Set<string>();

// A reviewer that dies on a limit error right after its spawn is relaunched on the reviewer
// fallback with its brief, at once, not after the notice's fallback minutes. At most once per
// agent, and never for a relaunch itself; with no usable fallback its parent is mailed.
// Returns the result sentence, or null when the agent isn't such a reviewer.
export async function relaunchReviewerAtSpawn(agentId: string, now: number = Date.now()): Promise<string | null> {
  const a = db.getAgent(agentId);
  if (!a || !db.isLive(a) || !isReviewer(a) || a.forwarded_to) return null;
  if (now - Date.parse(a.created_at) > SPAWN_WINDOW_MS || /-t\d+$/.test(a.name) || relaunched.has(a.id)) return null;
  relaunched.add(a.id);
  const account = accountFor(a) ?? '';
  const told = (why: string) => {
    if (a.parent_id) void sendFromStam([a.parent_id], `Reviewer ${a.name} died on a usage limit at spawn`, `${a.name} hit a usage limit right after it started, and stam couldn't relaunch it: ${why}. Spawn the review again once the account clears or a reviewer fallback type is set (review.fallback on its type).`).catch(() => {});
    db.addEvent(a.id, 'reviewer:relaunch', { ok: false, why });
    return `not relaunched: ${why}`;
  };
  const fb = freeFallback(reviewerTypeOf(a), account);
  if (!fb.type) return told(`no free reviewer fallback type: ${fb.reasons.join('; ')}`);
  const costSwitch = await import('./cost-switch.ts');
  const opts = { agent: a.id, preset: `type:${fb.type}`, toType: fb.type, by: STAM };
  try {
    const res = await costSwitch.costSwitch(opts, costSwitch.check(opts));
    db.addEvent(a.id, 'reviewer:relaunch', { ok: true, to: res.to });
    return `relaunched: ${res.from} now continues as ${res.to} on the reviewer fallback type ${fb.type}`;
  } catch (e) {
    // Another transition has it already; nothing to report.
    if (/already being switched|already taken over/.test(msg(e))) return null;
    return told(msg(e));
  }
}

// The chief of staff, when it can take the news: not the blocked agent, active, unblocked.
function reachableChief(blocked: string): db.Agent | undefined {
  const cos = chiefOfStaff();
  if (!cos || cos.id === blocked || cos.lifecycle !== 'active' || cos.forwarded_to || db.blockerRows(cos.id).length) return undefined;
  return cos;
}

// Tells the chief of staff, or the human when it can't. Returns who was told.
function tell(a: db.Agent, r: FallbackRow, f: FallbackAction, result: string): string {
  const managers = costNotices.managerOf(a.id).map((m) => db.getAgent(m)?.name ?? m);
  const body = render('cost-fallback', {
    agent: a.name,
    event: r.notice_id,
    minutes: minutes(),
    blocker: `${r.kind}${r.account ? ` on ${r.account}` : ''}`,
    action: phrase(f),
    field: f.field || 'no configured action, so the default',
    result,
    managers: managers.join(', ') || '(none)',
  });
  const subject = `[stam] Cost fallback ran for ${a.name}: ${f.action}`;
  const cos = reachableChief(a.id);
  if (cos) {
    costNotices.deliver(cos.id, subject, body);
    db.addEvent(cos.id, 'cost:fallback-told', { agent: a.name, event: r.notice_id });
    return cos.name;
  }
  if (!humanMailAllows('necessary')) return '';
  const why = chiefOfStaff()?.id === a.id ? 'The chief of staff is the blocked agent' : 'The chief of staff is unavailable or blocked';
  void sendFromStam([HUMAN], subject, `${body}\n\n${why}, so this reaches you instead.`).catch(() => {});
  return HUMAN;
}

// The blocker this row was armed for, by kind, account and generation.
function blockerState(r: FallbackRow): 'same' | 'replaced' | 'cleared' {
  const b = (db.blockerRows(r.agent_id) as { kind: string; account: string; since: string }[]).find((x) => x.kind === r.kind && x.account === r.account);
  return !b ? 'cleared' : b.since === r.blocker_since ? 'same' : 'replaced';
}

// Why the fallback no longer applies, or null: a manager acked the notice, the blocker
// cleared or was replaced, or someone paused the agent after the claim.
function unwanted(r: FallbackRow): string | null {
  const n = costNotices.notice(r.notice_id);
  if (!n) return 'its notice is gone';
  // An explicit archive or shut-down of the agent since the claim (S-2458). Read fresh: r may predate it.
  const cancel = row(r.notice_id)?.cancel;
  if (cancel) return cancel;
  if (n.acked_at) return `${n.acked_by === HUMAN ? 'the human' : (db.getAgent(n.acked_by ?? '')?.name ?? n.acked_by)} acted on it`;
  const a = db.getAgent(r.agent_id);
  if (a && endingPending(a)) return `${a.name} is being archived or shut down`;
  const b = blockerState(r);
  if (b !== 'same') return `the blocker ${b === 'cleared' ? 'cleared' : 'was replaced by a newer one'}`;
  if (!r.prior) return null; // not claimed yet: nothing to compare the pauses against
  const before: string[] = JSON.parse(r.prior).owners;
  const added = a ? pauseOwners(a).filter((o) => !before.includes(o)) : [];
  if (added.length) return `${added.map((o) => (o === HUMAN ? 'the human' : (db.getAgent(o)?.name ?? o))).join(', ')} paused it`;
  return null;
}

// Runs one due fallback. Claims the row first, so a second evaluate can't run it too.
async function run(r: FallbackRow): Promise<void> {
  const d = db.open();
  // The agent's archive or shut-down is checked in this same statement, so one that lands after the due scan stops the claim (S-2458).
  const claimed = d.prepare(`UPDATE cost_fallbacks SET state = 'claimed', ran_at = ? WHERE notice_id = ? AND state = 'pending'
    AND agent_id NOT IN (SELECT id FROM agents WHERE lifecycle = 'archived' OR json_extract(pending_action, '$.type') IN ('archive', 'shutdown'))`).run(new Date().toISOString(), r.notice_id);
  if (Number(claimed.changes) !== 1) {
    // Still pending: the claim refused it, so it is retired here. A row another run claimed is not pending and stays as it is.
    d.prepare("UPDATE cost_fallbacks SET state = 'done', result = ? WHERE notice_id = ? AND state = 'pending'").run('skipped: the agent is archived, or its archive or shut-down is pending', r.notice_id);
    return;
  }
  const done = (result: string) => d.prepare("UPDATE cost_fallbacks SET state = 'done', result = ? WHERE notice_id = ?").run(result, r.notice_id);
  const a = db.getAgent(r.agent_id);
  if (!a || !db.isLive(a) || a.forwarded_to) return void done('skipped: the agent is gone or taken over');
  const why = unwanted({ ...r, prior: null });
  if (why) return void done(`skipped: ${why}`);
  r = { ...r, prior: JSON.stringify({ lifecycle: a.lifecycle, owners: pauseOwners(a) }) };
  d.prepare("UPDATE cost_fallbacks SET state = 'running', prior = ? WHERE notice_id = ?").run(r.prior, r.notice_id);
  const f = actionForAgent(a, r.account, r.kind);
  db.addEvent(a.id, 'cost:fallback', { step: 'start', event: r.notice_id, action: phrase(f) });
  let result: string;
  try {
    result = f.action === 'take-over' ? await takeOver(f, a, r) : await plain(f.action, a, r);
  } catch (e) {
    result = `failed: ${msg(e)}`;
  }
  const told = tell(db.getAgent(a.id) ?? a, r, f, result);
  done(result);
  db.addEvent(a.id, 'cost:fallback', { step: 'done', event: r.notice_id, result, told });
}

// Runs every fallback due by `now`, then sets the timer for the next. Called by the timer and
// at daemon start.
export async function evaluate(now: number = Date.now()): Promise<void> {
  table();
  const due = db.open().prepare("SELECT * FROM cost_fallbacks WHERE state = 'pending' AND due_at <= ? ORDER BY due_at").all(now) as unknown as FallbackRow[];
  for (const r of due) {
    try {
      await run(r);
    } catch {}
  }
  schedule();
}

let timer: ReturnType<typeof setTimeout> | undefined;
function schedule(now: number = Date.now()): void {
  table();
  clearTimeout(timer);
  timer = undefined;
  const next = db.open().prepare("SELECT MIN(due_at) AS due FROM cost_fallbacks WHERE state = 'pending'").get() as { due: number | null };
  if (next?.due == null) return;
  timer = setTimeout(() => void evaluate(), Math.min(Math.max(0, next.due - now), 2 ** 31 - 1));
  timer.unref?.();
}

// The rows a previous daemon left mid-run. A claimed row did nothing yet, so it runs again. A
// running row is reconciled, never repeated blindly: a successor that exists means the
// take-over got through; otherwise its partial effects are undone (the taken-over blocker, a
// stop of an agent that ran) and it retries once.
export async function recover(): Promise<void> {
  table();
  const d = db.open();
  d.prepare("UPDATE cost_fallbacks SET state = 'pending', ran_at = NULL WHERE state = 'claimed'").run();
  for (const r of d.prepare("SELECT * FROM cost_fallbacks WHERE state = 'running'").all() as unknown as FallbackRow[]) {
    const done = (result: string) => d.prepare("UPDATE cost_fallbacks SET state = 'done', result = ? WHERE notice_id = ?").run(result, r.notice_id);
    const a = db.getAgent(r.agent_id);
    if (!a) {
      done('skipped: the agent is gone');
      continue;
    }
    if (a.forwarded_to) {
      done(`took over (reconciled after a restart): ${a.name} continues as ${db.getAgent(a.forwarded_to)?.name ?? a.forwarded_to}`);
      continue;
    }
    d.prepare("DELETE FROM blockers WHERE agent_id = ? AND kind = 'taken-over'").run(a.id);
    const prior = r.prior ? (JSON.parse(r.prior) as { lifecycle: string }) : null;
    if (prior && (prior.lifecycle === 'active' || prior.lifecycle === 'paused') && db.getAgent(a.id)!.lifecycle === 'shut_down') {
      const lifecycle = await import('./lifecycle.ts');
      // A held agent comes back paused, as any resume of one does.
      await lifecycle.resume(db.getAgent(a.id)!, '').catch((e) => db.addEvent(a.id, 'cost:fallback-resume-error', msg(e)));
    }
    db.addEvent(a.id, 'cost:fallback', { step: 'recovered', event: r.notice_id, attempts: r.attempts });
    if (r.attempts >= 1) done('failed: interrupted by a daemon restart twice');
    else d.prepare("UPDATE cost_fallbacks SET state = 'pending', attempts = attempts + 1, prior = NULL, ran_at = NULL WHERE notice_id = ?").run(r.notice_id);
  }
}

// At daemon start: recovers rows left mid-run, runs the fallbacks that came due while the
// daemon was down, and sets the timer for the rest.
export async function reschedule(): Promise<void> {
  await recover();
  await evaluate();
}
