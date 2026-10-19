// What the Finished issues panel and the Issues tab share: loading GET /api/usage/issues, which
// issues fall in the page's period, a configuration's short name, and an issue's tree.
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { HARNESS } from '../format'
import { getData } from '../store'
import { modelName } from './shared'
import { apiDays, type UsageMeasure, type UsagePeriod } from './state'
import type { ConfigRow, IssueRow, Issues, UnitStats } from './types'

export const CLOSED = new Set(['done', 'canceled', 'duplicate', 'wont_do'])
export const isClosed = (r: IssueRow) => CLOSED.has(r.status)

// The issues call, with the error it failed on and `retry`. A reply without issues is an error,
// never a crash.
export function useIssues(shown: boolean) {
  const [state, setState] = useState<{ data: Issues | null; error: string | null }>({ data: null, error: null })
  const [tries, setTries] = useState(0)
  const retry = useCallback(() => setTries((n) => n + 1), [])
  useEffect(() => {
    if (!shown) return
    let live = true
    // A retry starts clean: clear the old error so the panel shows Loading, not the error it
    // is asking again about (S-663).
    setState((s) => (s.error == null ? s : { ...s, error: null }))
    api<Issues>('GET', '/api/usage/issues').then(
      (r) => { if (live) setState(Array.isArray(r?.issues) ? { data: r, error: null } : { data: null, error: 'The issue costs are not available from this daemon.' }) },
      (e: Error) => { if (live) setState((s) => ({ data: s.data, error: e.message || 'Could not load issues.' })) },
    )
    return () => { live = false }
  }, [shown, tries])
  return { ...state, retry }
}

// The start of the page's period in calendar days, at UTC midnight as the API counts its days: a
// period of N days is N calendar days ending today. `apiDays` gives the API's count, which covers one more day than it names (and today alone
// asks for 1, hourly), so the days the page shows are `apiDays + 1`, or 1 for Today.
export function periodStart(days: UsagePeriod, now = new Date()): number {
  const n = days === 1 ? 1 : apiDays(days) + 1
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (n - 1))
}
export function closedInPeriod(r: IssueRow, days: UsagePeriod, now = new Date()): boolean {
  if (!isClosed(r) || !r.closed_at) return false
  const t = Date.parse(r.closed_at)
  return !Number.isNaN(t) && t >= periodStart(days, now)
}

// The issues the page lists: kind issue, closed ones inside the period, open ones as they are now.
export function issuesFor(d: Issues, days: UsagePeriod, status: 'closed' | 'open' | 'all', now = new Date()): IssueRow[] {
  return d.issues.filter((r) => r.kind === 'issue' && (
    status === 'closed' ? closedInPeriod(r, days, now)
      : status === 'open' ? !isClosed(r)
        : isClosed(r) ? closedInPeriod(r, days, now) : true))
}

// A configuration in short words, as the sidebar names models: "Haiku 5.5 · Claude Code",
// "DeepSeek v4.1 flash · OpenCode".
export function configName(config: string | null): string {
  if (!config) return '—'
  const [harness, ...rest] = config.split(' · ')
  return `${modelName(rest.join(' · '))} · ${HARNESS[harness] ?? harness}`
}
// Subscription spend is what OpenCode and OpenRouter bill through their own accounts, so a
// configuration on them with no weekly share reads as paid rather than unknown.
export const isPaidConfig = (config: string | null) => !!config && /^opencode\b|openrouter/i.test(config)
// The weekly-window cell: a share of the window when known, else paid or an em dash.
export const weeklyCell = (pct: number | null | undefined, config: string | null) =>
  pct != null ? `≈${pct}%` : isPaidConfig(config) ? 'paid' : '—'

// The configuration's median cost, from the API's per-configuration stats (API dollars).
export const medianOf = (rows: ConfigRow[], config: string | null) => rows.find((c) => c.config === config)?.median ?? null

// One configuration's closed-issue cost stats in the page's measure (S-663), from the API's
// per-configuration stats: `units[measure]` when the daemon sends it, else the API-equivalent
// dollars for the API measure and nothing for the others (never an invented number).
export function configUnit(rows: ConfigRow[], config: string | null, measure: UsageMeasure): UnitStats {
  const r = rows.find((c) => c.config === config)
  if (!r) return { n: 0, median: null, average: null, min: null, max: null }
  const unit = r.units?.[measure]
  if (unit) return unit
  return measure === 'api' ? { n: r.n, median: r.median, average: r.average, min: r.min, max: r.max } : { n: 0, median: null, average: null, min: null, max: null }
}

// The tree an issue belongs to: the root of its owner's agent chain, the owner read from the ITSA
// in the store. An ITSA or owner the store no longer holds reads as an em dash.
export function treeOf(key: string): string {
  const { agents, itsas } = getData()
  const owner = itsas.find((i) => i.key === key)?.owner
  let a = agents.find((x) => x.id === owner || x.name === owner)
  for (let i = 0; a?.parent_id && i < 20; i++) a = agents.find((x) => x.id === a!.parent_id) ?? a
  return a?.name ?? '—'
}
