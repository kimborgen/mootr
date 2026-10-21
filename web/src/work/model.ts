// The Work page's model, free of the store so it can be tested alone: open ITSAs grouped by
// issue tree, by agent tree, or as one flat list. Each issue root with something under it is a
// group; the rows below are its descendants to any depth, in tree order. Roots with nothing
// under them to show are rows of one trailing group. An ancestor that the filter or the
// open-only view would hide stays as a context row, so every row keeps its place in the tree.
import type { Itsa } from '../types'
import type { CellContext } from './columns'
import { quickKeeps, type QuickId, type StatusLookup } from './quick'
import { searchHas } from './search'
import { BLANK, keeps, kindsOf, sorted, type ColFilter, type ColLookup, type SortFilterCol, type SortKey } from './sortfilter'

export type Show = 'open' | 'all'
// How the rows are grouped: by issue tree (the default), by the agent tree that owns them, as
// one flat list, or by the values of a column (S-1520; the layout names the column).
export type Group = 'issues' | 'agents' | 'flat' | 'column'
export const GROUPS: Group[] = ['issues', 'agents', 'flat', 'column']
// A row of the Work table: an ITSA, in a group or as a Needs-you row's subject.
// `role` is set in the agent grouping only: which way the ITSA belongs to that agent, as its owner or a participant.
export interface WorkRow { it: Itsa; depth: number; context: boolean; role?: 'owner' | 'participant' }
// `root` is the issue an issue group is for; `agent` the root agent of an agent group. A flat
// group, the unowned group, and a standalone group have no agent; the flat group has no root
// either, and no header.
// A column group has `column`: the value it is for (BLANK for the (Blank) group) and its label.
export interface WorkGroup { id: string; root: Itsa | null; agent?: AgentHead | null; column?: { col: string; value: string; label: string }; rows: WorkRow[] }
export const STANDALONE = '\u0000standalone'
export const UNOWNED = '\u0000unowned'
export const FLAT = '\u0000flat'

// What an agent group heads with: the agent's id, name, and harness mark.
export interface AgentHead { id: string; name: string; harness: string }
// An agent as the grouping needs it: its place in the tree (its parents, or its parent_id) and
// when it was made, which orders siblings.
export interface AgentNode extends AgentHead { parents?: string[]; parent_id?: string | null; created_at?: string }

// `sort` and `filters` are the layout's (views.ts); `cols` says what each column's value is and `cx`
// carries the extras (cost, activity, watch) those values read. Without `cols` they do nothing.
export interface GroupOptions {
  show: Show; text: string; closed: (x: Itsa) => boolean
  sort?: SortKey[]; filters?: Record<string, ColFilter>; cols?: ColLookup; cx?: CellContext
  // The quick filters on (S-1515) and the statuses they read; they AND with the column filters.
  quick?: QuickId[]; status?: StatusLookup
  // Every column, for the text search (S-1519): a row matches when any column's text has it. Without
  // them the search reads the key, title and summary.
  searchCols?: readonly SortFilterCol[]
  // The column a 'column' grouping is by (S-1520).
  groupBy?: string
}

const NO_CX: CellContext = { now: 0, extras: { costs: null, activity: null, watch: {}, fields: null, fieldsFailed: false, fieldsStart: 0 } }
const rowOf = (it: Itsa): WorkRow => ({ it, depth: 0, context: false })
// The ITSAs ordered by the sort keys (equal ones keep their order); as given without keys.
const sortedBy = (xs: Itsa[], o: GroupOptions) => sorted(xs, o.sort, o.cols, o.cx ?? NO_CX, rowOf)

const matches = (x: Itsa, q: string) => !q || [x.key, x.title, x.summary ?? ''].some((s) => s.toLowerCase().includes(q))

// Whether the Show and filter settings keep an ITSA.
// Every column filter ANDs with them.
function wantedFn({ show, text, closed, filters, cols, cx, quick, status, searchCols }: GroupOptions) {
  const q = text.trim().toLowerCase()
  const active = Object.entries(filters ?? {})
  const found = (x: Itsa) => (searchCols ? searchHas(searchCols, x, cx ?? NO_CX, q) : matches(x, q))
  return (x: Itsa) => (show === 'all' || !closed(x)) && (!q || found(x))
    && active.every(([id, f]) => keeps(cols?.(id), f, rowOf(x), cx ?? NO_CX))
    && (!quick?.length || !status || quickKeeps(quick, x, status, cx?.now ?? Date.now()))
}

export function groupWork(all: Itsa[], opts: GroupOptions): WorkGroup[] {
  const known = new Set(all.map((x) => x.id))
  const kids = new Map<string | null, Itsa[]>()
  for (const x of all) {
    const p = x.parent_id && known.has(x.parent_id) ? x.parent_id : null
    kids.set(p, [...(kids.get(p) ?? []), x])
  }
  // Sort orders the siblings at each level, so the tree keeps its shape.
  for (const [p, list] of kids) kids.set(p, sortedBy(list, opts))
  const wanted = wantedFn(opts)

  // The rows under X, in tree order: each wanted descendant, and each ancestor of one as
  // context. `seen` guards against a cycle the daemon refuses but old data might hold.
  const below = (x: Itsa, depth: number, seen: Set<string>): WorkRow[] => {
    const out: WorkRow[] = []
    for (const c of kids.get(x.id) ?? []) {
      if (seen.has(c.id)) continue
      seen.add(c.id)
      const sub = below(c, depth + 1, seen)
      const self = wanted(c)
      if (self || sub.length) out.push({ it: c, depth, context: !self }, ...sub)
    }
    return out
  }

  const groups: WorkGroup[] = []
  const single: WorkRow[] = []
  for (const r of kids.get(null) ?? []) {
    const rows = below(r, 0, new Set([r.id]))
    if (rows.length) groups.push({ id: r.id, root: r, rows })
    else if (wanted(r)) single.push({ it: r, depth: 0, context: false })
  }
  if (single.length) groups.push({ id: STANDALONE, root: null, rows: single })
  return groups
}

// One group per top-level agent tree: its agents in tree order (depth first, siblings by
// creation), each agent's ITSAs under it at the agent's depth. An ITSA whose owner is not an
// agent in the store (none, or one that was forgotten) goes to a trailing Unowned group. An ITSA is listed
// once per agent tree: under its owner when the owner is in that tree, else under its shallowest participant
// there. The human is no agent.
export function groupByAgent(all: Itsa[], agents: AgentNode[], opts: GroupOptions): WorkGroup[] {
  const wanted = wantedFn(opts)
  const known = new Map(agents.map((a) => [a.id, a]))
  const primary = (a: AgentNode) => (a.parents ?? []).find((p) => known.has(p)) ?? (a.parent_id && known.has(a.parent_id) ? a.parent_id : null)
  const kids = new Map<string | null, AgentNode[]>()
  for (const a of agents) {
    const p = primary(a) ?? null
    kids.set(p, [...(kids.get(p) ?? []), a])
  }
  for (const list of kids.values()) list.sort((x, y) => (x.created_at ?? '').localeCompare(y.created_at ?? '') || x.id.localeCompare(y.id))

  // Each top-level agent tree with the depth of each agent in it; `seen` guards against a cycle in the stored parents.
  const trees: Map<string, number>[] = []
  const measure = (a: AgentNode, depth: number, seen: Set<string>, into: Map<string, number>) => {
    into.set(a.id, depth)
    for (const c of kids.get(a.id) ?? []) {
      if (seen.has(c.id)) continue
      seen.add(c.id)
      measure(c, depth + 1, seen, into)
    }
  }
  for (const r of kids.get(null) ?? []) {
    const into = new Map<string, number>()
    measure(r, 0, new Set([r.id]), into)
    trees.push(into)
  }

  const byAgent = new Map<string, Itsa[]>()
  const unowned: WorkRow[] = []
  for (const x of all) {
    if (!wanted(x)) continue
    // agentIdsOf lists the owner first, so a tie in depth goes to the owner.
    const ids = agentIdsOf(x).filter((id) => known.has(id))
    for (const tree of trees) {
      const here = ids.filter((id) => tree.has(id))
      if (!here.length) continue
      const at = x.owner && tree.has(x.owner) ? x.owner : here.reduce((best, id) => (tree.get(id)! < tree.get(best)! ? id : best))
      byAgent.set(at, [...(byAgent.get(at) ?? []), x])
    }
    if (!x.owner || !known.has(x.owner)) unowned.push({ it: x, depth: 0, context: false })
  }
  // Sort orders each agent's ITSAs and the Unowned ones; the agents keep their tree order.
  for (const [id, list] of byAgent) byAgent.set(id, sortedBy(list, opts))
  const unownedRows = sorted(unowned, opts.sort, opts.cols, opts.cx ?? NO_CX, (r) => r)

  const groups: WorkGroup[] = []
  // Depth first over one tree; `seen` guards against a cycle in the stored parents.
  const walk = (a: AgentNode, depth: number, seen: Set<string>, rows: WorkRow[]) => {
    for (const x of byAgent.get(a.id) ?? []) rows.push({ it: x, depth, context: false, role: x.owner === a.id ? 'owner' : 'participant' })
    for (const c of kids.get(a.id) ?? []) {
      if (seen.has(c.id)) continue
      seen.add(c.id)
      walk(c, depth + 1, seen, rows)
    }
  }
  for (const r of kids.get(null) ?? []) {
    const rows: WorkRow[] = []
    walk(r, 0, new Set([r.id]), rows)
    if (rows.length) groups.push({ id: r.id, root: null, agent: { id: r.id, name: r.name, harness: r.harness }, rows })
  }
  if (unownedRows.length) groups.push({ id: UNOWNED, root: null, agent: null, rows: unownedRows })
  return groups
}

// One group without a header: every wanted ITSA at depth 0, sorted by the sort keys; newest
// update first for the rest, and for all of it without keys.
export function groupFlat(all: Itsa[], opts: GroupOptions): WorkGroup[] {
  const wanted = wantedFn(opts)
  const newest = all.filter(wanted).sort((x, y) => y.updated_at.localeCompare(x.updated_at) || x.id.localeCompare(y.id))
  const rows = sortedBy(newest, opts)
  return rows.length ? [{ id: FLAT, root: null, rows: rows.map((it) => ({ it, depth: 0, context: false })) }] : []
}

// Whether a column can group rows: it has a values filter (a few choices) or a check one.
export const groupable = (c: SortFilterCol | undefined): c is SortFilterCol => kindsOf(c).some((k) => k === 'values' || k === 'check')

// One group per value of a column, in the column's group order, each holding its rows sorted by
// the view's sort (newest update first without one); rows with no value come last in (Blank). A
// row with several values (an ITSA with several agents) is in the group of each, so no group
// hides a row a filter for its value would show. Groups the filters leave empty are not made.
export function groupByColumn(all: Itsa[], col: SortFilterCol, opts: GroupOptions): WorkGroup[] {
  const f = col.filter
  const cx = opts.cx ?? NO_CX
  if (!f) return []
  const check = !kindsOf(col).includes('values')
  const kind = check ? 'check' : 'values'
  const newest = all.filter(wantedFn(opts)).sort((x, y) => y.updated_at.localeCompare(x.updated_at) || x.id.localeCompare(y.id))
  const rows = sortedBy(newest, opts).map(rowOf)
  const valuesOf = (r: WorkRow): string[] => {
    const v = f.valueOf(r, cx, kind)
    if (check) return [v ? 'yes' : 'no']
    return [...new Set((Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string' && x !== BLANK))]
  }
  const by = new Map<string, WorkRow[]>()
  for (const r of rows) for (const v of valuesOf(r).length ? valuesOf(r) : [BLANK]) by.set(v, [...(by.get(v) ?? []), r])
  const labels = new Map((check ? [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] : f.values?.(rows, cx) ?? []).map((v) => [v.value, v.label]))
  const listed = [...labels.keys()].filter((v) => v !== BLANK)
  const found = [...by.keys()].filter((v) => v !== BLANK)
  // The column's own order, then values it doesn't list in the order met; `groupOrder` sorts them all.
  const values = [...listed.filter((v) => by.has(v)), ...found.filter((v) => !labels.has(v))]
  if (f.groupOrder) values.sort(f.groupOrder)
  if (by.has(BLANK)) values.push(BLANK)
  return values.map((value) => ({ id: `${col.id}:${value}`, root: null, column: { col: col.id, value, label: value === BLANK ? '(Blank)' : labels.get(value) ?? value }, rows: by.get(value)! }))
}

// The fold keys without those of agents that are gone (`column:agents:<id>`); the same object when
// none is, so a caller can tell nothing changed. The blank group's key (no id) stays.
export function pruneFolded(folded: Record<string, boolean>, agentIds: Set<string>, itsaIds?: Set<string>): Record<string, boolean> {
  const P = 'column:agents:'
  // A row fold (`row:<mode>:<id>`, S-1437) goes with its ITSA, once the ITSAs have loaded. The Agents tree has
  // no row folds (its group heads fold), so a saved `row:agents:` key always goes.
  const rowGone = (k: string) => /^row:agents:/.test(k) || (!!itsaIds && /^row:[a-z]+:./.test(k) && !itsaIds.has(k.replace(/^row:[a-z]+:/, '')))
  const gone = Object.keys(folded).filter((k) => rowGone(k) || (k.startsWith(P) && k.length > P.length && !agentIds.has(k.slice(P.length))))
  if (!gone.length) return folded
  return Object.fromEntries(Object.entries(folded).filter(([k]) => !gone.includes(k)))
}

// The groups for a grouping mode.
export function groupFor(mode: Group, all: Itsa[], agents: AgentNode[], opts: GroupOptions): WorkGroup[] {
  if (mode === 'column') {
    const col = opts.groupBy ? opts.cols?.(opts.groupBy) : undefined
    // A column that is gone, or can't group, shows the issue tree instead of hiding the rows.
    if (groupable(col)) return groupByColumn(all, col, opts)
    return groupWork(all, opts)
  }
  if (mode === 'agents') return groupByAgent(all, agents, opts)
  if (mode === 'flat') return groupFlat(all, opts)
  return groupWork(all, opts)
}

// How long ago, said short: `now`, `4m`, `3h`, `2d`, `5w`.
export function since(t: string, now = Date.now()) {
  const s = Math.max(0, (now - Date.parse(t)) / 1000)
  return s < 60 ? 'now' : s < 3600 ? Math.floor(s / 60) + 'm' : s < 86400 ? Math.floor(s / 3600) + 'h' : s < 86400 * 14 ? Math.floor(s / 86400) + 'd' : Math.floor(s / 86400 / 7) + 'w'
}

// The agents on an ITSA: its owner, then its other participants, without the human.
export function agentIdsOf(x: Pick<Itsa, 'owner' | 'participants'>) {
  return [...new Set([x.owner, ...(x.participants ?? [])])].filter((id): id is string => !!id && id !== 'human')
}

// Row folds (S-1437): a row's subrows are the rows after it that sit deeper, up to the next row at its
// depth or above. `kids` counts them for every row that has any; `rows` is what shows once the rows
// `folded` says are folded hide their subrows.
export function foldRows(rows: WorkRow[], folded: (r: WorkRow) => boolean): { rows: WorkRow[]; kids: Map<string, number> } {
  const kids = new Map<string, number>()
  const shown: WorkRow[] = []
  let skipBelow = Infinity
  rows.forEach((r, i) => {
    let n = 0
    while (rows[i + 1 + n] && rows[i + 1 + n].depth > r.depth) n++
    if (n) kids.set(r.it.id, n)
    if (r.depth > skipBelow) return
    skipBelow = Infinity
    shown.push(r)
    if (n && folded(r)) skipBelow = r.depth
  })
  return { rows: shown, kids }
}
