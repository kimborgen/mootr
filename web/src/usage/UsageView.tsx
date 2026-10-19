// The Usage page: spend and subscription windows, in tabs (Overview, Activity, Issues, Models, Trees,
// Agents, Days) under a header with a Period control and a Measure control, and on every tab but Issues an
// Agent types control (S-1491, S-1753; /api/usage takes it as `agents=`). The tab, period,
// measure and drill scope live in ./state.ts and in the browser history (nav-history.ts), so back
// and forward move between them and a reload restores them. It loads when it mounts, again each
// time `shown` turns true, and again when the period changes, so a tab kept mounted while hidden
// refreshes when the human comes back.
import { useEffect, useRef, useState } from 'react'
import { openWorld } from '../actions'
import { api } from '../api'
import { ActivityTab } from './Activity'
import { IssuesTab } from './Issues'
import { useIssues } from './issueData'
import { filterParam, hasLegacy } from './agentFilter'
import { useLegacyFilter } from './useLegacyFilter'
import { MEASURES, MEASURE_CAPTION, toMeasure } from './measure'
import { Overview } from './Overview'
import { AgentsTab, DaysTab, ModelsTab } from './Tables'
import { TreesTab } from './Trees'
import { apiDays, getUsageState, measurePinned, PERIODS, pinMeasure, setUsageState, TABS, useUsageState, type UsagePeriod, type UsageTab } from './state'
import type { Usage } from './types'
import { Loading } from '../Loading'

const TAB_LABEL: Record<UsageTab, string> = {
  overview: 'Overview', issues: 'Issues', models: 'Models', trees: 'Trees', agents: 'Agents', days: 'Days', activity: 'Activity',
}
const PERIOD_LABEL: Record<UsagePeriod, string> = { 1: 'Today', 7: '7 days', 30: '30 days', 0: 'All time' }

// Opens the Usage page on its Activity tab: the Settings link for what agents spend time on.
export function openUsageActivity() {
  setUsageState({ tab: 'activity' })
  openWorld('usage')
}

function Header() {
  const s = useUsageState()
  return (
    <div className="usage-head">
      <div className="usage-top">
        <h2>Usage</h2>
        <div className="usage-controls">
          <div className="seg" role="group" aria-label="Period">
            {PERIODS.map((d) => <button key={d} type="button" className={s.days === d ? 'on' : ''} aria-pressed={s.days === d} onClick={() => setUsageState({ days: d })}>{PERIOD_LABEL[d]}</button>)}
          </div>
          <div className="seg" role="group" aria-label="Measure">
            {MEASURES.map((x) => (
              <button key={x.id} type="button" title={MEASURE_CAPTION[x.id]} className={s.measure === x.id ? 'on' : ''} aria-pressed={s.measure === x.id}
                onClick={() => { pinMeasure(); setUsageState({ measure: x.id }) }}>{x.label}</button>
            ))}
          </div>
        </div>
      </div>
      <div className="usage-tabs" role="tablist" aria-label="Usage">
        {TABS.map((t) => (
          <button key={t} type="button" role="tab" id={`usage-tab-${t}`} aria-selected={s.tab === t} aria-controls="usage-panel" onClick={() => setUsageState({ tab: t })}>{TAB_LABEL[t]}</button>
        ))}
      </div>
    </div>
  )
}

export function UsageView({ shown = true }: { shown?: boolean }) {
  const { tab, days, agents } = useUsageState()
  const [u, setU] = useState<Usage | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!shown) return
    let live = true
    // The shared Agent types selection (S-1753); a saved link's legacy tokens wait until Activity's hook resolves them.
    const types = hasLegacy(agents) ? '' : filterParam(agents)
    api<Usage>('GET', `/api/usage?days=${apiDays(days)}${types ? `&agents=${encodeURIComponent(types)}` : ''}`).then((r) => { if (live) { setU(r); setError(null) } }, (e: Error) => { if (live) setError(e.message) })
    return () => { live = false }
  }, [shown, days, filterParam(agents)])
  // The Measure control defaults to the Settings cost unit (S-663): adopt it once, when the page
  // first loads it, unless a link, a history entry or the human already chose a measure.
  const applied = useRef(false)
  useEffect(() => {
    if (!u || applied.current || measurePinned()) return
    applied.current = true
    const want = toMeasure(u.display_mode)
    if (want !== getUsageState().measure) setUsageState({ measure: want })
  }, [u])
  useLegacyFilter(shown)
  const { data: issues, error: issuesError, retry: retryIssues } = useIssues(shown)

  const body = () => {
    if (tab === 'activity') return <ActivityTab shown={shown} />
    if (tab === 'issues') return <IssuesTab d={issues} error={issuesError} retry={retryIssues} days={days} />
    if (!u) return error ? <p className="muted">{error}</p> : <Loading className="muted" label="Loading usage" />
    switch (tab) {
      case 'models': return <ModelsTab u={u} days={days} />
      case 'agents': return <AgentsTab u={u} days={days} />
      case 'days': return <DaysTab u={u} />
      case 'trees': return <TreesTab nodes={u.trees ?? []} u={u} />
      default: return <Overview u={u} shown={shown} issues={issues} issuesError={issuesError} retryIssues={retryIssues} days={days} />
    }
  }
  return (
    <div className="pad usage">
      <Header />
      <div className="usage-panel" role="tabpanel" id="usage-panel" aria-labelledby={`usage-tab-${tab}`}>{body()}</div>
    </div>
  )
}
