// Search over the ITSAs by meaning (S-142), behind GET /api/itsas/search and the search tool. An
// ITSA lives on its home daemon, so only the home answers; the other daemons proxy the route as
// they do every /api/itsas route. Ranking as mail's (mail-search.ts): by meaning when this
// daemon's embedder is ready, blending 0.7 × the ITSA's cosine with 0.3 × its keyword rank (scaled
// to the best hit); otherwise by keyword alone. `kinds` limits the search to some kinds (the retro
// search's own) and `open` drops closed ITSAs before the limit, so closed matches can't crowd an
// open one out of the top.
import * as db from './db.ts';
import * as itsa from './itsa.ts';
import { embed } from './embed.ts';
import { excerpt, rank } from './search.ts';
import { nearest } from './vectors.ts';

export interface ItsaHit {
  id: string;
  key: string;
  title: string;
  status: string;
  // The owner's name (its id when it isn't an agent here), or null.
  owner: string | null;
  // A short excerpt of the summary (or the body) around the query.
  excerpt: string;
  score: number;
  // Which ranking placed the hit: by meaning, or by keyword.
  by: 'meaning' | 'keyword';
  // The raw parts the score blends (S-142 review): the cosine when it ranked by meaning (else null),
  // and the keyword rank. The tool blends mail with ITSAs from these.
  cosine: number | null;
  keyword: number;
}

// The weights of an ITSA's meaning and keyword scores, and the least cosine that counts (as mail's).
const MEANING_WEIGHT = 0.7;
const KEYWORD_WEIGHT = 0.3;
const MEANING_FLOOR = 0.15;

// The keyword rank of an ITSA: its key and title count most, then the summary and the body.
function keywordOf(x: itsa.Itsa, q: string): number {
  return rank(x.title, q) * 2 + rank(x.key, q) * 2 + rank(x.summary, q) + rank(x.body, q);
}

export async function searchItsas(q: string, opts: { limit: number; kinds?: string[]; open?: boolean; offset?: number }): Promise<ItsaHit[]> {
  const s = String(q ?? '').trim();
  if (!s) return [];
  // Restrict to these kinds when given (the retro search's own: kind `retro` and feedback reports),
  // and drop closed ITSAs when asked, so a nearer ITSA of another kind or a closed one can't crowd
  // a near-duplicate out of the top. Both filters apply before the limit. `offset` pages the ranked
  // results, so a caller can look past items it can't use (the retro search's unreadable matches).
  const only = opts.kinds?.length ? new Set(opts.kinds) : null;
  const keep = (x: itsa.Itsa): boolean => (!only || only.has(x.kind ?? '')) && (!opts.open || !x.closed_at);
  const vec = (await embed([s]))?.[0] ?? null;
  // The candidates: the keyword matches, and the ITSAs whose text is near the query.
  const found = new Map<string, itsa.Itsa>();
  for (const x of await itsa.list({ text: s })) if (keep(x)) found.set(x.id, x);
  const cos = new Map<string, number>();
  if (vec) {
    for (const { ref, score } of nearest('itsa', vec, undefined, Infinity)) {
      if (score < MEANING_FLOOR) continue;
      if (!found.has(ref)) {
        const x = itsa.find(ref);
        if (!x || !keep(x)) continue;
        found.set(ref, x);
      }
      cos.set(ref, score);
    }
  }
  const kw = new Map<string, number>();
  for (const x of found.values()) kw.set(x.id, keywordOf(x, s));
  const maxKw = Math.max(1, ...kw.values());
  return [...found.values()]
    .map((x): ItsaHit => {
      const owner = x.owner ? (db.getAgent(x.owner)?.name ?? x.owner) : null;
      return {
        id: x.id,
        key: x.key,
        title: x.title,
        status: x.status,
        owner,
        excerpt: excerpt(x.summary || x.body || '', s),
        score: vec ? MEANING_WEIGHT * (cos.get(x.id) ?? 0) + KEYWORD_WEIGHT * ((kw.get(x.id) ?? 0) / maxKw) : kw.get(x.id)!,
        by: vec ? 'meaning' : 'keyword',
        cosine: vec ? (cos.get(x.id) ?? 0) : null,
        keyword: kw.get(x.id)!,
      };
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    .slice(opts.offset ?? 0, (opts.offset ?? 0) + opts.limit);
}
