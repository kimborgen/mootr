// What an agent's token may read of cost data (S-593). The user, the CLI and the bosses (the chief of
// staff, the assistant, a boss-flagged peer) keep every number. Any other agent sees the windows'
// totals, forecasts and notices in full, but per-agent and per-tree shares only for its own tree and
// its ancestors' trees; every other tree collapses into one "other" line. The scoping runs on the
// finished answer, so cost notices and pacing (cost-notices.ts, usage.ts) keep using full totals.

import * as db from './db.ts';
import * as org from './org.ts';
import { mayReadItsaThreads } from './mail-visibility.ts';

// The agents whose shares `me` may see: itself and its ancestors, and everything below each of them.
// An agent this daemon doesn't know (a peer's) sees only itself.
export function visibleAgents(me: string): Set<string> {
  const out = new Set<string>([me]);
  const a = db.getAgent(me);
  if (!a) return out;
  out.add(a.id);
  for (const id of org.ancestors(a)) out.add(id);
  for (const id of [...out]) for (const d of org.descendants(id)) out.add(d);
  return out;
}

// The agents of `me`'s own tree for permission requests: itself and everything below it.
export function ownTree(me: string): Set<string> {
  const a = db.getAgent(me);
  return new Set([a?.id ?? me, ...(a ? org.descendants(a.id) : [])]);
}

// Whether a tree (an agent id or name) is one `visible` holds. An unknown agent is let through, so the
// route reports it as it always did.
export function mayReadTree(visible: Set<string>, tree: string): boolean {
  const a = db.getAgent(tree);
  return !a || visible.has(a.id);
}

const sum = (xs: number[]): number => Math.round(xs.reduce((s, x) => s + x, 0) * 1e4) / 1e4;

// A window's shares (accounts[].shares[window]) with the agents and trees outside `visible` removed;
// their percent is summed into `other_trees`.
function scopeWindow(w: any, visible: Set<string>): any {
  if (!w || typeof w !== 'object') return w;
  const keep = (x: { id: string }) => visible.has(x.id);
  const hidden = (w.by_agent ?? []).filter((x: any) => !keep(x));
  const out = { ...w, agents: (w.agents ?? []).filter(keep), by_agent: (w.by_agent ?? []).filter(keep), trees: (w.trees ?? []).filter(keep), by_tree: (w.by_tree ?? []).filter(keep) };
  if (w.history) out.history = { ...w.history, trees: (w.history.trees ?? []).filter(keep), agents: (w.history.agents ?? []).filter(keep) };
  out.other_trees = { percent: sum(hidden.map((x: any) => x.percent)) };
  return out;
}

function scopeTrees(trees: any[], visible: Set<string>): any[] {
  const keep = trees.filter((t) => visible.has(t.id)).map((t) => ({ ...t, children: scopeTrees(t.children ?? [], visible) }));
  const hidden = trees.filter((t) => !visible.has(t.id));
  if (!hidden.length) return keep;
  const shares: Record<string, Record<string, { estimate: true; percent: number }>> = {};
  for (const t of hidden) for (const [acct, ws] of Object.entries<any>(t.shares ?? {})) for (const [win, v] of Object.entries<any>(ws)) {
    const cur = ((shares[acct] ??= {})[win] ??= { estimate: true, percent: 0 });
    cur.percent = sum([cur.percent, v.percent]);
  }
  return [...keep, { id: 'other', name: 'other', cost_usd: sum(hidden.map((t) => t.cost_usd)), tokens: hidden.reduce((s, t) => s + t.tokens, 0), shares, children: [] }];
}

// GET /api/usage for an agent's token. `visible` is visibleAgents(caller).
export function scopeSummary<T extends Record<string, any>>(s: T, visible: Set<string>): T {
  const out: Record<string, any> = { ...s };
  if (Array.isArray(s.accounts)) out.accounts = s.accounts.map((a: any) => (a.shares ? { ...a, shares: Object.fromEntries(Object.entries<any>(a.shares).map(([win, w]) => [win, scopeWindow(w, visible)])) } : a));
  if (Array.isArray(s.trees)) out.trees = scopeTrees(s.trees, visible);
  if (Array.isArray(s.by_agent)) {
    const hidden = s.by_agent.filter((r: any) => !visible.has(r.agent_id));
    out.by_agent = s.by_agent.filter((r: any) => visible.has(r.agent_id));
    if (hidden.length) {
      const col = (k: string) => hidden.reduce((n: number, r: any) => n + (Number(r[k]) || 0), 0);
      out.by_agent.push({ agent_id: 'other', agent: 'other', cost_usd: sum(hidden.map((r: any) => Number(r.cost_usd) || 0)), tokens_in: col('tokens_in'), tokens_out: col('tokens_out'), tokens_cache_read: col('tokens_cache_read'), tokens_cache_write: col('tokens_cache_write'), harness: '', model: null, today: null, lifetime: null });
    }
  }
  if (Array.isArray(s.allocations)) out.allocations = s.allocations.filter((x: any) => visible.has(x.root_id));
  if (Array.isArray(s.blocked)) out.blocked = s.blocked.filter((x: any) => visible.has(x.agent_id));
  return out as T;
}

// GET /api/usage/issues and GET /api/activity?by=itsa: only ITSAs `me` belongs to (owns, takes part in,
// or whose parent it owns). The rest are left out, not refused. Totals and the per-config averages stay.
function mayItsa(me: string, key: string): boolean {
  try {
    return mayReadItsaThreads(me, key);
  } catch {
    return false;
  }
}
export function scopeIssueCosts<T extends { issues: { key: string }[] }>(r: T, me: string): T {
  return { ...r, issues: r.issues.filter((x) => mayItsa(me, x.key)) };
}
// The same test as a predicate, for GET /api/usage/series and /api/usage/scope (S-657): an ITSA
// series leaves out the ITSAs `me` may not read, and a scope refuses one it names.
export function itsaFilter(me: string): (key: string) => boolean {
  return (key) => mayItsa(me, key);
}
export function scopeActivity<T extends { by: string; rows: any[] }>(r: T, me: string, visible: Set<string>): T {
  if (r.by === 'itsa') return { ...r, rows: r.rows.filter((x) => mayItsa(me, x.key)) };
  if (r.by === 'agent') return { ...r, rows: r.rows.filter((x) => visible.has(x.id)) };
  return r;
}
