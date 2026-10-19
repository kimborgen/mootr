// Issues: every issue in the period as a sortable table (click a row to drill into its ITSA), a
// status filter, and the cost per configuration. Costs follow the page's Measure control (S-663).
import { useState } from 'react'
import { measureText, measureValue } from './measure'
import { CLOSED, configName, configUnit, issuesFor, weeklyCell } from './issueData'
import { IssueKey } from './FinishedIssues'
import { setUsageState, useUsageState, type UsageMeasure, type UsagePeriod } from './state'
import type { ConfigRow, IssueRow, Issues } from './types'
import { Loading } from '../Loading'

type Status = 'closed' | 'open' | 'all'
const STATUSES: { id: Status; label: string }[] = [{ id: 'closed', label: 'Closed' }, { id: 'open', label: 'Open' }, { id: 'all', label: 'All' }]
type Dir = 'asc' | 'desc'
interface Col {
  id: string
  label: string
  value: (r: IssueRow) => number | string | null
  cell: (r: IssueRow) => React.ReactNode
  wide?: boolean
  text?: boolean
}
const cmp = (a: number | string | null, b: number | string | null, dir: Dir): number => {
  if (a == null || b == null) return a == null && b == null ? 0 : a == null ? 1 : -1
  const c = typeof a === 'string' ? a.localeCompare(b as string) : a - (b as number)
  return dir === 'asc' ? c : -c
}
const statusLabel = (s: string) => s.replace(/_/g, ' ')
// The drill shows on the Overview, so a row also leaves the Issues tab.
const drill = (key: string) => setUsageState({ tab: 'overview', scope: { kind: 'itsa', id: key } })

const ownCost = (r: IssueRow, measure: UsageMeasure) => (measure === 'api' ? r.own.cost_usd : measureValue(r.cost?.own, measure))
const totalCost = (r: IssueRow, measure: UsageMeasure) => (measure === 'api' ? r.total.cost_usd : measureValue(r.cost?.total, measure))

const COLS = (measure: UsageMeasure): Col[] => [
  { id: 'key', label: 'Issue', value: (r) => r.key, cell: (r) => <IssueKey keyName={r.key} title={r.title} /> , text: true },
  { id: 'status', label: 'Status', value: (r) => r.status, text: true, wide: true, cell: (r) => <span className={'badge' + (CLOSED.has(r.status) ? '' : ' prog')}>{statusLabel(r.status)}</span> },
  { id: 'config', label: 'Configuration', value: (r) => configName(r.config), text: true, wide: true, cell: (r) => configName(r.config) },
  { id: 'own', label: 'Own cost', value: (r) => ownCost(r, measure), cell: (r) => measureText(ownCost(r, measure), measure) },
  { id: 'total', label: 'Total with children', value: (r) => totalCost(r, measure), wide: true, cell: (r) => measureText(totalCost(r, measure), measure) },
  { id: 'agents', label: 'Agents', value: (r) => r.agents, wide: true, cell: (r) => r.agents },
  { id: 'week', label: 'Week', value: (r) => r.weekly_percent, wide: true, cell: (r) => weeklyCell(r.weekly_percent, r.config) },
]
// The wide columns as the muted line under the issue at a phone width.
const phoneLine = (r: IssueRow, measure: UsageMeasure) => {
  const weekly = weeklyCell(r.weekly_percent, r.config)
  return [statusLabel(r.status), configName(r.config), `total ${measureText(totalCost(r, measure), measure)}`, `${r.agents} ${r.agents === 1 ? 'agent' : 'agents'}`, weekly === '—' ? null : `week ${weekly}`].filter(Boolean).join(' · ')
}

function IssueTable({ rows, measure }: { rows: IssueRow[]; measure: UsageMeasure }) {
  const [sort, setSort] = useState<{ id: string; dir: Dir }>({ id: 'own', dir: 'desc' })
  const cols = COLS(measure)
  const col = cols.find((c) => c.id === sort.id) ?? cols[0]
  const sorted = [...rows].sort((a, b) => cmp(col.value(a), col.value(b), sort.dir) || a.key.localeCompare(b.key))
  return (
    <div className="usage-table usage-issue-list">
      <table className="data"><tbody>
        <tr>{cols.map((c) => {
          const on = sort.id === c.id
          return (
            <th key={c.id} className={(c.text ? '' : 'num ') + (c.wide ? 'wide' : '')} aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
              <button type="button" className="sort" onClick={() => setSort({ id: c.id, dir: on ? (sort.dir === 'asc' ? 'desc' : 'asc') : c.text ? 'asc' : 'desc' })}>
                {c.label}{on ? <span aria-hidden> {sort.dir === 'asc' ? '↑' : '↓'}</span> : null}
              </button>
            </th>
          )
        })}</tr>
        {sorted.map((r) => (
          <tr key={r.key} className="click" onClick={() => drill(r.key)}>
            {cols.map((c, i) => (
              <td key={c.id} className={(c.text ? '' : 'num') + (c.wide ? ' wide' : '')}>
                {c.cell(r)}
                {i === 0 ? <div className="muted phone-only">{phoneLine(r, measure)}</div> : null}
              </td>
            ))}
          </tr>
        ))}
      </tbody></table>
    </div>
  )
}

// Per configuration: how many closed issues, and their cost's median, with the average, range and
// weekly share, in the page's measure. At a phone width the average, range and weekly share move
// under the name.
function ConfigTable({ rows, measure }: { rows: ConfigRow[]; measure: UsageMeasure }) {
  return (
    <div className="usage-configs">
      <table className="data"><tbody>
        <tr><th>Configuration</th><th className="num">Issues</th><th className="num">Median</th><th className="num wide">Average</th><th className="num wide">Range</th><th className="num wide">Week</th></tr>
        {rows.map((r) => {
          const s = configUnit(rows, r.config, measure)
          const range = `${measureText(s.min, measure)}–${measureText(s.max, measure)}`
          const weekly = weeklyCell(r.median_weekly_percent, r.config)
          return (
            <tr key={r.config}>
              <td>{configName(r.config)}<div className="muted phone-only">{`Average ${measureText(s.average, measure)} · Range ${range}${weekly === '—' ? '' : ` · Week ${weekly}`}`}</div></td>
              <td className="num">{s.n || r.n}</td>
              <td className="num">{measureText(s.median, measure)}</td>
              <td className="num wide">{measureText(s.average, measure)}</td>
              <td className="num wide">{range}</td>
              <td className="num wide">{weekly}</td>
            </tr>
          )
        })}
      </tbody></table>
    </div>
  )
}

const count = (n: number, status: Status) => {
  const issues = `${n} ${n === 1 ? 'issue' : 'issues'}`
  return status === 'closed' ? `${issues} closed in the period` : status === 'open' ? `${issues} open` : `${issues}: closed in the period, and open`
}
const EMPTY: Record<Status, string> = { closed: 'No issues closed in this period', open: 'No open issues', all: 'No issues in this period' }

export function IssuesTab({ d, error, retry, days }: { d: Issues | null; error: string | null; retry: () => void; days: UsagePeriod }) {
  const { measure } = useUsageState()
  const [status, setStatus] = useState<Status>('closed')
  if (!d) {
    return error
      ? <div className="uc-error" role="alert"><p>Could not load issues: {error}</p><button type="button" className="btn text" onClick={retry}>Retry</button></div>
      : <Loading className="muted" label="Loading issues" />
  }
  const rows = issuesFor(d, days, status)
  return (
    <div className="issues-tab">
      <div className="usage-sub">
        <b>Issues</b>
        <div className="seg" role="group" aria-label="Status">
          {STATUSES.map((s) => <button key={s.id} type="button" className={status === s.id ? 'on' : ''} aria-pressed={status === s.id} onClick={() => setStatus(s.id)}>{s.label}</button>)}
        </div>
        <span className="muted">{count(rows.length, status)}</span>
      </div>
      {rows.length ? <IssueTable key={measure} rows={rows} measure={measure} /> : <p className="muted">{EMPTY[status]}</p>}
      {d.by_config.length ? (
        <>
          <div className="usage-sub"><b>Per configuration</b><span className="muted">all closed issues with spend, not only the period</span></div>
          <ConfigTable rows={d.by_config} measure={measure} />
        </>
      ) : null}
      <p className="muted">Claude and Codex amounts are API-equivalent, not what the subscription bills. Week: the issue's share of a week of the subscription.</p>
    </div>
  )
}
