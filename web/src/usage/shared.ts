import { openWorld } from '../actions'
import { HARNESS, model as modelOf } from '../format'

// The page's one money/percent format and Measure control live in ./measure.ts (S-663), re-exported
// here so the components that already import ./shared keep working.
export { m, money, pct, MEASURES, MEASURE_CAPTION, toMeasure, measureValue, measureText, measureCell } from './measure'

export const WIN_LABEL: Record<string, string> = { five_hour: '5-hour', seven_day: '7-day' }
export const winLabel = (w: string) => WIN_LABEL[w] ?? w.replace(/_/g, ' ')

// A reset instant, short on a phone: the time today, or the date and time otherwise.
export function timeOf(ts: number | string): string {
  const d = new Date(typeof ts === 'number' ? ts * 1000 : ts)
  if (Number.isNaN(d.getTime())) return ''
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// Opens Settings on the Spending section, the way the search palette opens a section.
export function openSpending() {
  try { localStorage.setItem('stam/settings-section', 'spend'); localStorage.removeItem('stam/settings-item') } catch {}
  openWorld('config')
  window.dispatchEvent(new CustomEvent('stam:open-setting', { detail: { section: 'spend' } }))
}

// A model in short words, as the sidebar names it: "Opus 5.5", "DeepSeek v4.1 flash". An id that
// isn't a known family (gpt-6.1-sol, a decide purpose) stays as it is.
export function modelName(id: string | null | undefined): string {
  if (!id) return 'unknown model'
  const ds = id.match(/deepseek-v([\d.]+)(?:-(\w+))?/)
  if (ds) return `DeepSeek v${ds[1]}${ds[2] ? ' ' + ds[2] : ''}`
  if (!/claude-/.test(id)) return id.split('/').pop()!.replace(/^~/, '')
  return modelOf({ model: id }).label.replace(/^\w/, (c) => c.toUpperCase())
}
// A harness's label and colour token; stam's own spend (decide purposes, on openrouter) reads as stam.
export const harnessLabel = (h: string) => HARNESS[h] ?? (h === 'openrouter' || !h ? 'mootr' : h)
export const harnessColor = (h: string) => (HARNESS[h] ? `var(--h-${h})` : 'var(--text-muted)')
