// The activity summary (S-1009): GET /api/activity?by=summary, one answer the Activity tab and the
// activity_info tool read, scoped to everything, a tree, an ITSA, or one agent. Time is in seconds
// (agent-hours). Costs are the usage table's (what Overview and by=agent's cost_usd show) with their
// Measure modes; an ITSA scope takes each agent's day of usage in proportion to the share of that day's
// item est cost (or clock) attributed to the ITSA. Only the per-category split is an estimate: the items'
// est cost per category, scaled to the usage total (`estimated: true`).
//
//   clock       the scope's agent-hours, split into working, friction, others, you, and idle
//               (src/activity-categories.ts, clockGroup); the groups sum to the total
//   tiles       working, waiting on you (reply, prompt, permission), friction and its parts, cost and
//               cost per working hour, and working seconds per day
//   working_by_category  working time (friction left out) per top category and leaf, with its cost
//   bottlenecks every friction, you and idle leaf and the slow-work leaves (SLOW_WORK_KINDS): seconds,
//               agents hit, the top three agents, and the longest single span
//   configs     closed work issues by model, by type and by both, as S-1007's by=model and by=type
//   trees       root agents with their subtrees' totals, and each root's direct children
//
// Speed: the daemon never makes a whole-window pass inside a request (S-1009, md1fe47f). Each agent's
// items are folded once into a digest of hour buckets (all its time, and its time attributed to each
// ITSA), kept in memory. A digest is rebuilt only when that agent's items change (activity-changes.ts)
// or when the ITSA timelines it is attributed by change. A request merges the digests of the agents in
// its scope. Every rebuild and every merge runs in slices that yield to the event loop after SLICE_MS;
// the longest slice is kept in summaryMetrics(). Answers are cached per (days, scope, viewer) until any
// digest changes, or for CACHE_MS while the window moves (and new usage rows arrive).
//
// The window starts on the hour: since = the start of the hour `days` days ago.
//
// Machines (S-1079): every daemon digests only its own agents (their transcripts are local). A summary
// merges in the peers' digests, fetched as compact pages (src/activity-wire.ts) and kept per (peer, days),
// refreshed at most every PEER_TTL_MS and then only for digests that changed. A daemon that is not the ITSA
// home reads the ITSAs' attribution inputs from the home the same way, so its digests are attributed too.
// A peer that does not answer is left out and named in `machines.missing`.
import { createHash, randomBytes } from 'node:crypto';
import * as db from './db.ts';
import * as tree from './tree.ts';
import * as itsa from './itsa.ts';
import { MACHINE } from './config.ts';
import { settings } from './settings.ts';
import { peers, peerByName, peerCall, type Peer } from './peers.ts';
import { buildAttribution, readAttributionData, type Attribution, type AttributionData } from './issue-costs.ts';
import { digestToWire, digestFromWire, usageToWire, Keys, WIRE_VERSION, type WirePage, type WireAgent, type WireUsage } from './activity-wire.ts';
import { isReviewerType } from './agent-types.ts';
import { filterKey, parseAgentFilter, typeOf } from './agent-class.ts';
import { sweep, reviewersByItsa, reviewerNames, costCtx, modesOf, spread, modesSpread, activityLabels, type Window } from './activity-stats.ts';
import { CLOCK_GROUPS, FRICTION_KINDS, SLOW_WORK_KINDS, clockGroup, activityLabel, CATEGORY_LABELS, type ClockGroup } from './activity-categories.ts';
import { onTouched } from './activity-changes.ts';
import type { Ctx, Modes } from './cost-display.ts';
import { envVar } from './env.ts';

const HOUR = 3_600_000;
const DAY = 86_400_000;
// Each synchronous slice yields once it has run this long.
export const SLICE_MS = 8;
const CACHE_MS = 30_000;
// After a daemon start, a request waits this long for the first refresh to finish; then it answers with the
// digests built so far, marked `warming: true` (S-1206), instead of waiting until it times out.
const WARM_WAIT_MS = Number(envVar('ACTIVITY_WARM_MS')) || 1_500;
export const MAX_DAYS = 400;

export const SUMMARY_NOTE =
  'Seconds are agent-hours of clock (concurrent items split their wall time). clock groups sum to total_s; friction is throttle.cost, throttle.scheduler, tool.sleep, tool.contention and model.stall. Costs are the usage table\'s (as Overview), in every Measure mode, a mode that cannot be computed is null; an ITSA scope places each agent-day of usage by the ITSA\'s share of that day\'s item est cost. working_by_category cost is estimated: item est cost per category, scaled to the usage total. The window starts on the hour. configs are closed work issues (kind issue, with working time) whose time falls in the scope.';

export type Scope = { kind: 'all' } | { kind: 'tree' | 'agent'; id: string } | { kind: 'itsa'; id: string; key: string };

// What the summary reads of an agent: a peer's agents come as this, from its digests page.
export type AgentLite = Pick<db.Agent, 'id' | 'name' | 'type' | 'harness' | 'model' | 'parent_id'> & { kind?: string | null };

export class ScopeError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// `tree:AGENT`, `itsa:S-N`, `agent:AGENT` (an id or a name), or nothing for everything.
// An agent of a peer, by id or name, from the digests pages read so far.
function peerAgent(ref: string): AgentLite | undefined {
  let byName: AgentLite | undefined;
  for (const sl of state.slices.values()) {
    const a = sl.agents.get(ref);
    if (a) return a;
    byName ??= [...sl.agents.values()].find((x) => x.name === ref);
  }
  return byName;
}

// `parseScope` after the state it reads is current: the peers' agents and, off the ITSA home, the ITSAs.
export async function resolveScope(raw: string | null | undefined, days = 7): Promise<Scope> {
  // A malformed scope is refused before anything is read from a peer.
  if (raw) {
    const kind = raw.split(':', 1)[0];
    if (!['tree', 'agent', 'itsa'].includes(kind) || !raw.slice(kind.length + 1)) throw new ScopeError(400, `scope must be tree:AGENT, itsa:S-N or agent:AGENT, not ${raw}`);
  }
  if (Number.isFinite(days) && days >= 1 && days <= MAX_DAYS) {
    if (state.warm) await refresh();
    else {
      // Cold (right after a restart): wait a short time for the first refresh, then go on with what is built.
      const r = refresh();
      await Promise.race([r, new Promise((res) => setTimeout(res, WARM_WAIT_MS).unref?.())]);
      if (!state.itsa) await r;
    }
    await syncPeers(days);
  }
  return parseScope(raw);
}

export function parseScope(raw: string | null | undefined): Scope {
  if (!raw) return { kind: 'all' };
  const i = raw.indexOf(':');
  const kind = i < 0 ? raw : raw.slice(0, i);
  const ref = i < 0 ? '' : raw.slice(i + 1);
  if (kind === 'tree' || kind === 'agent') {
    const a = db.getAgent(ref) ?? peerAgent(ref);
    if (!a) throw new ScopeError(404, `no agent ${ref}`);
    return { kind, id: a.id };
  }
  if (kind === 'itsa') {
    const x = isHome() ? itsa.find(ref) : [...(state.itsa?.attr.items.values() ?? [])].find((y) => y.id === ref || y.key === ref);
    if (!x) throw new ScopeError(404, `no ITSA ${ref}`);
    return { kind, id: x.id, key: x.key };
  }
  throw new ScopeError(400, `scope must be tree:AGENT, itsa:S-N or agent:AGENT, not ${raw}`);
}

// ---- digests ------------------------------------------------------------------------------------

// One hour of one agent's clock: seconds per working leaf (w) and per wait leaf (g), working seconds
// and est cost per category leaf (c, cu: friction left out), and the hour's est cost.
export interface Bucket {
  w: Record<string, number>;
  g: Record<string, number>;
  c: Record<string, number>;
  cu: Record<string, number>;
  usd: number;
}
const bucketZero = (): Bucket => ({ w: {}, g: {}, c: {}, cu: {}, usd: 0 });
type Hours = Map<number, Bucket>;
// The longest span per (start day, leaf): `${day}|${leaf}` -> [start, end] ms.
type Spans = Map<string, Window>;

export interface Part {
  hours: Hours;
  spans: Spans;
}
export interface Digest extends Part {
  // The agent's time attributed to each ITSA, scaled by its share.
  itsa: Map<string, Part>;
  // The attribution inputs it was built with (attribution signature for this agent).
  sig: string;
  // The longest item folded (ms): how far before a refold's start an item can still reach into it.
  maxDur: number;
}

const add = (m: Record<string, number>, k: string, v: number) => {
  m[k] = (m[k] ?? 0) + v;
};
const FRICTION = new Set(FRICTION_KINDS);

function addTo(part: Part, hour: number, gap: boolean, leaf: string, cat: string | null, sec: number, usd: number) {
  let b = part.hours.get(hour);
  if (!b) part.hours.set(hour, (b = bucketZero()));
  add(gap ? b.g : b.w, leaf, sec);
  if (cat) {
    add(b.c, cat, sec);
    add(b.cu, cat, usd);
  }
  b.usd += usd;
}
function addSpan(spans: Spans, leaf: string, s: number, e: number) {
  const k = `${Math.floor(s / DAY)}|${leaf}`;
  const cur = spans.get(k);
  if (!cur || e - s > cur[1] - cur[0]) spans.set(k, [s, e]);
}

interface ItemRow {
  seq: number;
  kind: string;
  wait_kind: string | null;
  start: string;
  end: string;
  est_cost_usd: number;
  category: string | null;
}
type Kept = { r: ItemRow; s: number; e: number };

// Items per page when a digest is built: an agent with a long history is folded a page at a time.
export const PAGE = 1000;

// A copy of a digest without its hours from `hour` on and its spans from `day` on, for a refold
// from there. The kept buckets are shared, never written again: a refold only adds to later hours.
function trimmed(dg: Digest, hour: number, day: number): Digest {
  const trim = (p: Part): Part => ({
    hours: new Map([...p.hours].filter(([h]) => h < hour)),
    spans: new Map([...p.spans].filter(([k]) => Number(k.slice(0, k.indexOf('|'))) < day)),
  });
  return { ...trim(dg), itsa: new Map([...dg.itsa].map(([id, p]) => [id, trim(p)])), sig: dg.sig, maxDur: dg.maxDur };
}

// Folds one agent's items into a digest, a page at a time in start order, yielding between pages.
// A page is folded up to its last quiet point (no earlier item still running), so concurrent items
// are always in the same fold; the rest carries over. With `prev` and `from` (ms), only the hours from
// from's hour on are refolded: the items that reach into them are read again (from the longest item
// before), and only the stretches from that hour on are added; spans refold from that day.
async function buildDigest(agentId: string, attr: Attribution, sig: string, sl: Slicer, prev?: Digest, from?: number): Promise<Digest> {
  const page = db
    .open()
    .prepare(`SELECT seq, kind, wait_kind, start, "end", est_cost_usd, category FROM activity_items WHERE agent_id = ? AND kind != 'text' AND (start > ? OR (start = ? AND seq > ?)) ORDER BY start, seq LIMIT ?`);
  const partial = prev != null && from != null && prev.sig === sig;
  const fromHour = partial ? Math.floor(from! / HOUR) : -Infinity;
  const fromDay = partial ? Math.floor((fromHour * HOUR) / DAY) : -Infinity;
  const dg: Digest = partial ? trimmed(prev!, fromHour, fromDay) : { hours: new Map(), spans: new Map(), itsa: new Map(), sig, maxDur: 0 };
  let carry: Kept[] = [];
  const readFrom = partial ? Math.min(fromHour * HOUR - prev!.maxDur, fromDay * DAY) : null;
  let cur = { start: readFrom == null ? '' : new Date(readFrom).toISOString(), seq: -1 };
  for (;;) {
    const rows = page.all(agentId, cur.start, cur.start, cur.seq, PAGE) as unknown as ItemRow[];
    for (const r of rows) {
      const s = Date.parse(r.start);
      const e = Date.parse(r.end);
      if (e > s) carry.push({ r, s, e });
    }
    if (rows.length) cur = { start: rows[rows.length - 1].start, seq: rows[rows.length - 1].seq };
    const last = rows.length < PAGE;
    let cut = carry.length;
    if (!last) {
      // The last index whose item starts after every earlier one has ended.
      cut = 0;
      let maxEnd = -Infinity;
      for (let i = 0; i < carry.length; i++) {
        if (i > 0 && carry[i].s >= maxEnd) cut = i;
        maxEnd = Math.max(maxEnd, carry[i].e);
      }
      // No quiet point in a whole page: fold it anyway rather than grow without bound.
      if (cut === 0 && carry.length >= 4 * PAGE) cut = carry.length;
    }
    fold(dg, agentId, attr, carry.slice(0, cut), fromHour * HOUR, fromDay * DAY);
    carry = carry.slice(cut);
    await sl.step(`digest ${agentId}`);
    if (last) break;
  }
  return dg;
}

// Each stretch of wall time, cut at the hours, goes to its hour, split evenly among the items covering
// it (as by=agent splits concurrent items); each item's est cost goes to its hours in proportion. Both
// also go to the item's ITSAs by the attribution, scaled by their shares.
// Stretches before `from` and spans starting before `spanFrom` (ms) are left out: a refold keeps them.
function fold(dg: Digest, agentId: string, attr: Attribution, kept: Kept[], from = -Infinity, spanFrom = -Infinity): void {
  if (!kept.length) return;
  let lo = Infinity;
  let hi = -Infinity;
  const meta = kept.map(({ r, s, e }) => {
    lo = Math.min(lo, s);
    hi = Math.max(hi, e);
    const gap = r.kind === 'gap';
    const leaf = gap ? (r.wait_kind ?? 'unknown') : (r.wait_kind ?? r.kind);
    const parts = attr.attribute(agentId, s).map(({ itsaId, share }) => {
      let p = dg.itsa.get(itsaId);
      if (!p) dg.itsa.set(itsaId, (p = { hours: new Map(), spans: new Map() }));
      return { p, share };
    });
    dg.maxDur = Math.max(dg.maxDur, e - s);
    if (s >= spanFrom) {
      addSpan(dg.spans, leaf, s, e);
      for (const { p } of parts) addSpan(p.spans, leaf, s, e);
    }
    return { gap, leaf, cat: !gap && !FRICTION.has(leaf) ? (r.category ?? 'unclassified') : null, parts, usdPerMs: r.est_cost_usd / (e - s) };
  });
  const cuts: number[] = [];
  for (let h = Math.ceil(lo / HOUR) * HOUR; h < hi; h += HOUR) cuts.push(h);
  sweep(
    kept.map((x) => [x.s, x.e] as Window),
    cuts,
    (a, b, active) => {
      if (a < from) return;
      const h = Math.floor(a / HOUR);
      const sec = (b - a) / 1000 / active.length;
      for (const i of active) {
        const m = meta[i];
        const usd = m.usdPerMs * (b - a);
        addTo(dg, h, m.gap, m.leaf, m.cat, sec, usd);
        for (const { p, share } of m.parts) addTo(p, h, m.gap, m.leaf, m.cat, sec * share, usd * share);
      }
    },
  );
}

// Each agent's attribution inputs: the ITSAs it is linked to, with what the attribution reads of
// them (status and owner timelines, participation). An agent whose string changes is rebuilt.
function agentSigs(attr: Attribution): Map<string, string> {
  const per = new Map<string, string[]>();
  const put = (agent: string, s: string) => {
    if (!per.has(agent)) per.set(agent, []);
    per.get(agent)!.push(s);
  };
  for (const x of attr.items.values()) {
    const base = `${x.id}:${x.created}:${x.initialStatus}:${x.statuses.map((s) => `${s.at}>${s.to}`).join(',')}:${x.owners.map((o) => `${o.at}>${o.owner}`).join(',')}`;
    const linked = new Set<string>([...x.participants, ...x.owners.map((o) => o.owner).filter((o): o is string => !!o)]);
    for (const a of linked) put(a, `${base}:${x.participants.has(a) ? 'p' : ''}`);
  }
  return new Map([...per].map(([a, list]) => [a, list.sort().join('|')]));
}

// ---- state --------------------------------------------------------------------------------------

interface ItsaState {
  sig: string;
  attr: Attribution;
  agentSig: Map<string, string>;
  // Status moves from a review category back to an active or ready one, per ITSA.
  moves: Map<string, number>;
  children: Map<string, string[]>;
  // What the review rounds read of the ITSAs (the home's, on any machine).
  participants: AttributionData['participants'];
  links: AttributionData['links'];
  // Who created each ITSA, and the ITSAs by key: what an agent's right to read one is judged from.
  createdBy: Map<string, string | null>;
  byKey: Map<string, string>;
}

const state = {
  digests: new Map<string, Digest>(),
  // Agents to rebuild, each from the earliest change (ms), or whole (null).
  dirty: new Map<string, number | null>(),
  known: false,
  // True once the first refresh has finished: until then the digests may be partial.
  warm: false,
  itsa: null as ItsaState | null,
  gen: 0,
  refreshing: null as Promise<void> | null,
  cache: new Map<string, { gen: number; at: number; value: Summary }>(),
  // What peers read of this daemon's digests: a version per digest from a counter, the latest hour of each
  // digest, and an epoch that changes when the counter restarts.
  epoch: randomBytes(4).toString('hex'),
  seq: 0,
  vers: new Map<string, number>(),
  last: new Map<string, number>(),
  // The ITSA home's attribution inputs, read when this daemon is not the home.
  remote: { sig: '', data: null as AttributionData | null, at: 0, ok: false },
  remoteBusy: null as Promise<void> | null,
  // The peers' digests, per `${peer}|${days}`.
  slices: new Map<string, PeerSlice>(),
  metrics: { max_slice_ms: 0, max_slice_at: '', last_refresh_ms: 0, last_rebuilt: 0, last_merge_ms: 0, slices: 0 },
};

interface PeerSlice {
  peer: string;
  epoch: string;
  seq: number;
  digests: Map<string, Digest>;
  agents: Map<string, AgentLite & { parents: string[] }>;
  usage: WireUsage;
  reviewers: Record<string, string[]>;
  // When the digests were last read, whether that worked, and when it last failed.
  at: number;
  ok: boolean;
  failedAt: number;
  busy: Promise<void> | null;
}

const isHome = () => (settings().itsa.home ?? MACHINE) === MACHINE;

function markDirty(id: string, since: number | null) {
  if (!state.dirty.has(id)) state.dirty.set(id, since);
  else {
    const cur = state.dirty.get(id)!;
    state.dirty.set(id, cur == null || since == null ? null : Math.min(cur, since));
  }
}

let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  onTouched((id, since) => {
    if (since === Infinity) return;
    markDirty(id, since);
    state.cache.clear();
  });
}

// For tests and the bench: forget every digest and the metrics.
export function resetSummary(): void {
  state.digests.clear();
  state.vers.clear();
  state.last.clear();
  state.slices.clear();
  state.remote = { sig: '', data: null, at: 0, ok: false };
  state.dirty.clear();
  state.known = false;
  state.warm = false;
  state.itsa = null;
  state.cache.clear();
  state.gen++;
  state.metrics = { max_slice_ms: 0, max_slice_at: '', last_refresh_ms: 0, last_rebuilt: 0, last_merge_ms: 0, slices: 0 };
}

export function summaryMetrics() {
  return { ...state.metrics, digests: state.digests.size };
}

// A run of synchronous work that yields to the event loop once a slice has run SLICE_MS, keeping
// the longest slice it ran.
class Slicer {
  private t = performance.now();
  // `at` names the step that ended the slice, for the metrics.
  async step(at: string): Promise<void> {
    const ms = performance.now() - this.t;
    if (ms < SLICE_MS) return;
    this.end(at);
    await new Promise<void>((r) => setImmediate(r));
    this.t = performance.now();
  }
  end(at: string): void {
    const ms = Math.round((performance.now() - this.t) * 10) / 10;
    if (ms > state.metrics.max_slice_ms) {
      state.metrics.max_slice_ms = ms;
      state.metrics.max_slice_at = at;
    }
    state.metrics.slices++;
  }
}

// The event types the attribution reads; others (posts, links) never move the signature.
const EXPORTED_EVENTS = "'created', 'status', 'owner'";

// What the attribution reads changed when an event, a participant or an ITSA row did.
function itsaSignature(): string {
  const d = db.open();
  const e = d.prepare(`SELECT MAX(id) AS m FROM itsa_events WHERE type IN (${EXPORTED_EVENTS})`).get() as { m: number | null };
  const p = createHash('sha1');
  for (const r of d.prepare('SELECT itsa_id, agent_id FROM itsa_participants ORDER BY itsa_id, agent_id').all() as { itsa_id: string; agent_id: string }[]) p.update(`${r.itsa_id}:${r.agent_id};`);
  const x = d.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS u FROM itsas').get() as { n: number; u: string | null };
  return `${e.m}:${p.digest('hex')}:${x.n}:${x.u}`;
}

function buildItsaState(sig: string, data: AttributionData = readAttributionData()): ItsaState {
  const attr = buildAttribution(data);
  const categoryOf = new Map(itsa.statuses().map((s) => [s.name, s.category as string]));
  const moves = new Map<string, number>();
  for (const x of attr.items.values()) {
    let prev = x.initialStatus;
    for (const s of x.statuses) {
      if (categoryOf.get(prev ?? '') === 'review' && ['active', 'ready'].includes(categoryOf.get(s.to) ?? '')) moves.set(x.id, (moves.get(x.id) ?? 0) + 1);
      prev = s.to;
    }
  }
  const children = new Map<string, string[]>();
  for (const x of attr.items.values()) if (x.parent_id && attr.items.has(x.parent_id)) (children.get(x.parent_id) ?? children.set(x.parent_id, []).get(x.parent_id)!).push(x.id);
  return { sig, attr, agentSig: agentSigs(attr), moves, children, participants: data.participants, links: data.links, createdBy: new Map(data.itsas.map((x) => [x.id, x.created_by])), byKey: new Map(data.itsas.map((x) => [x.key, x.id])) };
}

// The agents with items, by a skip scan over the (agent_id, seq) key: one indexed step per agent.
async function agentsWithItems(sl: Slicer): Promise<string[]> {
  const next = db.open().prepare('SELECT agent_id FROM activity_items WHERE agent_id > ? ORDER BY agent_id LIMIT 1');
  const out: string[] = [];
  let cur = '';
  for (;;) {
    const r = next.get(cur) as { agent_id: string } | undefined;
    if (!r) break;
    out.push((cur = r.agent_id));
    await sl.step('agent list');
  }
  return out;
}

// Builds the digests in the background (at daemon start), so the first request finds them warm.
export function warmSummary(): Promise<void> {
  return refresh().catch((e) => console.error(`activity summary: ${e instanceof Error ? e.message : e}`));
}

// Brings every digest up to date, in slices. One refresh runs at a time; callers share it.
function refresh(): Promise<void> {
  listen();
  if (!state.refreshing) state.refreshing = refreshNow().finally(() => (state.refreshing = null));
  return state.refreshing;
}

async function refreshNow(): Promise<void> {
  const t0 = performance.now();
  // Off the ITSA home, the attribution inputs come from the home (cached for REMOTE_TTL_MS). The wait is not
  // a slice, so the slicer starts after it.
  if (!isHome()) await readRemoteAttribution();
  const sl = new Slicer();
  const sig = isHome() ? itsaSignature() : `remote:${state.remote.sig}`;
  // An ITSA change also moves what configs read (kind, status, closed_at), so it drops the answers.
  const itsaChanged = state.itsa?.sig !== sig;
  if (itsaChanged) {
    const prev = state.itsa;
    state.itsa = buildItsaState(sig, isHome() ? undefined : (state.remote.data ?? { itsas: [], events: [], participants: [], links: [] }));
    await sl.step('attribution');
    if (prev) {
      for (const [id, dg] of state.digests) if (dg.sig !== (state.itsa.agentSig.get(id) ?? '')) markDirty(id, null);
    }
  }
  if (!state.known) {
    for (const id of await agentsWithItems(sl)) markDirty(id, null);
    state.known = true;
  }
  const it = state.itsa!;
  let rebuilt = 0;
  while (state.dirty.size) {
    const [id, since] = state.dirty.entries().next().value as [string, number | null];
    state.dirty.delete(id);
    const dg = await buildDigest(id, it.attr, it.agentSig.get(id) ?? '', sl, since == null ? undefined : state.digests.get(id), since ?? undefined);
    if (dg.hours.size) {
      state.digests.set(id, dg);
      state.vers.set(id, ++state.seq);
      state.last.set(id, Math.max(...dg.hours.keys()));
    } else {
      state.digests.delete(id);
      state.vers.delete(id);
      state.last.delete(id);
    }
    rebuilt++;
  }
  sl.end('refresh');
  // The first refresh also drops the warming answers cached while it ran.
  if (rebuilt || itsaChanged || !state.warm) {
    state.gen++;
    state.cache.clear();
  }
  state.warm = true;
  state.metrics.last_refresh_ms = Math.round(performance.now() - t0);
  state.metrics.last_rebuilt = rebuilt;
}

// ---- machines (S-1079) --------------------------------------------------------------------------

const REMOTE_TTL_MS = Number(envVar('ACTIVITY_REMOTE_MS')) || 10_000;
const PEER_TTL_MS = Number(envVar('ACTIVITY_PEER_MS')) || 15_000;
// After a failed read, a peer is not asked again for this long (peers.ts also skips a peer it knows is down).
const PEER_RETRY_MS = 5_000;
const PEER_TIMEOUT_MS = 8_000;

// Reads the ITSA home's attribution inputs when its signature moved: the ITSAs, participants and branch links
// whole, the events only after the last one held (a restart of the numbering starts over), in pages so the home
// is never held long. A home that does not answer leaves the last inputs in place (none: no ITSAs), and
// `remote.ok` false names the home as missing.
function readRemoteAttribution(): Promise<void> {
  if (Date.now() - state.remote.at < REMOTE_TTL_MS) return Promise.resolve();
  state.remoteBusy ??= (async () => {
    const home = settings().itsa.home;
    const peer = home ? peerByName(home) : undefined;
    try {
      if (!peer) throw new Error(`ITSA home '${home}' is not a configured peer`);
      const have = state.remote.data;
      const lastHeld = have?.events.length ? have.events[have.events.length - 1].id : -1;
      const ask = (q: string) => peerCall(peer, 'GET', `/api/activity?by=attribution&${q}`, undefined, PEER_TIMEOUT_MS);
      // The ITSA rows come as a delta from the newest `updated_at` held (S-1208); a reader with none asks for all.
      const since = have?.itsas.length ? have.itsas.reduce((m, x) => (x.updated_at > m ? x.updated_at : m), '') : '';
      let r = await ask(`sig=${encodeURIComponent(state.remote.sig)}&events_after=${lastHeld}${since ? `&rows_since=${encodeURIComponent(since)}` : ''}`);
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      let d = r.data as AttributionExport;
      if (!d.itsas) {
        state.remote.ok = true;
        return;
      }
      const events = d.reset || !have ? [] : have.events.slice();
      const first = d;
      for (;;) {
        events.push(...d.events);
        if (!d.more) break;
        r = await ask(`cont=1&events_after=${events[events.length - 1].id}`);
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        d = r.data as AttributionExport;
      }
      const itsas = first.ids && have ? mergeRows(have.itsas, first.itsas!, first.ids) : first.itsas!;
      state.remote = { sig: first.sig!, data: { itsas, participants: first.participants!, links: first.links!, events }, at: Date.now(), ok: true };
    } catch {
      state.remote.ok = false;
    } finally {
      state.remote.at = Date.now();
      state.remoteBusy = null;
    }
  })();
  return state.remoteBusy;
}

// The held ITSA rows with the changed ones replaced or added and those not in `ids` (the home's whole id set) dropped.
export function mergeRows(held: AttributionData['itsas'], changed: AttributionData['itsas'], ids: string[]): AttributionData['itsas'] {
  const keep = new Set(ids);
  const rows = new Map(held.filter((x) => keep.has(x.id)).map((x) => [x.id, x]));
  for (const x of changed) rows.set(x.id, x);
  return [...rows.values()];
}

export interface AttributionExport {
  sig?: string;
  // Absent when the reader's signature is current.
  // With `ids`, only the rows changed since the reader's `rows_since`; else all of them.
  itsas?: AttributionData['itsas'];
  // Every ITSA id the home holds, sent with a delta of `itsas` so the reader drops removed ones.
  ids?: string[];
  participants?: AttributionData['participants'];
  links?: AttributionData['links'];
  events: AttributionData['events'];
  // The reader's cursor is past the home's last event: it starts over.
  reset?: boolean;
  more?: boolean;
}
const EVENTS_PAGE = 2000;

// The attribution inputs for a peer that is not the home (S-1079): its signature alone when it holds them, else
// the ITSAs, participants and links and the events after `after` (`cont`: only the next events), a page of
// EVENTS_PAGE at a time.
export function attributionExport(sig: string | null, after = -1, cont = false, rowsSince: string | null = null): AttributionExport {
  const d = db.open();
  const events = (from: number) =>
    d.prepare(`SELECT id, itsa_id, ts, type, data FROM itsa_events WHERE id > ? AND type IN (${EXPORTED_EVENTS}) ORDER BY id LIMIT ?`).all(from, EVENTS_PAGE + 1) as unknown as AttributionData['events'];
  const page = (from: number) => {
    const rows = events(from);
    return { events: rows.slice(0, EVENTS_PAGE), ...(rows.length > EVENTS_PAGE ? { more: true } : {}) };
  };
  if (cont) return page(after);
  const now = itsaSignature();
  if (now === sig) return { sig: now, events: [] };
  const max = (d.prepare(`SELECT MAX(id) AS m FROM itsa_events WHERE type IN (${EXPORTED_EVENTS})`).get() as { m: number | null }).m ?? 0;
  const reset = after > max;
  const { events: _e, ...tables } = readAttributionData(false);
  // Rows at or after the reader's newest `updated_at` (equal stamps may hold more than it saw), with every id.
  // A cursor past every row (a restored database, a clock that went back) is not a baseline: all rows, no ids.
  const newest = tables.itsas.reduce((m, x) => (x.updated_at > m ? x.updated_at : m), '');
  const delta = rowsSince && rowsSince <= newest ? { itsas: tables.itsas.filter((x) => x.updated_at >= rowsSince), ids: tables.itsas.map((x) => x.id) } : {};
  return { sig: now, ...tables, ...delta, ...(reset ? { reset: true } : {}), ...page(reset ? -1 : after) };
}

// The reviewer agents on this machine by the ITSA keys and branch-like names (with a `/`) their first prompts
// name: what a daemon that holds the ITSAs counts as review rounds for them.
function reviewerKeys(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, ids] of reviewerNames(db.open())) if (/^S-\d+$/.test(name) || name.includes('/')) out[name] = [...ids];
  return out;
}

export const PAGE_AGENTS = 40;
// A page stops growing once building it has taken this long, so a peer's loop is held for a few ms at a time.
const PAGE_MS = 8;

// One page of this daemon's digests for a peer (activity-wire.ts).
export async function digestsPage(opts: { days: number; since: number; epoch: string; after: string; now?: number; limit?: number }): Promise<WirePage> {
  const { days } = opts;
  if (!Number.isFinite(days) || days < 1 || days > MAX_DAYS) throw new ScopeError(400, `days must be a number from 1 to ${MAX_DAYS}, not ${opts.days}`);
  await refresh();
  const now = opts.now ?? Date.now();
  const sinceHour = Math.floor((now - days * DAY) / HOUR) - 1;
  const since = opts.epoch === state.epoch ? opts.since : -1;
  const ids = [...state.digests.keys()].filter((id) => (state.last.get(id) ?? 0) >= sinceHour).sort();
  const keys = new Keys();
  const page: WirePage = { wire: WIRE_VERSION, machine: MACHINE, epoch: state.epoch, seq: state.seq, keys: keys.list, digests: [] };
  if (!opts.after) {
    const sinceDay = Math.floor((sinceHour * HOUR) / DAY);
    const usage = usageToWire(usageRows(sinceDay));
    page.ids = ids;
    page.usage = usage;
    page.reviewers = reviewerKeys();
    const want = new Set([...ids, ...Object.keys(usage)]);
    const parents = new Map<string, string[]>();
    for (const [child, parent] of tree.edges()) (parents.get(child) ?? parents.set(child, []).get(child)!).push(parent);
    // The agents with data and their ancestors, so a reader can walk the whole tree above them.
    const all = new Map(db.listAgents().map((a) => [a.id, a]));
    const done = new Set<string>();
    const up = (id: string) => {
      if (done.has(id)) return;
      done.add(id);
      const a = all.get(id);
      if (!a) return;
      want.add(id);
      for (const q of [...(a.parent_id ? [a.parent_id] : []), ...(parents.get(id) ?? [])]) up(q);
    };
    for (const id of [...want]) up(id);
    page.agents = [...all.values()]
      .filter((a) => want.has(a.id))
      .map((a): WireAgent => ({ id: a.id, name: a.name, type: a.type, kind: a.kind, harness: a.harness, model: a.model, parents: [...new Set([...(a.parent_id ? [a.parent_id] : []), ...(parents.get(a.id) ?? [])])] }));
  }
  const t0 = performance.now();
  const limit = opts.limit ?? PAGE_AGENTS;
  for (const id of ids) {
    if (opts.after && id <= opts.after) continue;
    if ((state.vers.get(id) ?? 0) <= since) continue;
    if (page.digests.length >= limit || (page.digests.length && performance.now() - t0 > PAGE_MS)) {
      page.next = page.digests[page.digests.length - 1].id;
      break;
    }
    page.digests.push(digestToWire(id, state.vers.get(id) ?? 0, state.digests.get(id)!, keys, now, days));
  }
  return page;
}

// At most this many (peer, days) slices are kept; the least recently used goes first.
const MAX_SLICES = 8;
function sliceOf(p: Peer, days: number): PeerSlice {
  const key = `${p.name}|${days}`;
  let sl = state.slices.get(key);
  if (sl) {
    // Moves to the end: Map order is the recency.
    state.slices.delete(key);
    state.slices.set(key, sl);
  } else {
    while (state.slices.size >= MAX_SLICES) {
      const oldest = [...state.slices].find(([, x]) => !x.busy);
      if (!oldest) break;
      state.slices.delete(oldest[0]);
    }
  }
  if (!sl) state.slices.set(key, (sl = { peer: p.name, epoch: '', seq: -1, digests: new Map(), agents: new Map(), usage: {}, reviewers: {}, at: 0, ok: false, failedAt: 0, busy: null }));
  return sl;
}

// Reads one peer's digests for `days`: its pages, then the slice is replaced in one step.
async function readPeer(p: Peer, days: number, sl: PeerSlice): Promise<void> {
  const staged = new Map<string, WireDigestFrom>();
  let first: WirePage | null = null;
  let after = '';
  for (;;) {
    const q = `/api/activity?by=digests&days=${days}&since=${sl.seq}&epoch=${sl.epoch}${after ? `&after=${encodeURIComponent(after)}` : ''}`;
    const r = await peerCall(p, 'GET', q, undefined, PEER_TIMEOUT_MS);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const page = r.data as WirePage;
    if (page.wire !== WIRE_VERSION) throw new Error(`wire version ${page.wire}`);
    first ??= page;
    for (const w of page.digests) staged.set(w.id, { v: w.v, dg: digestFromWire(w, page.keys) });
    if (!page.next) break;
    after = page.next;
  }
  const full = first.epoch !== sl.epoch;
  const keep = new Set(first.ids ?? []);
  const digests = new Map<string, Digest>();
  for (const [id, dg] of full ? [] : sl.digests) if (keep.has(id)) digests.set(id, dg);
  for (const [id, x] of staged) digests.set(id, x.dg);
  const agents = new Map((first.agents ?? []).map((a) => [a.id, { ...a, parent_id: a.parents[0] ?? null }]));
  const usage = first.usage ?? {};
  const changed = staged.size > 0 || full || digests.size !== sl.digests.size || JSON.stringify(usage) !== JSON.stringify(sl.usage) || agents.size !== sl.agents.size;
  Object.assign(sl, { epoch: first.epoch, seq: first.seq, digests, agents, usage, reviewers: first.reviewers ?? {} });
  if (changed) {
    state.gen++;
    state.cache.clear();
  }
}
type WireDigestFrom = { v: number; dg: Digest };

// Brings every peer's slice for `days` up to date (concurrently; callers share a read). A peer that fails is
// left out of the answer until a later read works. Returns the machines left out.
async function syncPeers(days: number): Promise<void> {
  await Promise.all(
    peers().map((p) => {
      const sl = sliceOf(p, days);
      if (sl.busy) return sl.busy;
      const age = Date.now() - sl.at;
      if (sl.ok && age < PEER_TTL_MS) return;
      if (!sl.ok && sl.failedAt && Date.now() - sl.failedAt < PEER_RETRY_MS) return;
      sl.busy = readPeer(p, days, sl)
        .then(() => {
          sl.ok = true;
          sl.at = Date.now();
        })
        .catch((e) => {
          console.error(`activity summary: ${p.name} digests: ${e instanceof Error ? e.message : e}`);
          if (sl.ok) {
            state.gen++;
            state.cache.clear();
          }
          sl.ok = false;
          sl.failedAt = Date.now();
        })
        .finally(() => {
          sl.busy = null;
        });
      return sl.busy;
    }),
  );
}

// ---- the answer ---------------------------------------------------------------------------------

export interface SummaryOptions {
  days?: number;
  scope?: string | null;
  now?: number;
  // An agent's token: only the agents it may see (usage-scope visibleAgents) and the ITSAs it may
  // read count. Unset for the human, the CLI and the bosses.
  visible?: Set<string>;
  mayItsa?: (key: string) => boolean;
  viewer?: string;
  // Agent types kept (src/agent-class.ts): a comma list of type names (older preset names still map); unset keeps every agent.
  agents?: string | null;
}

type Summary = Record<string, unknown>;

interface Groups {
  working: number;
  friction: number;
  others: number;
  you: number;
  idle: number;
}
const groupsZero = (): Groups => ({ working: 0, friction: 0, others: 0, you: 0, idle: 0 });

// One agent's merged window: its leaves, groups and cost.
interface AgentAcc {
  leaves: Record<string, number>;
  groups: Groups;
  // The agent's usage-table cost in the scope, per account.
  usd: number;
  acct: Map<string, number>;
}

const r0 = (n: number) => Math.round(n);
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const roundAll = (m: Record<string, number>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Math.round(v)]));
const per = (m: Modes, div: number): Modes => ({
  api: r6(m.api / div),
  paid_usd: r6(m.paid_usd / div),
  five_hour: m.five_hour == null ? null : Math.round((m.five_hour / div) * 100) / 100,
  seven_day: m.seven_day == null ? null : Math.round((m.seven_day / div) * 100) / 100,
  subscription: m.subscription == null ? null : Math.round((m.subscription / div) * 100) / 100,
});
function addAcct(m: Map<string, number>, account: string, v: number) {
  m.set(account, (m.get(account) ?? 0) + v);
}
const scaleModes = (m: Modes, f: number): Modes => per(m, 1 / f);
const sumMap = (m: Map<string, number>) => [...m.values()].reduce((n, v) => n + v, 0);

// Per day of a part (day index), its est cost and clock seconds in the window.
function daysOf(parts: Part[], sinceHour: number, nowHour: number): Map<number, { usd: number; sec: number }> {
  const out = new Map<number, { usd: number; sec: number }>();
  for (const part of parts)
    for (const [h, b] of part.hours) {
      if (h < sinceHour || h > nowHour) continue;
      const d = Math.floor((h * HOUR) / DAY);
      let x = out.get(d);
      if (!x) out.set(d, (x = { usd: 0, sec: 0 }));
      x.usd += b.usd;
      for (const v of Object.values(b.w)) x.sec += v;
      for (const v of Object.values(b.g)) x.sec += v;
    }
  return out;
}

// The usage table's cost (what Overview and by=agent's cost_usd show) per agent, day index and
// account, over the window's days.
type Usage = Map<string, Map<number, Map<string, number>>>;
function usageRows(sinceDay: number) {
  return db
    .open()
    .prepare('SELECT agent_id, day, account, SUM(cost_usd) AS c FROM usage WHERE day >= ? GROUP BY agent_id, day, account')
    .all(new Date(sinceDay * DAY).toISOString().slice(0, 10)) as { agent_id: string; day: string; account: string; c: number }[];
}
function usageOf(sinceDay: number, peerUsage: WireUsage[] = []): Usage {
  const out: Usage = new Map();
  for (const r of usageRows(sinceDay)) {
    if (!out.has(r.agent_id)) out.set(r.agent_id, new Map());
    const byDay = out.get(r.agent_id)!;
    const d = Math.floor(Date.parse(`${r.day}T00:00:00.000Z`) / DAY);
    if (!byDay.has(d)) byDay.set(d, new Map());
    addAcct(byDay.get(d)!, r.account, Number(r.c) || 0);
  }
  // The peers' agents' usage as their usage tables hold it, added to what is here: an agent's rows live on its
  // own machine, but the `stam` pseudo-agent (decisions, voice) has rows on every machine.
  for (const wu of peerUsage)
    for (const [agent, byDay] of Object.entries(wu)) {
      if (!out.has(agent)) out.set(agent, new Map());
      const mine = out.get(agent)!;
      for (const [d, byAcct] of Object.entries(byDay)) {
        if (Number(d) < sinceDay) continue;
        if (!mine.has(Number(d))) mine.set(Number(d), new Map());
        for (const [acct, v] of Object.entries(byAcct)) addAcct(mine.get(Number(d))!, acct, v);
      }
    }
  return out;
}

// The part of an agent's usage that falls to some of its digest's parts (its ITSAs): each day's usage
// in proportion to the parts' share of that day's est cost, or of its clock on a day with no est cost.
// With no parts given, all of it. Usage on a day with no items at all goes to no ITSA.
function usageFor(usage: Usage, id: string, all: Map<number, { usd: number; sec: number }> | null, mine: Map<number, { usd: number; sec: number }> | null): Map<string, number> {
  const out = new Map<string, number>();
  for (const [d, byAcct] of usage.get(id) ?? []) {
    let share = 1;
    if (all && mine) {
      const a = all.get(d);
      const m = mine.get(d);
      share = !a || !m ? 0 : a.usd > 0 ? m.usd / a.usd : a.sec > 0 ? m.sec / a.sec : 0;
    }
    if (share > 0) for (const [acct, v] of byAcct) addAcct(out, acct, v * share);
  }
  return out;
}

export async function activitySummary(opts: SummaryOptions = {}): Promise<Summary> {
  const days = opts.days ?? 7;
  if (!Number.isFinite(days) || days < 1 || days > MAX_DAYS) throw new ScopeError(400, `days must be a number from 1 to ${MAX_DAYS}, not ${opts.days}`);
  const scope = await resolveScope(opts.scope, days);
  const now = opts.now ?? Date.now();
  let keep;
  try {
    keep = parseAgentFilter(opts.agents);
  } catch (e) {
    throw new ScopeError(400, (e as Error).message);
  }
  const key = `${days}|${opts.scope ?? ''}|${opts.viewer ?? ''}|${opts.now ?? ''}|${filterKey(keep)}`;
  const hit = state.cache.get(key);
  if (hit && hit.gen === state.gen && Date.now() - hit.at < CACHE_MS) return hit.value;
  const t0 = performance.now();
  const gen = state.gen;
  // Read before the merge: the first refresh may finish while it runs, and the answer is partial then.
  const warming = !state.warm;
  const value = await merge(scope, days, now, opts, keep);
  state.metrics.last_merge_ms = Math.round(performance.now() - t0);
  // A warming answer is cached too (S-1725): uncached, every poll after a restart ran a full merge beside the
  // refresh. The first refresh's end drops it (refreshNow), so the full answer follows.
  const out = warming ? { ...value, warming: true } : value;
  state.cache.set(key, { gen, at: Date.now(), value: out });
  return out;
}

async function merge(scope: Scope, days: number, now: number, opts: SummaryOptions, keep: Set<string> | null): Promise<Summary> {
  const sl = new Slicer();
  const it = state.itsa!;
  const sinceHour = Math.floor((now - days * DAY) / HOUR);
  const since = sinceHour * HOUR;
  // The last hour that starts before now (the window ends at now; no item ends after it).
  const nowHour = Math.ceil(now / HOUR) - 1;
  const sinceDay = Math.floor(since / DAY);
  // The Measure context reads the usage snapshot, memoized for every cost view (usage.ts).
  const ctx: Ctx = costCtx(now);
  await sl.step('cost context');

  // The peers that answered: their digests, agents and usage join this daemon's.
  const included = [MACHINE];
  const missing: string[] = [];
  const digests = new Map<string, Digest>();
  const agents = new Map<string, AgentLite>();
  const peerEdges: [string, string][] = [];
  const peerUsage: WireUsage[] = [];
  const peerNames = new Map<string, Set<string>>();
  for (const p of peers()) {
    const sl = state.slices.get(`${p.name}|${days}`);
    if (!sl?.ok) {
      missing.push(p.name);
      continue;
    }
    included.push(p.name);
    for (const [id, dg] of sl.digests) digests.set(id, dg);
    for (const [id, a] of sl.agents) {
      agents.set(id, a);
      for (const parent of a.parents) peerEdges.push([id, parent]);
    }
    peerUsage.push(sl.usage);
    for (const [name, ids] of Object.entries(sl.reviewers)) for (const id of ids) (peerNames.get(name) ?? peerNames.set(name, new Set()).get(name)!).add(id);
  }
  // The ITSA home's inputs count as a machine of their own when this daemon reads them from it.
  const homeName = settings().itsa.home;
  if (!isHome() && !state.remote.ok && homeName && !missing.includes(homeName)) missing.push(homeName);
  for (const [id, dg] of state.digests) digests.set(id, dg);
  for (const a of db.listAgents()) agents.set(a.id, a);
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  const link = (child: string, parent: string) => {
    if (child === parent) return;
    const list = children.get(parent) ?? children.set(parent, []).get(parent)!;
    if (!list.includes(child)) list.push(child);
    (parents.get(child) ?? parents.set(child, []).get(child)!).push(parent);
  };
  for (const [child, parent] of tree.edges([...agents.values()])) link(child, parent);
  for (const [child, parent] of peerEdges) link(child, parent);
  // What an agent's token may read, judged on the merged graph (a tree crosses machines) and, for ITSAs, on the
  // home's data: its own agent and its ancestors, everything below each of them, and the ITSAs it belongs to.
  if (opts.viewer !== undefined) {
    const me = opts.viewer;
    opts = { ...opts, visible: opts.visible ?? visibleFrom(me, parents, children), mayItsa: opts.mayItsa ?? ((key) => itsaMember(me, key)) };
    if ((scope.kind === 'tree' || scope.kind === 'agent') && !opts.visible!.has(scope.id))
      throw new ScopeError(403, `an agent reads the activity of its own tree and its ancestors' trees only, not ${scope.kind}:${agents.get(scope.id)?.name ?? scope.id}`);
    if (scope.kind === 'itsa' && !opts.mayItsa!(scope.key)) throw new ScopeError(403, `an agent reads the activity of the ITSAs it belongs to only, not ${scope.key}`);
  }
  const subtree = (root: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [root];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(children.get(id) ?? []));
    }
    return seen;
  };

  // The agents counted, and for an ITSA scope the ITSAs whose attributed time counts.
  let members: string[] = [];
  let itsaIds: Set<string> | null = null;
  if (scope.kind === 'itsa') {
    itsaIds = new Set<string>();
    const stack = [scope.id];
    while (stack.length) {
      const id = stack.pop()!;
      if (itsaIds.has(id)) continue;
      itsaIds.add(id);
      stack.push(...(it.children.get(id) ?? []));
    }
    members = [...digests].filter(([, dg]) => [...itsaIds!].some((x) => dg.itsa.has(x))).map(([id]) => id);
  }
  // The usage table: agents with cost but no items (no transcript read yet) still count for cost.
  const usage = usageOf(sinceDay, peerUsage);
  await sl.step('usage');
  const counted = (id: string) => digests.has(id) || usage.has(id);
  if (scope.kind === 'all') members = [...new Set([...digests.keys(), ...usage.keys()])];
  else if (scope.kind === 'tree') members = [...subtree(scope.id)].filter(counted);
  else if (scope.kind === 'agent') members = counted(scope.id) ? [scope.id] : [];
  if (opts.visible && scope.kind !== 'itsa') members = members.filter((id) => opts.visible!.has(id));
  // The types present in the period, before the filter, each with its agent count; then the type filter
  // (S-1491): everything below is built from the members.
  const cos = settings().chiefOfStaff;
  const typeCounts = new Map<string, number>();
  const typeOfId = (id: string) => {
    const a = agents.get(id);
    return a ? typeOf(a, cos) : 'untyped';
  };
  for (const id of members) typeCounts.set(typeOfId(id), (typeCounts.get(typeOfId(id)) ?? 0) + 1);
  const types = [...typeCounts].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  if (keep) members = members.filter((id) => keep.has(typeOfId(id)));

  // The parts of a digest the scope reads.
  const partsOf = (dg: Digest | undefined): Part[] => (!dg ? [] : itsaIds ? [...itsaIds].map((x) => dg.itsa.get(x)).filter((p): p is Part => !!p) : [dg]);

  const leavesW: Record<string, number> = {};
  const leavesG: Record<string, number> = {};
  const catS: Record<string, number> = {};
  const catUsd: Record<string, number> = {};
  const totalAcct = new Map<string, number>();
  const workingByDay = new Map<number, number>();
  const perAgent = new Map<string, AgentAcc>();
  const longest = new Map<string, { seconds: number; agent: string; start: number }>();
  let usd = 0;

  for (const id of members) {
    const dg = digests.get(id);
    const parts = partsOf(dg);
    const acct = usageFor(usage, id, itsaIds && dg ? daysOf([dg], sinceHour, nowHour) : null, itsaIds ? daysOf(parts, sinceHour, nowHour) : null);
    const acc: AgentAcc = { leaves: {}, groups: groupsZero(), usd: sumMap(acct), acct };
    for (const part of parts) {
      for (const [h, b] of part.hours) {
        if (h < sinceHour || h > nowHour) continue;
        const day = Math.floor((h * HOUR) / DAY);
        for (const [k, v] of Object.entries(b.w)) {
          add(leavesW, k, v);
          add(acc.leaves, k, v);
          const g = clockGroup(k, false);
          acc.groups[g] += v;
          if (g === 'working') workingByDay.set(day, (workingByDay.get(day) ?? 0) + v);
        }
        for (const [k, v] of Object.entries(b.g)) {
          add(leavesG, k, v);
          add(acc.leaves, k, v);
          acc.groups[clockGroup(k, true)] += v;
        }
        for (const [k, v] of Object.entries(b.c)) {
          const t = k.split('.')[0];
          add(catS, k, v);
          add(catUsd, t, b.cu[k] ?? 0);
        }
      }
      for (const [k, [s, e]] of part.spans) {
        const bar = k.indexOf('|');
        const day = Number(k.slice(0, bar));
        if (day < sinceDay - 1) continue;
        const seconds = (Math.min(e, now) - Math.max(s, since)) / 1000;
        if (seconds <= 0) continue;
        const leaf = k.slice(bar + 1);
        const cur = longest.get(leaf);
        if (!cur || seconds > cur.seconds || (seconds === cur.seconds && id < cur.agent)) longest.set(leaf, { seconds, agent: id, start: Math.max(s, since) });
      }
    }
    usd += acc.usd;
    for (const [a, v] of acct) addAcct(totalAcct, a, v);
    perAgent.set(id, acc);
    await sl.step(`merge ${id}`);
  }

  // Clock: every leaf in its group, the groups summing to the total.
  const groupLeaves = Object.fromEntries(CLOCK_GROUPS.map((g) => [g.key, {} as Record<string, number>])) as Record<ClockGroup, Record<string, number>>;
  for (const [k, v] of Object.entries(leavesW)) add(groupLeaves[clockGroup(k, false)], k, v);
  for (const [k, v] of Object.entries(leavesG)) add(groupLeaves[clockGroup(k, true)], k, v);
  const groupS = Object.fromEntries(CLOCK_GROUPS.map((g) => [g.key, Object.values(groupLeaves[g.key]).reduce((n, v) => n + v, 0)])) as Record<ClockGroup, number>;
  // The total is the sum of the rounded groups, so they add up exactly.
  const clock = {
    total_s: CLOCK_GROUPS.reduce((n, g) => n + r0(groupS[g.key]), 0),
    ...Object.fromEntries(CLOCK_GROUPS.map((g) => [`${g.key}_s`, r0(groupS[g.key])])),
    groups: CLOCK_GROUPS.map((g) => ({ key: g.key, label: g.label, seconds: r0(groupS[g.key]), leaves: roundAll(groupLeaves[g.key]) })),
  };

  const totalModes = modesOf(ctx, totalAcct);
  const workingH = groupS.working / 3600;
  const youLeaves = groupLeaves.you;
  const dayKeys: number[] = [];
  for (let d = sinceDay; d <= Math.floor(now / DAY); d++) dayKeys.push(d);
  const tiles = {
    working_s: r0(groupS.working),
    you: { seconds: r0(groupS.you), reply_s: r0(youLeaves['human.reply'] ?? 0), prompt_s: r0(youLeaves['human.prompt'] ?? 0), permission_s: r0(youLeaves['human.permission'] ?? 0) },
    friction: { seconds: r0(groupS.friction), parts: roundAll(groupLeaves.friction) },
    cost: { cost_usd: r6(usd), modes: totalModes },
    cost_per_working_hour: workingH > 0 ? { cost_usd: r6(usd / workingH), modes: per(modesOf(ctx, totalAcct), workingH) } : null,
    working_by_day: dayKeys.map((d) => ({ day: new Date(d * DAY).toISOString().slice(0, 10), working_s: r0(workingByDay.get(d) ?? 0) })),
  };

  // Working time by category: friction left out, so the categories sum to the working tile.
  const tops = new Map<string, { seconds: number; leaves: Record<string, number> }>();
  for (const [k, v] of Object.entries(catS)) {
    const t = k.split('.')[0];
    if (!tops.has(t)) tops.set(t, { seconds: 0, leaves: {} });
    tops.get(t)!.seconds += v;
    add(tops.get(t)!.leaves, k, v);
  }
  // Its cost is the only estimate: the items' est cost per category, scaled so the categories sum to
  // the scope's usage cost, every mode in the same proportion.
  const catTotal = Object.values(catUsd).reduce((n, v) => n + v, 0);
  const catShare = (k: string) => (catTotal > 0 ? (catUsd[k] ?? 0) / catTotal : 0);
  const working_by_category = [...tops]
    .map(([k, x]) => ({ key: k, label: CATEGORY_LABELS[k] ?? k, seconds: r0(x.seconds), cost_usd: r6(usd * catShare(k)), modes: scaleModes(totalModes, catShare(k)), estimated: true, leaves: roundAll(x.leaves) }))
    .sort((a, b) => b.seconds - a.seconds || a.key.localeCompare(b.key));

  // Bottlenecks: the leaves that can be fixed, with who they hit.
  const name = (id: string) => agents.get(id)?.name ?? id;
  const slow = new Set(SLOW_WORK_KINDS);
  const bottleneckLeaves = new Map<string, ClockGroup>();
  for (const k of Object.keys(leavesW)) {
    const g = clockGroup(k, false);
    if (g === 'friction' || slow.has(k)) bottleneckLeaves.set(k, g);
  }
  for (const k of Object.keys(leavesG)) {
    const g = clockGroup(k, true);
    if (g === 'friction' || g === 'you' || g === 'idle' || slow.has(k)) bottleneckLeaves.set(k, g);
  }
  const bottlenecks = [...bottleneckLeaves]
    .map(([k, group]) => {
      const hit = [...perAgent].filter(([, a]) => (a.leaves[k] ?? 0) > 0).sort((a, b) => (b[1].leaves[k] ?? 0) - (a[1].leaves[k] ?? 0) || a[0].localeCompare(b[0]));
      const l = longest.get(k);
      return {
        key: k,
        label: activityLabel(k),
        group,
        seconds: r0((leavesW[k] ?? 0) + (leavesG[k] ?? 0)),
        agents: hit.length,
        top: hit.slice(0, 3).map(([id, a]) => ({ id, name: name(id), seconds: r0(a.leaves[k]) })),
        longest: l ? { seconds: r0(l.seconds), agent: l.agent, name: name(l.agent), start: new Date(l.start).toISOString() } : null,
      };
    })
    .filter((b) => b.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds || a.key.localeCompare(b.key));
  await sl.step('bottlenecks');

  const configs = await configsOf(itsaIds, members, digests, peerNames, usage, sinceHour, nowHour, since, ctx, agents, children, sl);
  await sl.step('configs');
  const trees = treesOf(scope, members, perAgent, subtree, parents, children, agents, ctx);
  sl.end('trees');

  // Cost by agent type and by harness · model (S-1491): the kept members' usage cost in every mode, with their
  // agent count and working time. A time figure rides along, never as a cost.
  const costBy = (keyOf: (id: string) => string) => {
    const g = new Map<string, { count: number; working_s: number; usd: number; acct: Map<string, number> }>();
    for (const id of members) {
      const acc = perAgent.get(id);
      if (!acc) continue;
      const k = keyOf(id);
      const x = g.get(k) ?? g.set(k, { count: 0, working_s: 0, usd: 0, acct: new Map() }).get(k)!;
      x.count++;
      x.working_s += acc.groups.working;
      x.usd += acc.usd;
      for (const [a, v] of acc.acct) addAcct(x.acct, a, v);
    }
    return [...g]
      .map(([key, x]) => ({ key, count: x.count, working_s: r0(x.working_s), cost_usd: r6(x.usd), modes: modesOf(ctx, x.acct) }))
      .filter((x) => x.cost_usd > 0 || x.working_s > 0)
      .sort((a, b) => b.cost_usd - a.cost_usd || a.key.localeCompare(b.key));
  };
  const by_type = costBy(typeOfId).map(({ key, ...x }) => ({ type: key, ...x }));
  const by_model = costBy((id) => {
    const a = agents.get(id);
    return a ? `${a.harness} · ${a.model || 'unknown'}` : 'unknown';
  }).map(({ key, ...x }) => ({ model: key, ...x }));

  return {
    note: SUMMARY_NOTE,
    by: 'summary',
    days,
    since: new Date(since).toISOString(),
    until: new Date(now).toISOString(),
    scope: scopeDescriptor(scope, agents),
    machines: { included, missing },
    filter: { agents: filterKey(keep) || 'all', types },
    agents: [...perAgent.values()].filter((a) => a.usd > 0 || Object.values(a.groups).some((v) => v > 0)).length,
    clock,
    tiles,
    working_by_category,
    bottlenecks,
    configs,
    trees,
    by_type,
    by_model,
    labels: activityLabels(),
  };
}

// `me`, its ancestors and everything below each of them (usage-scope's visibleAgents on the merged graph).
function visibleFrom(me: string, parents: Map<string, string[]>, children: Map<string, string[]>): Set<string> {
  const out = new Set<string>([me]);
  const walk = (start: string[], edges: Map<string, string[]>) => {
    const stack = [...start];
    while (stack.length) {
      const id = stack.pop()!;
      for (const n of edges.get(id) ?? []) if (!out.has(n)) {
        out.add(n);
        stack.push(n);
      }
    }
  };
  walk([me], parents);
  walk([...out], children);
  return out;
}

// Whether an agent belongs to an ITSA (mail-visibility's isMember without the bosses): its owner, creator or a
// participant, or the owner of an ancestor ITSA.
function itsaMember(me: string, key: string): boolean {
  const it = state.itsa;
  const id = it?.byKey.get(key);
  const x = id ? it!.attr.items.get(id) : undefined;
  if (!it || !x) return false;
  const ownerOf = (y: typeof x) => y.owners[y.owners.length - 1]?.owner ?? null;
  if (ownerOf(x) === me || it.createdBy.get(x.id) === me || x.participants.has(me)) return true;
  for (let p = x.parent_id ? it.attr.items.get(x.parent_id) : undefined, n = 0; p && n < 50; p = p.parent_id ? it.attr.items.get(p.parent_id) : undefined, n++) if (ownerOf(p) === me) return true;
  return false;
}

function scopeDescriptor(scope: Scope, agents: Map<string, AgentLite>) {
  if (scope.kind === 'all') return { kind: 'all' };
  if (scope.kind === 'itsa') return { kind: 'itsa', id: scope.id, key: scope.key };
  return { kind: scope.kind, id: scope.id, name: agents.get(scope.id)?.name ?? scope.id };
}

// Closed work issues in the scope, grouped by worker config, by agent type, and by both, as S-1007's
// by=model and by=type: each ITSA's time and cost here are the scope agents' attributed to it.
async function configsOf(
  itsaIds: Set<string> | null,
  members: string[],
  digests: Map<string, Digest>,
  peerNames: Map<string, Set<string>>,
  usage: Usage,
  sinceHour: number,
  nowHour: number,
  since: number,
  ctx: Ctx,
  agents: Map<string, AgentLite>,
  children: Map<string, string[]>,
  sl: Slicer,
) {
  const it = state.itsa!;
  const sinceIso = new Date(since).toISOString();
  type Per = { work: number; wait: number; usd: number; acct: Map<string, number>; byAgent: Map<string, { work: number; usd: number }> };
  const perItsa = new Map<string, Per>();
  for (const id of members) {
    const dg = digests.get(id);
    if (!dg) continue;
    const all = daysOf([dg], sinceHour, nowHour);
    for (const [itsaId, part] of dg.itsa) {
      if (itsaIds && !itsaIds.has(itsaId)) continue;
      const x = it.attr.items.get(itsaId);
      if (!x || x.kind !== 'issue' || x.category !== 'closed' || !x.closed_at || x.closed_at < sinceIso) continue;
      let p = perItsa.get(itsaId);
      if (!p) perItsa.set(itsaId, (p = { work: 0, wait: 0, usd: 0, acct: new Map(), byAgent: new Map() }));
      let a = p.byAgent.get(id);
      if (!a) p.byAgent.set(id, (a = { work: 0, usd: 0 }));
      for (const [h, b] of part.hours) {
        if (h < sinceHour || h > nowHour) continue;
        for (const v of Object.values(b.w)) {
          p.work += v;
          a.work += v;
        }
        for (const v of Object.values(b.g)) p.wait += v;
      }
      const cost = usageFor(usage, id, all, daysOf([part], sinceHour, nowHour));
      for (const [acct, v] of cost) {
        p.usd += v;
        a.usd += v;
        addAcct(p.acct, acct, v);
      }
    }
    await sl.step(`configs ${id}`);
  }
  // The reviewer agents' names from every machine, and the home's participants and branch links.
  const names = new Map([...reviewerNames(db.open())].map(([k, v]) => [k, new Set(v)]));
  for (const [name, ids] of peerNames) for (const id of ids) (names.get(name) ?? names.set(name, new Set()).get(name)!).add(id);
  const reviewers = reviewersByItsa(db.open(), agents, new Map([...perItsa.keys()].map((id) => [id, it.attr.items.get(id)!])), { participants: it.participants, links: it.links, names });
  await sl.step('reviewers');
  const configOf = (id: string) => {
    const a = agents.get(id);
    return a ? `${a.harness} · ${a.model || 'unknown'}` : 'unknown';
  };
  const rows: { config: string; type: string; working_s: number; waiting_s: number; cost_usd: number; modes: Modes; lead_s: number; review_rounds: number }[] = [];
  for (const [id, p] of perItsa) {
    // No per-ITSA filter for an agent viewer: the members are already the agents its scope lets it read, the rows carry no
    // ITSA key, and an ITSA scope was checked up front (S-1197).
    if (p.work <= 0) continue;
    {
      const x = it.attr.items.get(id)!;
      const list = [...p.byAgent];
      // The config is the costliest worker's (agents with children are managers); the type is the
      // most-working agent that is not a reviewer type.
      const workers = list.filter(([a]) => !children.has(a));
      const byUsd = (workers.length ? workers : list).sort((a, b) => b[1].usd - a[1].usd || a[0].localeCompare(b[0]));
      const topWorker = list.filter(([a]) => !isReviewerType(agents.get(a)?.type ?? '')).sort((a, b) => b[1].work - a[1].work || a[0].localeCompare(b[0]))[0];
      rows.push({
        config: byUsd.length ? configOf(byUsd[0][0]) : 'unknown',
        type: (topWorker && agents.get(topWorker[0])?.type) || 'unknown',
        working_s: Math.round(p.work),
        waiting_s: Math.round(p.wait),
        cost_usd: r6(p.usd),
        modes: modesOf(ctx, p.acct),
        lead_s: Math.round((Date.parse(x.closed_at!) - x.created) / 1000),
        review_rounds: (it.moves.get(id) ?? 0) + (reviewers.get(id)?.size ?? 0),
      });
    }
    await sl.step('config rows');
  }
  const group = (keyOf: (r: (typeof rows)[number]) => Record<string, string>) => {
    const g = new Map<string, { key: Record<string, string>; list: typeof rows }>();
    for (const r of rows) {
      const key = keyOf(r);
      const k = JSON.stringify(key);
      if (!g.has(k)) g.set(k, { key, list: [] });
      g.get(k)!.list.push(r);
    }
    return [...g.values()]
      .map(({ key, list }) => ({
        key,
        ...key,
        n: list.length,
        working_s: spread(list.map((r) => r.working_s)),
        waiting_s: spread(list.map((r) => r.waiting_s)),
        cost_usd: spread(list.map((r) => r.cost_usd)),
        cost_modes: modesSpread(list.map((r) => r.modes)),
        lead_s: spread(list.map((r) => r.lead_s)),
        review_rounds: spread(list.map((r) => r.review_rounds)),
      }))
      .sort((a, b) => b.n - a.n || JSON.stringify(a.key).localeCompare(JSON.stringify(b.key)))
      .map(({ key: _key, ...r }) => r);
  };
  return {
    n: rows.length,
    by_model: group((r) => ({ model: r.config })),
    by_type: group((r) => ({ type: r.type })),
    by_model_type: group((r) => ({ model: r.config, type: r.type })),
  };
}

// Root agents with their subtrees' totals over the scope, and each root's direct children the same
// way. A scope on a tree or an agent is its own root; otherwise the roots are the top agents (no
// parent) of the counted agents.
function treesOf(
  scope: Scope,
  members: string[],
  perAgent: Map<string, AgentAcc>,
  subtree: (root: string) => Set<string>,
  parents: Map<string, string[]>,
  children: Map<string, string[]>,
  agents: Map<string, AgentLite>,
  ctx: Ctx,
) {
  const row = (id: string) => {
    const g = groupsZero();
    const acct = new Map<string, number>();
    let usd = 0;
    let n = 0;
    for (const m of subtree(id)) {
      const a = perAgent.get(m);
      if (!a) continue;
      for (const k of Object.keys(g) as ClockGroup[]) g[k] += a.groups[k];
      usd += a.usd;
      for (const [k, v] of a.acct) addAcct(acct, k, v);
      if (a.usd > 0 || Object.values(a.groups).some((v) => v > 0)) n++;
    }
    const a = agents.get(id);
    return {
      id,
      name: a?.name ?? id,
      type: a?.type ?? null,
      harness: a?.harness ?? null,
      model: a?.model ?? null,
      agents: n,
      working_s: r0(g.working),
      friction_s: r0(g.friction),
      others_s: r0(g.others),
      you_s: r0(g.you),
      idle_s: r0(g.idle),
      cost_usd: r6(usd),
      modes: modesOf(ctx, acct),
    };
  };
  let roots: string[];
  if (scope.kind === 'tree' || scope.kind === 'agent') roots = [scope.id];
  else {
    const top = new Set<string>();
    for (const id of members) {
      // The top ancestors of each counted agent, through any parent edge.
      const stack = [id];
      const seen = new Set<string>();
      while (stack.length) {
        const x = stack.pop()!;
        if (seen.has(x)) continue;
        seen.add(x);
        const up = parents.get(x) ?? [];
        if (!up.length) top.add(x);
        stack.push(...up);
      }
    }
    roots = [...top];
  }
  const order = (a: { cost_usd: number; working_s: number; name: string }, b: { cost_usd: number; working_s: number; name: string }) =>
    b.cost_usd - a.cost_usd || b.working_s - a.working_s || a.name.localeCompare(b.name);
  return roots
    .map((id) => ({
      ...row(id),
      children: (scope.kind === 'agent' ? [] : (children.get(id) ?? [])).map(row).filter((c) => c.agents > 0).sort(order),
    }))
    .filter((r) => r.agents > 0)
    .sort(order);
}
