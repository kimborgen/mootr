// The Agents page's table (S-1432, PR 1): which columns a row can show, how the agents group and
// sort, and the lines the table draws. Pure, so the page, the table's stories and its test share one
// rule. The agents are the sidebar's (treeAgents) and the tree's order and folds are the sidebar's,
// so the page and the sidebar show the same set in the same order.
import { live, model, stateLabel, treeAgents } from './format'
import { isClosed, waitsOnHuman } from './itsa/itsa'
import { waitsOf } from './waits'
import type { Agent, CostMode, Itsa } from './types'

export const COLUMNS = [
  { id: 'role', label: 'Role' },
  { id: 'model', label: 'Model' },
  { id: 'machine', label: 'Machine' },
  { id: 'itsa', label: 'ITSA' },
  { id: 'activity', label: 'Activity' },
  { id: 'wait', label: 'Wait' },
  { id: 'context', label: 'Context' },
  { id: 'cost', label: 'Cost' },
  { id: 'unread', label: 'Unread' },
  { id: 'age', label: 'Age' },
] as const
export type ColumnId = (typeof COLUMNS)[number]['id']
export const ALL_COLS: ColumnId[] = COLUMNS.map((c) => c.id)

export const GROUPS = [
  { id: 'tree', label: 'Tree' },
  { id: 'machine', label: 'Machine' },
  { id: 'itsa', label: 'ITSA' },
  { id: 'flat', label: 'Flat' },
] as const
export type Group = (typeof GROUPS)[number]['id']

// The scope chips (S-2937): the live agents, the ones with a top wait, the shut-down ones and the archived ones.
export const SCOPES = [
  { id: 'live', label: 'Live' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'stopped', label: 'Stopped' },
  { id: 'archived', label: 'Archived' },
] as const
export type Scope = (typeof SCOPES)[number]['id']
export const sanitizeScope = (x: unknown): Scope => (SCOPES.some((s) => s.id === x) ? (x as Scope) : 'live')

// A sortable column: the agent's name, or any column the table shows.
export type SortCol = 'name' | ColumnId
export interface Sort { col: SortCol; dir: 'asc' | 'desc' }

// The picked columns in the order they show, from a stored value. A value that isn't a list shows all of them.
export function sanitizeCols(x: unknown): ColumnId[] {
  if (!Array.isArray(x)) return ALL_COLS
  return [...new Set(x)].filter((c): c is ColumnId => ALL_COLS.includes(c as ColumnId))
}
export const sanitizeGroup = (x: unknown): Group => (GROUPS.some((g) => g.id === x) ? (x as Group) : 'tree')

// Whether an agent waits: it has a permission request open, or any wait (a timer, another agent, its children, a job, an event
// or the human). This is the Waiting chip's rule.
export const waitingOf = (a: Agent) => live(a) && (!!a.pending_requests || waitsOf(a).length > 0)

// The agents a scope lists. Live is the sidebar's tree (treeAgents), so the page and the sidebar agree; Waiting is the
// waiting live agents; Stopped and Archived are the agents with that lifecycle, from the same list.
export function scopeAgents(agents: Agent[], scope: Scope): Agent[] {
  switch (scope) {
    case 'live': return treeAgents(agents)
    case 'waiting': return agents.filter(waitingOf)
    case 'stopped': return agents.filter((a) => a.lifecycle === 'shut_down')
    case 'archived': return agents.filter((a) => a.lifecycle === 'archived')
  }
}
// The chips' counts. Live is the running agents, as the header's count shows them whatever the scope.
export const scopeCounts = (agents: Agent[]): Record<Scope, number> => ({
  live: agents.filter(live).length,
  waiting: scopeAgents(agents, 'waiting').length,
  stopped: scopeAgents(agents, 'stopped').length,
  archived: scopeAgents(agents, 'archived').length,
})

// What the Activity column shows: an archived agent's state, whatever a stale detail says, else its detail or state.
export const activityOf = (a: Agent) => (a.lifecycle === 'archived' ? stateLabel(a) : a.activity_detail ?? stateLabel(a))

// The time the Age column shows: when a stopped or archived agent last changed (the sidebar's order for its Stopped
// list), else when it was created.
export const whenOf = (a: Agent) => (a.lifecycle === 'shut_down' || a.lifecycle === 'archived' ? a.updated_at : a.created_at)

// The picked columns after one pick or clear: a column picked goes last, as the sidebar's Work columns do.
export function toggleCol(cols: ColumnId[], id: ColumnId): ColumnId[] {
  return cols.includes(id) ? cols.filter((c) => c !== id) : [...cols, id]
}

// A header click: ascending, then descending, then no sort.
export function nextSort(sort: Sort | null, col: SortCol): Sort | null {
  if (sort?.col !== col) return { col, dir: 'asc' }
  return sort.dir === 'asc' ? { col, dir: 'desc' } : null
}

// What each agent shows, looked up once per render: its own ITSA (the one waiting on you first, else its
// first open one), how many agents of the scope it is the parent of, this machine, and the cost unit.
export interface Facts {
  machine: string
  costMode: CostMode
  owned: Map<string, Itsa>
  // The scope's children of each agent: the fold's count.
  kids: Map<string, number>
  // Whether an agent has any child in any scope: its cost shows the tree's spend, whatever the scope lists.
  hasKids: Set<string>
}
export function factsOf(agents: Agent[], itsas: Itsa[], machine: string, scope: Scope = 'live'): Facts {
  const owned = new Map<string, Itsa>()
  for (const x of itsas) {
    if (!x.owner || isClosed(x)) continue
    const cur = owned.get(x.owner)
    if (!cur || (waitsOnHuman(x) && !waitsOnHuman(cur))) owned.set(x.owner, x)
  }
  // The children a fold hides are the scope's, since buildLines lists only the scope's agents: an archived parent's
  // chevron counts its archived children, not its live ones.
  const kids = new Map<string, number>()
  for (const a of scopeAgents(agents, scope)) for (const p of a.parents ?? []) kids.set(p, (kids.get(p) ?? 0) + 1)
  const costMode = treeAgents(agents).find((a) => a.cost)?.cost?.mode ?? 'api'
  const hasKids = new Set<string>()
  for (const a of agents) for (const p of a.parents ?? []) hasKids.add(p)
  return { machine, costMode, owned, kids, hasKids }
}

// The value a column sorts by. Unknown costs and dates sort as the smallest.
export function sortValue(col: SortCol, a: Agent, f: Facts): string | number {
  switch (col) {
    case 'name': return a.name
    case 'role': return a.role ?? a.type ?? ''
    case 'model': return model(a).label
    case 'machine': return a.machine
    case 'itsa': return f.owned.get(a.id)?.key ?? ''
    case 'activity': return activityOf(a)
    case 'wait': return waitsOf(a).length
    case 'context': return a.context_tokens ?? 0
    case 'cost': return a.cost?.own[f.costMode] ?? -1
    case 'unread': return a.unread ?? 0
    case 'age': return Date.parse(whenOf(a)) || 0
  }
}

const text = (x: string | number, y: string | number) => String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' })
// Equal values keep a stable order: by name, then id.
export function compareAgents(x: Agent, y: Agent, sort: Sort, f: Facts): number {
  const p = sortValue(sort.col, x, f)
  const q = sortValue(sort.col, y, f)
  const c = typeof p === 'number' && typeof q === 'number' ? p - q : text(p, q)
  return (sort.dir === 'desc' ? -c : c) || text(x.name, y.name) || text(x.id, y.id)
}

const CREATED = (x: Agent, y: Agent) => x.created_at.localeCompare(y.created_at)
const NEWEST: Sort = { col: 'age', dir: 'desc' }
// With no sort: the assistant first, then the chief of staff, then the oldest.
const ROOT_ORDER = (x: Agent, y: Agent) =>
  (Number(y.kind === 'assistant') - Number(x.kind === 'assistant')) || (Number(y.chief_of_staff ?? 0) - Number(x.chief_of_staff ?? 0)) || CREATED(x, y)

export const matches = (a: Agent, q: string) => !q || [a.name, a.role, a.type, a.model, a.harness, a.machine, a.cwd].some((x) => String(x ?? '').toLowerCase().includes(q))

export type Line =
  | { kind: 'agent'; agent: Agent; depth: number; dup: boolean }
  | { kind: 'group'; key: string; label: string; count: number }

export interface LinesOpts {
  group: Group
  // The search text, as typed.
  query: string
  sort: Sort | null
  // The sidebar's folds: an agent id here hides its children.
  collapsed: Record<string, boolean>
  // Which agents the table lists (scopeAgents); Live when not given.
  scope?: Scope
}

// The table's lines. Tree: the sidebar's order, with children under their parent, indented by depth; an agent
// with two parents shows under each, its second place marked `dup`, and its children are not repeated. A tree
// keeps a parent shown when a child matches the search. Machine and ITSA put a group line before each group's
// agents; Flat is one list.
export function buildLines(agents: Agent[], f: Facts, o: LinesOpts): Line[] {
  const q = o.query.trim().toLowerCase()
  const shown = scopeAgents(agents, o.scope ?? 'live')
  // The Archived and Stopped lists in the tree, with no sort: newest first by Age, roots and siblings alike (S-3088).
  const gone = o.scope === 'stopped' || o.scope === 'archived'
  const sortBy = o.sort ?? (o.group === 'tree' && gone ? NEWEST : null)
  const inOrder = (xs: Agent[], root: boolean) => [...xs].sort((x, y) => (sortBy ? compareAgents(x, y, sortBy, f) : root ? ROOT_ORDER(x, y) : CREATED(x, y)))
  if (o.group !== 'tree') {
    const rows = inOrder(shown.filter((a) => matches(a, q)), true)
    if (o.group === 'flat') return rows.map((agent) => ({ kind: 'agent' as const, agent, depth: 0, dup: false }))
    const by = new Map<string, Agent[]>()
    for (const a of rows) {
      const key = o.group === 'machine' ? a.machine : f.owned.get(a.id)?.key ?? ''
      by.set(key, [...(by.get(key) ?? []), a])
    }
    // Machines: this one first, then by name. ITSAs by key, with the agents in none last.
    const keys = [...by.keys()].sort((x, y) => {
      if (o.group === 'machine') return x === f.machine ? -1 : y === f.machine ? 1 : text(x, y)
      return x === '' ? 1 : y === '' ? -1 : text(x, y)
    })
    return keys.flatMap((key) => {
      const members = by.get(key)!
      const title = o.group === 'machine' ? key : key ? `${key} ${f.owned.get(members[0].id)?.title ?? ''}` : 'Not in an ITSA'
      return [{ kind: 'group' as const, key, label: title, count: members.length }, ...members.map((agent) => ({ kind: 'agent' as const, agent, depth: 0, dup: false }))]
    })
  }
  const ids = new Set(shown.map((a) => a.id))
  // The children of each agent, and each agent's sorted children and visibility, worked out once per call: a long archive
  // costs one pass, not a scan of the list per agent.
  const byParent = new Map<string, Agent[]>()
  for (const a of shown) for (const p of a.parents ?? []) byParent.set(p, [...(byParent.get(p) ?? []), a])
  const kidsCache = new Map<string, Agent[]>()
  const kidsOf = (id: string) => {
    if (!kidsCache.has(id)) kidsCache.set(id, inOrder(byParent.get(id) ?? [], false))
    return kidsCache.get(id)!
  }
  // An agent shows when it or a descendant matches the search. A cycle counts as no match on the way round.
  const seenVisible = new Map<string, boolean>()
  const visible = (a: Agent): boolean => {
    const known = seenVisible.get(a.id)
    if (known !== undefined) return known
    seenVisible.set(a.id, false)
    const r = matches(a, q) || kidsOf(a.id).some(visible)
    seenVisible.set(a.id, r)
    return r
  }
  const roots = inOrder(shown.filter((a) => !(a.parents ?? []).some((p) => ids.has(p))), true).filter((a) => visible(a))
  const lines: Line[] = []
  const placed = new Set<string>()
  const walk = (a: Agent, depth: number, dup: boolean) => {
    lines.push({ kind: 'agent', agent: a, depth, dup })
    if (dup || o.collapsed[a.id]) return
    for (const c of kidsOf(a.id).filter((c) => visible(c))) {
      const dd = placed.has(c.id)
      placed.add(c.id)
      walk(c, depth + 1, dd)
    }
  }
  for (const a of roots) {
    placed.add(a.id)
    walk(a, 0, false)
  }
  return lines
}

// The agents the keyboard can move between, in the order they show: a dup line is the same agent again.
export const orderOf = (lines: Line[]) => lines.flatMap((l) => (l.kind === 'agent' && !l.dup ? [l.agent.id] : []))

// The Agents header's step after a judge (S-3182, S-3489): up one level while it overflows, and back down when the level below
// fits with `slack` to spare. A step back waits until the header is wider than the width that last overflowed, or the header
// holds less than it did then (`overflowNeed`, the estimate of the level it stepped up from): a machine that leaves the strip
// lets the header step back at the same width. Without that wait the estimate of the level below can say it fits while the
// header still overflows, and the two steps alternate at one width.
export interface HeaderStep { level: number; overflowAt: number | null; overflowNeed: number | null }
export function headerStep(s: { level: number; max: number; overflows: boolean; width: number; here: number; need: number; slack: number; overflowAt: number | null; overflowNeed?: number | null }): HeaderStep {
  if (s.overflows) return s.level < s.max ? { level: s.level + 1, overflowAt: s.width, overflowNeed: Number.isFinite(s.here) ? s.here : null } : { level: s.level, overflowAt: s.overflowAt, overflowNeed: s.overflowNeed ?? null }
  const held = s.overflowNeed ?? null
  const wider = s.overflowAt === null || s.width > s.overflowAt || (held !== null && s.need < held - 0.5)
  if (s.level > 0 && wider && s.need <= s.width - s.slack) return { level: s.level - 1, overflowAt: null, overflowNeed: null }
  return { level: s.level, overflowAt: s.overflowAt, overflowNeed: held }
}
