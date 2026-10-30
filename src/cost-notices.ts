// Cost notices to the responsible manager (docs/cost-policy.md, build step 11). A cost
// event goes to the manager of the tree it concerns, not only to the human: a window
// crossing a warn percentage, a window projected to reach 100% within 30 minutes, a cost
// blocker set or cleared, and low OpenRouter credit. A manager is an agent's direct
// parents, or the chief of staff for an agent without one. Account-wide events go to the
// managers of every active agent on the account, deduplicated, one notice each.
//
// A notice is delivered with queueNotice while the manager is in a turn, and as mail from
// stam otherwise (mirroring usage.ts's human mail). It carries the event id, the numbers,
// the tree's estimated share of the window, the user's cost instructions, and the manager's
// options. `cost_ack EVENT` records that a manager handled the event, keyed by its id, and
// stops the event's fallback timer (cost-fallback.ts).
import { randomBytes } from 'node:crypto';
import * as db from './db.ts';
import { settings, humanMailAllows, SYSTEM_ACCOUNT } from './settings.ts';
import { render } from './templates.ts';
import { queueNotice, sendFromSystem, sendFromSystemMail, HUMAN } from './mail.ts';
import { accountFor } from './accounts.ts';
import { windowShares, treeShare } from './attribution.ts';
import { chiefOfStaff } from './org.ts';
import type { BlockerKind } from './blockers.ts';
import * as fallback from './cost-fallback.ts';
import { withdrawQuietly } from './withdraw.ts';
import { timed } from './stall.ts';

export type CostEventKind = 'window' | 'projection' | 'blocker-set' | 'blocker-clear' | 'credits-low' | 'allocation' | 'budget-low' | 'reserve-near';

export interface CostNotice {
  id: string;
  // The dedup key: one notice per window and reset (or per blocker change).
  key: string;
  kind: CostEventKind;
  account: string;
  window: string;
  resets_at: number | null;
  // The agent the event is about, for blocker notices; null for account-wide events.
  agent_id: string | null;
  // The managers the notice went to (or the human, when there is no manager).
  managers: string[];
  created_at: string;
  acked_at: string | null;
  acked_by: string | null;
  // The human's mail that carried the notice, when it reached them by mail (withdraw_ask, S-425).
  human_mail_id: string | null;
}

// The table lives here rather than in db.ts's schema, so this step is self-contained.
let ready = false;
function table(): void {
  if (ready) return;
  db.open().exec(`CREATE TABLE IF NOT EXISTS cost_notices (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    account TEXT NOT NULL DEFAULT '',
    window TEXT NOT NULL DEFAULT '',
    resets_at INTEGER,
    agent_id TEXT,
    managers TEXT NOT NULL,
    created_at TEXT NOT NULL,
    acked_at TEXT,
    acked_by TEXT
  )`);
  // The human's mail for a notice (human_mail_id): added to a table made before it, once.
  if (!(db.open().prepare('PRAGMA table_info(cost_notices)').all() as { name: string }[]).some((c) => c.name === 'human_mail_id'))
    db.open().exec('ALTER TABLE cost_notices ADD COLUMN human_mail_id TEXT');
  ready = true;
}

type Row = Omit<CostNotice, 'managers'> & { managers: string };
const parse = (r: Row): CostNotice => ({ ...r, managers: JSON.parse(r.managers) });

// The manager responsible for an agent: its direct parents, or the chief of staff when it
// has none. Empty when neither exists, so the caller can fall back to the human.
export function managerOf(agentId: string): string[] {
  const a = db.getAgent(agentId);
  if (!a) return [];
  const parents = db.parentsOf(a).filter((p) => db.getAgent(p));
  if (parents.length) return parents;
  const cos = chiefOfStaff();
  return cos && cos.id !== a.id ? [cos.id] : [];
}

// The chief of staff's id as a list, empty when there is none: the recipient for scopes with no agents.
export function chiefOfStaffIds(): string[] {
  const cos = chiefOfStaff();
  return cos ? [cos.id] : [];
}

// The managers of every active agent that `pred` picks, deduplicated. A manager that is
// itself on the account still counts as a recipient.
function managersOfActive(pred: (a: db.Agent) => boolean): string[] {
  const out = new Set<string>();
  for (const a of db.listAgents()) {
    if (a.lifecycle !== 'active' || !pred(a)) continue;
    for (const m of managerOf(a.id)) out.add(m);
  }
  return [...out];
}

function managersOnAccount(account: string): string[] {
  return managersOfActive((a) => accountFor(a) === account);
}

function managersOnOpenRouter(): string[] {
  return managersOfActive((a) => a.harness === 'opencode' && (a.model ?? '').startsWith('openrouter/'));
}

// The account a subscription reading belongs to: its name is the harness (Claude) or
// `codex` / `codex:ID` (Codex), so match on the harness part.
function accountForReading(name: string): string | undefined {
  const harness = name.split(':')[0];
  return accountFor({ harness }) ?? Object.keys(settings().cost.accounts ?? {}).find((n) => settings().cost.accounts[n]?.match?.harness === harness);
}

// The human is a manager only as a fallback, when no manager exists and the user wants to
// hear this kind of thing (settings.humanMail.when).
function humanFallback(): string[] {
  return humanMailAllows('important') ? [HUMAN] : [];
}

// A window's shares for the share lines, kept for SHARES_TTL_MS. A provider error storm blocks and
// unblocks nearly every agent at once, and each notice calibrated the window again for each of its
// managers: single stalls of 40 to 112 s live (S-4356). Each line still sums its own tree. The
// shares are the window's now, on the wall clock as before (and as the Go mirror's shareLine);
// `sharesClock` is the tests' seam.
const SHARES_TTL_MS = 10_000;
const sharesMemo = new Map<string, { at: number; value: ReturnType<typeof windowShares> }>();
export const sharesClock = { now: (): number => Date.now() };

export function resetSharesMemo(): void {
  sharesMemo.clear();
}

function noticeShares(account: string, window: string): ReturnType<typeof windowShares> {
  const now = sharesClock.now();
  const key = `${account}\u0000${window}`;
  const hit = sharesMemo.get(key);
  if (hit && now >= hit.at && now - hit.at < SHARES_TTL_MS) return hit.value;
  const value = windowShares(account, window, undefined, now);
  sharesMemo.set(key, { at: now, value });
  return value;
}

// One tree's estimated share of a window, as a sentence for the notice. Reads nothing when
// no window reading exists yet, rather than claiming a 0% share.
function shareLine(manager: string, account: string, window: string): string {
  return timed('cost notice: share line', () => shareLineUntimed(manager, account, window));
}

function shareLineUntimed(manager: string, account: string, window: string): string {
  const harness = settings().cost.accounts?.[account]?.match?.harness;
  const has = harness ? db.open().prepare('SELECT 1 AS n FROM window_readings WHERE name = ? AND window = ? LIMIT 1').get(harness, window) : undefined;
  const win = window.replace('_', '-');
  if (!has) return `No ${win} reading yet to estimate this tree's share of ${account}.`;
  const share = treeShare(manager, account, window, undefined, noticeShares(account, window));
  return `This tree's estimated share of the ${win} window on ${account}: about ${Math.round(share * 100) / 100}% (stam's estimate, never a rule).`;
}

// A share line for a blocker whose account may be a real account or a scope such as
// `global`; no line when there is no window reading to base one on.
function blockerUsage(manager: string, account: string): string {
  const harness = account ? settings().cost.accounts?.[account]?.match?.harness : undefined;
  if (!harness) return 'No subscription window for this blocker.';
  const windows = (db.open().prepare('SELECT DISTINCT window FROM window_readings WHERE name = ?').all(harness) as { window: string }[]).map((r) => r.window);
  if (!windows.length) return `No window reading yet to estimate this tree's share of ${account}.`;
  return windows.map((w) => shareLine(manager, account, w)).join('\n');
}

interface Raise {
  kind: CostEventKind;
  account?: string;
  window?: string;
  resets_at?: number | null;
  agent_id?: string | null;
  key: string;
  managers: string[];
  summary: string;
  detail: string;
  usageOf: (manager: string) => string;
}

// Records the event once (its key is unique) and delivers one notice to each manager, or to
// the human when there is no manager. Returns the stored notice, or undefined when it was a
// duplicate or had no recipient.
function raise(r: Raise, now: number): CostNotice | undefined {
  // A notice is a side effect of cost tracking: it must never break the report that raised
  // it, so a failure here (a bad template, a full disk) is swallowed, not propagated.
  try {
    table();
    if (db.open().prepare('SELECT 1 AS n FROM cost_notices WHERE key = ?').get(r.key)) return undefined;
    const targets = r.managers.length ? r.managers : humanFallback();
    if (!targets.length) return undefined;
    const id = 'cn-' + randomBytes(4).toString('hex');
    const notice: CostNotice = {
      id,
      key: r.key,
      kind: r.kind,
      account: r.account ?? '',
      window: r.window ?? '',
      resets_at: r.resets_at ?? null,
      agent_id: r.agent_id ?? null,
      managers: targets,
      created_at: new Date(now).toISOString(),
      acked_at: null,
      acked_by: null,
      human_mail_id: null,
    };
    db.open()
      .prepare('INSERT INTO cost_notices (id, key, kind, account, window, resets_at, agent_id, managers, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(notice.id, notice.key, notice.kind, notice.account, notice.window, notice.resets_at, notice.agent_id, JSON.stringify(targets), notice.created_at);
    const instructions = settings().cost.instructions?.trim() || '(none set)';
    const subject = `[stam] Cost notice ${id}: ${r.summary}`;
    for (const m of targets) {
      const body = render('cost-notice', { event: id, summary: r.summary, detail: r.detail, usage: r.usageOf(m), instructions });
      deliver(m, subject, body, (mailId) => setHumanMail(id, mailId));
      if (m !== HUMAN) db.addEvent(m, 'cost:notice', { event: id, kind: r.kind, account: notice.account });
    }
    return notice;
  } catch {
    return undefined;
  }
}

// The human's mail that carried a notice, once sent. An ack that landed before the mail was stored
// settles it now (withdraw_ask, S-425).
function setHumanMail(eventId: string, mailId: string): void {
  db.open().prepare('UPDATE cost_notices SET human_mail_id = ? WHERE id = ?').run(mailId, eventId);
  const n = notice(eventId);
  if (n?.acked_at && n.acked_by && n.acked_by !== HUMAN) settleHumanCopy(mailId, n.acked_by, eventId);
}

// A manager's ack withdraws the human's copy of the notice, with who handled it.
function settleHumanCopy(mailId: string, by: string, eventId: string): void {
  withdrawQuietly([mailId], by, `Withdrawn by @${db.getAgent(by)?.name ?? by}: cost notice ${eventId} handled`);
}

// A working manager gets an in-turn notice (it passes the gate and arrives after its next
// tool call); anyone else gets mail from stam, which reaches an idle manager as a prompt.
// `onSent` gets the id of the mail when it goes to the human.
export function deliver(manager: string, subject: string, body: string, onSent?: (mailId: string) => void): void {
  if (manager === HUMAN) {
    void sendFromSystemMail('cost', [HUMAN], subject, body)
      .then((m) => {
        if (m && onSent) onSent(m.id);
      })
      .catch(() => {});
    return;
  }
  const a = db.getAgent(manager);
  if (a && a.lifecycle === 'active' && a.activity === 'working') queueNotice(manager, body);
  else void sendFromSystem('cost', [manager], subject, body).catch(() => {});
}

// A subscription window crossed a warn percentage. Called from usage.reportSubscription.
export function windowWarning(name: string, window: string, percent: number, threshold: number, resets_at: number | undefined, now = Date.now()): void {
  const account = accountForReading(name) ?? name;
  const win = window.replace('_', '-');
  const resets = resets_at ? new Date(resets_at * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'at an unknown time';
  raise(
    {
      kind: 'window',
      account,
      window,
      resets_at: resets_at ?? null,
      key: `window:${account}:${window}:${threshold}:${resets_at ?? 'none'}`,
      managers: managersOnAccount(account),
      summary: `${name} ${win} at ${percent}% (threshold ${threshold}%)`,
      detail: `The ${win} window is at ${percent}%, past the ${threshold}% warning line, and resets ${resets}.`,
      usageOf: (m) => shareLine(m, account, window),
    },
    now,
  );
}

// A window is projected to reach 100% within 30 minutes. Called from usage.reportSubscription;
// throttled, so a statusline refresh doesn't recompute the fit every time.
const lastProjection = new Map<string, number>();
const PROJECTION_MS = 5 * 60_000;
const WITHIN_MS = 30 * 60_000;

export function checkProjection(name: string, window: string, now = Date.now()): void {
  const account = accountForReading(name);
  if (!account) return;
  const k = `${account}:${window}`;
  if (now - (lastProjection.get(k) ?? -Infinity) < PROJECTION_MS) return;
  lastProjection.set(k, now);
  const proj = windowShares(account, window, undefined, now).projection;
  if (!proj.reaches_100_at) return;
  const at = Date.parse(proj.reaches_100_at);
  if (!(at > now && at - now <= WITHIN_MS)) return;
  const managers = managersOnAccount(account);
  const win = window.replace('_', '-');
  raise(
    {
      kind: 'projection',
      account,
      window,
      key: `projection:${account}:${window}:${proj.resets_at ?? 'none'}`,
      managers,
      summary: `${account} ${win} projected to reach 100% around ${proj.reaches_100_at.slice(11, 16)} UTC`,
      detail: `At the last 30 minutes' rate, ${account}'s ${win} window reaches 100% around ${proj.reaches_100_at.replace('T', ' ').slice(0, 16)} UTC.`,
      usageOf: (m) => shareLine(m, account, window),
    },
    now,
  );
}

// A cost blocker was set or cleared on an agent; its manager hears, whoever set it. `when`
// is the blocker's `since` for a set, or the clear time, so a refresh of the same blocker
// doesn't re-notify.
export function blockerChanged(agentId: string, kind: BlockerKind, account: string, action: 'set' | 'clear', reason: string, when: string, now = Date.now()): void {
  // cost_switch tells the managers itself (switched); its taken-over blocker is no news.
  if (kind === 'taken-over') return;
  const a = db.getAgent(agentId);
  const name = a?.name ?? agentId;
  const what = `${kind}${account ? ` on ${account}` : ''}`;
  const set = `Stam set a cost blocker on ${name}: ${reason}.`;
  // No notice for an archived or shut-down agent: a notice asks a manager to act within
  // minutes, and a finished agent needs no act (S-787). Its clear still retires any timer.
  const notice = a && db.isLive(a) ? raise(
    {
      kind: action === 'set' ? 'blocker-set' : 'blocker-clear',
      account,
      agent_id: agentId,
      key: `${action === 'set' ? 'blocker-set' : 'blocker-clear'}:${agentId}:${kind}:${account}:${when}`,
      managers: managerOf(agentId),
      summary: action === 'set' ? `${name} blocked: ${what}` : `${name} unblocked: ${what}`,
      detail: action === 'set' ? [set, fallback.describe(account, kind, a)].filter(Boolean).join('\n') : `The blocker on ${name} cleared: ${reason || 'its condition cleared'}.`,
      usageOf: (m) => blockerUsage(m, account),
    },
    now,
  ) : undefined;
  // A blocker that has a fallback starts its timer, for this generation of the blocker
  // (`when` is its since); acting on the agent stops it, and its clear retires it.
  try {
    if (notice && action === 'set') fallback.arm(notice, kind, when, now);
    if (action === 'clear') fallback.retire(agentId, kind, account);
  } catch {}
}

// Low OpenRouter credit. credits.ts decides when a warning is due (once per top-up) and
// passes a `basis` naming the capacity, so a top-up re-arms the notice.
export function lowCredits(remaining: number, threshold: number, basis: string, now = Date.now()): void {
  raise(
    {
      kind: 'credits-low',
      account: 'openrouter',
      key: `credits:${threshold}:${basis}`,
      managers: managersOnOpenRouter(),
      summary: `OpenRouter credit low: $${remaining.toFixed(2)} left`,
      detail: `The OpenRouter balance is $${remaining.toFixed(2)}, below the $${threshold.toFixed(2)} warning threshold. OpenCode agents on OpenRouter stop when it reaches zero.`,
      usageOf: () => 'OpenRouter credit is not a subscription window, so stam has no percentage share for it.',
    },
    now,
  );
}

// The shared OpenRouter credit is near the share kept for stam's own model calls (budgets.ts's
// reserve). Once per top-up: `basis` names the credit capacity, so a top-up re-arms it.
export function reserveNear(remaining: number, reserve: number, basis: string, now = Date.now()): void {
  raise(
    {
      kind: 'reserve-near',
      account: 'openrouter',
      key: `reserve-near:${basis}`,
      managers: [...new Set([...managersOnOpenRouter(), ...chiefOfStaffIds()])],
      summary: `OpenRouter credit near the system reserve: $${remaining.toFixed(2)} left`,
      detail: `The OpenRouter balance is $${remaining.toFixed(2)}; $${reserve.toFixed(2)} of it is kept for stam's own model calls (mail gate, titles, summaries, decisions). When the balance falls to $${reserve.toFixed(2)}, stam holds the agents on OpenRouter and refuses new ones until the human tops up.`,
      usageOf: () => 'OpenRouter credit is not a subscription window, so stam has no percentage share for it.',
    },
    now,
  );
}

// A budget scope's paid spend reached 90% of its budget (src/budgets.ts). `managers` are those of
// the trees on the account (every managed tree for `global`); `key` dedups per scope, period
// and budget amount.
export function budgetLow(scope: string, key: string, spent: number, usd: number, what: string, managers: string[], now = Date.now()): void {
  raise(
    {
      kind: 'budget-low',
      account: scope,
      key: `budget-low:${key}`,
      managers,
      summary: `${scope} at ${Math.round((spent / usd) * 100)}% of its ${what}`,
      detail: `Paid spend on ${scope} is $${spent.toFixed(2)} of its $${usd.toFixed(2)} ${what}. ${scope === SYSTEM_ACCOUNT ? "Stam skips its own model calls (mail gate, titles, summaries, decisions) when it is spent" : `Stam stops the agents on ${scope} when it is spent`}; only the human raises a budget, and stam asks them then.`,
      usageOf: () => 'A budget is paid dollars, not a subscription window, so stam has no percentage share for it.',
    },
    now,
  );
}

// An allocation reached 80% or 100% of its tree's allocation (docs/cost-policy.md, build
// step 10). It goes to the tree's manager and to the tree's root. Unlike a window warning,
// the recipients are always known, so it never falls back to the human. `basis` is the
// window reset (or period start) the notice dedups on; the cost_notices key is unique.
export interface AllocationNotice {
  allocation: string;
  root: string;
  account: string;
  kind: 'window' | 'usd';
  window: string;
  period: string;
  used: number;
  of: number;
  used_percent: number;
  threshold: number;
  basis: string;
  projection: string;
  note: string | null;
}

export function allocationWarning(e: AllocationNotice, now = Date.now()): CostNotice | undefined {
  const root = db.getAgent(e.root);
  if (!root) return undefined;
  // The tree's manager and the tree's root itself, each once.
  const targets = [...new Set([...managerOf(root.id), root.id])].filter((id) => id === HUMAN || db.getAgent(id));
  const unit = e.kind === 'usd' ? `$${e.used.toFixed(2)}` : `${e.used}%`;
  const ofUnit = e.kind === 'usd' ? `$${e.of}` : `${e.of}%`;
  const what = e.kind === 'usd' ? `its ${e.period} paid-spend allocation on ${e.account}` : `its ${e.window.replace('_', '-')} allocation on ${e.account}`;
  const detail = [
    `The tree rooted at ${root.name} has used about ${unit} of ${ofUnit} — ${Math.round(e.used_percent)}% of ${what}.`,
    e.projection,
    e.note ? `Note on the allocation: ${e.note}` : '',
    'Allocations are not enforced: this is a notice, not a stop, and what happens next is the manager\'s call.',
  ]
    .filter(Boolean)
    .join('\n');
  return raise(
    {
      kind: 'allocation',
      account: e.account,
      window: e.window,
      agent_id: root.id,
      key: `allocation:${e.allocation}:${e.threshold}:${e.basis}`,
      managers: targets,
      summary: `${root.name} at ${Math.round(e.used_percent)}% of its ${e.kind === 'usd' ? `${e.period} spend` : e.window.replace('_', '-')} allocation (${unit} of ${ofUnit})`,
      detail,
      usageOf: (m) =>
        e.kind === 'usd'
          ? `This tree's ${e.period} paid spend on ${e.account}: about $${e.used.toFixed(2)} of its $${e.of} allocation (stam's estimate).`
          : shareLine(m, e.account, e.window),
    },
    now,
  );
}

export interface AckResult {
  ok: boolean;
  event?: string;
  error?: string;
}

// Records that a manager handled a cost event, keyed by the event id in its notice, which
// stops its fallback. `via` names how: cost_ack, or the tool or pause that counted as acting.
export function ack(eventId: string, by: string, via = 'cost_ack'): AckResult {
  table();
  const row = db.open().prepare('SELECT * FROM cost_notices WHERE id = ?').get(eventId) as Row | undefined;
  if (!row) return { ok: false, error: `no cost notice ${eventId}` };
  if (row.acked_at) return { ok: false, error: `${eventId} was already acknowledged by ${row.acked_by}` };
  const at = new Date().toISOString();
  db.open().prepare('UPDATE cost_notices SET acked_at = ?, acked_by = ? WHERE id = ?').run(at, by, eventId);
  if (by !== HUMAN) db.addEvent(by, 'cost:ack', { event: eventId, via });
  // A manager that handled the notice settles the human's copy of it (withdraw_ask, S-425).
  if (by !== HUMAN && row.human_mail_id) settleHumanCopy(row.human_mail_id, by, eventId);
  return { ok: true, event: eventId };
}

// One stored notice, for tests and the CLI.
export function notice(eventId: string): CostNotice | undefined {
  table();
  const row = db.open().prepare('SELECT * FROM cost_notices WHERE id = ?').get(eventId) as Row | undefined;
  return row ? parse(row) : undefined;
}

// Every stored notice, newest first.
export function notices(limit = 100): CostNotice[] {
  table();
  return (db.open().prepare('SELECT * FROM cost_notices ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as Row[]).map(parse);
}

// The unacknowledged notices about a tree: the ones about any of its agents, plus the
// account-wide ones on the tree's account. A manager that acts on the tree (cost_pause)
// acknowledges these through ack().
export function openNotices(agentIds: string[], account?: string): CostNotice[] {
  table();
  const ids = new Set(agentIds);
  return (db.open().prepare('SELECT * FROM cost_notices WHERE acked_at IS NULL ORDER BY created_at').all() as unknown as Row[]).map(parse).filter(
    (n) => (n.agent_id != null && ids.has(n.agent_id)) || (n.agent_id == null && !!account && n.account === account),
  );
}

// cost_switch moved an agent's work to a successor: each of the successor's parents hears it,
// working ones in-turn, idle ones by mail. Information only, so nothing to acknowledge.
export function switched(from: db.Agent, to: db.Agent, preset: string, by: string): void {
  const who = by === HUMAN ? 'the human' : (db.getAgent(by)?.name ?? by);
  const subject = `[stam] ${from.name} now continues as ${to.name} on ${preset}`;
  const body = render('cost-switched', { from: from.name, to: to.name, preset, by: who });
  // The parents, and the manager that asked for the switch when it isn't one of them.
  const targets = [...new Set([...db.parentsOf(to), ...(by !== HUMAN && db.getAgent(by) ? [db.getAgent(by)!.id] : [])])];
  for (const m of targets.length ? targets : humanFallback()) {
    try {
      deliver(m, subject, body);
      if (m !== HUMAN) db.addEvent(m, 'cost:switched', { from: from.name, to: to.name, preset });
    } catch {}
  }
}
