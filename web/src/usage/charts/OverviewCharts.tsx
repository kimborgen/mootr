// The Overview's spend charts, wired to the page state (S-660): the period comes from the page's
// period control, and clicking a segment or bar sets the drill scope. All time draws the last 30
// days (a year of columns is a comb); the panel subtitle names the period it drew.
import { useState } from 'react'
import { apiDays, setUsageState, useUsageState, type UsagePeriod } from '../state'
import { SpendCharts } from './SpendCharts'
import { useSeries } from './useSeries'
import type { ColorMap, DrillKind, DrillTarget } from './math'

export const CHART_ALL_TIME_PERIOD: UsagePeriod = 30
// The days to ask /api/usage/series for: the page's period (all time is 30 days) as the API counts them.
export const chartDays = (p: UsagePeriod) => apiDays(p === 0 ? CHART_ALL_TIME_PERIOD : p)

// A drill target is a scope: the series ids are the scope's ids (a model's is `harness · model`).
export const drillScope = (t: DrillTarget) => ({ kind: t.kind, id: t.id })

// The series state the charts draw: their own, or a `feed` the parent loaded (the Overview shares it with the Spend tile).
export interface SeriesFeed extends ReturnType<typeof useSeries> { group: DrillKind; onGroup: (g: DrillKind) => void }

export function OverviewCharts({ shown = true, feed, allAgents }: { shown?: boolean; feed?: SeriesFeed; allAgents?: boolean }) {
  const { days } = useUsageState()
  const [ownGroup, setOwnGroup] = useState<DrillKind>('tree')
  const [colors] = useState<ColorMap>(() => new Map())
  const own = useSeries(chartDays(days), ownGroup, shown && !feed)
  const { series, loading, error, retry } = feed ?? own
  const group = feed?.group ?? ownGroup
  const setGroup = feed?.onGroup ?? setOwnGroup
  return <SpendCharts series={series} loading={loading} error={error} onRetry={retry} group={group} onGroup={setGroup} onDrill={(t) => setUsageState({ scope: drillScope(t) })} colors={colors} allAgents={allAgents} />
}
