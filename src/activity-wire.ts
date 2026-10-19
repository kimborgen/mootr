// What daemons exchange for the activity summary (S-1079). Each daemon folds its own agents' items
// into digests (src/activity-summary.ts: hour buckets, attributed to ITSAs); a peer sends those
// digests instead of items, so a summary on any machine covers every machine's agents and the
// transcripts stay where they are.
//
//   GET /api/activity?by=digests&days=N&since=SEQ&epoch=E&after=ID   (a peer's call only)
//
// answers a page of `agents`' digests, in id order after `after`, with a `next` cursor. The first page
// (no `after`) also carries `ids` (every agent with a digest, so the reader drops the gone ones),
// `agents` (name, type, model and parents of every agent in the window, with or without a digest),
// `usage` (the usage table's cost per agent, day and account over the window) and `seq`, the
// counter the reader sends back as `since` to get only digests that changed after it. The reader
// starts over (full) when `epoch` is not the peer's, i.e. after a restart.
//
// Numbers are rounded (seconds to 1 ms, dollars to 1e-7) and the leaf names are indexes into the page's
// `keys`. A digest is hour buckets [hour, w, g, c, usd] with w and g flat [leaf, seconds, ...] and c flat
// [category leaf, seconds, est cost, ...], and spans [day, leaf, start, duration]. An agent attributed to
// ITSAs sends only its per-ITSA parts: its own is their sum (the shares of an item add up to 1), and its
// spans the longest of theirs.
import type { Bucket, Digest, Part } from './activity-summary.ts';

export const WIRE_VERSION = 2;

export type WireBucket = [number, number[], number[], number[], number];
export interface WirePart {
  h: WireBucket[];
  sp: [number, number, number, number][];
}
export interface WireDigest {
  id: string;
  v: number;
  // The agent's own hours and spans: only when it has no ITSA parts.
  own?: WirePart;
  it: Record<string, WirePart>;
}
export interface WireAgent {
  id: string;
  name: string;
  type: string | null;
  // 'assistant' for the human's assistant (S-1444: the agent class filter); absent from older peers.
  kind?: string | null;
  harness: string;
  model: string | null;
  parents: string[];
}
// agent -> day index -> account -> USD
export type WireUsage = Record<string, Record<string, Record<string, number>>>;

export interface WirePage {
  wire: number;
  machine: string;
  epoch: string;
  seq: number;
  keys: string[];
  agents?: WireAgent[];
  ids?: string[];
  usage?: WireUsage;
  // Reviewer agents by the ITSA keys and branches their first prompts name (first page only).
  reviewers?: Record<string, string[]>;
  digests: WireDigest[];
  // The id to pass as `after` for the next page; absent on the last.
  next?: string;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

const rs = (n: number) => Math.round(n * 1000) / 1000;
const ru = (n: number) => Math.round(n * 1e7) / 1e7;

// The leaf names of one page.
export class Keys {
  readonly list: string[] = [];
  private idx = new Map<string, number>();
  of(k: string): number {
    let i = this.idx.get(k);
    if (i === undefined) {
      i = this.list.length;
      this.list.push(k);
      this.idx.set(k, i);
    }
    return i;
  }
}

function partToWire(p: Part, keys: Keys, sinceHour: number, sinceDay: number): WirePart {
  const h: WireBucket[] = [];
  for (const [hour, b] of p.hours) {
    if (hour < sinceHour) continue;
    const w: number[] = [];
    for (const k in b.w) w.push(keys.of(k), rs(b.w[k]));
    const g: number[] = [];
    for (const k in b.g) g.push(keys.of(k), rs(b.g[k]));
    const c: number[] = [];
    for (const k in b.c) c.push(keys.of(k), rs(b.c[k]), ru(b.cu[k] ?? 0));
    h.push([hour, w, g, c, ru(b.usd)]);
  }
  const sp: WirePart['sp'] = [];
  for (const [k, [s, e]] of p.spans) {
    const bar = k.indexOf('|');
    const day = Number(k.slice(0, bar));
    if (day >= sinceDay) sp.push([day, keys.of(k.slice(bar + 1)), s, e - s]);
  }
  return { h, sp };
}

// A digest's last `days` days (the window starts an hour early, and a day for spans, as merge reads them).
export function digestToWire(id: string, v: number, dg: Digest, keys: Keys, now: number, days: number): WireDigest {
  const sinceHour = Math.floor((now - days * DAY) / HOUR) - 1;
  const sinceDay = Math.floor((sinceHour * HOUR) / DAY) - 1;
  const it: Record<string, WirePart> = {};
  for (const [itsaId, part] of dg.itsa) {
    const w = partToWire(part, keys, sinceHour, sinceDay);
    if (w.h.length || w.sp.length) it[itsaId] = w;
  }
  // An agent with any ITSA part has all its time in them; one without has only its own.
  return dg.itsa.size ? { id, v, it } : { id, v, own: partToWire(dg, keys, sinceHour, sinceDay), it };
}

function partFromWire(w: WirePart, keys: string[]): Part {
  const hours = new Map<number, Bucket>();
  for (const [h, bw, bg, bc, usd] of w.h) {
    const b: Bucket = { w: {}, g: {}, c: {}, cu: {}, usd };
    for (let i = 0; i < bw.length; i += 2) b.w[keys[bw[i]]] = bw[i + 1];
    for (let i = 0; i < bg.length; i += 2) b.g[keys[bg[i]]] = bg[i + 1];
    for (let i = 0; i < bc.length; i += 3) {
      b.c[keys[bc[i]]] = bc[i + 1];
      b.cu[keys[bc[i]]] = bc[i + 2];
    }
    hours.set(h, b);
  }
  return { hours, spans: new Map(w.sp.map(([d, k, s, dur]) => [`${d}|${keys[k]}`, [s, s + dur] as [number, number]])) };
}

// A peer's digest as the summary reads it. It is never refolded here, so `sig` and `maxDur` are unused.
export function digestFromWire(w: WireDigest, keys: string[]): Digest {
  const itsa = new Map(Object.entries(w.it).map(([id, p]) => [id, partFromWire(p, keys)]));
  const own: Part = w.own ? partFromWire(w.own, keys) : sumParts([...itsa.values()]);
  return { ...own, itsa, sig: '', maxDur: 0 };
}

// The parts added: hours summed, each span the longest.
function sumParts(parts: Part[]): Part {
  const hours = new Map<number, Bucket>();
  const spans = new Map<string, [number, number]>();
  for (const p of parts) {
    for (const [h, b] of p.hours) {
      let t = hours.get(h);
      if (!t) hours.set(h, (t = { w: {}, g: {}, c: {}, cu: {}, usd: 0 }));
      for (const k in b.w) t.w[k] = (t.w[k] ?? 0) + b.w[k];
      for (const k in b.g) t.g[k] = (t.g[k] ?? 0) + b.g[k];
      for (const k in b.c) t.c[k] = (t.c[k] ?? 0) + b.c[k];
      for (const k in b.cu) t.cu[k] = (t.cu[k] ?? 0) + b.cu[k];
      t.usd += b.usd;
    }
    for (const [k, [s, e]] of p.spans) {
      const cur = spans.get(k);
      if (!cur || e - s > cur[1] - cur[0]) spans.set(k, [s, e]);
    }
  }
  return { hours, spans };
}

export function usageToWire(rows: { agent_id: string; day: string; account: string; c: number }[]): WireUsage {
  const out: WireUsage = {};
  for (const r of rows) {
    const day = String(Math.floor(Date.parse(`${r.day}T00:00:00.000Z`) / DAY));
    (((out[r.agent_id] ??= {})[day] ??= {})[r.account] = ru(Number(r.c) || 0));
  }
  return out;
}
