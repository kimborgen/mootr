// The maths of the Usage overview charts (S-660): stacking, scale ticks, shares, colour slots.
// Pure and DOM-free so it tests without a browser. Input is GET /api/usage/series.
import { measureValue } from '../measure'
import type { UsageMeasure } from '../state'
import type { Modes } from '../types'

export type DrillKind = 'tree' | 'itsa' | 'model' | 'harness' | 'agent'
export interface DrillTarget { kind: DrillKind; id: string }

// A chart value's cost in the page's measure (S-663): the API-equivalent dollars or the modes the
// daemon sent. A measure the row has no value for reads as 0 in a chart (a stacked column can't
// show a dash), so an uncalibrated row contributes nothing rather than an invented height.
export interface SeriesValue { cost_usd: number; modes?: Modes }
export const valueOf = (v: SeriesValue | undefined, measure: UsageMeasure): number =>
  Math.max(0, (v == null ? 0 : measure === 'api' ? v.cost_usd : measureValue(v.modes, measure) ?? 0))

export interface SeriesGroupInfo { id: string; name: string; harness?: string }
export interface SeriesRow extends SeriesValue { t: string; groups: Record<string, SeriesValue> }
export interface Series {
  days: number
  group: DrillKind
  bucket: 'day' | 'hour'
  groups: SeriesGroupInfo[]
  rows: SeriesRow[]
  // The same-length period before it, bucketed by the same groups; one row per bucket.
  previous_rows?: SeriesRow[]
  total: SeriesValue
  previous: SeriesValue
}

export const OTHER = 'other'
// The widest a column is drawn, in px: a one-day period is a column, not a block.
export const MAX_COLUMN_PX = 24

export interface Segment { id: string; value: number; y0: number; y1: number }
export interface Column { t: string; total: number; segments: Segment[] }

// Stacks one row's groups bottom to top in legend order, dropping zero values.
export function stackColumn(row: SeriesRow, groups: SeriesGroupInfo[], measure: UsageMeasure = 'api'): Column {
  let y = 0
  const segments: Segment[] = []
  for (const g of groups) {
    const value = valueOf(row.groups[g.id], measure)
    if (value <= 0) continue
    segments.push({ id: g.id, value, y0: y, y1: y + value })
    y += value
  }
  return { t: row.t, total: y, segments }
}

export const stackAll = (s: Series, measure: UsageMeasure = 'api'): Column[] => s.rows.map((r) => stackColumn(r, s.groups, measure))

// Three clean ticks: the smallest step from 1, 2, 2.5, 5 times a power of ten whose three
// multiples cover the maximum. Empty or zero input gives a unit scale, never NaN.
export function niceTicks(max: number): { ticks: number[]; top: number } {
  if (!Number.isFinite(max) || max <= 0) return { ticks: [0.5, 1, 1.5], top: 1.5 }
  const raw = max / 3
  const pow = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 2.5, 5, 10].map((f) => f * pow).find((s) => s * 3 >= max - 1e-9)!
  return { ticks: [step, step * 2, step * 3], top: step * 3 }
}

// The groups ranked for the bar list: by period total descending, Other last. Groups with no
// spend in the period are left out. The share is of the period total.
export interface Ranked { id: string; name: string; harness?: string; value: number; share: number }
export function rankGroups(s: Series, measure: UsageMeasure = 'api'): Ranked[] {
  const sums = new Map<string, number>()
  for (const r of s.rows) for (const g of s.groups) sums.set(g.id, (sums.get(g.id) ?? 0) + valueOf(r.groups[g.id], measure))
  const total = [...sums.values()].reduce((a, b) => a + b, 0)
  const rows = s.groups.filter((g) => (sums.get(g.id) ?? 0) > 0).map((g) => ({ ...g, value: sums.get(g.id) ?? 0, share: total > 0 ? (sums.get(g.id) ?? 0) / total : 0 }))
  const rank = (x: Ranked) => (x.id === OTHER ? 1 : 0)
  return rows.sort((a, b) => rank(a) - rank(b) || b.value - a.value || a.name.localeCompare(b.name))
}

// The previous period's columns, stacked by the legend, for periods up to 14 days (a month of
// paired columns is a comb). The server buckets `previous_rows` by the current legend, so no spend
// is lost. Each current day takes the previous day by date (the date minus the period's length);
// a day with no row is an empty column. Hourly series have no previous columns.
export const PREVIOUS_MAX_DAYS = 14
export function previousColumns(current: Series, measure: UsageMeasure = 'api'): Column[] {
  const prev = current.previous_rows
  if (!prev || current.rows.length > PREVIOUS_MAX_DAYS || current.bucket !== 'day' || !current.rows.length) return []
  const byT = new Map(prev.map((r) => [r.t, r]))
  const span = current.rows.length
  const shift = (t: string) => new Date(Date.parse(t.slice(0, 10) + 'T00:00:00Z') - span * 86_400_000).toISOString().slice(0, 10)
  return current.rows.map((r) => {
    const t = shift(r.t)
    return stackColumn(byT.get(t) ?? { t, cost_usd: 0, groups: {} }, current.groups, measure)
  })
}

// Colour slots: a group keeps the series slot it first got, in fixed order 1..6, so a filter
// or a changed period never repaints it. Other is neutral (null). Harness groups use their
// own hues.
export const SERIES_SLOTS = 6
export type ColorMap = Map<string, number>
export function slotOf(map: ColorMap, kind: string, id: string): number | null {
  if (id === OTHER || id === 'unattributed') return null
  const key = kind + '\u0000' + id
  let slot = map.get(key)
  if (slot === undefined) {
    const used = new Set([...map.entries()].filter(([k]) => k.startsWith(kind + '\u0000')).map(([, v]) => v))
    slot = 1
    while (used.has(slot) && slot <= SERIES_SLOTS) slot++
    if (slot > SERIES_SLOTS) slot = (map.size % SERIES_SLOTS) + 1
    map.set(key, slot)
  }
  return slot
}

const HARNESS_VAR: Record<string, string> = { claude: '--h-claude', codex: '--h-codex', opencode: '--h-opencode' }
export function colorVar(map: ColorMap, kind: string, g: { id: string; harness?: string }): string {
  if (kind === 'harness' && HARNESS_VAR[g.id]) return `var(${HARNESS_VAR[g.id]})`
  const slot = slotOf(map, kind, g.id)
  return slot == null ? 'var(--text-muted)' : `var(--series-${slot})`
}

// A bucket's axis label: the day as "Oct 12" or the hour as "14:00". Day keys are UTC days.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function bucketLabel(t: string, bucket: 'day' | 'hour'): string {
  if (bucket === 'hour') return t.slice(11, 16)
  const mo = Number(t.slice(5, 7)) - 1
  return `${MONTHS[mo] ?? ''} ${Number(t.slice(8, 10))}`
}

// The short axis label: the day number, with the month on the first column and on the 1st;
// the hour as "14".
export function axisLabel(t: string, bucket: 'day' | 'hour', first: boolean, room = true): string {
  if (bucket === 'hour') return t.slice(11, 13)
  const d = Number(t.slice(8, 10))
  return room && (first || d === 1) ? `${MONTHS[Number(t.slice(5, 7)) - 1] ?? ''} ${d}` : String(d)
}

// Every how-many-th column carries an axis label: all when each has room for two digits,
// every other on a phone with a month of days, every fourth when more crowded.
export function labelEvery(count: number, widthPx: number): number {
  const per = widthPx / Math.max(1, count)
  return per >= 16 ? 1 : per >= 8 ? 2 : 4
}
