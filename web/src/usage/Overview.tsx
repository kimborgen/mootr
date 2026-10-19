// Overview: the blocked callout, the limits band and the four headline tiles, then the cost
// charts, the finished issues panel, then the cost footer.
import { Icon } from '../Icon'
import { BlockedCallout, LimitsBand } from './Limits'
import { useState } from 'react'
import { chartDays, OverviewCharts } from './charts/OverviewCharts'
import { useSeries } from './charts/useSeries'
import type { DrillKind } from './charts/math'
import { ScopedView } from './drill/Drill'
import { UsageFilter } from './AgentTypeBar'
import { Tiles } from './Tiles'
import { FinishedIssues } from './FinishedIssues'
import { openSpending } from './shared'
import { useUsageState, type UsagePeriod } from './state'
import type { Issues, Usage } from './types'

export function Overview({ u, issues, issuesError, retryIssues, days, shown = true }: { u: Usage; issues: Issues | null; issuesError: string | null; retryIssues: () => void; days: UsagePeriod; shown?: boolean }) {
  const { scope } = useUsageState()
  // One series feeds the Spend tile and the charts, so it is fetched once.
  const [group, setGroup] = useState<DrillKind>('tree')
  const feed = useSeries(chartDays(days), group, shown && !scope)
  // The tile always reads the tree series: an ITSA series is built from samples and has no previous
  // period. It shares the charts' feed while they group by tree, and fetches its own otherwise.
  const own = useSeries(chartDays(days), 'tree', shown && !scope && group !== 'tree')
  const tileSeries = group === 'tree' ? feed.series : own.series
  // The spend series and the issues are not filtered by type (S-1753): while a type is set, their panels stay
  // and carry an "All agents" label (S-1845), and the Spend tile leaves out its change, which would mix the two.
  const narrowed = (u.filtered_agents?.length ?? 0) > 0
  const accounts = u.accounts ?? []
  const empty = !accounts.length && !u.subscriptions.length && !u.by_day.length && !u.today.cost_usd
  if (empty) {
    return (
      <div className="usage-none">
        <div className="eyebrow">Usage</div>
        <h2>No cost readings yet</h2>
        <p className="usage-empty">mootr shows spend, subscription windows and estimated shares here once an account is configured and an agent reports a reading.</p>
        <button className="btn text" onClick={openSpending}>Cost settings</button>
      </div>
    )
  }
  return (
    <>
      <BlockedCallout rows={u.blocked ?? []} />
      <UsageFilter u={u} scopeNote={scope ? 'The drill below counts every agent.' : 'Spend and Today count only those agents. Limits, subscription windows, real money, the charts and finished issues count every agent, and are labelled "All agents".'} />
      <LimitsBand accounts={accounts} allocations={u.allocations ?? []} compact={scope != null} reserve={u.openrouter_reserve} />
      {scope ? <ScopedView scope={scope} /> : (
        <>
          <Tiles u={u} days={days} series={narrowed ? null : tileSeries} issues={issues} issuesFailed={issuesError != null} />
          <OverviewCharts allAgents={narrowed} feed={{ ...feed, group, onGroup: setGroup }} />
          <FinishedIssues allAgents={narrowed} d={issues} error={issuesError} retry={retryIssues} days={days} />
        </>
      )}
      <footer className="usage-foot instructions-block">
        <span>{u.note} {u.shares_note ?? ''}</span>
        <span>Cost instructions: {u.instructions ? <q>{u.instructions.length > 120 ? u.instructions.slice(0, 120) + '…' : u.instructions}</q> : 'none set'}</span>
        <button className="btn text" onClick={openSpending}><Icon name="settings" size="xs" /> Edit in Settings</button>
      </footer>
    </>
  )
}
