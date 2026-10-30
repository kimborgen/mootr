// Issue costs (S-155, part 2): what each ITSA cost, from the usage samples and the ITSA events.
// An agent's spend in a 5-minute bucket counts toward the ITSAs it worked on at that time:
//
//   owner        the agent owns the ITSA at that time (owner changes are itsa_events 'owner')
//   participant  the agent is a participant (current participants; the table keeps no history)
//   existed      the agent's created_at is at or before the bucket
//   active       the ITSA's status then is in the active categories (review or active; not
//                backlog, ready, or closed), rebuilt from its 'created' and 'status' events
//   split        a sample is split evenly over the owned active ITSAs; when the agent owns none
//                active, over the active ITSAs it participates in; when neither, evenly over all
//                the agent's ITSAs; an agent with none goes to `unattributed`
//   own          what landed on an ITSA directly; total adds every descendant's own, each once.
//                manager_cost_usd is the part of own from agents with child agents
//   config       the largest config among worker agents (no child agents) with a share of own
//                cost; when there is none, the largest config overall
//
// Every $ is API-equivalent for Claude and Codex (see COST_NOTE). weekly_percent is an ITSA's
// own spend on subscription accounts as a share of that account's 7-day worth (the worth
// estimate in attribution.ts, mid); null when uncalibrated or without subscription spend.
// Computed on request in one pass over the samples and events.
import * as db from './db.ts';
import { due, runSync } from './slice.ts';
import * as itsa from './itsa.ts';
import * as tree from './tree.ts';
import { settings } from './settings.ts';
import { accountShares, windowStart } from './attribution.ts';
import { accountKind, convert, costDisplay, roundModes, type Ctx, type Modes } from './cost-display.ts';

export const COST_NOTE =
  'Claude and Codex $ are API-equivalent (the tokens at API prices), not what a subscription bills. weekly_percent is an ITSA\'s own spend on subscription accounts as a share of that account\'s 7-day worth estimate (mid); null when that is not calibrated or there is no subscription spend.';

type Win = 'five_hour' | 'seven_day';
const WINS: Win[] = ['five_hour', 'seven_day'];
type Tokens = 'tokens_in' | 'tokens_out' | 'tokens_cache_read' | 'tokens_cache_write';
const TOKENS: Tokens[] = ['tokens_in', 'tokens_out', 'tokens_cache_read', 'tokens_cache_write'];
export interface Tot {
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
}
const zero = (): Tot => ({ cost_usd: 0, tokens_in: 0, tokens_out: 0, tokens_cache_read: 0, tokens_cache_write: 0 });
function add(t: Tot, s: Tot, share = 1): void {
  t.cost_usd += s.cost_usd * share;
  for (const k of TOKENS) t[k] += s[k] * share;
}
const round = (n: number) => Math.round(n * 1e6) / 1e6;
const round2 = (n: number) => Math.round(n * 100) / 100;
function outTot(t: Tot): Tot {
  const o = zero();
  o.cost_usd = round(t.cost_usd);
  for (const k of TOKENS) o[k] = Math.round(t[k]);
  return o;
}

interface Sample extends Tot {
  agent_id: string;
  account: string;
  harness: string;
  model: string;
  bucket: string;
}

// What the attribution learns about one ITSA: its owner and status timelines, its participants,
// and what it was charged.
export interface Item {
  id: string;
  key: string;
  title: string;
  kind: string | null;
  status: string;
  category: string | null;
  closed_at: string | null;
  parent_id: string | null;
  created: number;
  participants: Set<string>;
  owners: { at: number; owner: string | null }[];
  statuses: { at: number; to: string }[];
  initialStatus: string | null;
  own: Tot;
  // Per agent (with any spend), its share of own cost; per config (all agents and workers only),
  // and per account, own cost.
  agents: Map<string, number>;
  configs: Map<string, number>;
  workerConfigs: Map<string, number>;
  manager: number;
  accounts: Map<string, number>;
  total: Tot;
  // Cost per account over own and every descendant's own, for the per-mode total.
  totalAccounts: Map<string, number>;
  // Subscription spend inside each account's current window, per account, for own and total.
  inWindow: Record<Win, Map<string, number>>;
  totalInWindow: Record<Win, Map<string, number>>;
  weekly_percent: number | null;
  config: string | null;
}

export interface Computed {
  items: Map<string, Item>;
  unattributed: Tot;
  all: Tot;
  since: string | null;
}

interface Options {
  days?: number;
  now?: number;
  // The 7-day worth mid per subscription account, in USD. Defaults to attribution's estimate.
  worthMid?: (account: string) => number | null;
  // How accounts are billed and what a window is worth, for the per-mode `cost` (cost-display.ts).
  // Defaults to the attribution estimate; the daemon passes the cached snapshot's.
  display?: Ctx;
}

// Samples read per page: about 6 ms of attribution each, so a slice ends soon after the budget.
const SAMPLE_PAGE = 500;
const ACTIVE_CATEGORIES = new Set(['active', 'review']);

function isSubscription(account: string): boolean {
  const a = settings().cost.accounts?.[account];
  return !!a && a.paid !== true;
}

function defaultWorthMid(now: number): (account: string) => number | null {
  const memo = new Map<string, number | null>();
  return (account) => {
    if (!memo.has(account)) {
      const w = (accountShares(account, ['seven_day'], now).seven_day as { worth?: { worth_usd?: { mid?: number } | null } } | undefined)?.worth;
      memo.set(account, w?.worth_usd?.mid ?? null);
    }
    return memo.get(account) ?? null;
  };
}

// The time attribution (S-212 shares it with activity-stats): which ITSAs an agent was on at a
// moment, and each one's even-split share. Build it once per request: it reads the events once.
export function attributor(): Attribution['attribute'] {
  return buildAttribution().attribute;
}

// An agent's ITSAs at a moment with their even shares; shared between calls, so read-only.
type Split = readonly Readonly<{ itsaId: string; share: number }>[];

export interface Attribution {
  items: Map<string, Item>;
  managers: Set<string>;
  attribute(agent: string, t: number): Split;
}

// The ITSA rows the attribution reads (S-1079): the ITSA home exports them so a daemon without ITSAs of its
// own builds the same attribution for its agents. Events are the created, status and owner ones only.
export interface AttributionData {
  itsas: { id: string; key: string; title: string; kind: string | null; status: string; parent_id: string | null; owner: string | null; created_by: string | null; created_at: string; updated_at: string; closed_at: string | null }[];
  events: { id: number; itsa_id: string; ts: string; type: string; data: string | null }[];
  participants: { itsa_id: string; agent_id: string }[];
  // The branch links, which the activity summary's review rounds read.
  links: { itsa_id: string; external_id: string }[];
}

export function readAttributionData(withEvents = true): AttributionData {
  const d = db.open();
  return {
    itsas: d.prepare('SELECT id, key, title, kind, status, parent_id, owner, created_by, created_at, updated_at, closed_at FROM itsas').all() as AttributionData['itsas'],
    events: !withEvents ? [] : d.prepare("SELECT id, itsa_id, ts, type, data FROM itsa_events WHERE type IN ('created', 'status', 'owner') ORDER BY id").all() as AttributionData['events'],
    participants: d.prepare('SELECT itsa_id, agent_id FROM itsa_participants').all() as AttributionData['participants'],
    links: d.prepare("SELECT itsa_id, external_id FROM itsa_links WHERE system = 'branch' AND external_id IS NOT NULL").all() as AttributionData['links'],
  };
}

// The whole attribution, with the ITSAs' timelines: the activity summary (S-1009) keeps one per
// change to the ITSAs and tells from the timelines which agents' attribution moved.
export function buildAttribution(data: AttributionData = readAttributionData()): Attribution {
  const d = db.open();
  const categoryOf = new Map(itsa.statuses().map((s) => [s.name, s.category as string]));

  const items = new Map<string, Item>();
  for (const r of data.itsas) {
    items.set(r.id, {
      id: r.id,
      key: r.key,
      title: r.title,
      kind: r.kind,
      status: r.status,
      category: categoryOf.get(r.status) ?? null,
      closed_at: r.closed_at,
      parent_id: r.parent_id,
      created: Date.parse(r.created_at),
      participants: new Set(),
      owners: r.owner ? [{ at: -Infinity, owner: r.owner }] : [{ at: -Infinity, owner: null }],
      statuses: [],
      initialStatus: null,
      own: zero(),
      agents: new Map(),
      configs: new Map(),
      workerConfigs: new Map(),
      manager: 0,
      accounts: new Map(),
      total: zero(),
      totalAccounts: new Map(),
      inWindow: { five_hour: new Map(), seven_day: new Map() },
      totalInWindow: { five_hour: new Map(), seven_day: new Map() },
      weekly_percent: null,
      config: null,
    });
  }

  // Events, oldest first. The owner before the first change is that change's `from`; the
  // status before the first change is the one the ITSA was created in.
  const firstOwner = new Map<string, string | null>();
  for (const e of data.events) {
    const x = items.get(e.itsa_id);
    if (!x) continue;
    const ev = e.data ? (JSON.parse(e.data) as { status?: string; from?: string | null; to?: string | null }) : {};
    if (e.type === 'created') x.initialStatus = ev.status ?? x.initialStatus;
    else if (e.type === 'status') {
      if (x.initialStatus == null) x.initialStatus = (ev.from as string | undefined) ?? null;
      x.statuses.push({ at: Date.parse(e.ts), to: String(ev.to) });
    } else if (e.type === 'owner') {
      if (!firstOwner.has(e.itsa_id)) firstOwner.set(e.itsa_id, ev.from ?? null);
      x.owners.push({ at: Date.parse(e.ts), owner: ev.to ?? null });
    }
  }
  for (const [id, owner] of firstOwner) items.get(id)!.owners[0] = { at: -Infinity, owner };

  const agentIdx = new Map<string, Set<string>>();
  const link = (agent: string, id: string) => {
    if (!agentIdx.has(agent)) agentIdx.set(agent, new Set());
    agentIdx.get(agent)!.add(id);
  };
  for (const p of data.participants) {
    const x = items.get(p.itsa_id);
    if (!x) continue;
    x.participants.add(p.agent_id);
    link(p.agent_id, x.id);
  }
  for (const x of items.values()) for (const o of x.owners) if (o.owner) link(o.owner, x.id);

  // Managers have child agents; their spend is not a worker's, so it never sets a config.
  const managers = new Set(
    tree.edges().map(([, parent]) => parent),
  );

  const agentCreated = new Map<string, number>();
  for (const a of d.prepare('SELECT id, created_at FROM agents').all() as { id: string; created_at: string }[]) agentCreated.set(a.id, Date.parse(a.created_at));

  // The last value at or before t, from a timeline sorted by time; null before its first entry.
  const at = <T extends { at: number }>(list: T[], t: number): T | null => {
    let cur: T | null = null;
    for (const e of list) {
      if (e.at > t) break;
      cur = e;
    }
    return cur;
  };
  const statusAt = (x: Item, t: number): string | null => {
    if (t < x.created) return null;
    const e = at(x.statuses, t);
    return e ? e.to : x.initialStatus;
  };
  const ownerAt = (x: Item, t: number): string | null => at(x.owners, t)?.owner ?? null;
  const categoryName = (status: string | null) => (status == null ? null : (categoryOf.get(status) ?? null));

  // The agent's flags for x: bit 1 owns it and bit 2 takes part in it, each only while x is active.
  const OWNED = 1;
  const PART = 2;
  const flagsOf = (agent: string, x: Item, status: string | null, owner: string | null, existed: boolean): number => {
    if (!existed || !ACTIVE_CATEGORIES.has(categoryName(status) ?? '')) return 0;
    return (owner === agent ? OWNED : 0) | (x.participants.has(agent) ? PART : 0);
  };
  const existedAt = (agent: string, t: number) => {
    const created = agentCreated.get(agent);
    return created == null || created <= t;
  };
  const evenly = (split: Item[]): Split => {
    const share = 1 / split.length;
    return Object.freeze(split.map((item) => Object.freeze({ itsaId: item.id, share })));
  };
  // Owner first; participation only when the agent owns no active ITSA then; else every candidate.
  // owned and part hold candidate positions, so the split keeps the candidates' order.
  const splitOf = (candidates: Item[], owned: Set<number>, part: Set<number>, all: () => Split): Split => {
    const pick = owned.size ? owned : part;
    return pick.size ? evenly([...pick].sort((a, b) => a - b).map((i) => candidates[i])) : all();
  };
  // The split read at the moment itself, for a moment no timeline orders (an unparsable time).
  const scan = (agent: string, candidates: Item[], t: number): Split => {
    const owned = new Set<number>();
    const part = new Set<number>();
    candidates.forEach((x, i) => {
      const f = flagsOf(agent, x, statusAt(x, t), ownerAt(x, t), existedAt(agent, t));
      if (f & OWNED) owned.add(i);
      if (f & PART) part.add(i);
    });
    return splitOf(candidates, owned, part, () => evenly(candidates));
  };

  // Each agent's flag changes, indexed on its first call (S-4356). A call used to pass over every ITSA
  // the agent was ever on, per item: 3,000 ITSAs held one activity slice 5 s. The agent's flags change
  // only at its candidates' created, status and owner times and its own creation, so the index keeps
  // each such time's changes (candidate, flags before, flags after), linear in the events. A cursor
  // per agent holds the owned and taking-part sets at one time and steps to the time asked; calls come
  // mostly in time order, so a step is a few changes. Only the cursor's split is materialized.
  interface Index {
    candidates: Item[];
    cuts: number[];
    // Cut c's changes are at from[c] .. from[c + 1] - 1 of who, was and now.
    from: number[];
    who: number[];
    was: number[];
    now: number[];
    // The cursor: the last cut at or before its time (-1 before every cut), its sets and its split.
    at: number;
    owned: Set<number>;
    part: Set<number>;
    split: Split | null;
    all: Split | null;
  }
  const indexes = new Map<string, Index>();
  const indexOf = (agent: string, ids: Set<string>): Index => {
    const candidates = [...ids].map((id) => items.get(id)!);
    const created = agentCreated.get(agent);
    const owned = new Set<number>();
    const part = new Set<number>();
    // Each candidate's flags from -Infinity on, walking its timelines once in time order: at(list, t)
    // takes the entries before the first one after t, so a pointer per timeline only moves forward.
    const changes: { t: number; i: number; was: number; now: number }[] = [];
    candidates.forEach((x, i) => {
      const times = [x.created, ...x.statuses.map((s) => s.at), ...x.owners.map((o) => o.at), created ?? NaN].filter(Number.isFinite);
      times.sort((a, b) => a - b);
      let s = 0;
      let o = 0;
      const flagsAtT = (t: number) => {
        while (s < x.statuses.length && !(x.statuses[s].at > t)) s++;
        while (o < x.owners.length && !(x.owners[o].at > t)) o++;
        const status = t < x.created ? null : s ? x.statuses[s - 1].to : x.initialStatus;
        return flagsOf(agent, x, status, o ? x.owners[o - 1].owner : null, existedAt(agent, t));
      };
      let f = flagsAtT(-Infinity);
      if (f & OWNED) owned.add(i);
      if (f & PART) part.add(i);
      for (let k = 0; k < times.length; k++) {
        if (k && times[k] === times[k - 1]) continue;
        const g = flagsAtT(times[k]);
        if (g !== f) changes.push({ t: times[k], i, was: f, now: g });
        f = g;
      }
    });
    changes.sort((a, b) => a.t - b.t);
    const index: Index = { candidates, cuts: [], from: [], who: [], was: [], now: [], at: -1, owned, part, split: null, all: null };
    for (const c of changes) {
      if (index.cuts[index.cuts.length - 1] !== c.t) {
        index.cuts.push(c.t);
        index.from.push(index.who.length);
      }
      index.who.push(c.i);
      index.was.push(c.was);
      index.now.push(c.now);
    }
    index.from.push(index.who.length);
    indexes.set(agent, index);
    return index;
  };
  const apply = (index: Index, c: number, flags: number[]) => {
    for (let k = index.from[c]; k < index.from[c + 1]; k++) {
      const i = index.who[k];
      if (flags[k] & OWNED) index.owned.add(i);
      else index.owned.delete(i);
      if (flags[k] & PART) index.part.add(i);
      else index.part.delete(i);
    }
  };

  // An empty list means unattributed: the agent has no ITSA at all.
  const attribute = (agent: string, t: number): Split => {
    const ids = agentIdx.get(agent);
    if (!ids || !ids.size) return [];
    const index = indexes.get(agent) ?? indexOf(agent, ids);
    if (Number.isNaN(t)) return scan(agent, index.candidates, t);
    // The last cut at or before t.
    let lo = 0;
    let hi = index.cuts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (index.cuts[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    const target = lo - 1;
    if (target !== index.at) index.split = null;
    while (index.at < target) apply(index, ++index.at, index.now);
    while (index.at > target) apply(index, index.at--, index.was);
    index.split ??= splitOf(index.candidates, index.owned, index.part, () => (index.all ??= evenly(index.candidates)));
    return index.split;
  };

  return { items, managers, attribute };
}

export const compute = (opts: Options = {}): Computed => runSync(computeSteps(opts));

// compute() as a generator that pauses between pages of samples (S-2094): see src/slice.ts.
export function* computeSteps(opts: Options = {}): Generator<void, Computed> {
  const now = opts.now ?? Date.now();
  const since = opts.days == null ? null : new Date(now - opts.days * 86_400_000).toISOString();
  const d = db.open();
  const { items, managers, attribute } = buildAttribution();

  const unattributed = zero();
  const all = zero();
  const worthMid = opts.worthMid ?? (opts.display ? (account: string) => opts.display!.worth(account, 'seven_day') : defaultWorthMid(now));
  const starts = new Map<string, number>();
  const winStart = (account: string, w: Win) => {
    const k = account + '|' + w;
    if (!starts.has(k)) starts.set(k, windowStart(account, w, now));
    return starts.get(k)!;
  };
  // The samples a page at a time by rowid, so a sliced run never holds the whole table.
  const sampleSql = `SELECT rowid AS rid, agent_id, account, harness, model, bucket, cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write FROM usage_samples WHERE rowid > ?${since ? ' AND bucket >= ?' : ''} ORDER BY rowid LIMIT ${SAMPLE_PAGE}`;
  const samplePage = d.prepare(sampleSql);
  let rid = 0;
  for (;;) {
    const page = samplePage.all(...(since ? [rid, since] : [rid])) as unknown as (Sample & { rid: number })[];
    if (!page.length) break;
    rid = page[page.length - 1].rid;
    for (const s of page) {
      add(all, s);
      const split = attribute(s.agent_id, Date.parse(s.bucket));
      if (!split.length) {
        add(unattributed, s);
        continue;
      }
      const t = Date.parse(s.bucket);
      const inWin = isSubscription(s.account) ? WINS.filter((w) => t >= winStart(s.account, w)) : [];
      const config = `${s.harness} · ${s.model || 'unknown'}`;
      const manager = managers.has(s.agent_id);
      for (const { itsaId, share } of split) {
        const x = items.get(itsaId)!;
        add(x.own, s, share);
        x.agents.set(s.agent_id, (x.agents.get(s.agent_id) ?? 0) + s.cost_usd * share);
        x.configs.set(config, (x.configs.get(config) ?? 0) + s.cost_usd * share);
        if (!manager) x.workerConfigs.set(config, (x.workerConfigs.get(config) ?? 0) + s.cost_usd * share);
        else x.manager += s.cost_usd * share;
        x.accounts.set(s.account, (x.accounts.get(s.account) ?? 0) + s.cost_usd * share);
        for (const w of inWin) x.inWindow[w].set(s.account, (x.inWindow[w].get(s.account) ?? 0) + s.cost_usd * share);
      }
    }
    if (due()) yield;
  }

  // Totals: each ITSA's own plus every descendant's own, each once (the parent links form a tree).
  const children = new Map<string, Item[]>();
  for (const x of items.values()) {
    if (x.parent_id && items.has(x.parent_id)) {
      if (!children.has(x.parent_id)) children.set(x.parent_id, []);
      children.get(x.parent_id)!.push(x);
    }
  }
  // Each ITSA folds its children's totals into its own once, children first, so a deep tree costs one pass.
  const folded = new Set<string>();
  const fold = (x: Item): void => {
    if (folded.has(x.id)) return;
    folded.add(x.id);
    add(x.total, x.own);
    for (const [a, c] of x.accounts) x.totalAccounts.set(a, (x.totalAccounts.get(a) ?? 0) + c);
    for (const w of WINS) for (const [a, c] of x.inWindow[w]) x.totalInWindow[w].set(a, (x.totalInWindow[w].get(a) ?? 0) + c);
    for (const c of children.get(x.id) ?? []) {
      fold(c);
      add(x.total, c.total);
      for (const [a, v] of c.totalAccounts) x.totalAccounts.set(a, (x.totalAccounts.get(a) ?? 0) + v);
      for (const w of WINS) for (const [a, v] of c.totalInWindow[w]) x.totalInWindow[w].set(a, (x.totalInWindow[w].get(a) ?? 0) + v);
    }
  };
  for (const x of items.values()) {
    fold(x);
    x.config = topKey(x.workerConfigs) ?? topKey(x.configs);
    x.weekly_percent = weeklyPercent(x, worthMid);
    if (due()) yield;
  }
  return { items, unattributed, all, since };
}

// The key with the largest value, ties by name; null when there are none.
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

function weeklyPercent(x: Item, worthMid: (account: string) => number | null): number | null {
  let pct = 0;
  let any = false;
  for (const [account, cost] of x.accounts) {
    if (!isSubscription(account)) continue;
    const mid = worthMid(account);
    if (mid == null || mid <= 0) return null;
    pct += (cost / mid) * 100;
    any = true;
  }
  return any ? round2(pct) : null;
}

function stats(values: number[]) {
  const v = [...values].sort((a, b) => a - b);
  const n = v.length;
  const median = n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
  return { n, median: round(median), average: round(v.reduce((s, x) => s + x, 0) / n), min: round(v[0]), max: round(v[n - 1]) };
}
const median = (v: number[]) => (v.length ? stats(v).median : null);
// The same stats with a unit that can be missing: a null is left out, so `n` counts the issues
// that have a value for that measure and an empty set is all nulls, never a $0.
function statsOf(values: (number | null)[]) {
  const v = values.filter((x): x is number => x != null).sort((a, b) => a - b);
  if (!v.length) return { n: 0, median: null, average: null, min: null, max: null };
  return stats(v);
}
// The real money of a modes set: the subscription dollars plus the paid spend, null when the
// subscription part can't be computed (the page's Real $, S-663).
const realUsd = (m: Modes): number | null => (m.subscription == null ? null : m.subscription + m.paid_usd);

// An ITSA's cost in every display unit. The window percents are its subscription spend since the
// window's current period began, over that window's worth (the same meaning as an agent's).
function defaultCtx(now: number): Ctx {
  const memo = new Map<string, number | null>();
  const prices = costDisplay().prices;
  return {
    kind: accountKind,
    price: (account) => prices[account] ?? null,
    worth(account, window) {
      const k = account + '|' + window;
      if (!memo.has(k)) {
        const w = (accountShares(account, [window], now)[window] as { worth?: { worth_usd?: { mid?: number } | null } } | undefined)?.worth;
        memo.set(k, w?.worth_usd?.mid ?? null);
      }
      return memo.get(k) ?? null;
    },
  };
}
function itemCost(x: Item, ctx: Ctx) {
  // Spend inside the current window as a percent of its worth; 0 with none, null when uncalibrated.
  const pct = (m: Record<Win, Map<string, number>>) => {
    const out = { five_hour: 0 as number | null, seven_day: 0 as number | null };
    for (const w of WINS) {
      for (const [account, c] of m[w]) {
        const worth = ctx.worth(account, w);
        out[w] = out[w] == null || worth == null || worth <= 0 ? null : out[w]! + (100 * c) / worth;
      }
    }
    return out;
  };
  return {
    mode: costDisplay().mode,
    own: roundModes(convert(x.accounts, ctx, pct(x.inWindow))),
    total: roundModes(convert(x.totalAccounts, ctx, pct(x.totalInWindow))),
  };
}

// The whole usage-by-issue view for GET /api/usage/issues.
export function issueCosts(opts: Options = {}) {
  const c = compute(opts);
  const ctx = opts.display ?? defaultCtx(opts.now ?? Date.now());
  const issues = [...c.items.values()]
    .map((x) => ({
      key: x.key,
      title: x.title,
      kind: x.kind,
      status: x.status,
      closed_at: x.closed_at,
      own: { ...outTot(x.own), manager_cost_usd: round(x.manager) },
      total: outTot(x.total),
      agents: x.agents.size,
      config: x.config,
      weekly_percent: x.weekly_percent,
      cost: itemCost(x, ctx),
    }))
    .sort((a, b) => b.total.cost_usd - a.total.cost_usd || a.key.localeCompare(b.key));

  const by_config = byConfig(c.items.values(), () => true, ctx);

  return { note: COST_NOTE, since: c.since, issues, by_config, unattributed: outTot(c.unattributed), all: outTot(c.all) };
}

// Closed leaf work items (kind issue) with own spend, per config. With a display context, each
// row also carries the stats in the page's measures (api, week as the 7-day share, real as the
// subscription dollars plus paid), so the Issues tab's Measure control switches them (S-663).
function byConfig(items: Iterable<Item>, keep: (x: Item) => boolean = () => true, ctx?: Ctx) {
  const groups = new Map<string, { costs: number[]; weekly: number[]; modes: Modes[] }>();
  for (const x of items) {
    if (x.kind !== 'issue' || x.category !== 'closed' || x.own.cost_usd <= 0 || !x.config || !keep(x)) continue;
    if (!groups.has(x.config)) groups.set(x.config, { costs: [], weekly: [], modes: [] });
    const g = groups.get(x.config)!;
    g.costs.push(x.own.cost_usd);
    if (x.weekly_percent != null) g.weekly.push(x.weekly_percent);
    if (ctx) g.modes.push(itemCost(x, ctx).own);
  }
  return [...groups]
    .map(([config, g]) => ({
      config,
      ...stats(g.costs),
      median_weekly_percent: median(g.weekly) == null ? null : round2(median(g.weekly)!),
      ...(ctx ? { units: { api: statsOf(g.modes.map((m) => m.api)), week: statsOf(g.modes.map((m) => m.seven_day)), real: statsOf(g.modes.map(realUsd)) } } : {}),
    }))
    .sort((a, b) => b.n - a.n || a.config.localeCompare(b.config));
}

// What a typical finished issue with this config (harness · model of its main worker) used, for
// usage_info tree= (build step 9): the by_config row of issues closed in the last TYPICAL_DAYS,
// each at its whole cost. Samples are kept for db.SAMPLE_RETENTION_MS (35 days), so an issue
// created before that has an incomplete history and is left out. Only the 7-day window: issue costs keep
// no 5-hour share. Memoized for TYPICAL_TTL_MS, since it reads every ITSA event.
const TYPICAL_DAYS = 28;
const TYPICAL_TTL_MS = 10 * 60_000;
export const TYPICAL_NOTE = `Issues closed in the last ${TYPICAL_DAYS} days and created in the last ${db.SAMPLE_RETENTION_MS / 86_400_000} (how long usage samples are kept), each at its whole own cost; matched by the harness and model of the issue's main worker. 7-day window only.`;
let typicalMemo: { at: number; rows: ReturnType<typeof byConfig> } | null = null;

export function resetTypicalMemo(): void {
  typicalMemo = null;
}

export function typicalIssue(config: string, opts: Options = {}) {
  const now = opts.now ?? Date.now();
  if (!typicalMemo || now < typicalMemo.at || now - typicalMemo.at >= TYPICAL_TTL_MS) {
    const scanFrom = now - db.SAMPLE_RETENTION_MS;
    const c = compute({ ...opts, now, days: db.SAMPLE_RETENTION_MS / 86_400_000 });
    const closedFrom = now - TYPICAL_DAYS * 86_400_000;
    const rows = byConfig(c.items.values(), (x) => x.created >= scanFrom && x.closed_at != null && Date.parse(x.closed_at) >= closedFrom);
    typicalMemo = { at: now, rows };
  }
  const row = typicalMemo.rows.find((r) => r.config === config);
  if (!row) return null;
  return { estimate: true, note: TYPICAL_NOTE, config, n: row.n, median_cost_usd: row.median, median_weekly_percent: row.median_weekly_percent };
}

// One ITSA's cost (GET /api/itsas/:ref/cost): own and total, its agents with their share of
// its own cost, its config, and its weekly percent.
export function itsaCost(ref: string, opts: Options = {}) {
  const found = itsa.must(ref);
  const c = compute(opts);
  const x = c.items.get(found.id)!;
  const agents = [...x.agents]
    .map(([id, cost]) => ({ agent: db.getAgent(id)?.name ?? id, id, cost_usd: round(cost), share: x.own.cost_usd > 0 ? round(cost / x.own.cost_usd) : 0 }))
    .sort((a, b) => b.cost_usd - a.cost_usd || a.agent.localeCompare(b.agent));
  return {
    note: COST_NOTE,
    key: x.key,
    title: x.title,
    kind: x.kind,
    status: x.status,
    own: { ...outTot(x.own), manager_cost_usd: round(x.manager) },
    total: outTot(x.total),
    agents,
    config: x.config,
    weekly_percent: x.weekly_percent,
    cost: itemCost(x, opts.display ?? defaultCtx(opts.now ?? Date.now())),
  };
}
