// Paid spend across machines (S-395). A budget is one number for the whole system, so each daemon
// adds the peers' paid spend to its own when it evaluates a budget. A peer serves its own totals at
// GET /api/usage/spend (localSpend); this module keeps the last answer per peer and refreshes it
// every REFRESH_MS. A peer that doesn't answer keeps its last total for STALE_MS, then counts as
// zero, so an unreachable machine never holds a spawn on a stale or missing number.
import { settings } from './settings.ts';
import { peers, peerPoll } from './peers.ts';
import { paidSpentIn, paidSpentAll } from './readings.ts';
import { envVar } from './env.ts';

const PERS = ['day', 'week', 'month', 'cap'] as const;
type Per = (typeof PERS)[number];
export type Totals = Record<Per, number>;
// One machine's paid spend by period: `global` over every account, `accounts` per configured account.
export interface Spend {
  global: Totals;
  accounts: Record<string, Totals>;
}

export const REFRESH_MS = Number(envVar('PEER_SPEND_MS')) || 30_000;
export const STALE_MS = Number(envVar('PEER_SPEND_STALE_MS')) || 10 * 60_000;

// The route's answer: this machine's totals for a peer's request, null for any other caller (a
// spend total is for the daemons, not agents or the browser).
export function serve(local: boolean): Spend | null {
  return local ? localSpend() : null;
}

// This machine's own totals, for the route and for the sum.
export function localSpend(now: number = Date.now()): Spend {
  const totals = (f: (per: Per) => number | null): Totals => Object.fromEntries(PERS.map((p) => [p, f(p) ?? 0])) as Totals;
  const accounts: Spend['accounts'] = {};
  for (const name of Object.keys(settings().cost.accounts ?? {})) accounts[name] = totals((p) => paidSpentIn(name, p, now));
  return { global: totals((p) => paidSpentAll(p, now)), accounts };
}

const wentStale = new Set<string>();
const cache = new Map<string, { at: number; spend: Spend }>();
let onChange: () => void = () => {};

// What the peers have spent in a scope (an account name, or "global") over a period, from their last
// answers that are no older than STALE_MS.
export function peersSpent(scope: string, per: Per, now: number = Date.now()): number {
  let sum = 0;
  for (const [name, c] of cache) {
    if (now - c.at > STALE_MS || !peers().some((p) => p.name === name)) continue;
    sum += (scope === 'global' ? c.spend.global : c.spend.accounts[scope])?.[per] ?? 0;
  }
  return sum;
}

// Asks each peer for its totals. Calls the change listener when any total moved.
export async function refresh(now: number = Date.now()): Promise<void> {
  let changed = false;
  await Promise.all(
    peers().map(async (p) => {
      try {
        const r = await peerPoll(p, '/api/usage/spend', 4000);
        if (r.status !== 200 || !r.data?.global) return;
        if (JSON.stringify(cache.get(p.name)?.spend) !== JSON.stringify(r.data)) changed = true;
        cache.set(p.name, { at: now, spend: r.data as Spend });
        if (wentStale.delete(p.name)) changed = true;
      } catch {
        // Keep the last answer until it goes stale.
      }
    }),
  );
  // A peer whose last answer just went stale stops counting, which can lift a budget stop.
  for (const [name, c] of cache) if (now - c.at > STALE_MS && !wentStale.has(name)) (wentStale.add(name), (changed = true));
  if (changed) onChange();
}

// Each machine's totals for usage_info: this one, then each peer's last answer (null if none yet).
export function perMachine(machine: string, now: number = Date.now()): Record<string, Spend | null> {
  const out: Record<string, Spend | null> = { [machine]: localSpend(now) };
  for (const p of peers()) {
    const c = cache.get(p.name);
    out[p.name] = c && now - c.at <= STALE_MS ? c.spend : null;
  }
  return out;
}

export function start(listener: () => void): void {
  onChange = listener;
  void refresh();
  setInterval(() => void refresh(), REFRESH_MS).unref?.();
}

// Test seams.
export function setForTest(name: string, spend: Spend | null, at: number = Date.now()): void {
  if (spend) cache.set(name, { at, spend });
  else cache.delete(name);
}
