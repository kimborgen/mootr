// Loads GET /api/activity?by=summary for the page's period and scope (S-1011). A new period or scope
// clears the old answer, so an old window never stands under a new label, and aborts the call in
// flight; `retry` asks again.
import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { filterParam, type AgentFilter } from '../agentFilter'
import type { UsagePeriod, UsageScope } from '../state'
import type { ActSummary } from '../types'

// The summary's days are a rolling window in whole days; all time asks for a year.
export const summaryDays = (p: UsagePeriod) => (p === 0 ? 365 : p)
// The scopes the summary reads; a model or harness drill shows the whole system.
export const SUMMARY_SCOPES = new Set(['tree', 'itsa', 'agent'])
export const summaryScope = (s: UsageScope | null) => (s && SUMMARY_SCOPES.has(s.kind) ? `${s.kind}:${s.id}` : null)
export const summaryPath = (p: UsagePeriod, s: UsageScope | null, f?: AgentFilter) => {
  const scope = summaryScope(s)
  const agents = f ? filterParam(f) : ''
  return `/api/activity?by=summary&days=${summaryDays(p)}${scope ? `&scope=${encodeURIComponent(scope)}` : ''}${agents ? `&agents=${encodeURIComponent(agents)}` : ''}`
}

export function useSummary(shown: boolean, period: UsagePeriod, scope: UsageScope | null, filter?: AgentFilter) {
  const path = summaryPath(period, scope, filter)
  const [state, setState] = useState<{ path: string; data: ActSummary } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tries, setTries] = useState(0)
  const retry = useCallback(() => setTries((n) => n + 1), [])
  useEffect(() => {
    if (!shown) return
    const ctl = new AbortController()
    setState(null)
    setError(null)
    api<ActSummary>('GET', path, undefined, ctl.signal).then(
      (r) => { if (!ctl.signal.aborted) { if (r?.clock && r.tiles) setState({ path, data: r }); else setError('This daemon has no activity summary yet') } },
      (e: Error) => { if (!ctl.signal.aborted) setError(e.message || 'Could not load activity') },
    )
    return () => ctl.abort()
  }, [shown, path, tries])
  return { data: state && state.path === path ? state.data : null, error, retry }
}
