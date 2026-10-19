// Sort and filter for the Work table (S-1504), as pure logic: the state a layout keeps (which
// column sorts, which filters apply), how a stored copy is checked, and how one value meets one
// filter. The columns say what a row's value is (columns.tsx); model.ts applies this tree-aware.
// No browser imports, so the unit tests run in node.
import type { CellContext } from './columns'
import type { WorkRow } from './model'

export type ColFilter =
  // `values` keeps the listed ones; `not` is a standing rule that hides them, so a value that
  // appears later still shows. One or the other (a stored pair collapses to `values`).
  | { kind: 'values'; values?: string[]; not?: string[] }
  | { kind: 'text'; q: string }
  | { kind: 'range'; min?: number; max?: number }
  | { kind: 'date'; preset?: DatePreset; from?: string; to?: string }
  | { kind: 'has'; has: boolean }
  | { kind: 'check'; value: boolean }
export type FilterKind = ColFilter['kind']
export const FILTER_KINDS: FilterKind[] = ['values', 'text', 'range', 'date', 'has', 'check']
export type DatePreset = 'hour' | 'today' | '7d' | 'older2d' | 'older7d'
export const DATE_PRESETS: DatePreset[] = ['hour', 'today', '7d', 'older2d', 'older7d']
// The "(Blank)" entry of a values filter: a row with no value for the column.
export const BLANK = ''

export interface SortKey { col: string; dir: 'asc' | 'desc' }

// What a column's filter reads off a row, by kind: `values` a string or several (none is blank),
// `text` the string searched, `range` a number, `date` an ISO date or time, `has` and `check` a boolean.
// Null is blank; undefined is "source not loaded", and the filter ignores it.
export type FilterCell = string | string[] | number | boolean | null | undefined
export interface FilterValue { value: string; label: string; n: number }

// The part of a Work column that sorting, filtering and searching read.
export interface SortFilterCol {
  id: string
  // The value rows sort by. Null or '' is blank, and sorts last in both directions.
  sortValue?(row: WorkRow, cx: CellContext): string | number | null
  // Everything the column shows as text, for a search across columns (S-1519).
  text?(row: WorkRow, cx: CellContext): string
  filter?: {
    kind: FilterKind | FilterKind[]
    // The distinct values over `rows`, with counts, for a values filter's checklist.
    values?(rows: WorkRow[], cx: CellContext): FilterValue[]
    valueOf(row: WorkRow, cx: CellContext, kind: FilterKind): FilterCell
    // The order the column's groups take when grouped by it (S-1520), as a comparison of two values.
    // Without it the groups follow `values`.
    groupOrder?(a: string, b: string): number
  }
}
export type ColLookup = (id: string) => SortFilterCol | undefined

export const kindsOf = (c: SortFilterCol | undefined): FilterKind[] => {
  const k = c?.filter?.kind
  return k === undefined ? [] : Array.isArray(k) ? k : [k]
}

// The distinct values of `rows` for a column, with counts, from a function giving each row's
// values (none is blank). `order` lists values that come first, in that order, even at 0.
export function countValues(rows: WorkRow[], read: (row: WorkRow) => string[], label: (value: string) => string, order: string[] = []): FilterValue[] {
  const n = new Map<string, number>(order.map((v) => [v, 0]))
  for (const r of rows) for (const v of new Set(read(r).length ? read(r) : [BLANK])) n.set(v, (n.get(v) ?? 0) + 1)
  const blank = n.get(BLANK)
  n.delete(BLANK)
  return [...[...n].map(([value, count]) => ({ value, label: label(value), n: count })), ...(blank ? [{ value: BLANK, label: '(Blank)', n: blank }] : [])]
}

const isBlank = (v: unknown) => v === null || v === undefined || v === '' || (typeof v === 'number' && Number.isNaN(v))

// The local calendar day (YYYY-MM-DD) of an ISO date or time. A bare day is already one.
export function dayOf(iso: string): string {
  if (!iso.includes('T')) return iso.slice(0, 10)
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const HOUR = 3_600_000
const DAY = 24 * HOUR
function inPreset(p: DatePreset, iso: string, now: number): boolean {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return false
  const age = now - t
  switch (p) {
    case 'hour': return age <= HOUR
    case 'today': return dayOf(iso) === dayOf(new Date(now).toISOString())
    case '7d': return age <= 7 * DAY
    case 'older2d': return age > 2 * DAY
    case 'older7d': return age > 7 * DAY
  }
}

// Whether a value meets a filter. A blank value meets only a values filter that lists blank, a
// has filter for "no", and a text filter with no text; a range or date filter with a bound excludes it.
export function matchFilter(f: ColFilter, v: FilterCell, now = Date.now()): boolean {
  switch (f.kind) {
    case 'values': {
      const list = Array.isArray(v) ? v : [isBlank(v) ? BLANK : String(v)]
      const vals = list.length ? list : [BLANK]
      // An include list keeps a row with any listed value; a `not` rule hides a row with any listed value.
      return (!f.values || vals.some((x) => f.values!.includes(x))) && !vals.some((x) => f.not?.includes(x))
    }
    case 'text': {
      const q = f.q.trim().toLowerCase()
      if (!q) return true
      return (Array.isArray(v) ? v.join(' ') : isBlank(v) ? '' : String(v)).toLowerCase().includes(q)
    }
    case 'range': {
      if (f.min === undefined && f.max === undefined) return true
      if (typeof v !== 'number' || Number.isNaN(v)) return false
      return (f.min === undefined || v >= f.min) && (f.max === undefined || v <= f.max)
    }
    case 'date': {
      if (!f.preset && !f.from && !f.to) return true
      if (typeof v !== 'string' || !v) return false
      if (f.preset && !inPreset(f.preset, v, now)) return false
      const day = dayOf(v)
      return (!f.from || day >= f.from) && (!f.to || day <= f.to)
    }
    case 'has': {
      const has = Array.isArray(v) ? v.length > 0 : typeof v === 'boolean' ? v : !isBlank(v)
      return has === f.has
    }
    case 'check': return Boolean(v) === f.value
  }
}

// Whether a column's filter keeps a row. A filter its column can't apply (no such column, or a kind
// it doesn't have, or a value whose source isn't loaded yet) keeps every row, so a stale filter never hides work.
export function keeps(col: SortFilterCol | undefined, f: ColFilter, row: WorkRow, cx: CellContext): boolean {
  if (!col?.filter || !kindsOf(col).includes(f.kind)) return true
  const v = col.filter.valueOf(row, cx, f.kind)
  // Undefined is "source not loaded" (null is blank): the filter waits for it rather than hide every row.
  return v === undefined ? true : matchFilter(f, v, cx.now)
}

// The comparison for sorted rows: the keys in turn, blanks last whichever way, numbers as numbers,
// text by locale with digit runs as numbers. Equal rows compare 0, so a stable sort keeps their order.
export function sorted<T>(items: T[], keys: SortKey[] | undefined, cols: ColLookup | undefined, cx: CellContext, rowOf: (x: T) => WorkRow): T[] {
  const live = (keys ?? []).flatMap((k) => { const c = cols?.(k.col); return c?.sortValue ? [{ dir: k.dir, read: c.sortValue.bind(c) }] : [] })
  if (!live.length || items.length < 2) return items
  const deco = items.map((x) => { const row = rowOf(x); return { x, v: live.map((k) => k.read(row, cx)) } })
  deco.sort((a, b) => {
    for (let i = 0; i < live.length; i++) {
      const [p, q] = [a.v[i], b.v[i]]
      const [bp, bq] = [isBlank(p), isBlank(q)]
      if (bp || bq) { if (bp && bq) continue; return bp ? 1 : -1 }
      const c = typeof p === 'number' && typeof q === 'number' ? p - q : String(p).localeCompare(String(q), undefined, { numeric: true, sensitivity: 'base' })
      if (c) return live[i].dir === 'desc' ? -c : c
    }
    return 0
  })
  return deco.map((d) => d.x)
}

// Checks a stored sort: well-formed keys only, one per column, in order. With `ids`, a column the
// registry doesn't have drops too.
export function cleanSort(raw: unknown, ids?: string[]): SortKey[] {
  const seen = new Set<string>()
  const out: SortKey[] = []
  if (!Array.isArray(raw)) return out
  for (const k of raw) {
    if (!k || typeof k !== 'object') continue
    const { col, dir } = k as Record<string, unknown>
    if (typeof col !== 'string' || (dir !== 'asc' && dir !== 'desc') || seen.has(col) || (ids && !ids.includes(col))) continue
    seen.add(col)
    out.push({ col, dir })
  }
  return out
}

const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined)
const day = (x: unknown) => (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : undefined)

// One stored filter, or null when it is malformed. Keys come out in one fixed order.
export function cleanFilter(raw: unknown): ColFilter | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  switch (r.kind) {
    case 'values': {
      const list = (x: unknown) => (Array.isArray(x) && x.every((v) => typeof v === 'string') ? [...new Set(x as string[])] : null)
      const [values, not] = [r.values === undefined ? undefined : list(r.values), r.not === undefined ? undefined : list(r.not)]
      if (values === null || not === null || (values === undefined && !not?.length)) return null
      // An include list already leaves out what `not` hides, so the two collapse to the list.
      if (values) return { kind: 'values', values: not?.length ? values.filter((v) => !not.includes(v)) : values }
      return { kind: 'values', not: not! }
    }
    case 'text': return typeof r.q === 'string' ? { kind: 'text', q: r.q } : null
    case 'range': {
      const [min, max] = [num(r.min), num(r.max)]
      if ((r.min !== undefined && min === undefined) || (r.max !== undefined && max === undefined)) return null
      return { kind: 'range', ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) }
    }
    case 'date': {
      const preset = DATE_PRESETS.find((p) => p === r.preset)
      const [from, to] = [day(r.from), day(r.to)]
      if ((r.preset !== undefined && !preset) || (r.from !== undefined && !from) || (r.to !== undefined && !to)) return null
      return { kind: 'date', ...(preset ? { preset } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) }
    }
    case 'has': return typeof r.has === 'boolean' ? { kind: 'has', has: r.has } : null
    case 'check': return typeof r.value === 'boolean' ? { kind: 'check', value: r.value } : null
    default: return null
  }
}

// Checks stored filters: well-formed ones only; with `ids`, only for columns the registry has.
export function cleanFilters(raw: unknown, ids?: string[]): Record<string, ColFilter> {
  const out: Record<string, ColFilter> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [col, f] of Object.entries(raw as Record<string, unknown>)) {
    if (ids && !ids.includes(col)) continue
    const clean = cleanFilter(f)
    if (clean) out[col] = clean
  }
  return out
}
