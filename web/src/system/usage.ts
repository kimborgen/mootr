// The system view header's instruments from GET /api/usage: each account's subscription windows
// and the day's spend, with spend per day for the sparkline. Fetched while the view is shown,
// every 30 s and on each usage.changed event; a failed fetch keeps the last good answer.
import { useEffect, useState } from 'react'
import { api } from '../api'
import { onUsageChanged } from '../store'

interface Window { used_percentage?: number | null }
interface Account { account: string; match?: { harness?: string }; windows?: Record<string, Window> }
export interface SystemUsage {
  today: { cost_usd: number }
  accounts?: Account[]
  by_day?: { day: string; cost_usd: number }[]
}
// `minor`: an account's later window (the week), which a narrow header drops first.
export interface Meter { id: string; label: string; title: string; pct: number; minor: boolean; harness: string }

const REFRESH_MS = 30_000
const HARNESS_SHORT: Record<string, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' }
const WINDOW_LABEL: Record<string, string> = { five_hour: '5 h', seven_day: 'week' }

// One meter per known window of each account: the 5-hour window named for its harness, the
// week after it named only "week", as the prototype reads them.
export function meters(u: SystemUsage | null): Meter[] {
  const out: Meter[] = []
  for (const a of u?.accounts ?? []) {
    const who = HARNESS_SHORT[a.match?.harness ?? ''] ?? a.account
    let first = true
    for (const w of ['five_hour', 'seven_day']) {
      const pct = a.windows?.[w]?.used_percentage
      if (pct == null) continue
      out.push({ id: `${a.account}:${w}`, label: first ? `${who} ${WINDOW_LABEL[w]}` : WINDOW_LABEL[w], title: `${a.account}: ${Math.round(pct)}% of the ${w === 'five_hour' ? '5-hour' : '7-day'} window used`, pct, minor: !first, harness: a.match?.harness ?? '' })
      first = false
    }
  }
  return out
}

// The sparkline's path over the last days' spend, in a w by h box, or '' with fewer than two days.
export function sparkPath(days: { cost_usd: number }[], w: number, h: number): string {
  if (days.length < 2) return ''
  const max = Math.max(...days.map((d) => d.cost_usd), 0.01)
  const step = w / (days.length - 1)
  return days.map((d, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)} ${(h - 1 - (d.cost_usd / max) * (h - 2)).toFixed(1)}`).join('')
}

export function useSystemUsage(shown: boolean): SystemUsage | null {
  const [u, setU] = useState<SystemUsage | null>(null)
  useEffect(() => {
    if (!shown) return
    let dead = false
    const load = () => api<SystemUsage>('GET', '/api/usage').then((x) => { if (!dead) setU(x) }).catch(() => {})
    void load()
    const t = setInterval(load, REFRESH_MS)
    const off = onUsageChanged(() => void load())
    return () => { dead = true; clearInterval(t); off() }
  }, [shown])
  return u
}
