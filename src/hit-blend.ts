// One order for the agent search tool's hits of several kinds (S-142). Pure: no db, so the agent's
// MCP shim can import it. Each hit carries its route's `score` (already in route order, computed
// from every candidate the route had, not only the hits it kept), plus its raw parts: `cosine`
// (null when it ranked by keyword) and `keyword`.

export interface BlendPart {
  by: 'meaning' | 'keyword';
  score: number;
  cosine: number | null;
  keyword: number;
}

// One order for hits of several kinds. When every non-empty list ranked by meaning, both routes
// put their scores on the same 0-1 scale (0.7 × cosine + 0.3 × keyword / the route's best keyword),
// so a route's score is used as it is. Otherwise each route's keyword scores are divided by the best
// score in that route's list, which keeps the route's order and puts each list on 0-1. Either way a
// route's order survives the merge, so cutting a route to its top `limit` keeps the overall top
// `limit`.
export function blendHits<T extends BlendPart>(lists: T[][]): { hits: (T & { score: number })[]; by: 'meaning' | 'keyword' } {
  const by = lists.filter((l) => l.length).every((l) => l.every((h) => h.by === 'meaning')) && lists.some((l) => l.length) ? 'meaning' : 'keyword';
  const hits = lists
    .flatMap((list) => {
      const top = Math.max(...list.map((h) => h.score)) || 1;
      return list.map((h) => ({ ...h, score: by === 'meaning' ? h.score : h.score / top }));
    })
    .sort((a, b) => b.score - a.score);
  return { hits, by };
}
