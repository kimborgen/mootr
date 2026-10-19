// The numbers of the drill-down view (S-661), DOM-free so they test without a browser.
import { pct } from '../measure'
import type { ItsaTotals, ScopeAnswer, ScopeWindow, Tot, Typical } from './types'

export const isItsaTotals = (t: ScopeAnswer['totals']): t is ItsaTotals => 'total' in t
export const totalOf = (t: ScopeAnswer['totals']): Tot => (isItsaTotals(t) ? t.total : t)

// Above this multiple of the median, an issue's cost reads as unusual and takes warning ink.
export const UNUSUAL = 1.5
export interface TypicalRead { median: number; multiple: number | null; unusual: boolean }
export function readTypical(t: Typical | null | undefined, cost: number): TypicalRead | null {
  if (!t || !(t.median_cost_usd > 0)) return null
  const multiple = cost / t.median_cost_usd
  return { median: t.median_cost_usd, multiple, unusual: multiple > UNUSUAL }
}

// "4.7×", with one decimal below 10 and none above.
export const timesText = (x: number) => `${x >= 10 ? Math.round(x) : x.toFixed(1)}×`

// The window tile: the weekly windows first (the budget that matters), the largest share leading.
// A window with no known share is left out of the lead and stays in the rest as unknown.
export interface WindowRead { label: string; percent: number | null }
export function readWindows(ws: ScopeWindow[]): { lead: WindowRead | null; rest: WindowRead[] } {
  const rows = ws
    .map((w) => ({ label: `${w.account} ${w.window === 'seven_day' ? 'week' : w.window === 'five_hour' ? '5-hour' : w.window.replace(/_/g, ' ')}`, percent: w.percent, week: w.window === 'seven_day' }))
    .sort((a, b) => Number(b.week) - Number(a.week) || (b.percent ?? -1) - (a.percent ?? -1) || a.label.localeCompare(b.label))
  const [lead, ...rest] = rows
  return { lead: lead ?? null, rest }
}
export const percentText = (p: number | null) => (p == null ? 'unknown' : p > 0 && p < 0.1 ? '<0.1%' : `≈ ${pct(p)}`)

// How long an ITSA has been open: to its close, else to now.
export function openFor(created: string, closed: string | null, now = Date.now()): string {
  const ms = (closed ? Date.parse(closed) : now) - Date.parse(created)
  if (!Number.isFinite(ms) || ms < 0) return ''
  const h = ms / 3_600_000
  return h < 1 ? `${Math.max(1, Math.round(ms / 60_000))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`
}

// An ITSA's chart span: from when it opened, per hour when that is under 48 hours, else per day.
export function itsaSpan(created: string | undefined, now = Date.now()): { since: string; bucket: 'hour' | 'day' } | undefined {
  const t = created ? Date.parse(created) : NaN
  if (!Number.isFinite(t) || t > now) return undefined
  return { since: new Date(t).toISOString(), bucket: now - t < 48 * 3_600_000 ? 'hour' : 'day' }
}
