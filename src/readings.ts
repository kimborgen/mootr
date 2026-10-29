// Cost readings (docs/cost-policy.md, build step 3): for each configured account, the
// harness's subscription windows and how fresh they are, the paid spend for today, the week
// and the month with the source it came from, and the account's budget and what is left of
// it. Readings only: nothing here blocks, stops or takes over an agent.
//
// Paid spend comes from stam's own ledger (the `usage` table), because a provider's reading
// is a cumulative total or a balance, not a per-period figure:
//   - exact: OpenRouter's OpenCode cost (`usage.cost_usd`) is scaled to billed dollars
//     by src/reconcile.ts on each credits poll, so it is always exact, whether or not the
//     credits reading is fresh.
//   - estimate: a Claude account with `paid: true` accrues `usage.paid_estimate_usd`, the
//     growth in statusline cost while a window reads 100% (recorded in usage.report).
//   - unknown: no fresh reading. Codex reports no cost, so its period spend is unknown; its
//     credits balance is exposed separately as `balance`.
//   - estimate, priced (S-2119): any other pay-per-token provider (accounts.payPerTokenProvider) has
//     no balance endpoint, so its spend is the ledger's tokens at the registry's prices for each
//     row's model (`PROVIDER/MODEL`), or the cost the harness reported for a model with no price.
import * as db from './db.ts';
import { settings, type CostAccount, type CostBudget } from './settings.ts';
import { isOpenRouter, matchAccount, openRouterAccounts, payPerTokenProvider } from './accounts.ts';
import { priceUsd } from './attribution.ts';
import { registry } from './registry.ts';
import { timed } from './stall.ts';
import { codexView, type ResetWindow } from './codex-usage-view.ts';

// A reading older than this, while an agent on the account is active, is stale and counts as
// unknown (docs/cost-policy.md, Readings).
export const STALE_MS = 15 * 60_000;

export type PaidSource = 'exact' | 'estimate' | 'unknown';
export interface PaidPeriod {
  usd: number | null;
  source: PaidSource;
}
export interface AccountWindow {
  used_percentage: number;
  resets_at: number | null;
}
export interface AccountBudget {
  usd: number;
  per: 'day' | 'week' | 'month' | 'cap';
  spent: number | null;
  remaining: number | null;
}
export interface AccountReading {
  account: string;
  match: { harness: string; model?: string };
  // The provider that bills it per token (accounts.payPerTokenProvider), or null.
  provider: string | null;
  windows: Record<string, AccountWindow>;
  // Codex only: windows whose reset time has passed, shown without their old percentage (S-1361).
  reset_windows?: Record<string, ResetWindow>;
  // When the account's limits or billing reading was last written, and its age.
  updated_at: string | null;
  age_ms: number | null;
  stale: boolean;
  paid: { today: PaidPeriod; week: PaidPeriod; month: PaidPeriod };
  // A provider balance, when one is read: Codex `credits.balance`, or OpenRouter's
  // remaining credit. Null when there is none or the reading is stale.
  balance: number | null;
  budget: AccountBudget | null;
}

interface Entry {
  data: Record<string, any> | null;
  updated_at: string;
}

// The stored subscriptions entry with this name, or null. Its `name` is the harness for the
// statusline and Codex readings, and "openrouter" for the credit poll.
function entry(name: string): Entry | null {
  const row = db.open().prepare('SELECT data, updated_at FROM subscriptions WHERE name = ?').get(name) as { data: string; updated_at: string } | undefined;
  if (!row) return null;
  let data: Record<string, any> | null = null;
  try {
    data = JSON.parse(row.data);
  } catch {
    data = null;
  }
  return { data, updated_at: row.updated_at };
}

const ageMs = (updatedAt: string | null, now: number): number | null => {
  if (!updatedAt) return null;
  const t = Date.parse(updatedAt);
  return Number.isFinite(t) ? Math.max(0, now - t) : null;
};

// A reading older than STALE_MS while an agent on the account is active is stale. Codex's
// limits refresh only through an open app-server connection, so with no Codex agent running
// its reading ages anyway: it is stale whether or not an agent is active (S-382).
function isStale(updatedAt: string | null, active: boolean, now: number): boolean {
  const age = ageMs(updatedAt, now);
  return age != null && age > STALE_MS && active;
}

// The account's windows: the entries that carry a used_percentage. Codex's credits and
// planType ride in the same entry but are not windows.
function windowsOf(e: Entry | null): Record<string, AccountWindow> {
  const out: Record<string, AccountWindow> = {};
  for (const [name, value] of Object.entries(e?.data ?? {})) {
    const w = value as { used_percentage?: unknown; resets_at?: unknown };
    if (typeof w?.used_percentage !== 'number') continue;
    out[name] = { used_percentage: w.used_percentage, resets_at: typeof w.resets_at === 'number' ? w.resets_at : null };
  }
  return out;
}

// The account's exact credits reading: Codex's balance, or OpenRouter's remaining credit.
// Null when the account has no such source. The period spend itself comes from the ledger.
function creditsFor(acct: CostAccount, name: string): { balance: number | null; updated_at: string } | null {
  if (acct.match.harness === 'codex') {
    const e = entry('codex');
    const credits = e?.data?.credits ?? e?.data?.windows?.credits;
    if (!e || !credits) return null;
    return { balance: typeof credits.balance === 'number' ? credits.balance : null, updated_at: e.updated_at };
  }
  if (isOpenRouter(acct, name)) {
    const e = entry('openrouter');
    const credits = e?.data?.credits;
    if (!e || !credits) return null;
    return { balance: typeof credits.remaining === 'number' ? credits.remaining : null, updated_at: e.updated_at };
  }
  return null;
}

// The first day included in a budget period, as the usage table's `day`, or null for a cap
// (all time). Weeks start on Monday, months on the first, in UTC. Exported for allocations,
// which measure a tree's paid spend over the same periods.
export function periodStart(per: 'day' | 'week' | 'month' | 'cap', now: number): string | null {
  if (per === 'cap') return null;
  const d = new Date(now);
  const at = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  if (per === 'week') at.setUTCDate(at.getUTCDate() - ((at.getUTCDay() + 6) % 7));
  if (per === 'month') at.setUTCDate(1);
  return at.toISOString().slice(0, 10);
}

// The ledger total for an account, from the first day of a period (or all time), in one of
// the two paid columns.
function ledger(account: string, column: 'cost_usd' | 'paid_estimate_usd', since: string | null): number {
  const d = db.open();
  const row = (since
    ? d.prepare(`SELECT SUM(${column}) AS s FROM usage WHERE account = ? AND day >= ?`).get(account, since)
    : d.prepare(`SELECT SUM(${column}) AS s FROM usage WHERE account = ?`).get(account)) as { s: number | null };
  return row.s ?? 0;
}

// How an account's paid spend is read from the ledger: billed dollars (OpenRouter), tokens at the
// registry's prices (another pay-per-token provider), the paid estimate (Claude), or none (Codex).
type Basis = 'billed' | 'priced' | 'estimate' | 'none';
function basisOf(acct: CostAccount, name: string, providers: Record<string, unknown>): Basis {
  if (isOpenRouter(acct, name)) return 'billed';
  if (payPerTokenProvider(acct, name, providers)) return 'priced';
  return acct.match.harness === 'codex' ? 'none' : 'estimate';
}

// An account's spend from the first day of a period (or all time) at the registry's per-model
// prices (attribution.priceUsd: a missing output or cache price is the input's, and a context
// suffix such as `[1m]` prices as its model), or, for a model with no price, the cost the harness reported.
export function pricedSpend(account: string, since: string | null, prices: Record<string, any> = registry().prices ?? {}): number {
  const sql = `SELECT model, SUM(tokens_in) AS tin, SUM(tokens_out) AS tout, SUM(tokens_cache_read) AS tcr, SUM(tokens_cache_write) AS tcw, SUM(cost_usd) AS cost
    FROM usage WHERE account = ?${since ? ' AND day >= ?' : ''} GROUP BY model`;
  const rows = db.open().prepare(sql).all(...(since ? [account, since] : [account])) as { model: string | null; tin: number; tout: number; tcr: number; tcw: number; cost: number }[];
  let usd = 0;
  for (const r of rows) {
    const priced = r.model ? priceUsd({ model: r.model, tokens_in: r.tin ?? 0, tokens_out: r.tout ?? 0, tokens_cache_read: r.tcr ?? 0, tokens_cache_write: r.tcw ?? 0 }, prices) : null;
    usd += priced ?? r.cost ?? 0;
  }
  return usd;
}

// Every configured account's reading. `now` is injectable for tests.
export function accountReadings(now: number = Date.now()): AccountReading[] {
  const cost = settings().cost;
  const accounts = cost.accounts ?? {};
  const agents = db.listAgents();
  // The accounts with an active agent, matched once against this read of the config (S-344): matching each
  // agent per account read settings.json again every time.
  const activeAccounts = new Set(agents.filter((a) => a.lifecycle === 'active').map((a) => matchAccount(cost, a.harness, a.model ?? null)));
  const providers = settings().providers;
  const out: AccountReading[] = [];
  for (const [name, acct] of Object.entries(accounts)) {
    if (!acct) continue;
    const basis = basisOf(acct, name, providers);
    let sub = timed('snapshot: subscription row', () => entry(acct.match.harness));
    // Codex: the newest of this machine's and the peers' readings, a passed reset taken out (S-1361).
    const view = acct.match.harness === 'codex' ? codexView(sub?.data ?? null, sub?.updated_at ?? null, now) : null;
    if (view && view.updated_at) sub = { data: view.live, updated_at: view.updated_at };
    const credits = timed('snapshot: credits row', () => creditsFor(acct, name));
    const isCodex = acct.match.harness === 'codex';
    const active = isCodex || activeAccounts.has(name);
    const subFresh = sub != null && !isStale(sub.updated_at, active, now);
    const creditsFresh = credits != null && !isStale(credits.updated_at, active, now);
    const openrouter = isOpenRouter(acct, name);
    const updatedAt = sub?.updated_at ?? credits?.updated_at ?? null;

    // Which ledger column (if any) holds this account's paid spend, and the source label.
    // The ledger is always read: `paid` controls only whether report() accrues more, so
    // turning it off never hides spend that was already recorded. Codex reports no cost, so
    // its period spend stays unknown.
    const paid = (per: 'day' | 'week' | 'month'): PaidPeriod => {
      const since = periodStart(per, now);
      if (basis === 'priced') return { usd: timed('snapshot: ledger', () => pricedSpend(name, since)), source: 'estimate' };
      if (isCodex) return { usd: null, source: 'unknown' };
      if (openrouter) return { usd: timed('snapshot: ledger', () => ledger(name, 'cost_usd', since)), source: 'exact' };
      return { usd: timed('snapshot: ledger', () => ledger(name, 'paid_estimate_usd', since)), source: subFresh ? 'estimate' : 'unknown' };
    };

    let budget: AccountBudget | null = null;
    if (acct.budget) {
      const spent = spentFor(acct.budget, { name, basis, now });
      budget = { usd: acct.budget.usd, per: acct.budget.per, spent, remaining: spent == null ? null : Math.max(0, acct.budget.usd - spent) };
    }

    out.push({
      account: name,
      match: acct.match,
      provider: payPerTokenProvider(acct, name, providers),
      windows: windowsOf(sub),
      ...(view ? { reset_windows: view.reset } : {}),
      updated_at: updatedAt,
      age_ms: ageMs(updatedAt, now),
      stale: isStale(updatedAt, active, now),
      paid: { today: paid('day'), week: paid('week'), month: paid('month') },
      balance: creditsFresh ? (credits?.balance ?? null) : null,
      budget,
    });
  }
  return out;
}

// What has been spent against a budget's own period: the same ledger column as the paid
// reading, over that period. Null when the account has no paid ledger (Codex, unmanaged).
function spentFor(budget: CostBudget, ctx: { name: string; basis: Basis; now: number }): number | null {
  if (ctx.basis === 'none') return null;
  const since = periodStart(budget.per, ctx.now);
  if (ctx.basis === 'priced') return pricedSpend(ctx.name, since);
  return ledger(ctx.name, ctx.basis === 'billed' ? 'cost_usd' : 'paid_estimate_usd', since);
}

// An account's paid spend over a budget period, from the same ledger column as its budget
// reading; null when it has no paid ledger (Codex) or isn't configured. Used by the global
// budget, which sums every account over its own period (src/budgets.ts).
export function paidSpentIn(account: string, per: CostBudget['per'], now: number = Date.now()): number | null {
  const acct = settings().cost.accounts?.[account];
  if (!acct) return null;
  return spentFor({ usd: 0, per }, { name: account, basis: basisOf(acct, account, settings().providers), now });
}

// All paid spend over a budget period, summed from the whole ledger whatever accounts are
// configured now. A row is billed (`cost_usd`) when its account is an OpenRouter account today
// (accounts.openRouterAccounts, which includes `openrouter`, where stam's decision calls are
// recorded), or when it was written by OpenCode on an openrouter/ model: a deleted account's
// rows keep the harness and model they were written with, so removing the account from
// settings doesn't turn its billed dollars into a zero estimate. Every other row counts by
// its paid estimate, except a configured pay-per-token provider account's rows, which count at the
// registry's prices (pricedSpend).
export function paidSpentAll(per: CostBudget['per'], now: number = Date.now()): number {
  const since = periodStart(per, now);
  const names = openRouterAccounts();
  const providers = settings().providers;
  const priced = Object.entries(settings().cost.accounts ?? {})
    .filter(([n, a]) => a && !names.includes(n) && basisOf(a, n, providers) === 'priced')
    .map(([n]) => n);
  const marks = names.map(() => '?').join(',');
  const skip = priced.length ? ` AND account NOT IN (${priced.map(() => '?').join(',')})` : '';
  const sum = `SUM(CASE WHEN account IN (${marks}) OR (harness = 'opencode' AND model LIKE 'openrouter/%') THEN cost_usd ELSE paid_estimate_usd END)`;
  const row = (since
    ? db.open().prepare(`SELECT ${sum} AS s FROM usage WHERE day >= ?${skip}`).get(...names, since, ...priced)
    : db.open().prepare(`SELECT ${sum} AS s FROM usage WHERE 1${skip}`).get(...names, ...priced)) as { s: number | null };
  return (row.s ?? 0) + priced.reduce((t, n) => t + pricedSpend(n, since), 0);
}
