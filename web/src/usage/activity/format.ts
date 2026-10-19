// The Activity tab's pure rules (S-1011, S-1012): how agent-hours read, the colour of each clock group
// and category, the rows of Where the time goes, the notes under the tiles and bottlenecks, the cost
// spreads of finished issues and the order of Agents by tree. DOM-free,
// so the components and their tests share them.
import { measureValue } from '../measure'
import { modelName } from '../shared'
import type { UsageMeasure } from '../state'
import type { ActBottleneck, ActConfig, ActCost, ActSummary, ActTreeRow, ClockGroupKey } from '../types'

// Agent-hours in the unit that reads short: 45 s, 12 min, 4.5 h, 196 h, 1,030 h. A no-break space
// keeps the number and its unit on one line at 360 px.
const NB = '\u00a0'
export function hours(s: number | null | undefined): string {
  if (s == null) return '—'
  if (s < 60) return `${Math.round(s)}${NB}s`
  if (s < 3600) return `${Math.round(s / 60)}${NB}min`
  const h = s / 3600
  return h < 10 ? `${h.toFixed(1)}${NB}h` : `${Math.round(h).toLocaleString('en-US')}${NB}h`
}
// A share in whole percent; under one percent reads <1%.
export const share = (v: number, total: number) => (total > 0 ? (v > 0 && v / total < 0.01 ? '<1%' : `${Math.round((v / total) * 100)}%`) : '—')
export const width = (v: number, total: number) => `${total > 0 ? Math.max(0, (v / total) * 100) : 0}%`

// A cost in the chosen measure; API $ falls back to the dollars when the daemon sent no modes.
export function costIn(c: ActCost | null | undefined, measure: UsageMeasure): number | null {
  if (!c) return null
  if (measure === 'api') return c.modes ? c.modes.api : c.cost_usd
  return measureValue(c.modes, measure)
}

// The clock groups' colours, as the Agents by tree bars will use them: working is the strong one; the
// human's share is the warning ochre, so it stands out. Idle is a light neutral: in dark the warning
// ochre is amber-300, so an amber idle would read as the human's.
export const GROUP_COLOR: Record<ClockGroupKey, string> = {
  working: 'var(--indigo-500)', others: 'var(--coal-200)', you: 'var(--status-warning-fg)', friction: 'var(--rust-300)', idle: 'var(--sand-400)',
}
// The order the clock bar and its legend read in: work first, then what it waits on.
export const GROUP_ORDER: ClockGroupKey[] = ['working', 'others', 'you', 'friction', 'idle']
const GROUP_LABEL: Record<ClockGroupKey, string> = {
  working: 'Working', others: 'On other agents and jobs', you: 'On you', friction: 'Friction', idle: 'Idle',
}
// What each group holds, under its label; others is the expected kind of waiting.
const GROUP_HINT: Partial<Record<ClockGroupKey, string>> = { others: 'expected', friction: 'cost pauses, queue, polling, stalls', idle: 'restart, compaction' }

export interface ClockRow { key: ClockGroupKey; label: string; hint?: string; seconds: number; color: string }
export function clockRows(d: ActSummary): ClockRow[] {
  const by = new Map(d.clock.groups.map((g) => [g.key, g.seconds]))
  return GROUP_ORDER.map((key) => ({ key, label: GROUP_LABEL[key], hint: GROUP_HINT[key], seconds: by.get(key) ?? 0, color: GROUP_COLOR[key] }))
}

// Categories take the series colours in order; --series-2 is skipped, since it reads like the
// warning ochre that marks the human. The rest fold into "N more" in sand.
export const CATEGORY_COLORS = ['var(--series-1)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--series-6)']
export const MORE_COLOR = 'var(--sand-400)'

export interface CategoryRow { key: string; label: string; value: number | null; color: string; muted?: boolean }
export const UNCLASSIFIED = 'unclassified'
// Unclassified work is not a category: it is a muted last row, never a ranked one.
export const UNCLASSIFIED_COLOR = 'var(--text-muted)'
// The working categories by time or by cost: the largest five real ones, then the rest as one row,
// then Unclassified (above zero) last. In cost a null mode leaves every value null (shown as a dash),
// never a guess.
export function categoryRows(d: ActSummary, by: 'time' | 'cost', measure: UsageMeasure): CategoryRow[] {
  const val = (c: ActSummary['working_by_category'][number]) => (by === 'time' ? c.seconds : costIn(c, measure))
  const all = d.working_by_category.map((c) => ({ key: c.key, label: c.label, value: val(c) }))
    .filter((c) => c.value == null || c.value > 0)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || a.label.localeCompare(b.label))
  const list = all.filter((c) => c.key !== UNCLASSIFIED)
  const shown = list.length > CATEGORY_COLORS.length + 1 ? list.slice(0, CATEGORY_COLORS.length) : list
  const rows: CategoryRow[] = shown.map((c, i) => ({ ...c, color: CATEGORY_COLORS[i] ?? MORE_COLOR }))
  const rest = list.slice(shown.length)
  if (rest.length) rows.push({ key: 'more', label: `${rest.length} more`, value: rest.some((c) => c.value == null) ? null : rest.reduce((n, c) => n + (c.value ?? 0), 0), color: MORE_COLOR })
  const unclassified = all.find((c) => c.key === UNCLASSIFIED)
  if (unclassified) rows.push({ ...unclassified, color: UNCLASSIFIED_COLOR, muted: true })
  return rows
}
// The real category that takes the most, for the cost-per-hour note: never "N more" or Unclassified.
export const topCategory = (rows: CategoryRow[]) => rows.find((c) => c.key !== 'more' && c.key !== UNCLASSIFIED && c.value != null)

// Short names for friction's parts, for the tile's note.
const FRICTION_SHORT: Record<string, string> = {
  'throttle.cost': 'cost pauses', 'throttle.scheduler': 'queue', 'tool.sleep': 'polling', 'tool.contention': 'locks', 'model.stall': 'model stalls',
}
// "incl. cost pauses 87 h, polling 35 h": friction's two largest parts.
export function frictionNote(parts: Record<string, number>): string {
  const top = Object.entries(parts).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2)
  return top.length ? `incl. ${top.map(([k, v]) => `${FRICTION_SHORT[k] ?? k} ${hours(v)}`).join(', ')}` : 'none in this window'
}

// "replies 36 h · new prompts 43 h", and permissions when there were any.
export function youNote(y: ActSummary['tiles']['you']): string {
  const parts = [`replies ${hours(y.reply_s)}`, `new prompts ${hours(y.prompt_s)}`]
  if (y.permission_s > 0) parts.push(`permissions ${hours(y.permission_s)}`)
  return parts.join(' · ')
}

// A bottleneck's single longest span, when it is most of the total: "one 12 h pause" (a run for slow work).
export function longestNote(b: ActBottleneck): string | null {
  if (!b.longest || b.longest.seconds <= b.seconds / 2) return null
  return `one ${hours(b.longest.seconds)} ${b.group === 'working' ? 'run' : 'pause'}`
}
export const isYou = (b: ActBottleneck) => b.key.startsWith('human.')

// A config group's cost spread in the chosen measure (S-1012): API $ from the dollars when the daemon
// sent no modes, % of week from the 7-day window, Real $ from each issue's subscription + paid. A mode
// with no values is a null median and p75, shown as a dash.
export function spreadIn(c: ActConfig, measure: UsageMeasure): { median: number | null; p75: number | null } {
  const s = measure === 'api' ? c.cost_modes?.api ?? c.cost_usd : measure === 'week' ? c.cost_modes?.seven_day : c.cost_modes?.real
  return { median: s?.median ?? null, p75: s?.p75 ?? null }
}
// "claude · claude-opus-5-5" as the harness and the model's short name.
export function configParts(config: string | undefined): { harness: string; model: string } {
  const [harness, ...rest] = (config ?? 'unknown').split(' · ')
  return rest.length ? { harness, model: modelName(rest.join(' · ')) } : { harness: '', model: modelName(harness) }
}
// The range mark's two positions as percents of the largest p75 shown: the dot at the median, the
// tick at p75. A row without a p75 places its tick at the median.
export function rangeMark(s: { median: number | null; p75: number | null }, max: number): { dot: number; tick: number } | null {
  if (s.median == null || max <= 0) return null
  const pos = (v: number) => Math.min(100, Math.max(0, (v / max) * 100))
  return { dot: pos(s.median), tick: pos(s.p75 ?? s.median) }
}
// The lead time of a closed issue in a short unit: 3.4 h, 2 d.
export const leadText = (s: number | null) => (s == null ? '—' : s >= 48 * 3600 ? `${(s / 86400).toFixed(1)}${NB}d` : hours(s))

// Agents by tree (S-1012): the sort value, the clock groups as bar parts, and the value text.
export type TreeSort = 'cost' | 'working' | 'friction'
export function treeValue(r: ActTreeRow, by: TreeSort, measure: UsageMeasure): number {
  return by === 'working' ? r.working_s : by === 'friction' ? r.friction_s : costIn(r, measure) ?? 0
}
export function sortTrees<T extends ActTreeRow>(rows: T[], by: TreeSort, measure: UsageMeasure): T[] {
  return [...rows].sort((a, b) => treeValue(b, by, measure) - treeValue(a, by, measure) || b.working_s - a.working_s || a.name.localeCompare(b.name))
}
export function treeParts(r: ActTreeRow): { key: ClockGroupKey; seconds: number; color: string }[] {
  const s: Record<ClockGroupKey, number> = { working: r.working_s, others: r.others_s, you: r.you_s, friction: r.friction_s, idle: r.idle_s }
  return GROUP_ORDER.map((key) => ({ key, seconds: s[key], color: GROUP_COLOR[key] }))
}
export const GROUP_SHORT: Record<ClockGroupKey, string> = { working: 'working', others: 'other agents', you: 'you', friction: 'friction', idle: 'idle' }
