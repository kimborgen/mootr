// The four headline tiles under the limits band: spend over the period with its trend, real money
// this month, issues finished in the period, and today. Every cost number follows the page's
// Measure control (S-663), so the tile reads API $, % of the 7-day window, or real $.
import { apiDays, useUsageState, type UsagePeriod } from './state'
import { chartDays } from './charts/OverviewCharts'
import { measureText, MEASURE_CAPTION, measureValue, money } from './measure'
import type { Modes } from './types'
import type { Series } from './charts/math'
import type { AgentRow, Issues, Usage } from './types'
import { paidKnown } from './Limits'
import { sparkPath } from '../system/usage'

const DAY_MS = 86_400_000
const PERIOD_NAME: Record<number, string> = { 1: 'today', 7: '7 days', 30: '30 days', 0: 'all time' }
export const periodName = (days: number) => PERIOD_NAME[days] ?? `${days} days`

export function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const i = s.length >> 1
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2
}

// The closed issues finished in the period (days 0 is all time).
export function finishedIn(d: Issues, days: UsagePeriod, now = Date.now()) {
  // N days is N calendar days ending today (UTC, as the usage rows are keyed).
  const from = days === 0 ? 0 : Date.parse(new Date(now).toISOString().slice(0, 10)) - (days <= 1 ? 0 : apiDays(days)) * DAY_MS
  return d.issues.filter((r) => r.kind === 'issue' && r.closed_at && ['done', 'canceled', 'duplicate', 'wont_do'].includes(r.status) && Date.parse(r.closed_at) >= from)
}

// The change against the previous period, or null when it can't be told: all time and today have none.
export function trend(s: Series | null, days: UsagePeriod, value: (v: { cost_usd: number; modes?: Modes }) => number | null = (v) => v.cost_usd): { pct: number; up: boolean } | null {
  if (!s || s.group !== 'tree' || days <= 1 || s.days !== chartDays(days)) return null
  const cur = value(s.total)
  const prev = value(s.previous)
  if (cur == null || prev == null || !(prev > 0)) return null
  const pct = ((cur - prev) / prev) * 100
  return { pct: Math.round(Math.abs(pct)), up: pct > 0 }
}

export function Tile({ label, value, children, spark }: { label: string; value: string; children?: React.ReactNode; spark?: string }) {
  return (
    <div className="tile">
      <div className="mb-mlabel">{label}</div>
      <div className="tile-val"><span className="mb-mval">{value}</span>{spark ? <svg className="tile-spark" viewBox="0 0 64 20" preserveAspectRatio="none" aria-hidden="true"><path d={spark} /></svg> : null}</div>
      <div className="mb-mnote">{children}</div>
    </div>
  )
}

export function Tiles({ u, days, series, issues, issuesFailed }: { u: Usage; days: UsagePeriod; series: Series | null; issues: Issues | null; issuesFailed: boolean }) {
  const { measure } = useUsageState()
  // A row's number in the chosen measure; for API $ it is the row's own dollars even without modes.
  const value = (v: { cost_usd: number; modes?: Modes }) => (measure === 'api' ? v.cost_usd : measureValue(v.modes, measure))
  const t = trend(series, days, value)
  // The series total covers the same window as its change; without it, the days' sum.
  const spend = t != null && series ? value(series.total) : (measure === 'api'
    ? u.by_day.reduce((a, d) => a + (d.cost_usd ?? 0), 0)
    : u.by_day.length && u.by_day.every((d) => measureValue(d.modes, measure) != null) ? u.by_day.reduce((a, d) => a + (measureValue(d.modes, measure) ?? 0), 0) : null)
  const spark = sparkPath(u.by_day.map((d) => ({ cost_usd: value({ cost_usd: d.cost_usd ?? 0, modes: d.modes }) ?? 0 })), 64, 20)
  const paid = (u.accounts ?? []).map((a) => paidKnown(a.paid.month, Object.keys(a.windows).length > 0)).filter((x): x is number => x != null)
  const real = paid.reduce((a, b) => a + b, 0)
  const fin = issues ? finishedIn(issues, days) : null
  const med = fin ? median(fin.map((r) => (measure === 'api' ? r.own.cost_usd : measureValue(r.cost?.own, measure))).filter((x): x is number => x != null)) : null
  const amount = (a: AgentRow) => measure === 'api' ? (a.today?.cost_usd ?? 0) : (measureValue(a.today?.modes, measure) ?? 0)
  const byAgent = (u.by_agent ?? []).filter((a) => amount(a) > 0).sort((a, b) => amount(b) - amount(a))
  // by_agent holds at most 30 agents, ranked by the period's cost: at the cap the count is a floor and the top agent unknown.
  const capped = (u.by_agent ?? []).length >= 30
  const top = capped ? undefined : byAgent[0]
  const topToday = top ? (measure === 'api' ? (top.today.cost_usd ?? 0) : measureValue(top.today.modes, measure)) : null
  return (
    <div className="tiles">
      <Tile label={`Spend · ${periodName(days)}`} value={measureText(spend, measure)} spark={spark}>
        {t ? <span className={t.up ? 'lim-warn' : ''}>{t.up ? '▲' : '▼'} {t.pct}% vs the {periodName(days)} before · </span> : null}{MEASURE_CAPTION[measure]}
      </Tile>
      <Tile label="Real money · month" value={paid.length ? money(real) : '—'}>
        {paid.length ? 'Paid accounts; subscriptions are flat' : 'No paid account reports spend'}
      </Tile>
      <Tile label={`Issues finished · ${periodName(days)}`} value={fin ? String(fin.length) : issuesFailed ? '—' : '…'}>
        {fin ? (med != null ? `median ${measureText(med, measure)} each` : 'none finished') : issuesFailed ? 'Could not load issues' : 'Loading'}
      </Tile>
      <Tile label="Today" value={measure === 'api' ? measureText(u.today.cost_usd, measure) : measureText(measureValue(u.today.modes, measure), measure)}>
        {byAgent.length ? `${byAgent.length}${capped ? '+' : ''} ${byAgent.length === 1 ? 'agent' : 'agents'} spent${top ? ` · top: ${top.agent} ${measureText(topToday, measure)}` : ''}` : 'No spend yet today'}
      </Tile>
    </div>
  )
}
