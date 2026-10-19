// Loads GET /api/usage/series for the Overview charts: the period and its previous period in one
// call (`previous_rows`). A new period or group aborts the call in flight; a failure keeps its
// message, and `retry` asks again.
import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import type { DrillKind, Series } from './math'

export function useSeries(days: number, group: DrillKind, shown = true) {
  const [state, setState] = useState<{ series: Series | null; loading: boolean; error: string | null }>({ series: null, loading: true, error: null })
  const [tries, setTries] = useState(0)
  const retry = useCallback(() => setTries((n) => n + 1), [])
  useEffect(() => {
    if (!shown) return
    const ctl = new AbortController()
    setState((s) => ({ ...s, loading: true, error: null }))
    api<Series>('GET', `/api/usage/series?days=${days}&group=${group}`, undefined, ctl.signal).then(
      // A reply without rows is no series (an old daemon, a stub): an error, never a crash.
      (r) => { if (!ctl.signal.aborted) setState(Array.isArray(r?.rows) && Array.isArray(r?.groups) ? { series: r, loading: false, error: null } : { series: null, loading: false, error: 'The spend series is not available from this daemon.' }) },
      (e: Error) => { if (!ctl.signal.aborted) setState({ series: null, loading: false, error: e.message || 'Could not load spend.' }) },
    )
    return () => ctl.abort()
  }, [days, group, shown, tries])
  return { ...state, retry }
}
