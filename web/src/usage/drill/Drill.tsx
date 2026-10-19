// The scoped Overview (S-661): what a click on a tree, ITSA, model, harness or agent shows. Breadcrumbs,
// four tiles, spend over time by agent, spend by model, the agents table and an ITSA's child ITSAs.
// Every row drills further through `setUsageState({ scope })`, so back and forward walk the drill.
import { useMemo, useState } from 'react'
import { k } from '../../format'
import { openItsa, statusInfo, statusLabel, toneOf } from '../../itsa/itsa'
import { getData } from '../../store'
import { Columns } from '../charts/SpendCharts'
import { colorVar, OTHER, valueOf, type ColorMap, type DrillKind, type Series } from '../charts/math'
import { measureText, measureValue, money } from '../measure'
import { apiDays, setUsageState, useUsageState, type UsageMeasure, type UsageScope } from '../state'
import { harnessLabel, modelName } from '../shared'
import { DataTable, type Col } from '../Tables'
import { itsaSpan, openFor, percentText, readTypical, readWindows, timesText, totalOf, isItsaTotals } from './math'
import type { ScopeAgent, ScopeAnswer, ScopeItsa, ScopeModel, Tot } from './types'
import { useScope } from './useScope'
import { Loading } from '../../Loading'

// usage_samples older than this are pruned, so an older ITSA's chart starts here (db.SAMPLE_RETENTION_MS).
const RETAINED_MS = 35 * 86_400_000
const drill = (scope: UsageScope | null) => setUsageState({ scope })
const KIND_LABEL: Record<DrillKind, string> = { tree: 'tree', itsa: 'ITSA', model: 'model', harness: 'harness', agent: 'agent' }
const dash = (v: number | null | undefined) => (v == null ? '—' : k(v))
// The scopes the Activity tab reads (S-1012): the same scope opens there, so its retro is one tap away.
const ACTIVITY_NOUN: Partial<Record<DrillKind, string>> = { tree: 'tree', itsa: 'issue', agent: 'agent' }
function ActivityLink({ scope }: { scope: UsageScope }) {
  const noun = ACTIVITY_NOUN[scope.kind]
  if (!noun) return null
  return <button type="button" className="btn text ud-activity" onClick={() => setUsageState({ tab: 'activity', scope })}>Activity for this {noun}</button>
}

// The ITSA status as a badge in the status's own tone.
export function StatusBadge({ status }: { status: string }) {
  const tone = toneOf(statusInfo(status))
  const cls = tone === 'done' ? 'ok' : tone === 'waiting' ? 'warn' : tone === 'active' || tone === 'review' ? 'progress' : ''
  return <span className={'badge ' + cls}>{statusLabel(status)}</span>
}

// The tree an ITSA's owner belongs to, when the store knows the owner: its root agent.
function treeOfOwner(owner: string | null | undefined): { id: string; name: string } | null {
  if (!owner) return null
  const agents = getData().agents
  let a = agents.find((x) => x.id === owner || x.name === owner)
  for (let i = 0; a && i < 20; i++) {
    const parent = a.parent_id ? agents.find((x) => x.id === a!.parent_id) : undefined
    if (!parent) return { id: a.id, name: a.name }
    a = parent
  }
  return null
}

function Crumbs({ data }: { data: ScopeAnswer }) {
  const s = data.scope
  const itsa = s.kind === 'itsa' ? getData().itsas.find((i) => i.key === s.key) : undefined
  const tree = itsa ? treeOfOwner(itsa.owner) : null
  const label = s.kind === 'itsa' ? s.key ?? s.name : s.kind === 'model' ? modelName(s.name) : s.kind === 'harness' ? harnessLabel(s.id) : s.name
  return (
    <nav className="ud-crumbs" aria-label="Scope">
      <button type="button" className="ud-crumb" onClick={() => drill(null)}>All</button>
      {tree ? <><span className="ud-sep" aria-hidden>›</span><button type="button" className="ud-crumb" onClick={() => drill({ kind: 'tree', id: tree.id })}>tree {tree.name}</button></> : null}
      <span className="ud-sep" aria-hidden>›</span>
      {s.kind === 'itsa' ? <b>{label}</b> : <><span className="muted">{KIND_LABEL[s.kind]}</span><b>{label}</b></>}
      {s.kind === 'itsa' ? <><span className="muted ud-title">{s.name.replace(/^\S+\s/, '')}</span>{itsa ? <StatusBadge status={itsa.status} /> : null}</> : null}
    </nav>
  )
}

function Tile({ label, value, note, warn }: { label: string; value: string; note?: React.ReactNode; warn?: boolean }) {
  return (
    <div className={'mb-metric' + (warn ? ' warning' : '')}>
      <div className="mb-mlabel">{label}</div>
      <div className="mb-mval">{value}</div>
      {note ? <div className="mb-mnote">{note}</div> : null}
    </div>
  )
}

function Tiles({ data, measure }: { data: ScopeAnswer; measure: UsageMeasure }) {
  const t = data.totals
  const total = totalOf(t)
  const s = data.scope
  const itsa = s.kind === 'itsa' ? getData().itsas.find((i) => i.key === s.key) : undefined
  const { lead, rest } = readWindows(data.windows)
  const typical = readTypical(data.typical, total.cost_usd)
  const typicalName = data.typical ? modelName(data.typical.config.split(' · ').slice(1).join(' · ')) : ''
  const at = (x: Tot) => (measure === 'api' ? measureText(x.cost_usd, measure) : measureText(measureValue(x.modes, measure), measure))
  const totalText = at(total)
  const own = isItsaTotals(t) ? `own ${at(t.own)} · children ${at(t.children)}` : `${k(total.tokens_in)} in · ${k(total.tokens_out)} out`
  const children = data.itsas?.length ?? 0
  const agents = data.by_agent.length
  return (
    <div className="mb-metrics ud-tiles">
      <Tile label="Cost so far" value={totalText} note={own} />
      <Tile label={lead ? `${lead.label} share` : 'Window share'} value={lead ? percentText(lead.percent) : '—'}
        note={lead ? (rest.some((r) => r.label.endsWith('week')) ? rest.filter((r) => r.label.endsWith('week')).map((r) => `${r.label} ${percentText(r.percent)}`).join(' · ') : 'estimate') : 'no subscription use in this period'} />
      {s.kind === 'itsa'
        ? <Tile label={data.typical ? `Typical for ${typicalName}` : 'Typical cost'} value={typical ? money(typical.median) : '—'} warn={typical?.unusual}
            note={typical ? (typical.unusual ? `${timesText(typical.multiple!)} the median issue` : 'in line with the median issue') : 'no closed issues of this configuration yet'} />
        : <Tile label="Tokens" value={k(total.tokens_in + total.tokens_out)} note={`cache read ${k(total.tokens_cache_read)} · write ${k(total.tokens_cache_write)}`} />}
      <Tile label="Agents" value={String(agents)}
        note={s.kind === 'itsa' ? [`${children} child ${children === 1 ? 'ITSA' : 'ITSAs'}`, itsa ? `open ${openFor(itsa.created_at, itsa.closed_at)}` : ''].filter(Boolean).join(' · ') : harnessList(data.by_agent)} />
    </div>
  )
}
const harnessList = (rows: ScopeAgent[]) => [...new Set(rows.map((r) => r.harness).filter((h): h is string => !!h))].map(harnessLabel).join(' · ') || 'none yet'

// Spend over time by agent: the stacked-columns component of the Overview, fed from `timeseries`.
function Spend({ data, colors, since, trimmed, onAgent }: { data: ScopeAnswer; colors: ColorMap; since?: string; trimmed?: boolean; onAgent: (id: string) => void }) {
  const { measure } = useUsageState()
  const names = useMemo(() => new Map(data.by_agent.map((a) => [a.id, a])), [data])
  const series: Series = useMemo(() => ({
    days: data.days, group: 'agent', bucket: data.bucket, groups: data.timeseries.groups, rows: data.timeseries.rows,
    total: totalOf(data.totals), previous: { cost_usd: 0 },
  }), [data])
  const has = series.rows.some((r) => valueOf(r, measure) > 0)
  const paint = (g: { id: string; harness?: string }) => colorVar(colors, 'agent', g)
  const pick = (id: string) => { if (id !== OTHER && names.has(id)) onAgent(id) }
  return (
    <div className="uc-panel uc-spend">
      <div className="uc-head">
        <span className="uc-title">Spend per {data.bucket === 'hour' ? 'hour' : 'day'}</span>
        <span className="uc-by muted">{since ? `since ${since} opened · ` : ''}by agent{since && trimmed ? ' · only the last 35 days are kept' : ''}</span>
      </div>
      {!has ? <p className="muted uc-empty">No spend in this period</p> : (
        <>
          <div className="uc-legend" aria-label="Legend">
            {series.groups.map((g) => (
              <button key={g.id} type="button" className="uc-key" disabled={g.id === OTHER || !names.has(g.id)} onClick={() => pick(g.id)} title={g.name}>
                <i style={{ background: paint(g) }} /><span>{g.name}</span>
              </button>
            ))}
          </div>
          <Columns series={series} prev={[]} paint={paint} onDrill={pick} measure={measure} />
        </>
      )}
    </div>
  )
}

// Spend by model as a ranked bar list in the harness colours; a row drills to the model.
function Models({ rows, colors, measure }: { rows: ScopeModel[]; colors: ColorMap; measure: UsageMeasure }) {
  const paint = (r: ScopeModel) => colorVar(colors, 'model', { id: `${r.harness} · ${r.model}` })
  // Each row's number in the page's measure; API $ from cost_usd, otherwise the units the daemon sent.
  const val = (r: ScopeModel) => (measure === 'api' ? r.cost_usd : measureValue(r.modes, measure) ?? 0)
  const total = rows.reduce((x, r) => x + val(r), 0)
  const top = Math.max(0.000001, ...rows.map(val))
  return (
    <div className="uc-panel uc-where">
      <div className="uc-head"><span className="uc-title">By model</span></div>
      {!rows.length ? <p className="muted uc-empty">No model spend in this period</p> : (
        <>
          <div className="uc-bars">
            {rows.map((r) => (
              <button key={r.harness + r.model} type="button" className="uc-bar" title={`${modelName(r.model)} · ${harnessLabel(r.harness)}`}
                onClick={() => drill({ kind: 'model', id: `${r.harness} · ${r.model}` })}>
                <i className="uc-dot" style={{ background: paint(r) }} />
                <span className="uc-name">{modelName(r.model)}<span className="muted"> · {harnessLabel(r.harness)}</span></span>
                <span className="uc-val">{measureText(measureValue(r.modes, measure), measure)}<span className="uc-share"> · {total > 0 ? Math.round((val(r) / total) * 100) : 0}%</span></span>
                <span className="uc-track"><i style={{ width: Math.max(val(r) > 0 ? 1 : 0, (val(r) / top) * 100) + '%', background: paint(r) }} /></span>
              </button>
            ))}
          </div>
          <p className="muted uc-note">Click a bar to see that model.</p>
        </>
      )}
    </div>
  )
}

const roleModel = (a: ScopeAgent) => [a.role, a.model ? modelName(a.model) : null].filter(Boolean).join(' · ') || harnessLabel(a.harness ?? '')

function AgentsTable({ rows, title, colors, measure }: { rows: ScopeAgent[]; title: string; colors: ColorMap; measure: UsageMeasure }) {
  const tokens = (key: 'tokens_in' | 'tokens_out' | 'tokens_cache_read' | 'tokens_cache_write', label: string): Col<ScopeAgent> => ({ id: key, label, wide: true, value: (r) => r[key], cell: (r) => dash(r[key]) })
  const name: Col<ScopeAgent> = { id: 'name', label: 'Agent', value: (r) => r.name, cell: (r) => <><i className="hdot" style={{ background: colorVar(colors, 'agent', { id: r.id }) }} />{r.name}</> }
  const cost = (r: ScopeAgent) => (measure === 'api' ? r.cost_usd : measureValue(r.modes, measure) ?? 0)
  const cols: Col<ScopeAgent>[] = [
    { id: 'model', label: 'Role · model', wide: true, text: true, value: (r) => roleModel(r), cell: (r) => roleModel(r) },
    tokens('tokens_in', 'In'), tokens('tokens_out', 'Out'), tokens('tokens_cache_read', 'Cache read'), tokens('tokens_cache_write', 'Cache write'),
    { id: 'cost', label: 'Cost', value: (r) => cost(r), cell: (r) => measureText(cost(r), measure) },
  ]
  return (
    <div className="uc-panel ud-table">
      <div className="uc-head"><span className="uc-title">{title}</span><span className="muted uc-by">tokens in · out · cache read · cache write</span></div>
      {!rows.length ? <p className="muted uc-empty">No agent spend in this period</p> : (
        <DataTable key={measure} className="usage-agents ud-agents" rows={rows} cols={cols} rowKey={(r) => r.id} name={name} cost={(r) => cost(r)}
          initial={{ id: 'cost', dir: 'desc' }} onRow={(r) => drill({ kind: 'agent', id: r.id })}
          phoneLine={(r) => `${roleModel(r)} · ${dash(r.tokens_in)} in · ${dash(r.tokens_out)} out · ${dash(r.tokens_cache_read)} cache`} />
      )}
    </div>
  )
}

// The key of a child ITSA opens the ITSA itself; the rest of the row drills into its spend.
function ItsaKey({ r }: { r: ScopeItsa }) {
  const id = getData().itsas.find((i) => i.key === r.key)?.id
  return (
    <>
      {id ? <a href="#" className="itsalink" onClick={(e) => { e.preventDefault(); e.stopPropagation(); openItsa(id) }}>{r.key}</a> : <b>{r.key}</b>} {r.title}
    </>
  )
}

function ChildItsas({ rows, measure }: { rows: ScopeItsa[]; measure: UsageMeasure }) {
  const name: Col<ScopeItsa> = { id: 'key', label: 'ITSA', value: (r) => r.key, cell: (r) => <ItsaKey r={r} /> }
  const cost = (r: ScopeItsa) => (measure === 'api' ? r.cost_usd : measureValue(r.modes, measure) ?? 0)
  const cols: Col<ScopeItsa>[] = [
    { id: 'owner', label: 'Owner', wide: true, text: true, value: (r) => r.owner, cell: (r) => <>{r.owner ?? '—'} <StatusBadge status={r.status} /></> },
    { id: 'cost', label: 'Cost', value: (r) => cost(r), cell: (r) => measureText(cost(r), measure) },
  ]
  return (
    <div className="uc-panel ud-table">
      <div className="uc-head"><span className="uc-title">Child ITSAs</span></div>
      {!rows.length ? <p className="muted uc-empty">No child ITSAs</p> : (
        <DataTable key={measure} className="usage-issues ud-children" rows={rows} cols={cols} rowKey={(r) => r.key} name={name} cost={(r) => cost(r)}
          initial={{ id: 'cost', dir: 'desc' }} onRow={(r) => drill({ kind: 'itsa', id: r.key })}
          phoneLine={(r) => `${r.owner ?? 'no owner'} · ${statusLabel(r.status)}`} />
      )}
    </div>
  )
}

export function ScopedView({ scope }: { scope: UsageScope }) {
  const { days, measure } = useUsageState()
  // An ITSA charts from when it opened, when the store knows that.
  const created = scope.kind === 'itsa' ? getData().itsas.find((i) => i.key === scope.id || i.id === scope.id)?.created_at : undefined
  const span = useMemo(() => itsaSpan(created), [created])
  const [colors] = useState<ColorMap>(() => new Map())
  const { data, loading, error, status, retry } = useScope(scope, apiDays(days), span)
  const back = <button type="button" className="ud-crumb" onClick={() => drill(null)}>All</button>
  if (error) {
    return (
      <div className="ud">
        <nav className="ud-crumbs" aria-label="Scope">{back}<span className="ud-sep" aria-hidden>›</span><b>{KIND_LABEL[scope.kind]} {scope.id}</b></nav>
        {status === 403 || status === 404
          ? <p className="muted uc-empty" role="status">{status === 403 ? 'Not visible to you' : 'Not found'}</p>
          : <div className="uc-error" role="alert"><p>Could not load this scope: {error}</p><button type="button" className="btn text" onClick={retry}>Retry</button></div>}
      </div>
    )
  }
  if (!data) {
    return (
      <div className="ud">
        <nav className="ud-crumbs" aria-label="Scope">{back}<span className="ud-sep" aria-hidden>›</span><b>{KIND_LABEL[scope.kind]} {scope.id}</b></nav>
        {loading ? <Loading className="muted uc-empty" /> : <p className="muted uc-empty">Nothing to show</p>}
      </div>
    )
  }
  const onAgent = (id: string) => drill({ kind: 'agent', id })
  const isItsa = data.scope.kind === 'itsa'
  const since = isItsa && span ? data.scope.key : undefined
  return (
    <div className="ud">
      <div className="ud-top"><Crumbs data={data} /><ActivityLink scope={scope} /></div>
      <Tiles data={data} measure={measure} />
      <section className="uc" aria-label="Spend">
        <Spend data={data} colors={colors} since={since} trimmed={span ? Date.now() - Date.parse(span.since) > RETAINED_MS : false} onAgent={onAgent} />
        <Models rows={data.by_model} colors={colors} measure={measure} />
      </section>
      <AgentsTable colors={colors} rows={data.by_agent} measure={measure} title={`Agents in ${isItsa ? data.scope.key : data.scope.kind === 'model' ? modelName(data.scope.name) : data.scope.kind === 'harness' ? harnessLabel(data.scope.id) : data.scope.name}`} />
      {isItsa ? <ChildItsas rows={data.itsas ?? []} measure={measure} /> : null}
    </div>
  )
}
