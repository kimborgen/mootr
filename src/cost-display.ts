// Cost display (S-316): each agent's and ITSA's cost in every unit the human can choose
// (settings.cost.display.mode), so the UI switches mode without refetching.
//
//   api            API-equivalent $, lifetime (what the harness reports)
//   five_hour      % of the 5-hour window, seven_day: % of the 7-day window
//   subscription   $ at what the subscription costs: api$ x monthly price / API-equivalent
//                  use per month (the 7-day worth x 30/7)
//   paid_usd       real money: spend on accounts billed per use (OpenRouter, paid: true).
//                  It is $ in every mode and stays apart from the converted parts.
//
// Spend with no configured account ('') counts toward `api` only. A converted value is null
// when it can't be computed: the worth isn't calibrated, or no price is set for the account.
// Values add up, so a tree is the sum of its members' values, null if any part is null.
// Agents are summed raw per account (Raw) and converted with the serving daemon's prices.
import { settings } from './settings.ts';
import { openRouterAccounts, payPerTokenProvider } from './accounts.ts';

export type CostMode = 'api' | 'five_hour' | 'seven_day' | 'subscription';
export const COST_MODES: CostMode[] = ['api', 'five_hour', 'seven_day', 'subscription'];

export interface CostDisplay {
  mode: CostMode;
  // Subscription price per account, USD per month.
  prices: Record<string, number>;
}

export const DEFAULT_DISPLAY: CostDisplay = { mode: 'api', prices: {} };

// The problem in a cost.display value, or null; accounts.validate calls this.
export function displayProblem(d: unknown): string | null {
  if (d == null) return null;
  if (typeof d !== 'object' || Array.isArray(d)) return 'cost.display must be an object';
  const { mode, prices } = d as { mode?: unknown; prices?: unknown };
  if (mode != null && !COST_MODES.includes(mode as CostMode)) return `cost.display.mode must be one of ${COST_MODES.join(', ')}`;
  if (prices != null) {
    if (typeof prices !== 'object' || Array.isArray(prices)) return 'cost.display.prices must be an object of account to USD per month';
    for (const [account, p] of Object.entries(prices as Record<string, unknown>)) {
      if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0) return `cost.display.prices.${account} must be a positive number of USD per month`;
    }
  }
  return null;
}

export function costDisplay(): CostDisplay {
  const d = (settings().cost as { display?: Partial<CostDisplay> }).display;
  return { mode: COST_MODES.includes(d?.mode as CostMode) ? (d!.mode as CostMode) : 'api', prices: { ...(d?.prices ?? {}) } };
}

export interface Modes {
  api: number;
  five_hour: number | null;
  seven_day: number | null;
  subscription: number | null;
  paid_usd: number;
}
export const zeroModes = (): Modes => ({ api: 0, five_hour: 0, seven_day: 0, subscription: 0, paid_usd: 0 });

export function addModes(t: Modes, s: Modes): void {
  t.api += s.api;
  t.paid_usd += s.paid_usd;
  for (const k of ['five_hour', 'seven_day', 'subscription'] as const) t[k] = t[k] == null || s[k] == null ? null : t[k]! + s[k]!;
}

export function roundModes(m: Modes): Modes {
  const r = (n: number) => Math.round(n * 1e6) / 1e6;
  const r2 = (n: number | null) => (n == null ? null : Math.round(n * 100) / 100);
  return { api: r(m.api), five_hour: r2(m.five_hour), seven_day: r2(m.seven_day), subscription: r2(m.subscription), paid_usd: r(m.paid_usd) };
}

// How accounts are billed and what a window is worth, injected so tests need no usage data.
export interface Ctx {
  // 'subscription' (configured, not paid), 'paid' (pay-per-token, as OpenRouter, or paid: true; an explicit paid: false wins), else 'none'.
  kind(account: string): 'subscription' | 'paid' | 'none';
  // A full window's worth in API-equivalent $ (mid), null when not calibrated.
  worth(account: string, window: 'five_hour' | 'seven_day'): number | null;
  price(account: string): number | null;
}

export function accountKind(account: string): 'subscription' | 'paid' | 'none' {
  return kindResolver()(account);
}

// Reads the settings once; the resolver then answers per account without touching them.
export function kindResolver(): (account: string) => 'subscription' | 'paid' | 'none' {
  const accounts = settings().cost.accounts ?? {};
  const providers = settings().providers;
  const openrouter = new Set(openRouterAccounts());
  return (account) => {
    const acct = accounts[account];
    if (acct?.paid !== false && (openrouter.has(account) || acct?.paid === true || (acct?.match && payPerTokenProvider(acct, account, providers)))) return 'paid';
    return accounts[account] ? 'subscription' : 'none';
  };
}

// The subscription $ for api$ spent on one account.
function subscriptionUsd(ctx: Ctx, account: string, api: number): number | null {
  const price = ctx.price(account);
  const worth = ctx.worth(account, 'seven_day');
  if (price == null || worth == null || worth <= 0) return null;
  return (api * price) / ((worth * 30) / 7);
}

// Lifetime cost per account into the modes. `windowPercent` is the spend's share of the
// current windows (five_hour, seven_day) when the caller has it, else lifetime cost over the
// window's worth.
export function convert(byAccount: Map<string, number>, ctx: Ctx, windowPercent?: { five_hour: number | null; seven_day: number | null }): Modes {
  const m = zeroModes();
  for (const [account, api] of byAccount) {
    m.api += api;
    const kind = ctx.kind(account);
    if (kind === 'paid') m.paid_usd += api;
    if (kind !== 'subscription') continue;
    m.subscription = m.subscription == null ? null : addNull(m.subscription, subscriptionUsd(ctx, account, api));
    if (!windowPercent) {
      for (const w of ['five_hour', 'seven_day'] as const) {
        const worth = ctx.worth(account, w);
        m[w] = m[w] == null || worth == null || worth <= 0 ? null : m[w]! + (100 * api) / worth;
      }
    }
  }
  if (windowPercent) {
    const hasSub = [...byAccount.keys()].some((a) => ctx.kind(a) === 'subscription');
    m.five_hour = hasSub ? windowPercent.five_hour : 0;
    m.seven_day = hasSub ? windowPercent.seven_day : 0;
  }
  return m;
}
const addNull = (a: number, b: number | null) => (b == null ? null : a + b);

// What an agent (or a tree) spent per account, before conversion: the input the daemon serving
// the UI converts with its own prices, so a peer's agents are shown the same way as local ones.
// `five_hour` and `seven_day` are the spend's share of that account's current window in percent
// (null when the window isn't calibrated and the spend is in it); `worth_seven_day` is a full
// 7-day window in API-equivalent $ (null when not calibrated).
export interface RawAcct {
  api: number;
  kind: 'subscription' | 'paid' | 'none';
  worth_seven_day: number | null;
  five_hour: number | null;
  seven_day: number | null;
}
export type Raw = Record<string, RawAcct>;

export function addRaw(t: Raw, s: Raw): void {
  for (const [a, r] of Object.entries(s)) {
    const x = t[a];
    if (!x) {
      t[a] = { ...r };
      continue;
    }
    x.api += r.api;
    x.worth_seven_day ??= r.worth_seven_day;
    x.five_hour = x.five_hour == null || r.five_hour == null ? null : x.five_hour + r.five_hour;
    x.seven_day = x.seven_day == null || r.seven_day == null ? null : x.seven_day + r.seven_day;
  }
}

// The modes for a raw cost, with this daemon's subscription prices.
export function rawToModes(raw: Raw, prices: Record<string, number>): Modes {
  const m = zeroModes();
  for (const [account, r] of Object.entries(raw)) {
    m.api += r.api;
    if (r.kind === 'paid') m.paid_usd += r.api;
    if (r.kind !== 'subscription') continue;
    for (const w of ['five_hour', 'seven_day'] as const) m[w] = m[w] == null || r[w] == null ? null : m[w]! + r[w]!;
    const price = prices[account];
    m.subscription =
      m.subscription == null || price == null || r.worth_seven_day == null || r.worth_seven_day <= 0
        ? null
        : m.subscription + (r.api * price) / ((r.worth_seven_day * 30) / 7);
  }
  return m;
}

// Each node's own value summed over itself and every descendant, each descendant once even
// where agents have several parents. One post-order pass sums a subtree when it has no
// shared descendant; a subtree that does (a node with two parents inside it) is summed over
// its distinct members instead, so only those nodes cost more than O(1) per edge.
export function treeSums<T>(ids: string[], children: Map<string, string[]>, own: Map<string, T>, zero: () => T, add: (into: T, from: T) => void): Map<string, T> {
  const out = new Map<string, T>();
  const sum = new Map<string, T>();
  const shared = new Map<string, boolean>();
  const parentCount = new Map<string, number>();
  for (const kids of children.values()) for (const k of new Set(kids)) parentCount.set(k, (parentCount.get(k) ?? 0) + 1);
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): void => {
    if (state.has(id)) return;
    state.set(id, 1);
    const acc = zero();
    if (own.has(id)) add(acc, own.get(id)!);
    let sh = false;
    for (const k of new Set(children.get(id) ?? [])) {
      if (state.get(k) === 1) continue;
      visit(k);
      add(acc, sum.get(k)!);
      if (shared.get(k) || (parentCount.get(k) ?? 0) > 1) sh = true;
    }
    sum.set(id, acc);
    shared.set(id, sh);
    state.set(id, 2);
  };
  for (const id of ids) visit(id);
  for (const id of ids) {
    if (!shared.get(id)) {
      out.set(id, sum.get(id)!);
      continue;
    }
    const acc = zero();
    const seen = new Set<string>();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (own.has(cur)) add(acc, own.get(cur)!);
      stack.push(...(children.get(cur) ?? []));
    }
    out.set(id, acc);
  }
  return out;
}
