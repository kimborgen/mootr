// Activity baseline (S-212, part 3 of S-204): working and waiting time, cost, and review rounds per
// agent, per ITSA, and per model and agent type over closed ITSAs. Built on the activity timeline
// (activity_items, src/activity.ts, S-210) and the usage table; ITSA attribution is issue-costs'
// (attributor, compute), so the two never drift apart.
//
//   working   tool and model items; broken down by their leaf wait kind (tool.test, model.generate, …)
//   waiting   gap items; broken down by top-level kind (agent, human, job, tool, throttle, …) and leaf
//   cost      per agent: the usage table (authoritative) and the summed item est_cost_usd
//   per ITSA  an item's time goes to the ITSAs its agent was on at the item's start, split evenly
//             (issue-costs' attribution); own and roll-up totals; review_rounds = status moves from a
//             review category back to an active or ready one, plus reviewer-type agents on the ITSA
//   per model and type: median and p75 over closed ITSAs, grouped by the ITSA's worker config and by
//             the agent type with the most working time on it
// Time is in seconds. Agents without items show usage cost and null time.
import type { StatementSync } from 'node:sqlite';
import * as db from './db.ts';
import * as itsa from './itsa.ts';
import { buildAttribution, computeSteps, COST_NOTE } from './issue-costs.ts';
import { due, runSync, runSliced } from './slice.ts';
import { timed } from './stall.ts';
import { EFFORT_KEYS } from './retro.ts';
import { isReviewerType, reviewerTypes } from './agent-types.ts';
import { accountFor } from './accounts.ts';
import { convert, costDisplay, kindResolver, roundModes, type Ctx, type Modes } from './cost-display.ts';
import { cachedWorth } from './usage.ts';
import { activityLabel, WAIT_LABELS, CATEGORY_LABELS } from './activity-categories.ts';

export type By = 'agent' | 'itsa' | 'model' | 'type';
export interface Options {
  by?: By;
  days?: number;
  closed?: boolean;
  now?: number;
}

const REVIEW = new Set(['review']);
const ACTIVE_OR_READY = new Set(['active', 'ready']);

const add = (m: Record<string, number>, k: string, v: number) => {
  m[k] = (m[k] ?? 0) + v;
};
const top = (kind: string) => kind.split('.')[0];

// Percentile by linear interpolation between the two nearest ranks; null for no values.
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const idx = p * (v.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return Math.round((v[lo] + (v[hi] - v[lo]) * (idx - lo)) * 1e6) / 1e6;
}

export function spread(values: number[]) {
  return { n: values.length, median: percentile(values, 0.5), p75: percentile(values, 0.75) };
}

// Cost in every Measure mode (S-663), as Usage builds it: kind and price from the settings, worth from
// the cached window shares. An agent's est cost converts at the agent's account.
const MODE_KEYS = ['api', 'five_hour', 'seven_day', 'subscription', 'paid_usd'] as const;
// Worth comes from the last usage snapshot, never recomputed here (cachedWorth): a stale one gives the
// old worths, none gives null window modes, and a refresh runs in the background.
export function costCtx(now: number): Ctx {
  const { prices } = costDisplay();
  return { kind: kindResolver(), worth: cachedWorth(now), price: (a) => prices[a] ?? null };
}
export const modesOf = (ctx: Ctx, byAccount: Map<string, number>): Modes => roundModes(convert(byAccount, ctx));
// Median and p75 per mode; a mode that is null (not calibrated) is left out of its spread. `real` is
// the Usage page's Real $ (subscription + paid) per row, since a median of a sum isn't the sum of the
// medians (S-1012).
export function modesSpread(list: Modes[]) {
  const real = list.map((m) => (m.subscription == null ? null : m.subscription + m.paid_usd)).filter((v): v is number => v != null);
  return {
    ...Object.fromEntries(MODE_KEYS.map((k) => [k, spread(list.map((m) => m[k]).filter((v): v is number => v != null))])),
    real: spread(real.map((v) => Math.round(v * 1e6) / 1e6)),
  };
}

interface ItemRow {
  agent_id: string;
  kind: string;
  wait_kind: string | null;
  start: string;
  end: string;
  est_cost_usd: number;
  category: string | null;
}

// Time per leaf working kind and per waiting top-level and leaf kind, in seconds.
interface Split {
  working_s: number;
  waiting_s: number;
  working_by_kind: Record<string, number>;
  waiting_by_top: Record<string, number>;
  waiting_by_kind: Record<string, number>;
}
const splitZero = (): Split => ({ working_s: 0, waiting_s: 0, working_by_kind: {}, waiting_by_top: {}, waiting_by_kind: {} });

// Adds one item's duration, scaled by share, to a split.
function addItem(s: Split, it: ItemRow, seconds: number) {
  if (it.kind === 'gap') {
    s.waiting_s += seconds;
    const leaf = it.wait_kind ?? 'unknown';
    add(s.waiting_by_top, top(leaf), seconds);
    add(s.waiting_by_kind, leaf, seconds);
  } else {
    s.working_s += seconds;
    add(s.working_by_kind, it.wait_kind ?? it.kind, seconds);
  }
}

// An item clipped to the request's window: `seconds` is the part inside it, and est_cost_usd is
// prorated to that part. Items are streamed from the db, never loaded whole.
interface Clipped extends ItemRow {
  seconds: number;
}

// A stored event's data as an object: bad JSON, null and non-objects read as empty.
function parseData(s: string | null): Record<string, unknown> {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

// Sweeps the spans' boundaries (and the cuts): calls fn(a, b, active) for each stretch of wall time
// [a, b) that some span covers, with the indexes of the spans covering it. Milliseconds.
export function sweep(spans: Window[], cuts: number[], fn: (a: number, b: number, active: number[]) => void): void {
  const pts = [...new Set([...spans.flat(), ...cuts].filter(Number.isFinite))].sort((x, y) => x - y);
  const byStart = spans.map((_, i) => i).sort((i, j) => spans[i][0] - spans[j][0]);
  const byEnd = spans.map((_, i) => i).sort((i, j) => spans[i][1] - spans[j][1]);
  const active = new Set<number>();
  let si = 0;
  let ei = 0;
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = pts[k];
    const b = pts[k + 1];
    while (si < byStart.length && spans[byStart[si]][0] <= a) active.add(byStart[si++]);
    while (ei < byEnd.length && spans[byEnd[ei]][1] <= a) active.delete(byEnd[ei++]);
    if (active.size) fn(a, b, [...active]);
  }
}

// Each span's share of the wall time: a stretch that several spans cover splits evenly among them,
// so concurrent items count once. Seconds per span; the shares sum to the wall time covered.
export function wallShares(spans: Window[]): number[] {
  const out = spans.map(() => 0);
  sweep(spans, [], (a, b, active) => {
    for (const i of active) out[i] += (b - a) / 1000 / active.length;
  });
  return out;
}

// The agents that have items (a probe per agent on the primary key, not a scan of every item); the window
// is applied per agent.
function itemAgents(d: ReturnType<typeof db.open>): string[] {
  return (
    d
      .prepare('WITH RECURSIVE ids(a) AS (SELECT MIN(agent_id) FROM activity_items UNION ALL SELECT (SELECT MIN(agent_id) FROM activity_items WHERE agent_id > a) FROM ids WHERE a IS NOT NULL) SELECT a FROM ids WHERE a IS NOT NULL')
      .all() as { a: string }[]
  ).map((r) => r.a);
}

// One agent's items clipped to the window, each with its wall share in `seconds` (concurrent items
// split a stretch evenly; est_cost_usd stays prorated to the clipped time).
function clippedFor(stmt: StatementSync, agent: string, since: string, to: string): Clipped[] {
  const from = Date.parse(since);
  const until = Date.parse(to);
  const batch: Clipped[] = [];
  for (const r of stmt.all(agent, to, since) as unknown as ItemRow[]) {
    const full = (Date.parse(r.end) - Date.parse(r.start)) / 1000;
    const s = Math.max(Date.parse(r.start), from);
    const e = Math.min(Date.parse(r.end), until);
    if (full <= 0 || e <= s) continue;
    const seconds = (e - s) / 1000;
    batch.push({ ...r, start: new Date(s).toISOString(), end: new Date(e).toISOString(), seconds, est_cost_usd: (r.est_cost_usd * seconds) / full });
  }
  return withShares(batch);
}

// The window's items an agent at a time, pausing between agents once a slice is used (src/slice.ts).
// The reads are short queries, so no cursor is open across a pause.
function* clippedByAgent(d: ReturnType<typeof db.open>, since: string, to: string): Generator<Clipped[] | null> {
  const stmt = d.prepare(`SELECT agent_id, kind, wait_kind, start, "end", est_cost_usd, category FROM activity_items WHERE agent_id = ? AND kind != 'text' AND start < ? AND "end" > ?`);
  for (const id of itemAgents(d)) {
    const batch = clippedFor(stmt, id, since, to);
    if (batch.length) yield batch;
    if (due()) yield null;
  }
}

function withShares(batch: Clipped[]): Clipped[] {
  const shares = wallShares(batch.map((it) => [Date.parse(it.start), Date.parse(it.end)] as Window));
  return batch.map((it, i) => ({ ...it, seconds: shares[i] }));
}

export const activityStats = (opts: Options = {}) => runSync(statsSteps(opts));
// The same report in slices of a few ms, for the daemon's request path (src/slice.ts, S-2094).
export const activityStatsSliced = (opts: Options = {}, wrap?: Parameters<typeof runSliced>[1]) => runSliced(statsSteps(opts), wrap);

// The report the daemon serves (S-2094): sliced so no request holds the event loop, and kept for FRESH_MS
// per (by, days, closed) so a page polling it reads a memo. Past FRESH_MS the last report is served at
// once while one refresh runs in the background (at most one per key); past STALE_MS a caller waits.
export const ACTIVITY_FRESH_MS = 30_000;
export const ACTIVITY_STALE_MS = 10 * 60_000;
// Keys kept: by x days x closed is a handful in use; a caller's odd `days` can't grow the map.
const MEMO_KEYS = 32;
const memo = new Map<string, { at: number; value: ReturnType<typeof activityStats> }>();
const refreshing = new Map<string, Promise<ReturnType<typeof activityStats>>>();
export const activityMemoSize = () => memo.size;
export const resetActivityMemo = () => (memo.clear(), refreshing.clear());
// Settles when no refresh is running (a test ends its database after it).
export const activityRefreshIdle = () => Promise.allSettled([...refreshing.values()]);
export async function activityStatsCached(opts: Options = {}, wrap?: Parameters<typeof runSliced>[1], now = Date.now()): Promise<ReturnType<typeof activityStats>> {
  const key = `${opts.by ?? 'agent'}|${opts.days ?? ''}|${opts.closed ? 1 : 0}`;
  const have = memo.get(key);
  if (have && now - have.at < ACTIVITY_FRESH_MS) return have.value;
  let run = refreshing.get(key);
  if (!run) {
    run = activityStatsSliced(opts, wrap).then((value) => {
      // Stamped with the caller's clock, so a test can step it; the oldest keys go past MEMO_KEYS.
      memo.set(key, { at: now, value });
      while (memo.size > MEMO_KEYS) memo.delete(memo.keys().next().value!);
      return value;
    });
    refreshing.set(key, run);
    const done = () => void (refreshing.get(key) === run && refreshing.delete(key));
    run.then(done, done);
  }
  if (have && now - have.at < ACTIVITY_STALE_MS) {
    run.catch(() => {});
    return have.value;
  }
  return run;
}

function* statsSteps(opts: Options = {}) {
  const by = opts.by ?? 'agent';
  const now = opts.now ?? Date.now();
  // The window defaults to 30 days, so a request never reads the whole history.
  const days = opts.days ?? 30;
  const since = new Date(now - days * 86_400_000).toISOString();
  const to = new Date(now).toISOString();
  const d = db.open();

  const ctx = costCtx(now);
  const agents = new Map(
    (d.prepare('SELECT id, name, harness, model, type FROM agents').all() as { id: string; name: string; harness: string; model: string | null; type: string | null }[]).map((a) => [a.id, a]),
  );
  const usage = new Map<string, number>();
  const usageAcct = new Map<string, Map<string, number>>();
  for (const u of d.prepare('SELECT agent_id, account, SUM(cost_usd) AS c FROM usage WHERE day >= ? GROUP BY agent_id, account').all(since.slice(0, 10)) as { agent_id: string; account: string; c: number }[]) {
    usage.set(u.agent_id, (usage.get(u.agent_id) ?? 0) + u.c);
    if (!usageAcct.has(u.agent_id)) usageAcct.set(u.agent_id, new Map());
    usageAcct.get(u.agent_id)!.set(u.account, u.c);
  }

  if (by === 'agent') {
    const { rows, categories } = yield* agentRows(clippedByAgent(d, since, to), agents, usage, usageAcct, ctx);
    return { note: COST_NOTE, by, since, rows, categories, labels: activityLabels() };
  }

  // ITSA state is read before the item pass, so the streamed items are the only open query.
  // The steps that don't yield are labelled, so a long slice names its step in daemon.log (S-4356).
  if (due()) yield;
  const attribute = timed('activity: attribution', () => buildAttribution()).attribute;
  if (due()) yield;
  // weekly_percent is not part of the activity rows, and its worth estimate costs over 100 ms the first time.
  const c = yield* computeSteps({ days, now, worthMid: () => null });
  const categoryOf = new Map(itsa.statuses().map((s) => [s.name, s.category as string]));
  const perItsa = new Map<string, Split>();
  const agentWork = new Map<string, Map<string, number>>();
  for (const batch of clippedByAgent(d, since, to)) {
    if (!batch) {
      yield;
      continue;
    }
    for (const it of batch) {
      for (const { itsaId, share } of attribute(it.agent_id, Date.parse(it.start))) {
        if (!perItsa.has(itsaId)) perItsa.set(itsaId, splitZero());
        addItem(perItsa.get(itsaId)!, it, it.seconds * share);
        if (it.kind !== 'gap') {
          if (!agentWork.has(itsaId)) agentWork.set(itsaId, new Map());
          agentWork.get(itsaId)!.set(it.agent_id, (agentWork.get(itsaId)!.get(it.agent_id) ?? 0) + it.seconds * share);
        }
      }
    }
  }

  // Review rounds: status moves from a review category back to an active or ready one.
  const moves = new Map<string, number>();
  // Streamed and yielded, so the whole history of status events never holds the loop (S-4356).
  for (const e of d.prepare("SELECT itsa_id, data FROM itsa_events WHERE type = 'status'").iterate() as Iterable<{ itsa_id: string; data: string | null }>) {
    const x = e.data ? (JSON.parse(e.data) as { from?: string; to?: string }) : {};
    if (REVIEW.has(categoryOf.get(x.from ?? '') ?? '') && ACTIVE_OR_READY.has(categoryOf.get(x.to ?? '') ?? '')) moves.set(e.itsa_id, (moves.get(e.itsa_id) ?? 0) + 1);
    if (due()) yield;
  }
  if (due()) yield;
  const reviewers = timed('activity: reviewers', () => reviewersByItsa(d, agents, c.items));
  if (due()) yield;

  // Roll-up time over the ITSA tree, each node's own counted once.
  const children = new Map<string, string[]>();
  for (const x of c.items.values()) if (x.parent_id && c.items.has(x.parent_id)) add2(children, x.parent_id, x.id);
  const rolled = new Map<string, Split>();
  const rollup = (id: string): Split => {
    const memo = rolled.get(id);
    if (memo) return memo;
    const t = splitZero();
    const own = perItsa.get(id);
    if (own) mergeSplit(t, own);
    for (const k of children.get(id) ?? []) mergeSplit(t, rollup(k));
    rolled.set(id, t);
    return t;
  };

  const kept = [...c.items.values()]
    .filter((x) => !opts.closed || x.category === 'closed')
    .filter((x) => !since || (x.closed_at ? x.closed_at >= since : perItsa.has(x.id) || (x.own.cost_usd ?? 0) > 0));
  const rowOf = (x: (typeof kept)[number]) => {
    const own = perItsa.get(x.id) ?? splitZero();
    const total = rollup(x.id);
    const work = [...(agentWork.get(x.id) ?? [])].sort((a, b) => b[1] - a[1]);
    // The type is the most-working agent that is not a reviewer type (ring members included).
    const topWorker = work.find(([id]) => !isReviewerType(agents.get(id)?.type ?? ''));
    const topAgent = topWorker ? agents.get(topWorker[0]) : undefined;
    return {
      key: x.key,
      kind: x.kind,
      title: x.title,
      status: x.status,
      category: x.category,
      config: x.config,
      type: topAgent?.type ?? null,
      created_at: new Date(x.created).toISOString(),
      closed_at: x.closed_at,
      lead_s: x.closed_at ? Math.round((Date.parse(x.closed_at) - x.created) / 1000) : null,
      own: { ...round(own), cost_usd: round6(x.own.cost_usd), modes: modesOf(ctx, x.accounts) },
      total: { ...round(total), cost_usd: round6(x.total.cost_usd) },
      review_moves: moves.get(x.id) ?? 0,
      reviewer_agents: reviewers.get(x.id)?.size ?? 0,
      review_rounds: (moves.get(x.id) ?? 0) + (reviewers.get(x.id)?.size ?? 0),
      // Who worked on it, and their own working time there, most first (S-226).
      agents: work.map(([id, s]) => ({ id, name: agents.get(id)?.name ?? id, working_s: Math.round(s) })),
    };
  };
  const itsaRows = [];
  for (const x of kept) {
    itsaRows.push(rowOf(x));
    if (due()) yield;
  }
  itsaRows.sort((a, b) => b.total.cost_usd - a.total.cost_usd || a.key.localeCompare(b.key));

  if (by === 'itsa') return { note: COST_NOTE, by, since, rows: itsaRows };

  // By model and by type, over closed work issues only: kind issue with working time. Retro and feedback
  // items, proposals and ITSAs nobody worked on would pull the medians to zero.
  const closedRows = itsaRows.filter((r) => r.category === 'closed' && r.kind === 'issue' && r.own.working_s > 0);
  const group = (keyOf: (r: (typeof closedRows)[number]) => string | null) => {
    const g = new Map<string, (typeof closedRows)[number][]>();
    for (const r of closedRows) {
      const k = keyOf(r) ?? 'unknown';
      if (!g.has(k)) g.set(k, []);
      g.get(k)!.push(r);
    }
    return [...g].map(([key, list]) => ({
      [by]: key,
      n: list.length,
      working_s: spread(list.map((r) => r.own.working_s)),
      waiting_s: spread(list.map((r) => r.own.waiting_s)),
      cost_usd: spread(list.map((r) => r.own.cost_usd)),
      cost_modes: modesSpread(list.map((r) => r.own.modes)),
      lead_s: spread(list.filter((r) => r.lead_s != null).map((r) => r.lead_s as number)),
      review_rounds: spread(list.map((r) => r.review_rounds)),
    }));
  };
  const rowsOut = by === 'model' ? group((r) => r.config) : group((r) => r.type);
  return { note: COST_NOTE, by, since, rows: rowsOut.sort((a, b) => b.n - a.n || String(Object.values(a)[0]).localeCompare(String(Object.values(b)[0]))) };
}

// Time and est cost per activity category (S-225): top-level and leaf keys, NULL as "unclassified".
// Working items only (not gaps, which carry no category): the categories the agent's work went to.
// top_cost_by_account is the raw input of the per-mode cost, converted once at the end.
interface Cats {
  top_s: Record<string, number>;
  leaf_s: Record<string, number>;
  top_cost_usd: Record<string, number>;
  top_cost_by_account: Map<string, Map<string, number>>;
}
const catsZero = (): Cats => ({ top_s: {}, leaf_s: {}, top_cost_usd: {}, top_cost_by_account: new Map() });
function addCategory(c: Cats, it: Clipped, account: string) {
  if (it.kind === 'gap') return;
  const leaf = it.category ?? 'unclassified';
  add(c.top_s, top(leaf), it.seconds);
  add(c.leaf_s, leaf, it.seconds);
  add(c.top_cost_usd, top(leaf), it.est_cost_usd);
  addAcct(c.top_cost_by_account, top(leaf), account, it.est_cost_usd);
}
function addAcct(m: Map<string, Map<string, number>>, k: string, account: string, v: number) {
  if (!m.has(k)) m.set(k, new Map());
  m.get(k)!.set(account, (m.get(k)!.get(account) ?? 0) + v);
}

const roundCats = (c: Cats, ctx: Ctx) => ({
  top_s: roundAll(c.top_s),
  leaf_s: roundAll(c.leaf_s),
  top_cost_usd: Object.fromEntries(Object.entries(c.top_cost_usd).map(([k, v]) => [k, round6(v)])),
  top_cost_modes: Object.fromEntries([...c.top_cost_by_account].map(([k, m]) => [k, modesOf(ctx, m)])),
});

// Human labels for every key the activity views show (S-225).
export function activityLabels(): Record<string, string> {
  const keys = new Set([...Object.keys(WAIT_LABELS), ...Object.keys(CATEGORY_LABELS)]);
  return Object.fromEntries([...keys].map((k) => [k, activityLabel(k)]));
}

// The agents' rows and the overall category totals. The totals sum the unrounded per-agent times, then
// round once, so small agents' fractions are not lost (S-225).
function* agentRows(batches: Iterable<Clipped[] | null>, agents: Map<string, { name: string; harness: string; model: string | null; type: string | null }>, usage: Map<string, number>, usageAcct: Map<string, Map<string, number>>, ctx: Ctx) {
  const accounts = new Map<string, string>();
  const accountOf = (id: string): string => {
    if (!accounts.has(id)) accounts.set(id, accountFor(agents.get(id) ?? { harness: '' }) ?? '');
    return accounts.get(id)!;
  };
  const per = new Map<string, { s: Split; c: Cats; first: number; last: number; est: number; n: number }>();
  const overall = catsZero();
  for (const batch of batches) {
    if (!batch) {
      yield;
      continue;
    }
    for (const it of batch) {
      if (!per.has(it.agent_id)) per.set(it.agent_id, { s: splitZero(), c: catsZero(), first: Infinity, last: -Infinity, est: 0, n: 0 });
      const p = per.get(it.agent_id)!;
      addItem(p.s, it, it.seconds);
      addCategory(p.c, it, accountOf(it.agent_id));
      p.first = Math.min(p.first, Date.parse(it.start));
      p.last = Math.max(p.last, Date.parse(it.end));
      p.est += it.est_cost_usd;
      p.n++;
    }
  }
  if (due()) yield;
  for (const p of per.values()) {
    for (const [k, v] of Object.entries(p.c.top_s)) add(overall.top_s, k, v);
    for (const [k, v] of Object.entries(p.c.leaf_s)) add(overall.leaf_s, k, v);
    for (const [k, v] of Object.entries(p.c.top_cost_usd)) add(overall.top_cost_usd, k, v);
    for (const [k, m] of p.c.top_cost_by_account) for (const [a, v] of m) addAcct(overall.top_cost_by_account, k, a, v);
  }
  const ids = new Set([...per.keys(), ...usage.keys()]);
  const rowOf = (id: string) => {
    const a = agents.get(id);
    const p = per.get(id);
    return {
      agent: a?.name ?? id,
      id,
      harness: a?.harness ?? null,
      model: a?.model ?? null,
      type: a?.type ?? null,
      items: p?.n ?? 0,
      // No transcript yet: time is unknown, not zero.
      wall_s: p && p.n ? Math.round((p.last - p.first) / 1000) : null,
      working_s: p && p.n ? Math.round(p.s.working_s) : null,
      waiting_s: p && p.n ? Math.round(p.s.waiting_s) : null,
      working_by_kind: p ? roundAll(p.s.working_by_kind) : null,
      waiting_by_top: p ? roundAll(p.s.waiting_by_top) : null,
      waiting_by_kind: p ? roundAll(p.s.waiting_by_kind) : null,
      cost_usd: round6(usage.get(id) ?? 0),
      modes: modesOf(ctx, usageAcct.get(id) ?? new Map()),
      item_est_cost_usd: round6(p?.est ?? 0),
      item_est_modes: modesOf(ctx, new Map([[accountOf(id), p?.est ?? 0]])),
      categories: roundCats(p?.c ?? catsZero(), ctx),
    };
  };
  const rows = [];
  for (const id of ids) {
    rows.push(rowOf(id));
    if (due()) yield;
  }
  rows.sort((a, b) => (b.cost_usd - a.cost_usd) || a.agent.localeCompare(b.agent));
  return { rows, categories: roundCats(overall, ctx) };
}

// The ITSA keys and branch names a reviewer's first prompt names (S-244). A key is S-N on whole tokens
// (S-21 is not in S-210). A branch is a run of text up to whitespace, a backtick, a quote, a comma, a
// closing paren, or the end, less a sentence-final `.`; so `stam/feature-x.v2` is one branch name.
const KEY = /(?<![A-Za-z0-9_/-])S-\d+(?![A-Za-z0-9_/-])/g;
const BRANCH = /[^\s`'",)]+/g;
export function promptNames(prompt: string): Set<string> {
  const out = new Set<string>(prompt.match(KEY) ?? []);
  for (const m of prompt.matchAll(BRANCH)) out.add(m[0].replace(/\.$/, ''));
  return out;
}

// The reviewer agents by the names their first prompts give, built once and rebuilt only when reviewer
// agents are added (the count and the largest id change). Keyed by name: a lookup is one map read.
let reviewerIndex: { sig: string; byName: Map<string, Set<string>> } | null = null;
export function reviewerNames(d: ReturnType<typeof db.open>): Map<string, Set<string>> {
  const types = reviewerTypes();
  const marks = types.map(() => '?').join(',');
  const { n, max } = d.prepare(`SELECT COUNT(*) AS n, MAX(id) AS max FROM agents WHERE type IN (${marks}) AND first_prompt IS NOT NULL`).get(...types) as { n: number; max: string | null };
  const sig = `${types.join(',')}:${n}:${max ?? ''}`;
  if (reviewerIndex?.sig === sig) return reviewerIndex.byName;
  const byName = new Map<string, Set<string>>();
  for (const r of d.prepare(`SELECT id, first_prompt FROM agents WHERE type IN (${marks}) AND first_prompt IS NOT NULL`).all(...types) as { id: string; first_prompt: string }[]) {
    for (const name of promptNames(r.first_prompt)) {
      if (!byName.has(name)) byName.set(name, new Set());
      byName.get(name)!.add(r.id);
    }
  }
  reviewerIndex = { sig, byName };
  return byName;
}

// The reviewers of each ITSA, as agent ids (S-244): reviewer-type participants, and reviewer agents whose
// first prompt names the ITSA's key or one of its linked branches. Reviews go by mail, so reviewers are
// rarely participants. Each reviewer agent counts once per ITSA; its rounds are the agent count.
// `from` replaces what the database holds when this daemon is not the ITSA home or has peers (S-1079): the
// participants and branch links the home exported, and the reviewer agents' names from every machine.
export interface ReviewerSources {
  participants?: { itsa_id: string; agent_id: string }[];
  links?: { itsa_id: string; external_id: string }[];
  names?: Map<string, Set<string>>;
}
export function reviewersByItsa(d: ReturnType<typeof db.open>, agents: Map<string, { type: string | null }>, items: Map<string, { key: string }>, from: ReviewerSources = {}): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const put = (itsaId: string, agentId: string) => {
    if (!out.has(itsaId)) out.set(itsaId, new Set());
    out.get(itsaId)!.add(agentId);
  };
  for (const p of from.participants ?? (d.prepare('SELECT itsa_id, agent_id FROM itsa_participants').all() as { itsa_id: string; agent_id: string }[])) {
    if (isReviewerType(agents.get(p.agent_id)?.type ?? '')) put(p.itsa_id, p.agent_id);
  }
  const byName = from.names ?? reviewerNames(d);
  const branches = new Map<string, string[]>();
  for (const l of from.links ?? (d.prepare("SELECT itsa_id, external_id FROM itsa_links WHERE system = 'branch' AND external_id IS NOT NULL").all() as { itsa_id: string; external_id: string }[])) {
    add2(branches, l.itsa_id, l.external_id);
  }
  for (const [itsaId, x] of items) {
    for (const name of [x.key, ...(branches.get(itsaId) ?? [])]) for (const agentId of byName.get(name) ?? []) put(itsaId, agentId);
  }
  return out;
}

function add2(m: Map<string, string[]>, k: string, v: string) {
  if (!m.has(k)) m.set(k, []);
  m.get(k)!.push(v);
}
function mergeSplit(t: Split, s: Split) {
  t.working_s += s.working_s;
  t.waiting_s += s.waiting_s;
  for (const [k, v] of Object.entries(s.working_by_kind)) add(t.working_by_kind, k, v);
  for (const [k, v] of Object.entries(s.waiting_by_top)) add(t.waiting_by_top, k, v);
  for (const [k, v] of Object.entries(s.waiting_by_kind)) add(t.waiting_by_kind, k, v);
}
function round(s: Split) {
  return {
    working_s: Math.round(s.working_s),
    waiting_s: Math.round(s.waiting_s),
    working_by_kind: roundAll(s.working_by_kind),
    waiting_by_top: roundAll(s.waiting_by_top),
    waiting_by_kind: roundAll(s.waiting_by_kind),
  };
}
const roundAll = (m: Record<string, number>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Math.round(v)]));
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

// The measured split (S-227): where an agent's wall time went, in the six keys a retro's self-report
// uses. Percentages of the classified time; `unclassified` is the share of all time that has no
// category (NULL or other.*), reported beside the six so they still sum to 100.
export type EffortKey = (typeof EFFORT_KEYS)[number];
export interface MeasuredEffort {
  split: Record<EffortKey, number>;
  unclassified: number;
  seconds: Record<EffortKey | 'unclassified', number>;
}

// The effort key of a category's top level. `other` and unknown tops are unclassified (null).
const TOP_KEY: Record<string, EffortKey> = {
  understand: 'reading',
  plan: 'reading',
  produce: 'implementing',
  integrate: 'implementing',
  operate: 'implementing',
  diagnose: 'implementing',
  verify: 'testing',
  wait: 'waiting',
  communicate: 'coordination',
  track: 'coordination',
  delegate: 'coordination',
  self: 'coordination',
};
export function effortKey(kind: string, category: string | null): EffortKey | null {
  if (kind === 'gap') return 'waiting';
  return (category && TOP_KEY[category.split('.')[0]]) || null;
}

// A window in which an agent's owned ITSA is back in an active status after a review move: [from, to) in ms.
export type Window = [number, number];
export interface StatusEvent {
  itsa_id: string;
  ts: string;
  type: string;
  data: string | null;
}

// Each agent's review-fix windows, from the ITSA events (pure). The owner is the one the ITSA had at
// the time (owner changes are 'owner' events, the first one's `from` is the owner before any); a
// window opens on a review-to-active status move and closes at the next move out of active, or when
// the owner changes, which reopens it for the new owner. Overlapping windows are merged.
export function fixWindowsFrom(events: StatusEvent[], ownerNow: Map<string, string | null>, categoryOf: Map<string, string>): Map<string, Window[]> {
  const firstOwner = new Map<string, string | null>();
  for (const e of events) if (e.type === 'owner' && !firstOwner.has(e.itsa_id)) firstOwner.set(e.itsa_id, (parseData(e.data) as { from?: string | null }).from ?? null);
  const out = new Map<string, Window[]>();
  const state = new Map<string, { owner: string | null; open: number | null }>();
  const close = (s: { owner: string | null; open: number | null }, at: number) => {
    if (s.open !== null && s.owner) out.set(s.owner, [...(out.get(s.owner) ?? []), [s.open, at]]);
    s.open = null;
  };
  for (const e of events) {
    const data = parseData(e.data) as { from?: string | null; to?: string | null };
    const at = Date.parse(e.ts);
    if (!state.has(e.itsa_id)) state.set(e.itsa_id, { owner: firstOwner.has(e.itsa_id) ? firstOwner.get(e.itsa_id)! : (ownerNow.get(e.itsa_id) ?? null), open: null });
    const s = state.get(e.itsa_id)!;
    if (e.type === 'owner') {
      const wasOpen = s.open !== null;
      close(s, at);
      s.owner = data.to ?? null;
      if (wasOpen) s.open = at;
    } else if (e.type === 'status') {
      const from = categoryOf.get(String(data.from)) ?? '';
      const to = categoryOf.get(String(data.to)) ?? '';
      if (from === 'review' && to === 'active') {
        if (s.open === null) s.open = at;
      } else if (to !== 'active') close(s, at);
    }
  }
  for (const s of state.values()) if (s.open !== null && s.owner) out.set(s.owner, [...(out.get(s.owner) ?? []), [s.open, Infinity]]);
  for (const [id, ws] of out) out.set(id, mergeWindows(ws));
  return out;
}

function mergeWindows(ws: Window[]): Window[] {
  const sorted = [...ws].sort((a, b) => a[0] - b[0]);
  const merged: Window[] = [];
  for (const w of sorted) {
    const last = merged.at(-1);
    if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
    else merged.push([w[0], w[1]]);
  }
  return merged;
}

// The review-fix windows of every agent, read once from the ITSA events.
export function fixWindows(): Map<string, Window[]> {
  const d = db.open();
  const categoryOf = new Map(itsa.statuses().map((s) => [s.name, s.category as string]));
  const ownerNow = new Map((d.prepare('SELECT id, owner FROM itsas').all() as { id: string; owner: string | null }[]).map((r) => [r.id, r.owner]));
  const events = d.prepare("SELECT itsa_id, ts, type, data FROM itsa_events WHERE type IN ('status', 'owner') ORDER BY id").all() as unknown as StatusEvent[];
  return fixWindowsFrom(events, ownerNow, categoryOf);
}

// The measured split of items (pure): each stretch of wall time, clipped to [from, until) ms, is
// split evenly among the items covering it, so concurrent items count once. A non-gap item's share
// goes to review_fixes where the stretch lies in one of the agent's windows, else to its key.
// Returns null when there is no time at all.
export function measuredFromItems(items: { kind: string; category: string | null; start: string; end: string }[], windows: Window[], from = -Infinity, until = Infinity): MeasuredEffort | null {
  const seconds = Object.fromEntries([...EFFORT_KEYS, 'unclassified'].map((k) => [k, 0])) as Record<EffortKey | 'unclassified', number>;
  const kept = items
    .map((it) => ({ it, s: Math.max(Date.parse(it.start), from), e: Math.min(Date.parse(it.end), until) }))
    .filter((x) => x.e > x.s);
  sweep(
    kept.map((x) => [x.s, x.e] as Window),
    windows.flat(),
    (a, b, active) => {
      const mid = (a + b) / 2;
      const inFix = windows.some(([x, y]) => mid >= x && mid < y);
      for (const i of active) {
        const { it } = kept[i];
        const sec = (b - a) / 1000 / active.length;
        if (inFix && it.kind !== 'gap') seconds.review_fixes += sec;
        else seconds[effortKey(it.kind, it.category) ?? 'unclassified'] += sec;
      }
    },
  );
  const classified = EFFORT_KEYS.reduce((n, k) => n + seconds[k], 0);
  const all = classified + seconds.unclassified;
  if (all <= 0) return null;
  const pct = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 1000) / 10 : 0);
  const split = Object.fromEntries(EFFORT_KEYS.map((k) => [k, pct(seconds[k], classified)])) as Record<EffortKey, number>;
  for (const k of Object.keys(seconds) as (EffortKey | 'unclassified')[]) seconds[k] = Math.round(seconds[k]);
  return { split, unclassified: pct(seconds.unclassified, all), seconds };
}

// An agent's measured split (S-227) from its activity items, over its whole life or the given window.
export function measuredEffort(agentId: string, opts: { since?: string; until?: string } = {}, windows: Map<string, Window[]> = fixWindows()): MeasuredEffort | null {
  const d = db.open();
  const since = opts.since ?? '0000-01-01T00:00:00.000Z';
  const until = opts.until ?? '9999-12-31T23:59:59.999Z';
  const rows = d
    .prepare(`SELECT kind, category, start, "end" FROM activity_items WHERE agent_id = ? AND kind != 'text' AND start < ? AND "end" > ?`)
    .iterate(agentId, until, since) as unknown as Iterable<{ kind: string; category: string | null; start: string; end: string }>;
  const items = [...rows];
  return measuredFromItems(items, windows.get(agentId) ?? [], Date.parse(since), Date.parse(until));
}
