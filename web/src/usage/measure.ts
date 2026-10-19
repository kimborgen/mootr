// The Usage page's Measure control and its number formats (S-663). Pure and import-free beyond
// the row shape, so the DOM-free chart maths and the components share one rule: one money format,
// one percent format, and one way to pick a row's number in the chosen measure.
import type { Modes } from './types'
import type { UsageMeasure } from './state'

// One money format for the whole page: two decimals under $10, none from $10 up, never three.
// The comparison is on the rounded cents, so $9.999 reads $10 (not $10.00).
export const money = (v: number) => {
  const a = Math.round(Math.abs(v) * 100) / 100
  return (v < 0 ? '-' : '') + '$' + (a >= 10 ? String(Math.round(a)) : a.toFixed(2))
}
// The same helper under the name the page's earlier call sites use.
export const m = money
// One percent format too: <0.1% below a tenth, one decimal under 10, none from 10 up.
export const pct = (p: number) => (p > 0 && p < 0.1 ? '<0.1%' : `${p < 10 ? p.toFixed(1) : Math.round(p)}%`)

// The three ways the page can show cost: API-equivalent dollars, a share of the 7-day window, or
// the real money the subscriptions and paid accounts bill.
export const MEASURES: { id: UsageMeasure; label: string }[] = [
  { id: 'api', label: 'API $' },
  { id: 'week', label: '% of week' },
  { id: 'real', label: 'Real $' },
]
export const MEASURE_CAPTION: Record<UsageMeasure, string> = { api: 'API-equivalent', week: 'share of the 7-day window', real: 'subscription + paid' }

// The Settings cost unit (cost.display.mode) as one of the page's three measures: the 7-day
// window is % of week, the subscription is Real $; everything else (api, a 5-hour window) reads
// as API $. The Measure control defaults to this (S-663).
export function toMeasure(mode: string | null | undefined): UsageMeasure {
  return mode === 'seven_day' ? 'week' : mode === 'subscription' ? 'real' : 'api'
}

// The number a row shows in the chosen measure. `real` is the subscription dollars plus the real
// paid spend; it is null when the subscription part can't be computed, so the UI shows a dash,
// never $0.00 or an invented number. A value is null too when the daemon sent no units at all.
export function measureValue(modes: Modes | null | undefined, measure: UsageMeasure): number | null {
  if (!modes) return null
  if (measure === 'week') return modes.seven_day
  if (measure === 'real') return modes.subscription == null ? null : modes.subscription + modes.paid_usd
  return modes.api
}
export function measureText(v: number | null, measure: UsageMeasure): string {
  return v == null ? '—' : measure === 'week' ? pct(v) : money(v)
}
export const measureCell = (modes: Modes | null | undefined, measure: UsageMeasure) => measureText(measureValue(modes, measure), measure)
