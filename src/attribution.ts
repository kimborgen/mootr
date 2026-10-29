// Attribution and estimates (docs/cost-policy.md, build step 7): each agent's and each tree's
// estimated share of a subscription window, and when the window reaches 100% at the current
// rate. Everything here is an estimate from stam's own samples and window readings; it never
// sets or clears a blocker.
//
//   weighted tokens  w = Σ over token types of tokens × price (USD per million tokens, from the
//                    registry's `prices`; a model without a price weighs 1 per token, a type
//                    without a price uses the model's input price)
//   interval         two consecutive window readings a, b (the last reading in each 5-minute
//                    bucket), covering the sample buckets after a's bucket up to b's
//   change           Δ = b% − a%, at least 0 (a fall under an unchanged, unpassed reset time is a
//                    correction: Δ = 0, no reset); across a window reset (reset time moved or
//                    passed, or a fall with no reset time), Δ = b% and only buckets from the reset on.
//                    A reading whose neighbours agree within 5 points and differ from it by more
//                    is an outlier and is dropped (S-3243)
//   scale            s, percent per weighted token, an exponential moving average of Δ / W over
//                    intervals, weighted by time (α = 1 − e^(−dt / 2 h)); reset (re-seeded from
//                    this interval's Δ / W) when the window resets or Δ misses s × W by > 25%
//   explained        E = Δ when W > 0 and s is unknown or the miss is within 25% or Δ is below
//                    the prediction; E = s × W when Δ exceeds the prediction by more than 25%;
//                    E = 0 when W = 0 (no stam agent ran)
//   agent share      Δ_i = w_i / W × E;   other = Δ − E;   Σ Δ_i + other = Δ
//   tree share       Σ Δ_i over the agent and its descendants, each agent once
//   projection       rate = min(s × (W over the last 30 minutes) / 30 min, R), where R is the rise
//                    the readings show over the same 30 minutes (from the reading at the 30 minutes' start,
//                    to the last, within the current window; none when the window started inside the 30
//                    minutes); 100% at now + (100 − current%) / rate, or null
//                    when the rate is 0 (no stam use, or the readings show no rise), s is unknown,
//                    or the window resets first
import * as db from './db.ts';
import * as tree from './tree.ts';
import { registry } from './registry.ts';
import { settings } from './settings.ts';
import { convert, roundModes, type Ctx, type Modes } from './cost-display.ts';
import type { UsageSample } from './usage.ts';
import { timed } from './stall.ts';
import { hourly, profile, hourRates, average, agentRates, patternProjection, paces } from './usage-history.ts';

const BUCKET_MS = 5 * 60_000;
const EMA_TAU_MS = 2 * 3_600_000;
const MISS = 0.25;
const BURN_MS = 30 * 60_000;
// The most the neighbours of a reading may differ for it to be judged an outlier, in points.
const OUTLIER = 5;
// Calibration starts this long before the span asked for, so the scale is warm by then.
const WARMUP_MS = 6 * 3_600_000;
const WINDOW_MS: Record<string, number> = { five_hour: 5 * 3_600_000, seven_day: 7 * 86_400_000 };
const TOP = 5;

export const ESTIMATE_NOTE = 'Estimates: shares split each change in a window among stam agents by API-price-weighted tokens; other is change no stam agent explains.';

interface Price {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}

// The registry's price for a model: an exact key, or the key without a context suffix such
// as "[1m]". Null when the model has none.
function priceOf(model: string, prices: Record<string, unknown>): Price | null {
  const p = (prices[model] ?? prices[model.replace(/\[.*\]$/, '')]) as Partial<Price> | null | undefined;
  if (!p || typeof p !== 'object' || typeof p.input !== 'number') return null;
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  return { input: p.input, output: num(p.output), cacheRead: num(p.cacheRead), cacheWrite: num(p.cacheWrite) };
}

type Tokens = Pick<UsageSample, 'model' | 'tokens_in' | 'tokens_out' | 'tokens_cache_read' | 'tokens_cache_write'>;

// A sample's weighted tokens, in USD per million tokens times tokens (so one unit is a
// millionth of a dollar at API prices). `prices` defaults to the registry's.
export function weighted(s: Tokens, prices: Record<string, unknown> = registry().prices ?? {}): number {
  const p = priceOf(s.model, prices);
  if (!p) return s.tokens_in + s.tokens_out + s.tokens_cache_read + s.tokens_cache_write;
  const at = (v: number | null) => v ?? p.input!;
  return s.tokens_in * p.input! + s.tokens_out * at(p.output) + s.tokens_cache_read * at(p.cacheRead) + s.tokens_cache_write * at(p.cacheWrite);
}

// A message's cost in USD at the registry's API prices, or null when the model has no price.
export function priceUsd(s: Tokens, prices: Record<string, unknown> = registry().prices ?? {}): number | null {
  return priceOf(s.model, prices) ? weighted(s, prices) / 1e6 : null;
}

// A model's tokens priced per kind at the API prices, in USD (S-1440). A kind is null when its
// price is null (unverified) or the harness reports no tokens of it; `total` adds the kinds that
// have a cost and is null when the model has no price or any reported kind is unpriced, so a
// partial sum never reads as the whole.
export interface KindCosts {
  cost_in: number | null;
  cost_out: number | null;
  cost_cache_read: number | null;
  cost_cache_write: number | null;
  cost_api_total: number | null;
}
const NO_KIND_COSTS: KindCosts = { cost_in: null, cost_out: null, cost_cache_read: null, cost_cache_write: null, cost_api_total: null };
export function kindCosts(model: string | null, t: { tokens_in: number | null; tokens_out: number | null; tokens_cache_read: number | null; tokens_cache_write: number | null }, prices: Record<string, unknown> = registry().prices ?? {}): KindCosts {
  const p = model == null ? null : priceOf(model, prices);
  if (!p) return { ...NO_KIND_COSTS };
  const usd = (tokens: number | null, price: number | null) => (tokens == null || price == null ? null : (tokens * price) / 1e6);
  const out: KindCosts = {
    cost_in: usd(t.tokens_in, p.input),
    cost_out: usd(t.tokens_out, p.output),
    cost_cache_read: usd(t.tokens_cache_read, p.cacheRead),
    cost_cache_write: usd(t.tokens_cache_write, p.cacheWrite),
    cost_api_total: null,
  };
  const parts = [[t.tokens_in, out.cost_in], [t.tokens_out, out.cost_out], [t.tokens_cache_read, out.cost_cache_read], [t.tokens_cache_write, out.cost_cache_write]] as const;
  const reported = parts.filter(([tokens]) => tokens != null && tokens > 0);
  if (reported.length && reported.every(([, c]) => c != null)) out.cost_api_total = reported.reduce((x, [, c]) => x + c!, 0);
  else if (!reported.length && parts.some(([tokens]) => tokens != null)) out.cost_api_total = 0;
  return out;
}

interface Reading {
  at: number;
  used: number;
  resets_at: number | null;
}

// The last reading in each 5-minute bucket, oldest first, so every interval spans at least
// one bucket boundary and each bucket belongs to exactly one interval.
function readings(name: string, window: string, from: number, until: number): Reading[] {
  type Row = { at: string; used_percentage: number | null; resets_at: number | null };
  const q = (sql: string, ...args: string[]) => db.open().prepare(sql).all(...args) as Row[];
  const cols = 'SELECT at, used_percentage, resets_at FROM window_readings WHERE name = ? AND window = ?';
  // The reading just before `from` is context for the outlier test on the first one, so the
  // same reading is judged the same way whatever range asks for it.
  const before = q(`${cols} AND at < ? AND used_percentage IS NOT NULL ORDER BY at DESC LIMIT 1`, name, window, new Date(from).toISOString());
  const rows = [...before, ...q(`${cols} AND at >= ? AND at <= ? ORDER BY at`, name, window, new Date(from).toISOString(), new Date(until).toISOString())];
  const out: Reading[] = [];
  for (const r of rows) {
    if (r.used_percentage == null) continue;
    const reading = { at: Date.parse(r.at), used: r.used_percentage, resets_at: r.resets_at };
    const last = out[out.length - 1];
    if (last && Math.floor(last.at / BUCKET_MS) === Math.floor(reading.at / BUCKET_MS)) out[out.length - 1] = reading;
    else out.push(reading);
  }
  return withoutOutliers(out).filter((r) => r.at >= from);
}

// Drops an isolated outlier (S-3243): a reading whose neighbours on both sides share its
// resets_at, agree with each other within OUTLIER points, and sit more than OUTLIER points from
// it, up or down. A lasting change is not one: it is a correction or a reset (see `isReset`).
// The first and last readings have a neighbour on one side only and are kept.
function withoutOutliers(rs: Reading[]): Reading[] {
  return rs.filter((r, i) => {
    const p = rs[i - 1];
    const n = rs[i + 1];
    if (!p || !n || r.resets_at == null || p.resets_at !== r.resets_at || n.resets_at !== r.resets_at) return true;
    return !(Math.abs(p.used - n.used) <= OUTLIER && Math.abs(r.used - p.used) > OUTLIER && Math.abs(r.used - n.used) > OUTLIER);
  });
}

// Whether b starts a new window after a: the reset time changed, or the percentage fell with no
// reset time to check it against, or b is past a's reset time. A fall under an unchanged,
// unpassed reset time is a correction, not a reset: it counts as no change.
function isReset(a: Reading, b: Reading): boolean {
  if (a.resets_at !== b.resets_at) return true;
  if (b.used >= a.used) return false;
  return a.resets_at == null || b.at >= a.resets_at * 1000;
}

// Every account's samples from `from` on, as weighted tokens per bucket, agent and model.
type Weighted = { bucket: number; agent: string; model: string; w: number };
// Inside withSampleMemo, the widest samples read per account: a narrower range is cut from it, not queried again.
let sampleMemo: Map<string, { from: number; until: number; rows: Weighted[] }> | null = null;

// Runs fn with the samples of the accounts read once (S-391): the snapshot reads a short and a long range of
// the same account, and no sample is written while it runs, since it is synchronous.
export function withSampleMemo<T>(fn: () => T): T {
  const outer = sampleMemo;
  sampleMemo = new Map();
  try {
    return fn();
  } finally {
    sampleMemo = outer;
  }
}

function weightedSamples(account: string, from: number, until: number): Weighted[] {
  const memo = sampleMemo?.get(account);
  if (memo && memo.from <= from && memo.until >= until) return memo.rows.filter((r) => r.bucket >= from && r.bucket < until);
  const rows = readWeightedSamples(account, from, until);
  sampleMemo?.set(account, { from, until, rows });
  return rows;
}

function readWeightedSamples(account: string, from: number, until: number): Weighted[] {
  const prices = registry().prices ?? {};
  const rows = db.open()
    .prepare('SELECT * FROM usage_samples WHERE account = ? AND bucket >= ? AND bucket < ? ORDER BY bucket')
    .all(account, new Date(from).toISOString(), new Date(until).toISOString()) as unknown as UsageSample[];
  return rows.map((r) => ({ bucket: Date.parse(r.bucket), agent: r.agent_id, model: r.model ?? '', w: weighted(r, prices) }));
}

// The window readings for an account are stored under its harness's name.
function readingName(account: string): string | null {
  return settings().cost.accounts?.[account]?.match?.harness ?? null;
}

export interface Interval {
  from: string;
  to: string;
  change: number;
  weighted: number;
  // The scale before this interval (the prediction's), and after it.
  scale_before: number | null;
  scale: number | null;
  reset: 'window' | 'miss' | null;
  explained: number;
  other: number;
  agents: Record<string, number>;
  models: Record<string, number>;
}

export interface Calibration {
  intervals: Interval[];
  scale: number | null;
  current: Reading | null;
}

const floorBucket = (t: number) => Math.floor(t / BUCKET_MS) * BUCKET_MS;

// Walks the readings from `from` to `now`, fitting the scale and splitting each change.
// The calibration walk: its own queries are labelled; the rest of its time is the walk (S-344).
export function calibrate(account: string, window: string, from: number, now: number = Date.now()): Calibration {
  return timed('calibrate: walk', () => calibrateWalk(account, window, from, now));
}

function calibrateWalk(account: string, window: string, from: number, now: number): Calibration {
  const name = readingName(account);
  if (!name) return { intervals: [], scale: null, current: null };
  const rs = timed('calibrate: readings query', () => readings(name, window, from, now));
  const samples = rs.length > 1 ? timed('calibrate: samples query', () => weightedSamples(account, floorBucket(rs[0].at) + BUCKET_MS, floorBucket(rs[rs.length - 1].at) + BUCKET_MS)) : [];
  const intervals: Interval[] = [];
  let scale: number | null = null;
  let i = 0;
  for (let k = 1; k < rs.length; k++) {
    const a = rs[k - 1];
    const b = rs[k];
    let start = floorBucket(a.at) + BUCKET_MS;
    const end = floorBucket(b.at) + BUCKET_MS;
    const windowReset = isReset(a, b);
    let change = Math.max(0, b.used - a.used);
    if (windowReset) {
      change = b.used;
      // Only tokens from the reset on count toward the new window.
      if (a.resets_at != null && a.resets_at * 1000 > a.at && a.resets_at * 1000 <= b.at) start = Math.max(start, floorBucket(a.resets_at * 1000));
      scale = null;
    }
    const agents: Record<string, number> = {};
    const models: Record<string, number> = {};
    let W = 0;
    while (i < samples.length && samples[i].bucket < end) {
      const s = samples[i++];
      if (s.bucket < start) continue;
      agents[s.agent] = (agents[s.agent] ?? 0) + s.w;
      models[s.model] = (models[s.model] ?? 0) + s.w;
      W += s.w;
    }
    const before: number | null = scale;
    let reset: Interval['reset'] = windowReset ? 'window' : null;
    let explained = 0;
    if (W > 0 && change > 0) {
      const ratio = change / W;
      const predicted = before == null ? null : before * W;
      if (predicted == null) {
        explained = change;
        scale = ratio;
      } else if (Math.abs(change - predicted) > MISS * predicted) {
        // A miss: Δ above the prediction is partly use outside stam; below it, stam's tokens
        // still explain all of Δ. Either way the fit starts over from this interval.
        explained = change > predicted ? predicted : change;
        scale = ratio;
        reset = reset ?? 'miss';
      } else {
        explained = change;
        const alpha = 1 - Math.exp(-(b.at - a.at) / EMA_TAU_MS);
        scale = before! + alpha * (ratio - before!);
      }
    }
    for (const id of Object.keys(agents)) agents[id] = W > 0 ? (agents[id] / W) * explained : 0;
    for (const m of Object.keys(models)) models[m] = W > 0 ? (models[m] / W) * explained : 0;
    intervals.push({
      from: new Date(a.at).toISOString(),
      to: new Date(b.at).toISOString(),
      change,
      weighted: W,
      scale_before: before,
      scale,
      reset,
      explained,
      other: Math.max(0, change - explained),
      agents,
      models,
    });
  }
  return { intervals, scale, current: rs[rs.length - 1] ?? null };
}

// The start of the window's current period: its reset time minus its length, or `now` minus
// its length when the reset time is unknown.
export function windowStart(account: string, window: string, now: number): number {
  const len = WINDOW_MS[window] ?? WINDOW_MS.five_hour;
  const name = readingName(account);
  const row = name
    ? (db.open().prepare('SELECT resets_at FROM window_readings WHERE name = ? AND window = ? ORDER BY at DESC LIMIT 1').get(name, window) as { resets_at: number | null } | undefined)
    : undefined;
  if (row?.resets_at != null) return row.resets_at * 1000 - len;
  return now - len;
}

export interface WindowShares {
  estimate: true;
  account: string;
  window: string;
  since: string;
  change: number;
  other: number;
  scale: number | null;
  // Agent id to estimated percentage points of the window since `since`.
  agents: Record<string, number>;
  // Model to estimated percentage points of the window since `since`.
  models: Record<string, number>;
  intervals: number;
  projection: Projection;
}

export interface Projection {
  estimate: true;
  used_percentage: number | null;
  percent_per_hour: number | null;
  reaches_100_at: string | null;
  resets_at: string | null;
  note?: string;
}

// Each agent's estimated share of one window from `since` (an ISO instant or ms; default the
// window's current period), `other`, and the projection.
export function windowShares(account: string, window: string, since?: string | number, now: number = Date.now()): WindowShares {
  const from = since == null ? windowStart(account, window, now) : typeof since === 'number' ? since : Date.parse(since);
  const cal = calibrate(account, window, from - WARMUP_MS, now);
  const agents: Record<string, number> = {};
  const models: Record<string, number> = {};
  let change = 0;
  let other = 0;
  let count = 0;
  for (const iv of cal.intervals) {
    if (Date.parse(iv.to) <= from) continue;
    count++;
    change += iv.change;
    other += iv.other;
    for (const [id, p] of Object.entries(iv.agents)) agents[id] = (agents[id] ?? 0) + p;
    for (const [m, p] of Object.entries(iv.models)) models[m] = (models[m] ?? 0) + p;
  }
  return {
    estimate: true,
    account,
    window,
    since: new Date(from).toISOString(),
    change,
    other,
    scale: cal.scale,
    agents,
    models,
    intervals: count,
    projection: project(account, cal, now, window),
  };
}

// The percent per millisecond the window readings show over the last 30 minutes, within the
// current window. Zero when they show no rise, or fewer than two readings span the period; null
// when the window began inside the period, so the readings can't say.
function observedRate(account: string, window: string, now: number): number | null {
  const name = readingName(account);
  if (!name) return 0;
  const rs = readings(name, window, now - WARMUP_MS, now);
  // The current window: from the last reset in the readings on.
  let first = rs.length - 1;
  while (first > 0 && !isReset(rs[first - 1], rs[first])) first--;
  const span = rs.slice(first);
  const last = span[span.length - 1];
  if (!last) return 0;
  const from = now - BURN_MS;
  // The current window must have started before the 30 minutes did: a reset or jump inside them
  // leaves a rise from the post-reset reading that the readings can't support, so no rate (S-532).
  if (span[0].at > from) return null;
  // The reading at the span's start: the first at or after it, else the last (no rise then).
  const base = span.find((r) => r.at >= from) ?? last;
  const ms = last.at - base.at;
  const rise = last.used - base.used;
  if (ms <= 0 || rise <= 0) return 0;
  return rise / ms;
}

// When the window reaches 100% at the last 30 minutes' weighted tokens times the scale, or at
// the rise the readings show over the same span, whichever is slower.
function project(account: string, cal: Calibration, now: number, window: string): Projection {
  const cur = cal.current;
  const resets = cur?.resets_at != null ? cur.resets_at * 1000 : null;
  const base: Projection = {
    estimate: true,
    used_percentage: cur?.used ?? null,
    percent_per_hour: null,
    reaches_100_at: null,
    resets_at: resets != null ? new Date(resets).toISOString() : null,
  };
  if (!cur) return { ...base, note: 'no readings' };
  if (cal.scale == null) return { ...base, note: 'not calibrated yet' };
  const W = weightedSamples(account, floorBucket(now - BURN_MS) + BUCKET_MS, floorBucket(now) + BUCKET_MS).reduce((sum, s) => sum + s.w, 0);
  const scaled = (cal.scale * W) / BURN_MS;
  if (cur.used >= 100) return { ...base, percent_per_hour: scaled * 3_600_000, reaches_100_at: new Date(cur.at).toISOString() };
  if (scaled <= 0) return { ...base, percent_per_hour: 0, note: 'no stam use in the last 30 minutes' };
  // An inflated scale must not project past what the readings show.
  const observed = observedRate(account, window, now);
  const perMs = Math.min(scaled, observed ?? 0);
  const out = { ...base, percent_per_hour: perMs * 3_600_000 };
  if (observed == null) return { ...out, note: 'window began in the last 30 minutes' };
  if (perMs <= 0) return { ...out, note: 'readings show no rise in the last 30 minutes' };
  const at = now + (100 - cur.used) / perMs;
  if (resets != null && at >= resets) return { ...out, note: 'resets before reaching 100%' };
  return { ...out, reaches_100_at: new Date(at).toISOString() };
}

// The agents and parent links of one snapshot, loaded once: the tree walks read them instead of a
// query per node. Outside indexed() the walks query the database.
interface TreeIndex {
  byRef: Map<string, db.Agent>;
  parents: Map<string, Set<string>>;
  children: Map<string, Set<string>>;
}
let treeIndex: TreeIndex | null = null;

function indexed<T>(fn: () => T): T {
  if (treeIndex) return fn();
  const agents = db.listAgents();
  const idx: TreeIndex = { byRef: new Map(), parents: new Map(), children: new Map() };
  const link = (child: string, parent: string) => {
    (idx.parents.get(child) ?? idx.parents.set(child, new Set()).get(child)!).add(parent);
    (idx.children.get(parent) ?? idx.children.set(parent, new Set()).get(parent)!).add(child);
  };
  // getAgent matches an id or a name; an id wins over another agent's name.
  for (const a of agents) idx.byRef.set(a.name, a);
  for (const a of agents) idx.byRef.set(a.id, a);
  for (const [child, parent] of tree.edges(agents)) link(child, parent);
  treeIndex = idx;
  try {
    return fn();
  } finally {
    treeIndex = null;
  }
}

const agentRef = (ref: string): db.Agent | undefined => (treeIndex ? treeIndex.byRef.get(ref) : db.getAgent(ref));
const parentIdsOf = (a: db.Agent): string[] => (treeIndex ? [...(treeIndex.parents.get(a.id) ?? [])] : db.parentsOf(a));
const childIdsOf = (id: string): string[] => (treeIndex ? [...(treeIndex.children.get(id) ?? [])] : tree.childrenOf(id));

// The agent and everything below it, each once, even where the tree is a DAG.
export function treeMembers(agentId: string): Set<string> {
  const seen = new Set<string>();
  const stack = [agentId];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...childIdsOf(id));
  }
  return seen;
}

// A tree's estimated share: the sum of its agents' shares, from `shares` or computed.
export function treeShare(agentId: string, account: string, window: string, since?: string | number, shares?: WindowShares): number {
  const s = shares ?? windowShares(account, window, since);
  let sum = 0;
  for (const id of treeMembers(agentId)) sum += s.agents[id] ?? 0;
  return sum;
}

const round = (n: number) => Math.round(n * 100) / 100;
const nameOf = (id: string) => agentRef(id)?.name ?? id;

// Worth and daily history (the Usage page): BY_DAY_DAYS daily buckets per window, and the
// spread of interval scales over the last day for the worth range.
const DAY_MS = 86_400_000;
const BY_DAY_DAYS = 14;
const WORTH_MS = 24 * 3_600_000;
const WORTH_MIN = 5;
// `weighted` counts tokens × USD per million tokens, so one weighted unit is a millionth of a
// dollar. A full window is 100 / scale weighted units, or 100 / (scale × 1e6) dollars: with a
// scale of 1e-6 (a percent per micro-dollar) the whole window is worth $100.
const USD_PER_WEIGHTED = 1 / 1_000_000;

function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export interface Worth {
  estimate: true;
  // What a full window is worth in API-equivalent dollars, and the dollars used and left at
  // the latest reading. Null when the window is not calibrated (no scale yet); used and left
  // are also null when no reading says how much is used.
  worth_usd: { low: number; mid: number; high: number } | null;
  used_usd: number | null;
  left_usd: number | null;
  percent_used: number | null;
  samples: number;
}

// A window's worth: 100 / (scale × 1e6) dollars for each recent interval's scale, with the
// 20th and 80th percentiles as the range, or ±25% around the current scale with few samples.
function worthOf(cal: Calibration, now: number): Worth {
  const percent_used = cal.current?.used ?? null;
  const since = now - WORTH_MS;
  const scales: number[] = [];
  for (const iv of cal.intervals) if (iv.scale != null && Date.parse(iv.to) >= since) scales.push(iv.scale);
  if (!scales.length) return { estimate: true, worth_usd: null, used_usd: null, left_usd: null, percent_used, samples: 0 };
  const usd = (s: number) => (100 * USD_PER_WEIGHTED) / s;
  const vals = scales.map(usd).sort((a, b) => a - b);
  let low: number;
  let mid: number;
  let high: number;
  if (vals.length < WORTH_MIN) {
    mid = cal.scale != null ? usd(cal.scale) : quantile(vals, 0.5);
    low = mid * 0.75;
    high = mid * 1.25;
  } else {
    low = quantile(vals, 0.2);
    mid = quantile(vals, 0.5);
    high = quantile(vals, 0.8);
  }
  const used = percent_used == null ? null : (percent_used / 100) * mid;
  return {
    estimate: true,
    worth_usd: { low: round(low), mid: round(mid), high: round(high) },
    used_usd: used == null ? null : round(used),
    left_usd: used == null ? null : round(Math.max(0, mid - used)),
    percent_used,
    samples: vals.length,
  };
}

// The percentage of a window consumed on each of the last `days` days, oldest first: the sum
// of the calibration's interval changes whose reading falls on that day, across resets.
function byDay(cal: Calibration, days: number, now: number): { day: string; percent: number }[] {
  const from = now - days * DAY_MS;
  const sums: Record<string, number> = {};
  for (const iv of cal.intervals) {
    const at = Date.parse(iv.to);
    if (at < from) continue;
    const d = new Date(at).toISOString().slice(0, 10);
    sums[d] = (sums[d] ?? 0) + iv.change;
  }
  const out: { day: string; percent: number }[] = [];
  for (let k = days - 1; k >= 0; k--) {
    const day = new Date(now - k * DAY_MS).toISOString().slice(0, 10);
    out.push({ day, percent: round(sums[day] ?? 0) });
  }
  return out;
}

// The trees with a share in a window: the topmost ancestor of each agent that has one, or the
// agent itself when it has no parents. Deduped.
function windowRoots(agents: [string, number][]): string[] {
  const roots = new Set<string>();
  for (const [id] of agents) {
    const stack = [id];
    const seen = new Set<string>();
    let parentless = true;
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const a = agentRef(cur);
      if (!a) continue;
      for (const p of parentIdsOf(a)) {
        parentless = false;
        roots.add(p);
        stack.push(p);
      }
    }
    if (parentless) roots.add(id);
  }
  return [...roots];
}

// The calibration over the summary's whole history (BY_DAY_DAYS and its warm-up): it feeds the
// daily buckets, the worth range and the hourly history. Callers that cache pass it along.
export function historyCalibration(account: string, window: string, now: number): Calibration {
  return calibrate(account, window, now - BY_DAY_DAYS * DAY_MS - WARMUP_MS, now);
}

const historyOf = (cal: Calibration, now: number) => hourly(cal, now - BY_DAY_DAYS * DAY_MS);
const patternOf = (h: ReturnType<typeof hourly>, cal: Calibration, s: WindowShares, window: string, now: number) =>
  ({ ...s.projection, pattern: patternProjection(h, s.projection, WINDOW_MS[window] ?? WINDOW_MS.five_hour, now), ...paces(cal, s.projection, now) });

// The summary's `shares` entry for one window: the top and the full agent, tree and model
// shares, the daily history, the worth estimate, the hourly history, and the projection.
export function windowSummary(account: string, window: string, s: WindowShares, now: number = Date.now(), cal: Calibration = historyCalibration(account, window, now)): Record<string, unknown> {
  return indexed(() => windowSummaryIndexed(account, window, s, now, cal));
}

function windowSummaryIndexed(account: string, window: string, s: WindowShares, now: number, cal: Calibration): Record<string, unknown> {
  const agents = Object.entries(s.agents).sort((x, y) => y[1] - x[1]);
  const models = Object.entries(s.models).sort((x, y) => y[1] - x[1]);
  const trees = windowRoots(agents)
    .map((id) => [id, timed('snapshot: tree shares', () => treeShare(id, account, window, undefined, s))] as const)
    .filter(([, p]) => p > 0)
    .sort((x, y) => y[1] - x[1]);
  const fullAgents = agents.map(([id, p]) => ({ agent: nameOf(id), id, percent: round(p) }));
  const fullTrees = trees.map(([id, p]) => ({ root: nameOf(id), id, percent: round(p) }));
  const h = historyOf(cal, now);
  const rates = (members: Set<string>) => ({ percent_per_hour: average(h, members), by_hour: hourRates(h, members) });
  const perAgent = agentRates(h, fullAgents.slice(0, TOP).map((a) => a.id));
  return {
    estimate: true,
    since: s.since,
    change: round(s.change),
    other: round(s.other),
    agents: fullAgents.slice(0, TOP),
    trees: fullTrees.slice(0, TOP),
    by_agent: fullAgents,
    by_tree: fullTrees,
    by_model: models.map(([model, p]) => ({ model: model || null, percent: round(p) })),
    by_day: byDay(cal, BY_DAY_DAYS, now),
    worth: worthOf(cal, now),
    history: {
      estimate: true,
      days: BY_DAY_DAYS,
      percent_per_hour: average(h),
      ...profile(h),
      trees: fullTrees.slice(0, TOP).map((t) => ({ root: t.root, id: t.id, ...rates(treeMembers(t.id)) })),
      agents: fullAgents.slice(0, TOP).map((a) => ({ agent: a.agent, id: a.id, ...perAgent.get(a.id) })),
    },
    projection: patternOf(h, cal, s, window, now),
  };
}

// The summary's `shares` for one account: one entry per window (see windowSummary).
export function accountShares(account: string, windows: string[], now: number = Date.now()): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const window of windows) out[window] = windowSummary(account, window, windowShares(account, window, undefined, now), now);
  return out;
}

export interface CachedWindow {
  account: string;
  window: string;
  shares: WindowShares;
  cal: Calibration;
}

// Every account window with readings, computed now: what treeSummary uses without a cache.
function allWindows(now: number): CachedWindow[] {
  const out: CachedWindow[] = [];
  for (const account of Object.keys(settings().cost.accounts ?? {})) {
    const name = readingName(account);
    if (!name) continue;
    for (const { window } of db.open().prepare('SELECT DISTINCT window FROM window_readings WHERE name = ?').all(name) as { window: string }[]) {
      out.push({ account, window, shares: windowShares(account, window, undefined, now), cal: historyCalibration(account, window, now) });
    }
  }
  return out;
}

// One tree's estimated share of every window of every account that has readings. `cached` is
// the Usage snapshot's windows, so usage_info tree= reuses its calibrations.
export function treeSummary(agentId: string, now: number = Date.now(), cached?: CachedWindow[]): Record<string, unknown> {
  return indexed(() => treeSummaryIndexed(agentId, now, cached));
}

function treeSummaryIndexed(agentId: string, now: number, cached?: CachedWindow[]): Record<string, unknown> {
  const out: Record<string, Record<string, unknown>> = {};
  const members = treeMembers(agentId);
  for (const { account, window, shares: s, cal } of cached ?? allWindows(now)) {
    const h = historyOf(cal, now);
    (out[account] ??= {})[window] = {
      estimate: true,
      since: s.since,
      percent: round(treeShare(agentId, account, window, undefined, s)),
      change: round(s.change),
      other: round(s.other),
      projection: patternOf(h, cal, s, window, now),
      history: { estimate: true, days: BY_DAY_DAYS, percent_per_hour: average(h, members), ...profile(h, members) },
    };
  }
  return { note: ESTIMATE_NOTE, agent: nameOf(agentId), id: agentId, members: [...treeMembers(agentId)].map(nameOf), accounts: out };
}

export interface TreeShares {
  [account: string]: { [window: string]: { estimate: true; percent: number } };
}

export interface TreeNode {
  id: string;
  name: string;
  // Subtree API-equivalent cost and tokens over the requested days. A DAG node below several
  // parents is counted once in each subtree (and so once in the root's tree total).
  cost_usd: number;
  tokens: number;
  // The subtree's cost in every display unit (src/cost-display.ts), when a display context is
  // given; absent for callers that only want the API-equivalent dollars.
  modes?: Modes;
  // The subtree's estimated share of each account window it has one in.
  shares: TreeShares;
  children: TreeNode[];
}

// Every agent at or below `root`, each once, following parent→child edges.
function subtree(root: string, children: Map<string, string[]>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (const c of children.get(id) ?? []) stack.push(c);
  }
  return out;
}

// Every tree (a root agent) as a nested structure of its total cost and tokens over `days` and
// its share of each window, for the Usage page's collapsible tree. `windows` are the account
// windows to include, as accountShares computes them. In a DAG a node with several parents
// shows under each parent while its agents are counted once in every subtree total.
// `only`, a set of agent ids, counts just those agents in every subtree and leaves out a node whose subtree has none.
export function treeTotals(days: number, now: number, windows: { account: string; window: string; shares: WindowShares }[], ctx?: Ctx, only?: Set<string>): TreeNode[] {
  return indexed(() => treeTotalsIndexed(days, now, windows, ctx, only));
}

function treeTotalsIndexed(days: number, now: number, windows: { account: string; window: string; shares: WindowShares }[], ctx?: Ctx, only?: Set<string>): TreeNode[] {
  const since = new Date(now - days * 86_400_000).toISOString().slice(0, 10);
  const rows = timed('snapshot: tree usage rows', () => db.open()
    .prepare('SELECT agent_id, account, SUM(cost_usd) AS cost_usd, SUM(tokens_in + tokens_out + tokens_cache_read + tokens_cache_write) AS tokens FROM usage WHERE day >= ? GROUP BY agent_id, account')
    .all(since) as { agent_id: string; account: string; cost_usd: number | null; tokens: number | null }[]);
  // Each agent's own cost, tokens and raw spend per account, so a subtree can be summed once
  // and converted to every unit when a display context is given.
  const totals = new Map<string, { cost: number; tokens: number; accounts: Map<string, number> }>();
  for (const r of rows) {
    const t = totals.get(r.agent_id) ?? { cost: 0, tokens: 0, accounts: new Map<string, number>() };
    t.cost += r.cost_usd ?? 0;
    t.tokens += r.tokens ?? 0;
    t.accounts.set(r.account, (t.accounts.get(r.account) ?? 0) + (r.cost_usd ?? 0));
    totals.set(r.agent_id, t);
  }

  const agents = db.listAgents();
  const byId = new Map(agents.map((a) => [a.id, a]));
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const a of agents) {
    for (const p of parentIdsOf(a)) {
      if (!byId.has(p)) continue;
      hasParent.add(a.id);
      const list = children.get(p) ?? [];
      list.push(a.id);
      children.set(p, list);
    }
  }

  const build = (id: string, path: Set<string>): TreeNode => {
    const all = subtree(id, children);
    const ids = only ? all.filter((m) => only.has(m)) : all;
    let cost = 0;
    let tokens = 0;
    const accounts = new Map<string, number>();
    for (const m of ids) {
      const t = totals.get(m);
      if (!t) continue;
      cost += t.cost;
      tokens += t.tokens;
      for (const [account, api] of t.accounts) accounts.set(account, (accounts.get(account) ?? 0) + api);
    }
    const shares: TreeShares = {};
    for (const { account, window, shares: s } of windows) {
      let p = 0;
      for (const m of ids) p += s.agents[m] ?? 0;
      if (p > 0) (shares[account] ??= {})[window] = { estimate: true, percent: round(p) };
    }
    const next = new Set(path);
    next.add(id);
    const kids = (children.get(id) ?? [])
      .filter((k) => !next.has(k) && (!only || subtree(k, children).some((m) => only.has(m))))
      .map((k) => build(k, next))
      .sort((a, b) => b.cost_usd - a.cost_usd || a.name.localeCompare(b.name));
    return { id, name: byId.get(id)?.name ?? id, cost_usd: round(cost), tokens, ...(ctx ? { modes: roundModes(convert(accounts, ctx)) } : {}), shares, children: kids };
  };

  return agents
    .filter((a) => !hasParent.has(a.id) && (!only || subtree(a.id, children).some((m) => only.has(m))))
    .map((a) => build(a.id, new Set()))
    .sort((a, b) => b.cost_usd - a.cost_usd || a.name.localeCompare(b.name));
}
