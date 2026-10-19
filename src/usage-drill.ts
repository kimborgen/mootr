// Usage drill-down data (S-657): the spend series the redesigned Usage page charts, and one
// scope endpoint for a drilled tree, ITSA, model, harness or agent. No UI here.
//
//   series   one row per day (per hour for days=1, from usage_samples), split into the top 5
//            groups plus "Other", over the period and the same-length period before it.
//   scope    one scope's totals, its share of each subscription window, spend over time by
//            agent, spend by model, an agents table, and for an ITSA its child ITSAs and a
//            typical-issue estimate.
//
// Real data only: an empty scope returns empty arrays, never an error. Costs are the
// harness-reported API-equivalent $ in the `usage` table (or `usage_samples` for hourly and
// per-ITSA rows); issue attribution comes from src/issue-costs.ts, built once per request.
// Both answers are scoped for an agent's token the way src/usage-scope.ts scopes /api/usage:
// hidden agents collapse into "Other" in a tree/agent series, an unreadable ITSA becomes
// "Other" in a series, and a scope's agent rows hold only the agents the token may see.
//
// A tree series groups an agent under one root, even in a DAG: the root is the
// lexicographically smallest top ancestor reachable through any parent edge, so each agent
// lands in exactly one tree and the choice is stable. Scoping is by the agent, not the root,
// so a hidden agent is "Other" whichever root it would pick, and a visible agent (whose
// ancestors are visible) never leaks a hidden root.
import * as db from './db.ts';
import * as tree from './tree.ts';
import * as itsa from './itsa.ts';
import * as issueCosts from './issue-costs.ts';
import { displayContext } from './usage.ts';
import { treeMembers, windowStart } from './attribution.ts';
import { accountKind, convert, costDisplay, kindResolver, roundModes, zeroModes, type Ctx as DisplayCtx, type Modes } from './cost-display.ts';
import { settings } from './settings.ts';

export type SeriesGroup = 'tree' | 'model' | 'harness' | 'agent' | 'itsa';
export const SERIES_GROUPS: SeriesGroup[] = ['tree', 'model', 'harness', 'agent', 'itsa'];
export type Bucket = 'day' | 'hour';

// The most days a series or scope asks for: All time is 365, and every bucket is a zero-filled row.
export const MAX_DAYS = 400;

// The separator in a model group's id, `harness · model`; the scope's `model=` accepts the same.
export const MODEL_SEP = ' · ';

export const SERIES_NOTE =
  "One row per bucket, split into the top 5 groups by period cost plus Other when there are more. previous_rows is the same-length period before it, one row per bucket over the same groups (a group outside them folds into Other). Every bucket of both periods has a row, zero when nothing was spent. Each group has a stable id (a tree root's agent id, an agent id, a harness, `harness · model`, or an ITSA key) and a display name; the model group also carries its harness. group=itsa reads usage_samples (kept 35 days) and puts spend on no ITSA under Unattributed; the other groups read the usage table and cover any period.";

const DAY_MS = 86_400_000;
const TOKEN_KEYS = ['tokens_in', 'tokens_out', 'tokens_cache_read', 'tokens_cache_write'] as const;

export interface Tot {
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  // The cost in every display unit (src/cost-display.ts, S-316). A unit that can't be computed
  // is null, so the UI shows a dash rather than an invented number.
  modes: Modes;
}
const zero = (): Tot => ({ cost_usd: 0, tokens_in: 0, tokens_out: 0, tokens_cache_read: 0, tokens_cache_write: 0, modes: zeroModes() });
function addModes(t: Modes, s: Modes, share: number): void {
  t.api += s.api * share;
  t.paid_usd += s.paid_usd * share;
  for (const k of ['five_hour', 'seven_day', 'subscription'] as const) t[k] = t[k] == null || s[k] == null ? null : t[k]! + s[k]! * share;
}
function add(t: Tot, s: Tot, share = 1): void {
  t.cost_usd += s.cost_usd * share;
  for (const k of TOKEN_KEYS) t[k] += s[k] * share;
  addModes(t.modes, s.modes, share);
}
function scaled(t: Tot, share: number): Tot {
  const o = zero();
  add(o, t, share);
  return o;
}
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
function roundTot(t: Tot): Tot {
  const o = zero();
  o.cost_usd = r6(t.cost_usd);
  for (const k of TOKEN_KEYS) o[k] = Math.round(t[k]);
  o.modes = roundModes(t.modes);
  return o;
}
// A row's Tot, with its cost converted to every unit from its own account's raw spend.
const totOf = (r: { account: string; cost_usd: number; tokens_in: number; tokens_out: number; tokens_cache_read: number; tokens_cache_write: number }, ctx: DisplayCtx): Tot => ({
  cost_usd: Number(r.cost_usd) || 0,
  tokens_in: Number(r.tokens_in) || 0,
  tokens_out: Number(r.tokens_out) || 0,
  tokens_cache_read: Number(r.tokens_cache_read) || 0,
  tokens_cache_write: Number(r.tokens_cache_write) || 0,
  modes: roundModes(convert(new Map([[r.account, Number(r.cost_usd) || 0]]), ctx)),
});

// The display context for the units the series and scope answers carry, as /api/usage builds it:
// kind and price from the settings, worth from the cached window shares.
function drillCtx(now: number): DisplayCtx {
  const { prices } = costDisplay();
  const dc = displayContext(now);
  return { kind: kindResolver(), worth: dc.worth, price: (a) => prices[a] ?? null };
}

const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const dayStartIso = (day: string): string => `${day}T00:00:00.000Z`;
const hourKey = (ms: number): string => new Date(Math.floor(ms / 3_600_000) * 3_600_000).toISOString();
// The bucket of an already-ISO sample time, sliced rather than reformatted (87k rows).
const bucketKey = (iso: string, bucket: Bucket): string => (bucket === 'hour' ? `${iso.slice(0, 13)}:00:00.000Z` : iso.slice(0, 10));

// One request's shared lookups, so a 300-agent answer doesn't call db.getAgent per row: the
// agents by id, their parent edges, memoized tree roots, the ITSA metadata, and the issue
// attribution built once (a series shares it over its two windows, a scope uses it once).
interface ItsaMeta {
  key: string;
  title: string;
  status: string;
  owner: string | null;
  parent: string | null;
}

interface Ctx {
  agents: Map<string, db.Agent>;
  parents: Map<string, string[]>;
  roots: Map<string, string>;
  // Peer agents' names looked up so far (a forgotten agent's id is kept as its own name), one query per id.
  peerNames: Map<string, string>;
  itsaMeta: Map<string, ItsaMeta>;
  itsaChildren: Map<string, string[]>;
  // Agents with a child, as issue-costs counts managers (any parent link).
  managers: Set<string>;
  attribute: ReturnType<typeof issueCosts.attributor> | null;
}

function requestCtx(): Ctx {
  const agents = new Map(db.listAgents().map((a) => [a.id, a]));
  const parents = new Map<string, string[]>();
  const managers = new Set<string>();
  const link = (child: string, parent: string) => {
    const list = parents.get(child) ?? parents.set(child, []).get(child)!;
    list.push(parent);
  };
  // Every parent link, adopting and peer ones too, so a tree crossing machines groups under one root;
  // a parent is a manager, as issue-costs counts them.
  for (const [child, parent] of tree.edges([...agents.values()])) {
    link(child, parent);
    managers.add(parent);
  }
  const itsaMeta = new Map(
    (db.open().prepare('SELECT id, key, title, status, owner, parent_id FROM itsas').all() as { id: string; key: string; title: string; status: string; owner: string | null; parent_id: string | null }[]).map((r) => [
      r.id,
      { key: r.key, title: r.title, status: r.status, owner: r.owner, parent: r.parent_id },
    ]),
  );
  const itsaChildren = new Map<string, string[]>();
  for (const [id, m] of itsaMeta) if (m.parent) (itsaChildren.get(m.parent) ?? itsaChildren.set(m.parent, []).get(m.parent)!).push(id);
  return { agents, parents, roots: new Map(), peerNames: new Map(), itsaMeta, itsaChildren, managers, attribute: null };
}

// A peer root (a manager on the other machine) isn't in `agents`; its remembered name stands in.
const nameOf = (ctx: Ctx, id: string): string => {
  const hit = ctx.agents.get(id)?.name ?? ctx.peerNames.get(id);
  if (hit !== undefined) return hit;
  const name = db.peerAgentById(id)?.name ?? id;
  ctx.peerNames.set(id, name);
  return name;
};

const attributeOf = (ctx: Ctx): ReturnType<typeof issueCosts.attributor> => (ctx.attribute ??= issueCosts.attributor());

// The one root an agent groups under: the lexicographically smallest top ancestor reachable
// through any parent edge (a DAG can have more than one root). Memoized; a cycle is left alone.
function rootOf(ctx: Ctx, id: string): string {
  const memo = ctx.roots;
  const hit = memo.get(id);
  if (hit) return hit;
  const seen = new Set<string>();
  const tops = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const ps = ctx.parents.get(cur) ?? [];
    if (ps.length) stack.push(...ps);
    else tops.add(cur);
  }
  const root = [...tops].sort()[0] ?? id;
  // Memoize only the agent asked about: an ancestor visited on the walk can reach a different
  // root (a DAG node under two roots), so caching it here would poison later lookups.
  memo.set(id, root);
  return root;
}

// One leaf: a bucket (t), a group (id/name, plus a harness for the model group), and the cost
// and tokens landing there.
interface Leaf {
  id: string;
  name: string;
  t: string;
  tot: Tot;
  harness?: string;
}

// A raw usage row, per day (from the `usage` table) or per 5-minute sample, before grouping.
interface RawRow {
  agent_id: string;
  harness: string;
  model: string;
  t: string;
  tot: Tot;
}

function dailyRows(since: string, untilExclusive: string, ctx: DisplayCtx): { agent_id: string; harness: string; model: string | null; day: string; tot: Tot }[] {
  const rows = db.open()
    .prepare(
      `SELECT agent_id, account, harness, model, day, SUM(cost_usd) AS cost_usd, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
         SUM(tokens_cache_read) AS tokens_cache_read, SUM(tokens_cache_write) AS tokens_cache_write
       FROM usage WHERE day >= ? AND day < ? GROUP BY agent_id, account, harness, model, day ORDER BY day`,
    )
    .all(since, untilExclusive) as { agent_id: string; account: string; harness: string; model: string | null; day: string; cost_usd: number; tokens_in: number; tokens_out: number; tokens_cache_read: number; tokens_cache_write: number }[];
  return rows.map((r) => ({ agent_id: r.agent_id, harness: r.harness, model: r.model, day: r.day, tot: totOf(r, ctx) }));
}

interface SampleRow {
  agent_id: string;
  account: string;
  harness: string;
  model: string;
  bucket: string;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
}
function sampleRows(fromIso: string, toIso: string): SampleRow[] {
  return db.open()
    .prepare(
      `SELECT agent_id, account, harness, model, bucket, cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write
       FROM usage_samples WHERE bucket >= ? AND bucket < ? ORDER BY bucket`,
    )
    .all(fromIso, toIso) as unknown as SampleRow[];
}

// The leaves a window and a bucket produce, before top-N splitting. The window is [from, to)
// in ms; a day bucket runs over whole calendar days, `dayUntil` exclusive, so a series and the
// daily table agree. Hidden agents become "other" for tree/agent groups; an unreadable ITSA
// becomes "other" for an ITSA series.
function leavesFor(ctx: Ctx, dc: DisplayCtx, group: SeriesGroup, from: number, to: number, bucket: Bucket, visible: Set<string> | undefined, mayItsa: ((key: string) => boolean) | undefined, dayUntil: string): Leaf[] {
  if (group === 'itsa') {
    const [fIso, tIso] = bucket === 'hour' ? [new Date(from).toISOString(), new Date(to).toISOString()] : [dayStartIso(dayKey(from)), dayStartIso(dayUntil)];
    return itsaLeaves(ctx, dc, fIso, tIso, bucket, mayItsa);
  }
  const hidden = (agentId: string) => (group === 'tree' || group === 'agent') && visible != null && !visible.has(agentId);
  const out: Leaf[] = [];
  const push = (row: RawRow) => {
    if (hidden(row.agent_id)) {
      out.push({ id: 'other', name: 'Other', t: row.t, tot: row.tot });
      return;
    }
    const k = keyFor(ctx, group, row);
    out.push({ id: k.id, name: k.name, t: row.t, tot: row.tot, ...(k.harness ? { harness: k.harness } : {}) });
  };
  if (bucket === 'hour') {
    for (const s of sampleRows(new Date(from).toISOString(), new Date(to).toISOString())) {
      push({ agent_id: s.agent_id, harness: s.harness, model: s.model || 'unknown', t: hourKey(Date.parse(s.bucket)), tot: totOf(s, dc) });
    }
    return out;
  }
  for (const r of dailyRows(dayKey(from), dayUntil, dc)) {
    push({ agent_id: r.agent_id, harness: r.harness, model: r.model || 'unknown', t: r.day, tot: r.tot });
  }
  return out;
}

// A leaf's group id, display name and optional harness for a non-ITSA series. The model group
// is split by harness: its id is `harness · model` and its harness rides along, so the UI can
// colour by harness while the display name stays the model.
function keyFor(ctx: Ctx, group: SeriesGroup, row: RawRow): { id: string; name: string; harness?: string } {
  switch (group) {
    case 'tree': {
      const root = rootOf(ctx, row.agent_id);
      return { id: root, name: nameOf(ctx, root) };
    }
    case 'agent':
      return { id: row.agent_id, name: nameOf(ctx, row.agent_id) };
    case 'harness':
      return { id: row.harness || 'unknown', name: row.harness || 'unknown' };
    case 'model':
      return { id: `${row.harness || 'unknown'}${MODEL_SEP}${row.model || 'unknown'}`, name: row.model || 'unknown', harness: row.harness || 'unknown' };
    default:
      return { id: 'other', name: 'Other' };
  }
}

// The leaves of an ITSA series: each sample is split among the ITSAs its agent was on at that
// time (issue-costs attribution). A sample on no ITSA, or on one this daemon no longer holds,
// goes to "Unattributed", so the ITSA branches sum to the same spend as the other groups.
function itsaLeaves(ctx: Ctx, dc: DisplayCtx, fromIso: string, toIso: string, bucket: Bucket, mayItsa: ((key: string) => boolean) | undefined): Leaf[] {
  const attribute = attributeOf(ctx);
  const out: Leaf[] = [];
  for (const s of sampleRows(fromIso, toIso)) {
    const t = bucketKey(s.bucket, bucket);
    const base = totOf(s, dc);
    const entries = attribute(s.agent_id, Date.parse(s.bucket));
    let placed = false;
    for (const e of entries) {
      const m = ctx.itsaMeta.get(e.itsaId);
      if (!m) continue;
      placed = true;
      const id = mayItsa && !mayItsa(m.key) ? 'other' : m.key;
      out.push({ id, name: id === 'other' ? 'Other' : m.key, t, tot: scaled(base, e.share) });
    }
    if (!placed) out.push({ id: 'unattributed', name: 'Unattributed', t, tot: base });
  }
  return out;
}

interface Group {
  id: string;
  name: string;
  // The harness, for the model series, so the UI can colour a group by it.
  harness?: string;
}

interface Aggregate {
  groups: Group[];
  rows: Record<string, unknown>[];
  total: Tot;
}

// One row per bucket over the given groups; ids outside `chosen` fold into Other. Every legend
// group appears in every row (zero when absent), and a bucket with no spend is a zero row.
function bucketRows(perBucket: Map<string, Map<string, Tot>>, keys: string[], groups: Group[], chosen: Set<string>): Record<string, unknown>[] {
  return [...new Set(keys)].sort().map((t) => {
    const b = perBucket.get(t) ?? new Map<string, Tot>();
    const byGroup: Record<string, Tot> = {};
    for (const g of groups) byGroup[g.id] = zero();
    for (const [id, tot] of b) add(byGroup[chosen.has(id) ? id : OTHER_ID], tot);
    const rowTotal = zero();
    for (const g of groups) {
      byGroup[g.id] = roundTot(byGroup[g.id]);
      add(rowTotal, byGroup[g.id]);
    }
    return { t, ...roundTot(rowTotal), groups: byGroup };
  });
}

const OTHER_ID = 'other';

// The previous period's rows, bucketed by the current period's legend: a group outside it folds
// into Other. When the current legend has no Other and something folded, it gains one (zero in
// the current rows), so the previous period never loses spend.
function previousRows(leaves: Leaf[], keys: string[], agg: Aggregate): Record<string, unknown>[] {
  const chosen = new Set(agg.groups.filter((g) => g.id !== OTHER_ID).map((g) => g.id));
  const perBucket = new Map<string, Map<string, Tot>>();
  let folded = false;
  for (const l of leaves) {
    const b = perBucket.get(l.t) ?? perBucket.set(l.t, new Map()).get(l.t)!;
    add(b.get(l.id) ?? b.set(l.id, zero()).get(l.id)!, l.tot);
    if (!chosen.has(l.id) && l.tot.cost_usd > 0) folded = true;
  }
  if (folded && !agg.groups.some((g) => g.id === OTHER_ID)) {
    agg.groups.push({ id: OTHER_ID, name: 'Other' });
    for (const r of agg.rows) (r.groups as Record<string, Tot>)[OTHER_ID] = roundTot(zero());
  }
  return bucketRows(perBucket, keys, agg.groups, chosen);
}

// Splits leaves into the top 5 groups by period cost plus Other, one row per bucket. Every
// legend group appears in every row (zero when absent), so the UI can stack them directly.
function aggregate(leaves: Leaf[], keys: string[] = []): Aggregate {
  const meta = new Map<string, Group>();
  const perGroup = new Map<string, Tot>();
  const perBucket = new Map<string, Map<string, Tot>>();
  const buckets = new Set<string>(keys);
  for (const l of leaves) {
    if (!meta.has(l.id)) meta.set(l.id, { id: l.id, name: l.name, ...(l.harness ? { harness: l.harness } : {}) });
    const g = perGroup.get(l.id) ?? zero();
    add(g, l.tot);
    perGroup.set(l.id, g);
    let b = perBucket.get(l.t);
    if (!b) {
      b = new Map();
      perBucket.set(l.t, b);
    }
    add(b.get(l.id) ?? (b.set(l.id, zero()).get(l.id)!), l.tot);
    buckets.add(l.t);
  }
  const top = [...perGroup.keys()]
    .filter((id) => id !== 'other')
    .sort((a, b) => (perGroup.get(b)!.cost_usd - perGroup.get(a)!.cost_usd) || a.localeCompare(b))
    .slice(0, 5);
  const chosen = new Set(top);
  const hasOther = [...perGroup.keys()].some((id) => !chosen.has(id));
  const groups: Group[] = [
    ...top.map((id) => meta.get(id) ?? { id, name: id }),
    ...(hasOther ? [{ id: 'other', name: 'Other' }] : []),
  ];
  const rows = bucketRows(perBucket, [...buckets], groups, chosen);
  const total = zero();
  for (const t of perGroup.values()) add(total, t);
  return { groups, rows, total };
}

const sumLeaves = (leaves: Leaf[]): Tot => {
  const t = zero();
  for (const l of leaves) add(t, l.tot);
  return t;
};

export interface SeriesOpts {
  days: number;
  group: SeriesGroup;
  now?: number;
  // The agents an agent's token may see; undefined for the human, the CLI and the bosses.
  visible?: Set<string>;
  mayItsa?: (key: string) => boolean;
}

// GET /api/usage/series: one row per day (per hour for days=1), top 5 groups plus Other, and
// the same-length period's totals for the trend tile.
export function spendSeries(opts: SeriesOpts): Record<string, unknown> {
  const now = opts.now ?? Date.now();
  const days = opts.days;
  const ctx = requestCtx();
  const dc = drillCtx(now);
  const bucket: Bucket = days <= 1 ? 'hour' : 'day';
  const from = now - days * DAY_MS;
  // A day bucket covers the calendar days `from` through today: days+1 of them, as /api/usage
  // does. The previous period is the same number of days, ending the day before `from`.
  const spanDays = bucket === 'day' ? days + 1 : days;
  const cur = leavesFor(ctx, dc, opts.group, from, now, bucket, opts.visible, opts.mayItsa, dayKey(now + DAY_MS));
  const prev = leavesFor(ctx, dc, opts.group, from - spanDays * DAY_MS, from, bucket, opts.visible, opts.mayItsa, dayKey(from));
  // Every bucket of the period gets a row (a zero row when nothing was spent), and the previous
  // period's rows are keyed the same way, so the UI draws no gaps and matches days by date.
  const step = bucket === 'hour' ? 3_600_000 : DAY_MS;
  const key = bucket === 'hour' ? hourKey : dayKey;
  const count = bucket === 'hour' ? 25 : days + 1;
  const prevCount = bucket === 'hour' ? 24 : spanDays;
  const curKeys = [...Array(count).keys()].map((i) => key(from + i * step));
  const prevStart = from - prevCount * step;
  const prevKeys = [...Array(prevCount).keys()].map((i) => key(prevStart + i * step));
  const agg = aggregate(cur, curKeys);
  const prevRows = previousRows(prev, prevKeys, agg);
  return {
    note: SERIES_NOTE,
    days,
    group: opts.group,
    bucket,
    groups: agg.groups,
    rows: agg.rows,
    previous_rows: prevRows,
    total: roundTot(agg.total),
    previous: roundTot(sumLeaves(prev)),
  };
}

// --- The drill scope (S-657) --------------------------------------------------------

export type ScopeKind = 'tree' | 'itsa' | 'model' | 'harness' | 'agent';

export const SCOPE_NOTE =
  'totals are the scope\'s cost and tokens over the period; an ITSA carries own, children and total, where total is own plus every descendant ITSA. windows is the scope\'s estimated share of each subscription window. by_agent is the agents table (in, out, cache read, cache write, cost), by_model the same by harness and model, and timeseries the spend over time by agent.';

export interface ScopeOpts {
  days: number;
  kind: ScopeKind;
  ref: string;
  // With kind=model: the harness, when the model id is the bare model (the `harness=H&model=M`
  // form); a `harness · model` ref is split instead.
  harness?: string;
  // An ITSA scope's own span: from this instant (ms), in this bucket. Unset, the span is `days` and
  // hourly for one day, else daily. Both are ignored for other scopes.
  since?: number;
  bucket?: Bucket;
  now?: number;
  visible?: Set<string>;
  mayItsa?: (key: string) => boolean;
}

// Every bucket key from `from` to `now`, so a quiet bucket is a zero row, as /api/usage/series does.
function bucketKeys(from: number, now: number, bucket: Bucket): string[] {
  const step = bucket === 'hour' ? 3_600_000 : DAY_MS;
  const key = bucket === 'hour' ? hourKey : dayKey;
  const out: string[] = [];
  for (let t = from; ; t += step) {
    out.push(key(t));
    if (key(t + step) > key(now)) break;
  }
  return out;
}

// A model scope's harness and model: `harness=M` with `model=`, or a `harness · model` id as the
// series emits it, or a bare model name across harnesses.
function modelSelector(opts: { ref: string; harness?: string }): { harness?: string; model: string } {
  if (opts.harness) return { harness: opts.harness, model: opts.ref };
  const i = opts.ref.indexOf(MODEL_SEP);
  if (i >= 0) return { harness: opts.ref.slice(0, i), model: opts.ref.slice(i + MODEL_SEP.length) };
  return { model: opts.ref };
}

export function drillScope(opts: ScopeOpts): Record<string, unknown> {
  const now = opts.now ?? Date.now();
  const own = opts.kind === 'itsa';
  // An ITSA's own span starts no earlier than the samples kept (older ones are pruned), which also bounds the zero fill.
  const from = own && opts.since != null ? Math.min(Math.max(opts.since, now - db.SAMPLE_RETENTION_MS), now) : now - opts.days * DAY_MS;
  const bucket: Bucket = own && opts.bucket ? opts.bucket : opts.days <= 1 ? 'hour' : 'day';
  const ctx = requestCtx();
  const dc = drillCtx(now);
  return opts.kind === 'itsa' ? itsaScope(ctx, dc, opts, from, now, bucket) : plainScope(ctx, dc, opts, from, now, bucket);
}

// The filtered raw rows of a non-ITSA scope: tree members, one agent, or every row of a
// model/harness. `visible`, when given, keeps only the agents the caller may see.
function scopeRows(opts: ScopeOpts, dc: DisplayCtx, from: number, now: number, bucket: Bucket): RawRow[] {
  const visible = opts.visible;
  let memberSet: Set<string> | undefined;
  if (opts.kind === 'tree') memberSet = treeMembers(opts.ref);
  else if (opts.kind === 'agent') memberSet = new Set([opts.ref]);
  const model = opts.kind === 'model' ? modelSelector(opts) : undefined;
  const keep = (agent_id: string, harness: string, m: string): boolean => {
    if (visible && !visible.has(agent_id)) return false;
    if (memberSet && !memberSet.has(agent_id)) return false;
    if (model) {
      if (model.harness && harness !== model.harness) return false;
      if (m !== model.model) return false;
    }
    if (opts.kind === 'harness' && harness !== opts.ref) return false;
    return true;
  };
  const out: RawRow[] = [];
  if (bucket === 'hour') {
    for (const s of sampleRows(new Date(from).toISOString(), new Date(now).toISOString())) {
      const m = s.model || 'unknown';
      if (!keep(s.agent_id, s.harness, m)) continue;
      out.push({ agent_id: s.agent_id, harness: s.harness, model: m, t: hourKey(Date.parse(s.bucket)), tot: totOf(s, dc) });
    }
    return out;
  }
  for (const r of dailyRows(dayKey(from), dayKey(now + DAY_MS), dc)) {
    const m = r.model || 'unknown';
    if (!keep(r.agent_id, r.harness, m)) continue;
    out.push({ agent_id: r.agent_id, harness: r.harness, model: m, t: r.day, tot: r.tot });
  }
  return out;
}

// The scope's id and display name, as the series would name the same group.
function scopeDescriptor(ctx: Ctx, opts: ScopeOpts): Record<string, unknown> {
  if (opts.kind === 'model') {
    const s = modelSelector(opts);
    return { kind: 'model', id: s.harness ? `${s.harness}${MODEL_SEP}${s.model}` : s.model, name: s.model, ...(s.harness ? { harness: s.harness } : {}) };
  }
  if (opts.kind === 'tree' || opts.kind === 'agent') return { kind: opts.kind, id: opts.ref, name: nameOf(ctx, opts.ref) };
  return { kind: opts.kind, id: opts.ref, name: opts.ref };
}

function plainScope(ctx: Ctx, dc: DisplayCtx, opts: ScopeOpts, from: number, now: number, bucket: Bucket): Record<string, unknown> {
  const rows = scopeRows(opts, dc, from, now, bucket);
  const total = zero();
  for (const r of rows) add(total, r.tot);
  // A tree's window share is its every member's, not only those with rows this period.
  const memberIds = opts.kind === 'tree' ? treeMembers(opts.ref) : opts.kind === 'agent' ? new Set([opts.ref]) : new Set(rows.map((r) => r.agent_id));
  return {
    note: SCOPE_NOTE,
    days: opts.days,
    bucket,
    scope: scopeDescriptor(ctx, opts),
    totals: roundTot(total),
    windows: windowSharesFor(memberIds, now),
    timeseries: { group: 'agent', ...timeseries(ctx, rows, bucketKeys(from, now, bucket)) },
    by_agent: aggregateBy(ctx, rows, (r) => r.agent_id),
    by_model: aggregateBy(ctx, rows, (r) => `${r.harness}\u0000${r.model}`, (r) => ({ harness: r.harness, model: r.model })),
  };
}

// Groups rows by `key`, keeping name/harness/model metadata, into the agents table / by-model
// rows: each with the four token columns and cost.
function aggregateBy(ctx: Ctx, rows: RawRow[], key: (r: RawRow) => string, meta?: (r: RawRow) => Record<string, unknown>): Record<string, unknown>[] {
  const tot = new Map<string, Tot>();
  const info = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const k = key(r);
    add(tot.get(k) ?? (tot.set(k, zero()).get(k)!), r.tot);
    if (!info.has(k)) info.set(k, meta ? meta(r) : {});
  }
  return [...tot]
    .map(([k, t]) => {
      if (meta) return { ...info.get(k), ...roundTot(t) };
      const a = ctx.agents.get(k);
      return { id: k, name: a?.name ?? k, role: a?.role ?? null, harness: a?.harness ?? null, model: a?.model ?? null, ...roundTot(t) };
    })
    .sort((a, b) => (Number(b.cost_usd) || 0) - (Number(a.cost_usd) || 0));
}

// The spend over time by agent: one row per bucket, top 5 agents plus Other.
function timeseries(ctx: Ctx, rows: RawRow[], keys: string[]): { groups: Group[]; rows: Record<string, unknown>[] } {
  const leaves: Leaf[] = rows.map((r) => ({ id: r.agent_id, name: nameOf(ctx, r.agent_id), t: r.t, tot: r.tot }));
  const agg = aggregate(leaves, keys);
  return { groups: agg.groups, rows: agg.rows };
}

// The scope's estimated share of every configured account's windows. A member with no share in
// a window makes the percent null (unknown), as cost-display does; a window with no worth and
// no share is left out.
function windowSharesFor(members: Set<string>, now: number): Record<string, unknown>[] {
  const ctx = displayContext(now);
  const out: Record<string, unknown>[] = [];
  for (const account of Object.keys(settings().cost.accounts ?? {})) {
    for (const window of ['five_hour', 'seven_day'] as const) {
      const worth = ctx.worth(account, window);
      let percent: number | null = 0;
      for (const id of members) {
        const s = ctx.share(id, account, window);
        if (s == null) {
          percent = null;
          break;
        }
        percent += s;
      }
      if (worth == null && !(percent != null && percent > 0)) continue;
      out.push({ account, window, percent: percent == null ? null : Math.round(percent * 100) / 100, worth_usd: worth });
    }
  }
  return out;
}

// Every ITSA at or below `root`, each once, from this request's parent links.
function itsaSubtree(ctx: Ctx, root: string): Set<string> {
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(ctx.itsaChildren.get(id) ?? []));
  }
  return seen;
}

// The top config by cost, ties by name (issue-costs' rule).
function topKey(m: Map<string, number>): string | null {
  let best: string | null = null;
  let bestV = -Infinity;
  for (const [k, v] of [...m].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (v > bestV) {
      best = k;
      bestV = v;
    }
  }
  return best;
}

function itsaScope(ctx: Ctx, dc: DisplayCtx, opts: ScopeOpts, from: number, now: number, bucket: Bucket): Record<string, unknown> {
  const found = itsa.must(opts.ref);
  const meta = ctx.itsaMeta.get(found.id);
  if (!meta) throw new Error(`no ITSA ${opts.ref}`);
  const attribute = attributeOf(ctx);
  const subtree = itsaSubtree(ctx, found.id);
  const visible = opts.visible;
  const [fromIso, toIso] = bucket === 'hour' ? [new Date(from).toISOString(), new Date(now).toISOString()] : [dayStartIso(dayKey(from)), dayStartIso(dayKey(now + DAY_MS))];

  // One calendar-aligned pass over the samples gives the totals, the ITSA branches, the config
  // and the in-window subscription spend, all in the same units as by_agent (S-657 review).
  const perItsa = new Map<string, Tot>();
  const ownConfigs = new Map<string, number>();
  const ownWorkerConfigs = new Map<string, number>();
  const inWindow: Record<'five_hour' | 'seven_day', Map<string, number>> = { five_hour: new Map(), seven_day: new Map() };
  const starts = new Map<string, number>();
  const rows: RawRow[] = [];
  for (const s of sampleRows(fromIso, toIso)) {
    const kept = attribute(s.agent_id, Date.parse(s.bucket)).filter((e) => subtree.has(e.itsaId));
    if (!kept.length) continue;
    const base = totOf(s, dc);
    for (const e of kept) add(perItsa.get(e.itsaId) ?? (perItsa.set(e.itsaId, zero()).get(e.itsaId)!), scaled(base, e.share));
    const own = kept.filter((e) => e.itsaId === found.id);
    if (own.length) {
      const share = own.reduce((a, e) => a + e.share, 0);
      const config = `${s.harness}${MODEL_SEP}${s.model || 'unknown'}`;
      const m = ctx.managers.has(s.agent_id) ? ownConfigs : ownWorkerConfigs;
      m.set(config, (m.get(config) ?? 0) + base.cost_usd * share);
    }
    if (accountKind(s.account) === 'subscription') {
      const t = Date.parse(s.bucket);
      const share = kept.reduce((a, e) => a + e.share, 0);
      for (const w of ['five_hour', 'seven_day'] as const) {
        const k = `${s.account}|${w}`;
        if (!starts.has(k)) starts.set(k, windowStart(s.account, w, now));
        if (t >= starts.get(k)!) inWindow[w].set(s.account, (inWindow[w].get(s.account) ?? 0) + base.cost_usd * share);
      }
    }
    if (!(visible && !visible.has(s.agent_id))) {
      const share = kept.reduce((a, e) => a + e.share, 0);
      rows.push({ agent_id: s.agent_id, harness: s.harness, model: s.model || 'unknown', t: bucketKey(s.bucket, bucket), tot: scaled(base, share) });
    }
  }

  const own = roundTot(perItsa.get(found.id) ?? zero());
  const childTotal = zero();
  for (const [id, t] of perItsa) if (id !== found.id) add(childTotal, t);
  const children = roundTot(childTotal);
  const total = roundTot(addTot(own, children));
  const config = topKey(ownWorkerConfigs) ?? topKey(ownConfigs);

  const childItsas = [...ctx.itsaMeta]
    .filter(([, m]) => m.parent === found.id && (!opts.mayItsa || opts.mayItsa(m.key)))
    .map(([id, m]) => {
      const t = roundTot(sumItsa(perItsa, itsaSubtree(ctx, id)));
      return { key: m.key, title: m.title, status: m.status, owner: m.owner ? nameOf(ctx, m.owner) : null, cost_usd: t.cost_usd, modes: t.modes };
    })
    .sort((a, b) => b.cost_usd - a.cost_usd || a.key.localeCompare(b.key));

  return {
    note: SCOPE_NOTE,
    days: opts.days,
    bucket,
    scope: { kind: 'itsa', id: found.id, key: found.key, name: `${found.key} ${found.title}` },
    totals: { own, children, total },
    windows: itsaWindowEntries(inWindow, now),
    timeseries: { group: 'agent', ...timeseries(ctx, rows, bucketKeys(from, now, bucket)) },
    by_agent: aggregateBy(ctx, rows, (r) => r.agent_id),
    by_model: aggregateBy(ctx, rows, (r) => `${r.harness}\u0000${r.model}`, (r) => ({ harness: r.harness, model: r.model })),
    itsas: childItsas,
    typical: config ? issueCosts.typicalIssue(config, { days: opts.days, now }) : null,
  };
}

const addTot = (a: Tot, b: Tot): Tot => {
  const o = { ...a };
  add(o, b);
  return o;
};

function sumItsa(perItsa: Map<string, Tot>, ids: Set<string>): Tot {
  const t = zero();
  for (const id of ids) add(t, perItsa.get(id) ?? zero());
  return t;
}

// The ITSA's share of each subscription window it spent in (own plus descendants), in percent.
function itsaWindowEntries(inWindow: Record<'five_hour' | 'seven_day', Map<string, number>>, now: number): Record<string, unknown>[] {
  const dctx = displayContext(now);
  const out: Record<string, unknown>[] = [];
  for (const window of ['five_hour', 'seven_day'] as const) {
    for (const [account, cost] of inWindow[window]) {
      const worth = dctx.worth(account, window);
      out.push({ account, window, percent: worth == null || worth <= 0 ? null : Math.round(((100 * cost) / worth) * 100) / 100, worth_usd: worth });
    }
  }
  return out;
}
