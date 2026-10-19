// A saved link or state from before agent types (S-1444: `agents=work`, `agents=custom&classes=...`) holds legacy
// tokens, not types. The daemon maps them (src/agent-class.ts), so this asks it once and adopts the type list it
// answers with in `filter.agents`; until then the page counts by the token, which the daemon already understands.
import { useEffect } from 'react'
import { api } from '../api'
import { hasLegacy } from './agentFilter'
import { setUsageState, useUsageState } from './state'
import { summaryPath } from './activity/useSummary'
import type { ActSummary } from './types'

export function useLegacyFilter(shown: boolean) {
  const { agents } = useUsageState()
  const legacy = hasLegacy(agents)
  const path = legacy ? summaryPath(1, null, agents) : ''
  useEffect(() => {
    if (!shown || !path) return
    const ctl = new AbortController()
    api<ActSummary>('GET', path, undefined, ctl.signal).then((r) => {
      const kept = r?.filter?.agents
      if (ctl.signal.aborted || !kept) return
      setUsageState({ agents: kept === 'all' || kept === 'none' ? [] : kept.split(',') })
    }, () => {})
    return () => ctl.abort()
  }, [shown, path])
}
