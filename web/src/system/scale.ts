// The system view at scale (S-540): the human's own folds and the focus, search, and culling to
// the viewport. Every manager starts open, at any size and any number of agents (S-705): folding
// is the human's own action. Pure and layout-agnostic, so the Tree, Cards and Stars layouts can
// all use them: they take the tree's nodes and card places, never a layout's own shape.
import type { TreeIn } from './layout'

// Cards within this many screen px of the viewport stay mounted; the rest are culled.
export const CULL_MARGIN = 300
// At most this many cards in the margin round the stage mount in one frame.
export const CULL_BATCH = 12

const childrenOf = (nodes: readonly TreeIn[]) => {
  const by = new Map<string, string[]>()
  for (const n of nodes) if (n.parent) by.set(n.parent, [...(by.get(n.parent) ?? []), n.id])
  return by
}

// A node's ancestors, nearest first, not counting the node.
export function ancestors(nodes: readonly TreeIn[], id: string): string[] {
  const parent = new Map(nodes.map((n) => [n.id, n.parent]))
  const out: string[] = []
  for (let p = parent.get(id) ?? null; p && out.length < nodes.length; p = parent.get(p) ?? null) out.push(p)
  return out
}

// Folds while a manager is in focus: every manager outside its subtree is folded, its ancestors
// are open so it shows, and its own subtree is open.
export function focusFolds(nodes: readonly TreeIn[], focus: string): Set<string> {
  const kids = childrenOf(nodes)
  const keep = new Set([focus, ...ancestors(nodes, focus), ...subtree(nodes, focus)])
  const out = new Set<string>()
  for (const n of nodes) if (kids.get(n.id)?.length && !keep.has(n.id)) out.add(n.id)
  return out
}

// A node's descendants, in the full tree.
export function subtree(nodes: readonly TreeIn[], id: string): string[] {
  const kids = childrenOf(nodes)
  const out: string[] = []
  const walk = (x: string) => { for (const k of kids.get(x) ?? []) { out.push(k); walk(k) } }
  walk(id)
  return out
}

// The folds shown: the default (or focus) with the human's own toggles on top. In focus only the
// toggles inside the focused subtree count, so an old unfold elsewhere can't undo the focus.
export function shownFolds(base: ReadonlySet<string>, toggles: Readonly<Record<string, boolean>>, within?: ReadonlySet<string>): Set<string> {
  const out = new Set(base)
  for (const [id, on] of Object.entries(toggles)) {
    if (within && !within.has(id)) continue
    if (on) out.add(id); else out.delete(id)
  }
  return out
}

// One search entry: an agent's card, by its name and the ITSAs it owns.
export interface Findable { id: string; name: string; itsas: { key: string; title: string }[] }
export interface Found { id: string; name: string; why: string; score: number }
// The entries matching every word of the query, best first: a name that starts with it, then a
// name holding it, then an ITSA key, then an ITSA title. Case is ignored. `why` says what matched.
export function search(entries: readonly Findable[], query: string, limit = 8): Found[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const words = q.split(/\s+/)
  const out: Found[] = []
  for (const e of entries) {
    const name = e.name.toLowerCase()
    let best: Found | null = null
    const take = (score: number, why: string) => { if (!best || score > best.score) best = { id: e.id, name: e.name, why, score } }
    if (name.startsWith(q)) take(4, '')
    else if (words.every((w) => name.includes(w))) take(3, '')
    for (const it of e.itsas) {
      const key = it.key.toLowerCase(), title = it.title.toLowerCase()
      if (key === q || (key.startsWith(q) && /\d/.test(q))) take(2.5, `${it.key} ${it.title}`)
      else if (words.every((w) => title.includes(w) || key === w)) take(1, `${it.key} ${it.title}`)
    }
    if (best) out.push(best)
  }
  // Ties keep the tree's order, which `entries` gives.
  return out.map((f, i) => ({ f, i })).sort((a, b) => b.f.score - a.f.score || a.i - b.i).slice(0, limit).map((x) => x.f)
}

// The pan and zoom that shows a box of the world (world px) centred in a stage of W by H, at
// zoom `k` clamped to [min, max] and no closer than fits the box with `pad` around it.
export interface View { x: number; y: number; k: number }
export function frame(box: { x: number; y: number; w: number; h: number }, W: number, H: number, pad: number, min: number, max: number, want = 1): View {
  const fitK = Math.min((W - pad * 2) / Math.max(1, box.w), (H - pad * 2) / Math.max(1, box.h))
  const k = Math.max(min, Math.min(max, want, fitK))
  return { k, x: W / 2 - (box.x + box.w / 2) * k, y: box.w * k > W - pad * 2 || box.h * k > H - pad * 2 ? pad - box.y * k : H / 2 - (box.y + box.h / 2) * k }
}

// The bounding box of some cards' places (world px), each `h` high.
export function boxOf(places: Iterable<{ x: number; y: number; w: number }>, h: number): { x: number; y: number; w: number; h: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of places) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x + p.w); y1 = Math.max(y1, p.y + h) }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

// The cards to mount: those whose place, under the view's transform, falls within the stage
// (W by H screen px) grown by `margin` on every side. Cards are `h` high in world px. A card
// already mounted (`prev`) stays until it is twice the margin out, so a pan back and forth
// across the edge doesn't mount and unmount it each time.
export function inView(pos: ReadonlyMap<string, { x: number; y: number; w: number }>, view: View, W: number, H: number, h: number, margin = CULL_MARGIN, prev?: ReadonlySet<string> | null): Set<string> {
  const out = new Set<string>()
  const near = (m: number) => {
    const l = (-m - view.x) / view.k, t = (-m - view.y) / view.k, r = (W + m - view.x) / view.k, b = (H + m - view.y) / view.k
    return (p: { x: number; y: number; w: number }) => p.x < r && p.x + p.w > l && p.y < b && p.y + h > t
  }
  const add = near(margin), keep = near(margin * 2)
  for (const [id, p] of pos) if (add(p) || (prev?.has(id) && keep(p))) out.add(id)
  return out
}
// The cards to mount this frame, of those `want`ed: every one already mounted, every one in the
// stage itself (`seen`), so nothing in view is ever missing, and new ones in the margin up to `cap`,
// so a fast zoom out spreads the margin's mounts over a few frames. `more` says some wait for the
// next frame.
export function admit(want: ReadonlySet<string>, seen: ReadonlySet<string>, prev: ReadonlySet<string> | null, cap = CULL_BATCH): { ids: Set<string>; more: boolean } {
  const ids = new Set<string>()
  let room = cap
  for (const id of want) {
    if (prev?.has(id) || seen.has(id)) ids.add(id)
    else if (room > 0) { ids.add(id); room-- }
  }
  return { ids, more: ids.size < want.size }
}
export const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((x) => b.has(x))

// The human's own folds, per viewer, kept in localStorage: one map for the desktop tree and one
// for the phone's outline. Storage can be missing or throw (a private window); then they last
// the page's life.
const FOLDS_KEY = 'stam/system-folds'
export function loadFolds(narrow: boolean): Record<string, boolean> {
  try { const all = JSON.parse(localStorage.getItem(FOLDS_KEY) ?? '{}'); return all?.[narrow ? 'narrow' : 'wide'] ?? {} } catch { return {} }
}
export function saveFolds(narrow: boolean, toggles: Record<string, boolean>) {
  try {
    const all = JSON.parse(localStorage.getItem(FOLDS_KEY) ?? '{}') ?? {}
    all[narrow ? 'narrow' : 'wide'] = toggles
    localStorage.setItem(FOLDS_KEY, JSON.stringify(all))
  } catch { /* storage off: the folds last the page */ }
}
