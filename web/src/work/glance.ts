// The Work page at a glance, as the phone shows it (S-301), free of the store so it can be
// tested alone. The phone answers "what needs me now, and what's moving": the Needs-you rows
// first, then the work in flight grouped by its root issue, then what is ready to try. Browsing
// and editing every issue is the Issues page's job, so nothing here lists the backlog, the
// ready queue, or closed work.
import type { Itsa, ItsaCategory } from '../types'
import { isTestLink, type IssueCost, type IssueCosts } from './links'
import { agentIdsOf } from './model'

// A group of moving ITSAs under the root issue they belong to. `root` is null for the trailing
// group of roots with nothing moving under them; when the root itself moves it is the group's
// first item and the group needs no head of its own.
export interface GlanceGroup { id: string; root: Itsa | null; items: Itsa[] }
export interface Glance { moving: GlanceGroup[]; toTry: Itsa[] }
export const LOOSE = '\u0000loose'

export interface GlanceOptions {
  category: (status: string) => ItsaCategory
  // True when the status waits on the human; such an ITSA is a Needs-you row instead.
  human: (status: string) => boolean
  // An agent's state by id (a map lookup); an ITSA with a working agent is moving whatever its
  // status, short of the backlog.
  agentState: (id: string) => string | undefined
  // The ITSAs the Needs-you rows already show; they are left out below.
  needs: Set<string>
}

const testLinks = (it: Itsa) => (it.links ?? []).filter(isTestLink)

// Each issue's cost row by key, built once per report so a card's lookup is a map hit.
export function costIndex(report: IssueCosts | null | undefined): Map<string, IssueCost> {
  return new Map((report?.issues ?? []).map((i) => [i.key, i]))
}

// Each ITSA's root, memoised: a walk stops at the first ancestor already resolved and
// resolves every ITSA it passed, so the whole set costs one step per ITSA, a deep chain too.
// A parent cycle (old data) ends the walk where it repeats.
export function rootsOf(all: Itsa[]): (x: Itsa) => Itsa {
  const byId = new Map(all.map((x) => [x.id, x]))
  const memo = new Map<string, Itsa>()
  return (x: Itsa) => {
    const path: Itsa[] = []
    const seen = new Set<string>()
    let r = x
    let root: Itsa | undefined
    for (;;) {
      root = memo.get(r.id)
      if (root) break
      path.push(r)
      seen.add(r.id)
      const pid = r.parent_id
      if (!pid || !byId.has(pid) || seen.has(pid)) { root = r; break }
      r = byId.get(pid)!
    }
    for (const p of path) memo.set(p.id, root)
    return root
  }
}

export function glance(all: Itsa[], o: GlanceOptions): Glance {
  const rootOf = rootsOf(all)
  const working = (x: Itsa) => agentIdsOf(x).some((id) => o.agentState(id) === 'working')
  const toTry: Itsa[] = []
  const moving: Itsa[] = []
  for (const x of all) {
    const c = o.category(x.status)
    // The backlog stays on the Issues page, even with an agent working on it.
    if (c === 'closed' || c === 'backlog' || o.needs.has(x.id) || o.human(x.status)) continue
    // Ready to try: in review, or anything open that names somewhere to test it.
    if (c === 'review' || testLinks(x).length) toTry.push(x)
    else if (c === 'active' || working(x)) moving.push(x)
  }
  const newest = (a: Itsa, b: Itsa) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id)
  const groups = new Map<string, GlanceGroup>()
  const loose: Itsa[] = []
  const movingIds = new Set(moving.map((x) => x.id))
  const roots = new Map(moving.map((x) => [x.id, rootOf(x)]))
  const perRoot = new Map<string, number>()
  for (const r of roots.values()) perRoot.set(r.id, (perRoot.get(r.id) ?? 0) + 1)
  for (const x of moving) {
    const r = roots.get(x.id)!
    // A root with nothing moving under it is one line in the trailing group, not a group.
    if (r.id === x.id && perRoot.get(r.id) === 1) { loose.push(x); continue }
    const g = groups.get(r.id) ?? { id: r.id, root: r, items: [] }
    g.items.push(x)
    groups.set(r.id, g)
  }
  // Each group's latest change, read once its items are newest first, before its root moves up.
  const latest = new Map<string, string>()
  for (const g of groups.values()) {
    g.items.sort(newest)
    latest.set(g.id, g.items[0].updated_at)
    // The root itself leads its group, so the group needs no separate head.
    const i = movingIds.has(g.id) ? g.items.findIndex((x) => x.id === g.id) : -1
    if (i > 0) g.items.unshift(...g.items.splice(i, 1))
  }
  const out = [...groups.values()].sort((a, b) => latest.get(b.id)!.localeCompare(latest.get(a.id)!) || a.id.localeCompare(b.id))
  if (loose.length) out.push({ id: LOOSE, root: null, items: loose.sort(newest) })
  return { moving: out, toTry: toTry.sort(newest) }
}
