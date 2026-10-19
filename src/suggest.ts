// Prompt suggestions (S-1459), behind GET /api/suggest: agents, the human's mail threads and ITSAs
// nearest in meaning to the text typed so far. Only items at or above the cosine floor count; a
// recency boost then orders them (the client's recently visited ids, and a thread's latest mail).
// Results have search.ts's shape, so the web UI reuses it. Mail and ITSAs are searched as
// /api/search does; agents come from this daemon's `agent` source and the peers' own.
import * as db from './db.ts';
import { embed } from './embed.ts';
import { fanOut } from './peers.ts';
import { itsaHits, type Result } from './search.ts';
import { searchMail, type MailHit } from './mail-search.ts';
import { settings } from './settings.ts';
import { nearest } from './vectors.ts';
import './agent-vectors.ts';
import './turn-vectors.ts';

// The least cosine an item needs to be suggested.
export const SUGGEST_FLOOR = 0.35;
// Added to the score of the most recently visited id; the item at position n gets this × RECENT_DECAY^n.
export const RECENT_BOOST = 0.1;
export const RECENT_DECAY = 0.8;
// Added to a thread whose latest mail is just now; halves every THREAD_HALF_LIFE_DAYS.
export const THREAD_BOOST = 0.05;
export const THREAD_HALF_LIFE_DAYS = 3;
// Taken from an archived agent's score, so a live agent with a similar text ranks above it.
export const ARCHIVED_PENALTY = 0.15;

export interface SuggestOpts {
  limit: number;
  recent: string[];
  // A peer's own request: only this daemon's agents.
  local: boolean;
  // False for an agent's request: the human's mail isn't theirs to suggest (as /api/search).
  humanMail: boolean;
  // The least cosine counted, instead of SUGGEST_FLOOR (the rescoring pass asks for more, S-1465).
  floor?: number;
  // Overrides now, for tests.
  now?: number;
}

// The score added for being among the recent ids (by id or by an extra name, an ITSA's key).
export function recentBoost(recent: string[], ...ids: (string | undefined)[]): number {
  let best = -1;
  for (const id of ids) {
    const i = id ? recent.indexOf(id) : -1;
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  return best < 0 ? 0 : RECENT_BOOST * RECENT_DECAY ** best;
}

export function threadBoost(last: string, now: number): number {
  const days = Math.max(0, now - Date.parse(last)) / 86_400_000;
  return Number.isFinite(days) ? THREAD_BOOST * 0.5 ** (days / THREAD_HALF_LIFE_DAYS) : 0;
}

// An agent is one row, at the best of its own vector and its turns (a turn maps to its agent, with
// the turn as the snippet and its id in `turn`).
function agentResults(vec: Float32Array, recent: string[], now: number, floor: number): Result[] {
  const best = new Map<string, { score: number; turn?: string }>();
  for (const { ref, score } of nearest('agent', vec, undefined, Infinity, floor)) best.set(ref, { score });
  const since = now - settings().search.turnDays * 86_400_000;
  for (const { ref, score } of nearest('turn', vec, undefined, Infinity, floor)) {
    // A turn older than the window, or with no snippet row, is on its way out of the index.
    const row = db.turnSnippet(ref);
    if (!row || row.at < since) continue;
    const i = ref.indexOf(':');
    const agent = ref.slice(0, i);
    if (score > (best.get(agent)?.score ?? -Infinity)) best.set(agent, { score, turn: ref.slice(i + 1) });
  }
  const out: Result[] = [];
  for (const [id, { score, turn }] of best) {
    const a = db.getAgent(id);
    if (!a) continue;
    const archived = a.lifecycle === 'archived';
    out.push({
      kind: 'agent',
      id: a.id,
      title: a.name,
      snippet: (turn ? db.turnSnippet(`${id}:${turn}`)?.snippet : undefined) ?? (a.role || undefined),
      turn,
      meta: a.machine,
      score: score + recentBoost(recent, a.id, a.name) - (archived ? ARCHIVED_PENALTY : 0),
      by: 'meaning',
    });
  }
  return out;
}

async function threadHits(q: string, limit: number): Promise<MailHit[]> {
  try {
    return (await searchMail('human', q, { limit, local: false })) as MailHit[];
  } catch {
    return [];
  }
}

export async function suggest(q: string, opts: SuggestOpts): Promise<Result[]> {
  const s = String(q ?? '').trim();
  if (!s) return [];
  const vec = (await embed([s]))?.[0];
  if (!vec) return [];
  const now = opts.now ?? Date.now();
  const floor = opts.floor ?? SUGGEST_FLOOR;
  const agents = agentResults(vec, opts.recent, now, floor);
  const trim = (all: Result[]) => all.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, opts.limit);
  if (opts.local) return trim(agents);
  const params = new URLSearchParams({ q: s, limit: String(opts.limit), recent: opts.recent.join(','), floor: String(floor) });
  const [peers, mail, issues] = await Promise.all([
    fanOut<Result>(`/api/suggest?${params}`),
    opts.humanMail ? threadHits(s, opts.limit * 3) : Promise.resolve([] as MailHit[]),
    itsaHits(s, opts.limit * 3),
  ]);
  const threads = mail
    .filter((h) => h.cosine !== null && h.cosine >= floor)
    .map(
      (h): Result => ({
        kind: 'thread',
        id: h.thread_id,
        title: h.subject,
        snippet: h.excerpt || undefined,
        meta: h.people.map((p) => (p === 'human' ? 'you' : p)).join(', '),
        score: h.cosine! + recentBoost(opts.recent, h.thread_id) + threadBoost(h.last, now),
        by: 'meaning',
      }),
    );
  const itsas = issues
    .filter((x) => x.cosine !== null && x.cosine >= floor)
    .map(
      (x): Result => ({
        kind: 'itsa',
        id: x.id,
        title: x.title,
        snippet: x.excerpt || undefined,
        meta: `${x.key} · ${x.status}`,
        score: x.cosine! + recentBoost(opts.recent, x.id, x.key),
        by: 'meaning',
      }),
    );
  return trim([...agents, ...peers.filter((r) => r.kind === 'agent'), ...threads, ...itsas]);
}
