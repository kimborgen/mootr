// Search over the mail a viewer may read, behind GET /api/mail/search and the search_mail tool.
// A viewer reads its own mail, and the threads with the human that any of its ancestors (parents,
// and their parents up to the root) took part in: a developer finds the thread its manager already
// has with the human about the same issue. Mail lives on whichever daemon it was sent to, so the
// daemon that answers the tool fans out to its peers, and each daemon returns its raw parts per
// thread: the best cosine (null when none) and the keyword rank. Only the answering daemon blends
// and normalises them (S-141), so peers' scores never need to agree.
//
// Ranking: by meaning when this daemon's embedder is ready, blending 0.7 × the thread's best cosine
// with 0.3 × its keyword rank (scaled to the best hit); otherwise by keyword alone, as S-140 did.
import * as db from './db.ts';
import { HUMAN } from './mail.ts';
import { embed } from './embed.ts';
import { fanOut, type Via } from './peers.ts';
import { excerpt, rank } from './search.ts';
import { nearest } from './vectors.ts';
import { isPlacedAsk, mayReadMail, withoutHiddenAsks } from './mail-visibility.ts';

export interface MailHit {
  thread_id: string;
  subject: string;
  // The thread's latest mail on this daemon: what a reply names as reply_to.
  latest: string;
  // Who is in the thread, by name (the human as `human`).
  people: string[];
  last: string;
  excerpt: string;
  score: number;
  // Which ranking placed the hit: by meaning, or by keyword.
  by: 'meaning' | 'keyword';
  // The raw parts the score blends (S-142 review): the cosine when it ranked by meaning (else null),
  // and the keyword rank. The tool blends mail with ITSAs from these.
  cosine: number | null;
  keyword: number;
}

// A daemon's raw part of a thread, before the answering daemon blends: the text of the hit, the
// best cosine of the query with the thread's in-scope mail (null when none is near enough), and
// the keyword rank of the best matching mail.
export interface Part {
  thread_id: string;
  subject: string;
  latest: string;
  people: string[];
  last: string;
  excerpt: string;
  cos: number | null;
  kw: number;
}

export interface SearchOpts {
  // An agent name or id, or the human: only threads that one takes part in.
  with?: string;
  limit: number;
  // A peer's own request: answer only with this daemon's raw parts.
  local: boolean;
  // The agent the request acts for, forwarded to the peers so each one checks it (S-259).
  via?: Via;
}

// The weights of a thread's meaning and keyword scores, and the least cosine that counts.
const MEANING_WEIGHT = 0.7;
const KEYWORD_WEIGHT = 0.3;
const MEANING_FLOOR = 0.15;

// The viewer's parents, their parents, and so on up to the root.
function ancestorsOf(id: string): string[] {
  const out = new Set<string>();
  const todo = [id];
  while (todo.length) {
    const a = db.getAgent(todo.pop()!);
    if (!a) continue;
    for (const p of db.parentsOf(a)) {
      if (!out.has(p)) {
        out.add(p);
        todo.push(p);
      }
    }
  }
  return [...out];
}

// The threads a viewer may read beyond its own mail: those with the human that an ancestor took part in.
// Not an ITSA's thread, which only those the ITSA belongs to read whole (S-480, mail-visibility.ts).
// A placed ask (S-3827) makes neither the human nor its sender part of its home thread, so it opens that thread to nobody.
export function sharedThreads(viewer: string): string[] {
  const withHuman = new Set(db.humanThreadIds(true));
  const itsaThreads = db.itsaThreadIds();
  return [...new Set(ancestorsOf(viewer).flatMap((a) => db.threadIdsOf(a, true)))].filter((t) => withHuman.has(t) && !itsaThreads.has(t));
}

// The text a thread's hit shows: its latest mail, its people, and an excerpt around the query.
function textOf(viewer: string, thread: string, m: db.Mail, q: string): Omit<Part, 'cos' | 'kw'> {
  const mails = withoutHiddenAsks(viewer, db.threadMail(thread));
  const latest = mails.at(-1) ?? m;
  const people = new Set<string>();
  for (const x of mails) {
    people.add(x.from_name ?? x.from_id);
    for (const r of x.recipients) people.add(r.id === HUMAN ? HUMAN : (db.getAgent(r.id)?.name ?? r.id));
  }
  return {
    thread_id: thread,
    subject: m.subject || '(no subject)',
    latest: latest.id,
    people: [...people],
    last: latest.created_at,
    excerpt: excerpt(m.body, q),
  };
}

// This daemon's raw parts for a viewer: the keyword hits, plus the threads whose in-scope mail is
// near the query (when `vec` is given).
function localParts(viewer: string, q: string, opts: SearchOpts, vec: Float32Array | null): Part[] {
  const withId = opts.with ? (db.getAgent(opts.with)?.id ?? opts.with) : undefined;
  const inWith = withId ? new Set(db.threadIdsOf(withId)) : undefined;
  // Keyword: the best mail per thread. Ask for more than the limit, since the `with` filter can drop some.
  // A placed ask (S-3827) is found only by those who see it, not by everyone who reads its home thread.
  const hidden = (x: db.Mail) => viewer !== HUMAN && isPlacedAsk(x) && !mayReadMail(viewer, x);
  const found = db.searchMailText(q, viewer, opts.limit * 10, sharedThreads(viewer)).filter((m) => !hidden(m));
  const kw = new Map<string, { m: db.Mail; score: number }>();
  for (const m of found) {
    const thread = m.thread_id ?? m.id;
    if (inWith && !inWith.has(thread)) continue;
    const score = rank(m.subject, q) * 2 + rank(m.body, q);
    if (!kw.has(thread) || score > kw.get(thread)!.score) kw.set(thread, { m, score });
  }
  // Meaning: each thread's nearest in-scope mail.
  const threadOf = new Map<string, string>();
  for (const s of db.mailScope(viewer, sharedThreads(viewer))) if ((!inWith || inWith.has(s.thread)) && !(s.placed && hidden(db.getMail(s.id)!))) threadOf.set(s.id, s.thread);
  const best = new Map<string, { ref: string; cos: number }>();
  if (vec) {
    for (const { ref, score } of nearest('mail', vec, new Set(threadOf.keys()), Infinity)) {
      const t = threadOf.get(ref)!;
      if (!best.has(t)) best.set(t, { ref, cos: score });
    }
  }
  const threads = new Set([...kw.keys(), ...[...best].filter(([, b]) => b.cos >= MEANING_FLOOR).map(([t]) => t)]);
  const parts: Part[] = [];
  for (const t of threads) {
    const b = best.get(t);
    const k = kw.get(t);
    const m = k?.m ?? db.getMail(b!.ref)!;
    parts.push({ ...textOf(viewer, t, m, q), cos: b && b.cos >= MEANING_FLOOR ? b.cos : null, kw: k?.score ?? 0 });
  }
  return parts;
}

// One part per thread across the daemons: the text of the strongest part, the best cosine, and the best keyword rank.
function mergeParts(parts: Part[]): Part[] {
  const byThread = new Map<string, Part>();
  for (const p of parts) {
    const cur = byThread.get(p.thread_id);
    if (!cur) {
      byThread.set(p.thread_id, p);
      continue;
    }
    // The text comes from the strongest part, but its people are every part's (a sender's copy
    // of a mail has no recipients on it), and latest and last come from the newest part.
    const top = p.kw > cur.kw ? p : cur;
    const other = top === p ? cur : p;
    const newest = p.last > cur.last ? p : cur;
    const cos = Math.max(cur.cos ?? -Infinity, p.cos ?? -Infinity);
    const people = [...new Set([...top.people, ...other.people])];
    byThread.set(p.thread_id, { ...top, latest: newest.latest, last: newest.last, people, cos: Number.isFinite(cos) ? cos : null, kw: Math.max(cur.kw, p.kw) });
  }
  return [...byThread.values()];
}

// The answering daemon's scores: by meaning when `meaning` is set, else by keyword rank.
function blend(parts: Part[], meaning: boolean, limit: number): MailHit[] {
  const maxKw = Math.max(1, ...parts.map((p) => p.kw));
  const hits = parts.map(({ cos, kw, ...hit }): MailHit => ({
    ...hit,
    score: meaning ? MEANING_WEIGHT * (cos ?? 0) + KEYWORD_WEIGHT * (kw / maxKw) : kw,
    by: meaning ? 'meaning' : 'keyword',
    cosine: meaning ? (cos ?? 0) : null,
    keyword: kw,
  }));
  return hits
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || b.last.localeCompare(a.last))
    .slice(0, limit);
}

// Search for `viewer`: this daemon's parts, merged with the peers' unless the request is a peer's own.
export async function searchMail(viewer: string, q: string, opts: SearchOpts): Promise<MailHit[] | Part[]> {
  const s = String(q ?? '').trim();
  if (!s) return [];
  const vec = (await embed([s]))?.[0] ?? null;
  const own = localParts(viewer, s, opts, vec);
  if (opts.local) return own;
  const params = new URLSearchParams({ box: viewer, q: s, limit: String(opts.limit) });
  if (opts.with) params.set('with', opts.with);
  const peer = await fanOut<Part>(`/api/mail/search?${params}`, opts.via);
  return blend(mergeParts([...own, ...peer]), vec !== null, opts.limit);
}
