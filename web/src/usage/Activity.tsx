// Activity (S-1006, S-1011): what the agents' time and cost went to, from the one summary answer
// (GET /api/activity?by=summary, S-1009). It follows the page's Period, Measure and drill scope, and counts in
// Time or in Cost (S-1491): the Time | Cost switch, the Agent types row, the scope crumb, four tiles, then Where
// the time (cost) goes, by agent type and What finished issues cost beside the Bottlenecks (Cost by model in
// Cost mode) and Agents by tree (one column on a phone: tiles, time, types, bottlenecks, finished-issue costs,
// agents by tree). A tree or an agent tapped sets the scope (S-1012). The pieces live in ./activity/.
import { useEffect, useState } from 'react'
import { AgentTypeBar } from './AgentTypeBar'
import type { TypeCount } from './agentFilter'
import { MODES, setUsageState, useUsageState } from './state'
import { ActivityTiles } from './activity/ActivityTiles'
import { AgentTrees } from './activity/AgentTrees'
import { Bottlenecks } from './activity/Bottlenecks'
import { CostByModel, CostByType } from './activity/CostBreakdown'
import { ConfigCosts } from './activity/ConfigCosts'
import { ScopeCrumb } from './activity/ScopeCrumb'
import { TimeCard } from './activity/TimeCard'
import { useSummary } from './activity/useSummary'
import { Loading } from '../Loading'

export function ActivityTab({ shown }: { shown: boolean }) {
  const { days, measure, scope, agents, mode } = useUsageState()
  const { data, error, retry } = useSummary(shown, days, scope, agents)
  // The control keeps its buttons while a new answer loads: the last types stand until the next arrive.
  const [types, setTypes] = useState<TypeCount[]>([])
  const fresh = data?.filter?.types
  useEffect(() => { if (fresh) setTypes(fresh) }, [fresh])
  const empty = data && data.clock.total_s <= 0 && !data.tiles.cost.cost_usd
  return (
    <div className="activity-tab">
      <div className="usage-filter">
        <span className="usage-filter-name" id="usage-mode-label">Count by</span>
        <div className="seg" role="group" aria-labelledby="usage-mode-label">
          {MODES.map((x) => <button key={x} type="button" className={mode === x ? 'on' : ''} aria-pressed={mode === x} onClick={() => setUsageState({ mode: x })}>{x === 'time' ? 'Time' : 'Cost'}</button>)}
        </div>
      </div>
      <AgentTypeBar types={types} />
      <ScopeCrumb scope={scope} answer={data?.scope} days={days} filter={agents} />
      {error ? (
        <div className="act-error" role="alert">
          <p className="muted">Could not load activity: {error}</p>
          <button className="btn text" onClick={retry}>Retry</button>
        </div>
      ) : !data ? <Loading className="muted" label="Loading activity" /> : empty && !data.warming ? (
        <p className="muted ax-none">No agent activity in this window yet</p>
      ) : (
        <>
          {data.warming && (
            <p className="muted ax-warming" role="status">
              Still warming after a restart, so these figures are partial.{' '}
              <button className="btn text" onClick={retry}>Refresh</button>
            </p>
          )}
          <ActivityTiles d={data} measure={measure} mode={mode} />
          {/* Two columns on a desktop; on a phone the columns dissolve and the cards read time,
              bottlenecks, finished-issue costs, agents by tree (style.css orders them). */}
          <div className="ax-grid">
            <div className="ax-col">
              <TimeCard d={data} measure={measure} mode={mode} />
              <CostByType rows={data.by_type ?? []} mode={mode} measure={measure} />
              <ConfigCosts configs={data.configs} measure={measure} />
            </div>
            <div className="ax-col">
              {mode === 'cost' ? <CostByModel rows={data.by_model ?? []} measure={measure} /> : <Bottlenecks rows={data.bottlenecks} />}
              <AgentTrees trees={data.trees ?? []} measure={measure} mode={mode} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}
