// Allocations (docs/cost-policy.md, build step 10): the user or a manager says how much of
// an account's window, or how many paid dollars per period, a tree may use. They are stored
// by tree-root agent id, never enforced (no blockers), and checked on each reading: at 80%
// and 100% of the allocation a cost notice goes to the tree's manager and to the tree's
// root, once per allocation, threshold, and window reset (or period).
//
//   window   "tree T may use about X% of ACCOUNT's five_hour window": use is the tree's
//            estimated share of that window since its current reset (attribution.treeShare)
//   usd      "about $Y per day of paid spend": use is the tree's paid spend in the period
//            from stam's ledger (the same column readings.ts reads per account)
//
// Who may set what: the human (or the CLI, or the executive assistant) any allocation; the
// chief of staff any; every other agent only trees inside its own tree. When children's
// allocations add up past their parent tree's, the setter is warned but never refused.
import { randomBytes } from 'node:crypto';
import * as db from './db.ts';
import * as tree from './tree.ts';
import { settings } from './settings.ts';
import { accountFor, openRouterAccounts } from './accounts.ts';
import { periodStart } from './readings.ts';
import { mayManageTree } from './cost-auth.ts';
import { treeMembers, treeShare, windowShares } from './attribution.ts';
import * as costNotices from './cost-notices.ts';
import type { Projection } from './attribution.ts';

export type AllocationKind = 'window' | 'usd';
export type AllocationPeriod = 'day' | 'week' | 'month';

export interface Allocation {
  id: string;
  // The tree's root: the agent the allocation was set on.
  root_id: string;
  account: string;
  kind: AllocationKind;
  // The window name for kind 'window', '' for 'usd'.
  window: string;
  // The allocated percentage points for kind 'window'.
  percent: number | null;
  // The allocated dollars for kind 'usd'.
  amount: number | null;
  // day | week | month for kind 'usd', '' for 'window'.
  period: string;
  set_by: string;
  set_at: string;
  note: string | null;
}

// A row as shown with its current use, for usage_info and the CLI.
export interface AllocationView extends Allocation {
  root: string;
  // Percent points of the window, or dollars of the period, used so far.
  used: number;
  // Used as a percentage of the allocation (can pass 100).
  used_percent: number | null;
  // Where the window reaches 100% at the current rate, for a window allocation.
  projection?: Projection;
}

const now = () => new Date().toISOString();
const round = (n: number) => Math.round(n * 100) / 100;

// The table lives here rather than in db.ts's schema, so this step is self-contained, as
// cost-notices.ts does for cost_notices.
let ready = false;
function table(): void {
  if (ready) return;
  db.open().exec(`CREATE TABLE IF NOT EXISTS allocations (
    id TEXT PRIMARY KEY,
    root_id TEXT NOT NULL,
    account TEXT NOT NULL,
    kind TEXT NOT NULL,
    window TEXT NOT NULL DEFAULT '',
    percent REAL,
    amount REAL,
    period TEXT NOT NULL DEFAULT '',
    set_by TEXT NOT NULL,
    set_at TEXT NOT NULL,
    note TEXT
  )`);
  // One allocation per tree, account, kind and scope: a second set replaces the first.
  db.open().exec('CREATE UNIQUE INDEX IF NOT EXISTS allocations_key ON allocations(root_id, account, kind, window, period)');
  ready = true;
}

function scopeOf(kind: AllocationKind, window: string, period: string): { window: string; period: string } {
  return kind === 'usd' ? { window: '', period } : { window, period: '' };
}

// Every allocation, oldest first, optionally for one tree root.
export function list(rootId?: string): Allocation[] {
  table();
  const rows = rootId
    ? (db.open().prepare('SELECT * FROM allocations WHERE root_id = ? ORDER BY set_at').all(rootId) as unknown as Allocation[])
    : (db.open().prepare('SELECT * FROM allocations ORDER BY set_at').all() as unknown as Allocation[]);
  return rows;
}

export function find(ref: string): Allocation | undefined {
  table();
  return db.open().prepare('SELECT * FROM allocations WHERE id = ?').get(ref) as Allocation | undefined;
}

// The account a subscription reading belongs to: its name is the harness (Claude) or
// `codex` / `codex:ID` (Codex), so match on the harness part. Mirrors cost-notices.ts.
function readingAccount(name: string): string | undefined {
  const harness = name.split(':')[0];
  return accountFor({ harness }) ?? Object.keys(settings().cost.accounts ?? {}).find((n) => settings().cost.accounts[n]?.match?.harness === harness);
}

// Whether `by` (an agent id, or HUMAN) may set an allocation on the tree rooted at `rootId`:
// the human and the assistant any, the chief of staff any, every other agent only trees
// inside its own tree (itself and its descendants). Shared with cost_pause through
// cost-auth.ts, so both manager tools agree on permissions.
export function canSet(by: string, rootId: string): boolean {
  const root = db.getAgent(rootId);
  return !!root && mayManageTree(by, root);
}

export interface SetInput {
  tree: string;
  account: string;
  kind: AllocationKind;
  window?: string;
  percent?: number;
  amount?: number;
  period?: string;
  note?: string;
}

export interface SetResult {
  allocation: Allocation;
  // A sentence when this set pushes children past a parent tree's allocation; null otherwise.
  warning: string | null;
}

function mustTree(ref: unknown): db.Agent {
  const a = ref ? db.getAgent(String(ref)) : undefined;
  if (!a) throw new Error(`no agent ${ref ?? ''} to allocate on`);
  return a;
}

// Sets (or replaces) one allocation on a tree. Throws when the caller may not set it on that
// tree, or the allocation is malformed; returns the stored row and any overlap warning.
export function set(input: SetInput, by: string): SetResult {
  table();
  const root = mustTree(input.tree);
  if (!canSet(by, root.id)) throw new Error(`${db.getAgent(by)?.name ?? by} may set an allocation only on trees inside its own tree`);
  const account = String(input.account ?? '').trim();
  if (!account) throw new Error('an allocation needs an account');
  if (input.kind !== 'usd' && input.kind !== 'window') throw new Error("an allocation kind must be 'window' or 'usd'");
  const kind: AllocationKind = input.kind;
  let window = '';
  let period = '';
  let percent: number | null = null;
  let amount: number | null = null;
  if (kind === 'window') {
    window = String(input.window ?? '').trim();
    if (!window) throw new Error('a window allocation needs a window name');
    percent = Number(input.percent);
    if (!Number.isFinite(percent) || percent <= 0) throw new Error('a window allocation needs a positive percent');
  } else {
    period = String(input.period ?? '').trim();
    if (!['day', 'week', 'month'].includes(period)) throw new Error("a usd allocation needs a period of 'day', 'week', or 'month'");
    amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('a usd allocation needs a positive amount');
  }
  const note = input.note != null && String(input.note).trim() ? String(input.note) : null;
  const at = now();
  const existing = db.open().prepare('SELECT * FROM allocations WHERE root_id = ? AND account = ? AND kind = ? AND window = ? AND period = ?').get(root.id, account, kind, window, period) as Allocation | undefined;
  const id = existing?.id ?? 'al-' + randomBytes(4).toString('hex');
  db.open()
    .prepare(
      `INSERT INTO allocations (id, root_id, account, kind, window, percent, amount, period, set_by, set_at, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (root_id, account, kind, window, period) DO UPDATE SET percent = excluded.percent, amount = excluded.amount, set_by = excluded.set_by, set_at = excluded.set_at, note = excluded.note`,
    )
    .run(id, root.id, account, kind, window, percent, amount, period, by, at, note);
  const stored = find(id)!;
  return { allocation: stored, warning: overlapWarning(root.id, account, kind, window, period) };
}

export interface ClearInput {
  // Clear one allocation by id, or by tree + account + kind + scope.
  id?: string;
  tree?: string;
  account?: string;
  kind?: AllocationKind;
  window?: string;
  period?: string;
}

// Clears one allocation by id, or every allocation matching tree, account, kind and scope.
// Returns how many rows were removed.
export function clear(input: ClearInput, by: string): number {
  table();
  if (input.id) {
    const a = find(input.id);
    if (!a) throw new Error(`no allocation ${input.id}`);
    if (!canSet(by, a.root_id)) throw new Error(`${db.getAgent(by)?.name ?? by} may clear an allocation only on trees inside its own tree`);
    return Number(db.open().prepare('DELETE FROM allocations WHERE id = ?').run(a.id).changes);
  }
  const root = mustTree(input.tree);
  if (!canSet(by, root.id)) throw new Error(`${db.getAgent(by)?.name ?? by} may clear an allocation only on trees inside its own tree`);
  const kind: AllocationKind = input.kind === 'usd' ? 'usd' : 'window';
  const { window, period } = scopeOf(kind, String(input.window ?? ''), String(input.period ?? ''));
  return Number(db.open().prepare('DELETE FROM allocations WHERE root_id = ? AND account = ? AND kind = ? AND window = ? AND period = ?').run(root.id, String(input.account ?? ''), kind, window, period).changes);
}

// The allocations of the direct children of `parentId` with the same scope, summed.
function childrenTotal(parentId: string, account: string, kind: AllocationKind, window: string, period: string): { sum: number; count: number } {
  const kids = tree.childrenOf(parentId);
  if (!kids.length) return { sum: 0, count: 0 };
  const placeholders = kids.map(() => '?').join(', ');
  const rows = db.open()
    .prepare(`SELECT percent, amount FROM allocations WHERE root_id IN (${placeholders}) AND account = ? AND kind = ? AND window = ? AND period = ?`)
    .all(...kids, account, kind, window, period) as { percent: number | null; amount: number | null }[];
  const sum = rows.reduce((s, r) => s + (kind === 'usd' ? r.amount ?? 0 : r.percent ?? 0), 0);
  return { sum: round(sum), count: rows.length };
}

// Warn (never refuse) when the tracked tree's children, or an ancestor tree's children, add
// up past that parent tree's own allocation for the same account, kind and scope.
function overlapWarning(rootId: string, account: string, kind: AllocationKind, window: string, period: string): string | null {
  const messages: string[] = [];
  const nodes = [rootId];
  // The tree and every ancestor that owns an allocation for this scope.
  for (const id of treeAncestors(rootId)) nodes.push(id);
  for (const id of nodes) {
    const parent = db.open().prepare('SELECT percent, amount FROM allocations WHERE root_id = ? AND account = ? AND kind = ? AND window = ? AND period = ?').get(id, account, kind, window, period) as { percent: number | null; amount: number | null } | undefined;
    if (!parent) continue;
    const of = kind === 'usd' ? parent.amount ?? 0 : parent.percent ?? 0;
    const { sum, count } = childrenTotal(id, account, kind, window, period);
    if (count && sum > of) {
      const name = db.getAgent(id)?.name ?? id;
      const unit = kind === 'usd' ? `$${of}` : `${of}%`;
      const total = kind === 'usd' ? `$${sum}` : `${sum}%`;
      messages.push(`warning: the allocations of ${name}'s children add up to ${total}, over ${name}'s own ${unit} ${kind === 'usd' ? `per ${period}` : `on ${window}`} allocation; not refused.`);
    }
  }
  return messages.length ? messages.join('\n') : null;
}

// The agents above `id` (its parents and theirs), for the overlap check.
function treeAncestors(id: string): string[] {
  const out = new Set<string>();
  const stack = [...db.parentsOf(db.getAgent(id)!)];
  while (stack.length) {
    const p = stack.pop()!;
    if (out.has(p)) continue;
    out.add(p);
    const a = db.getAgent(p);
    if (a) stack.push(...db.parentsOf(a));
  }
  return [...out];
}

// A tree's paid spend in a period, from stam's ledger: the same column readings.ts reads,
// summed over the tree's members.
export function paidSpend(rootId: string, account: string, period: AllocationPeriod, nowMs: number = Date.now()): number {
  const members = [...treeMembers(rootId)];
  if (!members.length) return 0;
  const since = periodStart(period, nowMs);
  const column = openRouterAccounts().includes(account) ? 'cost_usd' : 'paid_estimate_usd';
  const placeholders = members.map(() => '?').join(', ');
  const row = db.open().prepare(`SELECT SUM(${column}) AS s FROM usage WHERE account = ? AND day >= ? AND agent_id IN (${placeholders})`).get(account, since, ...members) as { s: number | null };
  return round(row.s ?? 0);
}

// When the tree reaches its allocation at the rate it has used so far since the period
// began. `of` is percent points or dollars; `sinceMs` is the period's start.
function projectionLine(used: number, of: number, sinceMs: number, nowMs: number, resetsMs: number | null): string {
  if (used >= of) return 'The tree is already at or past its allocation.';
  const elapsed = nowMs - sinceMs;
  if (elapsed <= 0 || used <= 0) return 'No projection yet: too little use in this period.';
  const at = nowMs + ((of - used) * elapsed) / used;
  const when = new Date(at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  if (resetsMs != null && at >= resetsMs) return `At the current rate the period resets before the tree reaches its allocation (around ${when}).`;
  return `At the current rate the tree reaches its allocation around ${when}.`;
}

// One allocation's current use, and a notice at 80% and 100%. `basis` dedups a window
// notice per reset (or a usd notice per period).
function fireWindow(a: Allocation, used: number, sinceIso: string, projection: Projection, nowMs: number): void {
  const of = a.percent ?? 0;
  const percentUsed = of > 0 ? (used / of) * 100 : 0;
  const threshold = percentUsed >= 100 ? 100 : percentUsed >= 80 ? 80 : 0;
  if (!threshold) return;
  const sinceMs = Date.parse(sinceIso);
  const resetsMs = projection.resets_at ? Date.parse(projection.resets_at) : null;
  const line = projectionLine(used, of, sinceMs, nowMs, resetsMs);
  const windowProjection = projection.reaches_100_at ? `The ${a.window.replace('_', '-')} window itself reaches 100% around ${projection.reaches_100_at.replace('T', ' ').slice(0, 16)} UTC.` : '';
  costNotices.allocationWarning(
    {
      allocation: a.id,
      root: a.root_id,
      account: a.account,
      kind: 'window',
      window: a.window,
      period: '',
      used: round(used),
      of,
      used_percent: round(percentUsed),
      threshold,
      basis: sinceIso,
      projection: [line, windowProjection].filter(Boolean).join(' '),
      note: a.note,
    },
    nowMs,
  );
}

function fireUsd(a: Allocation, spent: number, nowMs: number): void {
  const of = a.amount ?? 0;
  const percentUsed = of > 0 ? (spent / of) * 100 : 0;
  const threshold = percentUsed >= 100 ? 100 : percentUsed >= 80 ? 80 : 0;
  if (!threshold) return;
  const period = a.period as AllocationPeriod;
  const sinceIso = (periodStart(period, nowMs) ?? '') + 'T00:00:00.000Z';
  const line = projectionLine(spent, of, Date.parse(sinceIso), nowMs, null);
  costNotices.allocationWarning(
    {
      allocation: a.id,
      root: a.root_id,
      account: a.account,
      kind: 'usd',
      window: '',
      period,
      used: round(spent),
      of,
      used_percent: round(percentUsed),
      threshold,
      // The period start is the reset a usd notice re-arms on.
      basis: sinceIso,
      projection: line,
      note: a.note,
    },
    nowMs,
  );
}

// Called on each window reading: check every window allocation on the account for that
// window. The tree's use is its estimated share since the window's current reset.
export function checkWindow(name: string, window: string, nowMs: number = Date.now()): void {
  table();
  const account = readingAccount(name);
  if (!account) return;
  const rows = db.open().prepare("SELECT * FROM allocations WHERE kind = 'window' AND account = ? AND window = ?").all(account, window) as unknown as Allocation[];
  if (!rows.length) return;
  const shares = windowShares(account, window, undefined, nowMs);
  for (const a of rows) fireWindow(a, treeShare(a.root_id, account, window, undefined, shares), shares.since, shares.projection, nowMs);
}

// Called on each usage report: check every usd allocation on the account.
export function checkUsd(account: string, nowMs: number = Date.now()): void {
  table();
  if (!account) return;
  const rows = db.open().prepare("SELECT * FROM allocations WHERE kind = 'usd' AND account = ?").all(account) as unknown as Allocation[];
  for (const a of rows) fireUsd(a, paidSpend(a.root_id, account, a.period as AllocationPeriod, nowMs), nowMs);
}

// The allocations with their current use, for usage_info and the CLI. With `rootId`, only
// that tree's.
export function view(rootId?: string, nowMs: number = Date.now()): AllocationView[] {
  table();
  return list(rootId).map((a) => {
    const root = db.getAgent(a.root_id)?.name ?? a.root_id;
    if (a.kind === 'window') {
      const shares = windowShares(a.account, a.window, undefined, nowMs);
      const used = round(treeShare(a.root_id, a.account, a.window, undefined, shares));
      return { ...a, root, used, used_percent: a.percent ? round((used / a.percent) * 100) : null, projection: shares.projection };
    }
    const used = paidSpend(a.root_id, a.account, a.period as AllocationPeriod, nowMs);
    return { ...a, root, used, used_percent: a.amount ? round((used / a.amount) * 100) : null };
  });
}
