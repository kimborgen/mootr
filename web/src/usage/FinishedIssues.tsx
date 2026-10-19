// The Overview's Finished issues panel: the most expensive issues closed in the period, each
// cost against its configuration's median as a bar with a tick. "All N" opens the Issues tab.
// Costs follow the page's Measure control (S-663).
import { measureText, measureValue } from './measure'
import { AllAgentsLabel } from './AgentTypeBar'
import { getData } from '../store'
import { openItsa } from '../itsa/itsa'
import { closedInPeriod, configName, configUnit, issuesFor, treeOf, weeklyCell } from './issueData'
import { setUsageState, useUsageState, type UsagePeriod } from './state'
import type { Issues } from './types'
import { Loading } from '../Loading'

const TOP = 5
// Over this many times its median an issue reads as "N× median"; below, "typical".
const OVER = 1.5
const PERIOD: Record<UsagePeriod, string> = { 1: 'today', 7: '7 days', 30: '30 days', 0: 'all time' }

// An issue's key and title. The key opens its ITSA when the store has it; a click on it stays out
// of any row click around it.
export function IssueKey({ keyName, title }: { keyName: string; title: string }) {
  const id = getData().itsas.find((i) => i.key === keyName)?.id
  return (
    <>
      {id
        ? <a href="#" className="itsalink" onClick={(e) => { e.preventDefault(); e.stopPropagation(); openItsa(id) }}>{keyName}</a>
        : keyName}{' '}{title}
    </>
  )
}

// `allAgents` marks a panel that counts every agent while a type filter is set (S-1845).
export function FinishedIssues({ d, error, retry, days, allAgents }: { d: Issues | null; error: string | null; retry: () => void; days: UsagePeriod; allAgents?: boolean }) {
  const { measure } = useUsageState()
  const head = (n?: number) => (
    <div className="uc-head">
      <span className="uc-title">Finished issues</span>
      {allAgents ? <AllAgentsLabel /> : null}
      <span className="muted">{PERIOD[days]} · against the median for their configuration</span>
      <span className="fin-all" />
      {n != null ? <a href="#" onClick={(e) => { e.preventDefault(); setUsageState({ tab: 'issues' }) }}>All {n} →</a> : null}
    </div>
  )
  if (!d) {
    return (
      <section className="uc-panel fin-issues">
        {head()}
        {error
          ? <div className="uc-error" role="alert"><p>Could not load issues: {error}</p><button type="button" className="btn text" onClick={retry}>Retry</button></div>
          : <Loading className="muted" label="Loading issues" />}
      </section>
    )
  }
  // "All N" counts what the Closed filter lists; the rows are the ones with spend.
  const closed = issuesFor(d, days, 'closed').length
  const costOf = (r: Issues['issues'][number]) => (measure === 'api' ? r.own.cost_usd : measureValue(r.cost?.own, measure))
  const done = d.issues.filter((r) => r.kind === 'issue' && r.own.cost_usd > 0 && closedInPeriod(r, days) && costOf(r) != null)
  const top = [...done].sort((a, b) => (costOf(b) ?? 0) - (costOf(a) ?? 0) || a.key.localeCompare(b.key)).slice(0, TOP)
  if (!done.length) {
    return <section className="uc-panel fin-issues">{head()}<p className="muted">No issues finished in this period</p></section>
  }
  const scale = Math.max(0.0001, ...top.flatMap((r) => [costOf(r) ?? 0, configUnit(d.by_config, r.config, measure).median ?? 0]))
  return (
    <section className="uc-panel fin-issues">
      {head(closed)}
      <table className="data"><tbody>
        <tr><th>Issue</th><th className="wide">Tree</th><th className="wide">Configuration</th><th className="num">Cost</th><th className="wide">vs median</th><th className="num wide">Week</th></tr>
        {top.map((r) => {
          const cost = costOf(r) ?? 0
          const med = configUnit(d.by_config, r.config, measure).median
          const over = med != null && med > 0 && cost > med * OVER
          const verdict = over ? `${(cost / med!).toFixed(1)}× median` : 'typical'
          const weekly = weeklyCell(r.weekly_percent, r.config)
          const tree = treeOf(r.key)
          return (
            <tr key={r.key}>
              <td><IssueKey keyName={r.key} title={r.title} /><div className="muted phone-only">{`${tree} · ${configName(r.config)}${med != null ? ` · median ${measureText(med, measure)}` : ''}${over ? ` · ${verdict}` : ''}${weekly === '—' ? '' : ` · ${weekly}`}`}</div></td>
              <td className="wide">{tree}</td>
              <td className="wide">{configName(r.config)}</td>
              <td className="num">{measureText(costOf(r), measure)}</td>
              <td className="wide">
                <span className="vs" role="img" aria-label={med != null ? `${measureText(costOf(r), measure)} against a median of ${measureText(med, measure)}` : `${measureText(costOf(r), measure)}, no median`}>
                  <i style={{ width: Math.min(100, (cost / scale) * 100) + '%' }} />
                  {med != null ? <b style={{ left: Math.min(100, (med / scale) * 100) + '%' }} /> : null}
                </span>
                <span className="muted vs-note">{verdict}</span>
              </td>
              <td className="num wide">{weekly}</td>
            </tr>
          )
        })}
      </tbody></table>
    </section>
  )
}
