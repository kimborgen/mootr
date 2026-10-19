// Loads GET /api/usage/scope for a drilled scope. A new scope or period aborts the call in flight;
// a failure keeps its message and HTTP status (a 403 is "not visible to you"), and `retry` asks again.
import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../../api'
import type { UsageScope } from '../state'
import type { ScopeAnswer } from './types'

export const scopeQuery = (s: UsageScope) => `${s.kind}=${encodeURIComponent(s.id)}`

// An ITSA's own span: from when it opened, hourly or daily.
export interface Span { since: string; bucket: 'hour' | 'day' }

export function useScope(scope: UsageScope, days: number, span?: Span) {
  const [state, setState] = useState<{ data: ScopeAnswer | null; loading: boolean; error: string | null; status: number | null }>({ data: null, loading: true, error: null, status: null })
  const [tries, setTries] = useState(0)
  const retry = useCallback(() => setTries((n) => n + 1), [])
  useEffect(() => {
    const ctl = new AbortController()
    setState((s) => ({ ...s, loading: true, error: null, status: null }))
    api<ScopeAnswer>('GET', `/api/usage/scope?days=${days}&${scopeQuery(scope)}${span ? `&since=${encodeURIComponent(span.since)}&bucket=${span.bucket}` : ''}`, undefined, ctl.signal).then(
      (r) => { if (!ctl.signal.aborted) setState(Array.isArray(r?.by_agent) && r?.timeseries ? { data: r, loading: false, error: null, status: null } : { data: null, loading: false, error: 'The scope is not available from this daemon.', status: null }) },
      (e: Error) => { if (!ctl.signal.aborted) setState({ data: null, loading: false, error: e.message || 'Could not load the scope.', status: e instanceof ApiError ? e.status : null }) },
    )
    return () => ctl.abort()
  }, [scope.kind, scope.id, days, span?.since, span?.bucket, tries])
  return { ...state, retry }
}
