// Subscription readings across machines (S-2367). A window's wait clears on a fresh reading of the
// same account taken on any machine, so a machine whose agents are all paused reads nothing and
// still lifts its window blockers after a reset another machine has already seen. Each daemon
// serves its windows per configured account at GET /api/usage/readings (rules.servedReadings);
// this module keeps the last answer per peer and refreshes it every REFRESH_MS, as peer-spend.ts
// does for paid spend. An account matches a peer's only by its configured identity (its name and
// match), and each reading is judged by its own `at` against STALE_MS. A peer that stops answering
// stops counting once its last answer is that old. A peer's reading never sets a blocker: rules.ts
// uses it to clear, and to tell which reading is the newest.
import { peers, peerPoll } from './peers.ts';
import { STALE_MS } from './readings.ts';
import type { Win } from './rules.ts';
import { envVar } from './env.ts';

export const REFRESH_MS = Number(envVar('PEER_READINGS_MS')) || 30_000;

// One machine's windows, per configured account name.
export type Served = Record<string, { match: { harness: string; model?: string }; windows: Record<string, Win> }>;

const cache = new Map<string, { at: number; served: Served }>();
const wentStale = new Set<string>();
let onChange: () => void = () => {};

const fresh = (at: number, now: number) => now - at <= STALE_MS;

// The same configured identity: the same harness and model, whatever order the keys came in.
const sameMatch = (a: Served[string]['match'], b: Served[string]['match']) => a.harness === b.harness && (a.model ?? null) === (b.model ?? null);

// The newest fresh reading of each window of an account, over the peers that answer for the same
// account with the same match. Empty when no peer has one.
export function peerWindows(account: string, match: Served[string]['match'], now: number = Date.now()): Record<string, Win> {
  const out: Record<string, Win> = {};
  for (const [name, c] of cache) {
    if (now - c.at > STALE_MS || !peers().some((p) => p.name === name)) continue;
    const s = c.served[account];
    if (!s || !sameMatch(s.match, match)) continue;
    for (const [window, w] of Object.entries(s.windows ?? {})) {
      if (typeof w?.pct !== 'number' || !fresh(w.at, now)) continue;
      if (!out[window] || w.at > out[window].at) out[window] = w;
    }
  }
  return out;
}

// Asks each peer for its windows. Calls the change listener when any answer moved, or a peer's
// last answer went stale, so the rules are evaluated again.
export async function refresh(now: number = Date.now()): Promise<void> {
  let changed = false;
  await Promise.all(
    peers().map(async (p) => {
      try {
        const r = await peerPoll(p, '/api/usage/readings', 4000);
        if (r.status !== 200 || !r.data || typeof r.data !== 'object') return;
        if (JSON.stringify(cache.get(p.name)?.served) !== JSON.stringify(r.data)) changed = true;
        cache.set(p.name, { at: now, served: r.data as Served });
        if (wentStale.delete(p.name)) changed = true;
      } catch {
        // Keep the last answer until it goes stale.
      }
    }),
  );
  // A peer whose last answer just went stale stops counting, which can lift a clear or re-set a window.
  for (const [name, c] of cache) if (now - c.at > STALE_MS && !wentStale.has(name)) (wentStale.add(name), (changed = true));
  if (changed) onChange();
}

export function start(listener: () => void): void {
  onChange = listener;
  void refresh();
  setInterval(() => void refresh(), REFRESH_MS).unref?.();
}
