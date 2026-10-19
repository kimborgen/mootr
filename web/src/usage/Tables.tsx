// The table tabs: Models, Agents and Days. Each shows one scope at a time (Today, Period or
// Lifetime) instead of ten token columns, with sortable columns and a share bar per row. At a phone
// width the token columns fold into a muted line under the name (the `wide` / `phone-only` pattern).
import { useState, type ReactNode } from 'react'
import { k } from '../format'
import type { AgentRow, ModelRow, Totals, Usage } from './types'
import { keepsType } from './agentFilter'
import { UsageFilter } from './AgentTypeBar'
import { useUsageState, type UsagePeriod } from './state'
import { measureText, measureValue, money, pct } from './measure'
import { harnessColor, harnessLabel, modelName } from './shared'

type Dir = 'asc' | 'desc'
export interface Col<R> {
  id: string
  label: string
  // The value the column sorts on; null sorts last.
  value: (r: R) => number | string | null
  cell: (r: R) => ReactNode
  wide?: boolean
  // A text column reads left, not as a number.
  text?: boolean
}

const dash = (v: number | null | undefined, fmt: (n: number) => string) => (v == null ? '—' : fmt(v))
const cmp = (a: number | string | null, b: number | string | null, dir: Dir): number => {
  if (a == null || b == null) return a == null && b == null ? 0 : a == null ? 1 : -1
  const c = typeof a === 'string' ? a.localeCompare(b as string) : a - (b as number)
  return dir === 'asc' ? c : -c
}

// A share bar: the row's part of the column total, as a percent with a bar.
function Share({ part, total }: { part: number | null; total: number }) {
  if (part == null || total <= 0) return <span className="muted">—</span>
  const pct = (part / total) * 100
  return (
    <span className="share-cell" title={`${pct.toFixed(1)}% of the total`}>
      <span className="share-pct">{pct < 1 && pct > 0 ? '<1' : Math.round(pct)}%</span>
      <span className="meter"><i style={{ width: Math.min(100, pct) + '%' }} /></span>
    </span>
  )
}

// A sortable table. The first column is the name; `phoneLine` is the muted line under it that
// holds the wide columns at a phone width. `cost` is the number the share bar divides.
export function DataTable<R>({ className, rows, cols, rowKey, name, phoneLine, cost, initial, onRow }: {
  className: string
  rows: R[]
  cols: Col<R>[]
  rowKey: (r: R) => string
  name: Col<R>
  phoneLine: (r: R) => string
  cost: (r: R) => number | null
  initial: { id: string; dir: Dir }
  // Makes a row open its scope: a click, or Enter on the focused row.
  onRow?: (r: R) => void
}) {
  const [sort, setSort] = useState(initial)
  const all = [name, ...cols]
  const col = all.find((c) => c.id === sort.id) ?? name
  const total = rows.reduce((x, r) => x + (cost(r) ?? 0), 0)
  const sorted = [...rows].sort((a, b) => cmp(col.value(a), col.value(b), sort.dir) || cmp(name.value(a), name.value(b), 'asc'))
  const head = (c: Col<R>) => {
    const on = sort.id === c.id
    return (
      <th key={c.id} className={(c.id === name.id || c.text ? '' : 'num ') + (c.wide ? 'wide' : '')} aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
        <button type="button" className="sort" onClick={() => setSort({ id: c.id, dir: on ? (sort.dir === 'asc' ? 'desc' : 'asc') : c.id === name.id ? 'asc' : 'desc' })}>
          {c.label}{on ? <span aria-hidden> {sort.dir === 'asc' ? '↑' : '↓'}</span> : null}
        </button>
      </th>
    )
  }
  return (
    <div className={'usage-table ' + className}>
      <table className="data"><tbody>
        <tr>{all.map(head)}<th className="num">Share</th></tr>
        {sorted.map((r) => (
          <tr key={rowKey(r)} className={onRow ? 'click' : undefined} tabIndex={onRow ? 0 : undefined}
            onClick={onRow ? () => onRow(r) : undefined} onKeyDown={onRow ? (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onRow(r) } : undefined}>
            <td>{name.cell(r)}<div className="muted phone-only">{phoneLine(r)}</div></td>
            {cols.map((c) => <td key={c.id} className={(c.text ? '' : 'num') + (c.wide ? ' wide' : '')}>{c.cell(r)}</td>)}
            <td className="num"><Share part={cost(r)} total={total} /></td>
          </tr>
        ))}
      </tbody></table>
    </div>
  )
}

const PERIOD_NAME: Record<UsagePeriod, string> = { 1: 'Today', 7: '7 days', 30: '30 days', 0: 'All time' }

// One row's totals for the page's period: today's and lifetime's own counters, and for 7 or 30
// days the API's top-level sums over `days`.
function totalsFor(r: ModelRow | AgentRow, days: UsagePeriod): Totals {
  if (days === 1) return r.today
  if (days === 0) return r.lifetime
  return {
    cost_usd: r.cost_usd ?? null,
    tokens_in: r.tokens_in ?? null,
    tokens_out: r.tokens_out ?? null,
    tokens_cache_read: r.tokens_cache_read ?? null,
    tokens_cache_write: r.tokens_cache_write ?? null,
    modes: r.modes,
    ...('cost_api_total' in r ? { cost_in: r.cost_in, cost_out: r.cost_out, cost_cache_read: r.cost_cache_read, cost_cache_write: r.cost_cache_write, cost_api_total: r.cost_api_total } : {}),
  }
}

interface SpendRow { key: string; name: string; harness: string; detail: string | null; t: Totals }

// A name with its harness colour dot.
export const Dot = ({ harness }: { harness: string }) => <i className="hdot" style={{ background: harnessColor(harness) }} />

// The tokens as one muted line, the phone's stand-in for the wide columns. On the Models table
// (`priced`) each count carries its API-equivalent cost, and the line ends with the total.
const tokenLine = (t: Totals, priced = false) => {
  const cache = t.tokens_cache_read == null && t.tokens_cache_write == null ? null : (t.tokens_cache_read ?? 0) + (t.tokens_cache_write ?? 0)
  // A cache cost is known only when every reported cache counter has a price: a null stays null, never 0.
  const part = (n: number | null, c: number | null | undefined) => (n == null || n === 0 ? 0 : c ?? null)
  const rc = part(t.tokens_cache_read, t.cost_cache_read), wc = part(t.tokens_cache_write, t.cost_cache_write)
  const cacheCost = cache == null || rc == null || wc == null ? null : rc + wc
  const costs = priced && [t.cost_in, t.cost_out, cacheCost, t.cost_api_total].some((c) => c != null)
  const at = (c: number | null | undefined) => (costs && c != null ? ` (${money(c)})` : '')
  const line = `${dash(t.tokens_in, k)} in${at(t.cost_in)} · ${dash(t.tokens_out, k)} out${at(t.cost_out)} · ${dash(cache, k)} cache${at(cacheCost)}`
  return costs && t.cost_api_total != null ? `${line} · est. ${money(t.cost_api_total)}` : line
}

// The share of the week's subscription window a row used (S-1440): empty for a model that isn't on
// a subscription (the daemon sends 0), a dash where the window isn't calibrated.
const weekShare = (t: Totals): number | null | undefined => (t.modes ? t.modes.seven_day : undefined)
const weekText = (t: Totals) => { const v = weekShare(t); return v === undefined || v === 0 ? '' : v == null ? '—' : pct(v) }

// What each Models column means, in plain words, for the ? by the table heading (S-1440).
export const MODEL_HELP: [string, string][] = [
  ['In', 'Fresh input, not cached.'],
  ['Out', 'Tokens the model generated.'],
  ['Cache read', 'Input read back from the cache. It is cheap, and it is large in long sessions because each turn re-reads the whole conversation.'],
  ['Cache write', 'Input written to the cache.'],
  ['Token est.', 'What those tokens would cost at public API list prices, per kind beside its count and in total. A dash means the model has no verified price. Cache writes are priced at the 5-minute rate, so it can be low for 1-hour writes.'],
  ['Cost', 'What the harness reported (OpenRouter: what was billed), in the chosen Measure. It can differ from the token estimate at list prices.'],
  ['% of week', 'This model\'s share of its subscription\'s 7-day window. Empty when the model does not run on a subscription.'],
]

// The ? button and the plain-words explanation it opens under the table heading.
export function ModelsHelp({ startOpen = false }: { startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen)
  return (
    <>
      <button type="button" className="help-btn" aria-expanded={open} aria-controls="models-help" aria-label="What do the columns mean?" onClick={() => setOpen(!open)}>?</button>
      {open ? <dl id="models-help" className="usage-help">{MODEL_HELP.map(([t, d]) => <div key={t}><dt>{t}</dt><dd>{d}</dd></div>)}</dl> : null}
    </>
  )
}

// The Models and Agents table. `harnessCol` adds a Harness column (Models); an agent's harness and
// model sit in a muted line under its name instead.
function SpendTable({ head, className, rows, days, harnessCol, helpOpen }: { head: string; className: string; rows: (Omit<SpendRow, 't'> & { src: ModelRow | AgentRow })[]; days: UsagePeriod; harnessCol?: boolean; helpOpen?: boolean }) {
  const { measure } = useUsageState()
  const data: SpendRow[] = rows.map((x) => ({ key: x.key, name: x.name, harness: x.harness, detail: x.detail, t: totalsFor(x.src, days) }))
  // The row's cost in the chosen measure: API $ from cost_usd, otherwise the units the daemon sent.
  const cost = (r: SpendRow) => (measure === 'api' ? r.t.cost_usd : measureValue(r.t.modes, measure))
  const total = data.reduce((x, r) => x + (cost(r) ?? 0), 0)
  // On Models a count carries its API-equivalent cost beside it ("1.2M · $3.40").
  const tokens = (key: 'tokens_in' | 'tokens_out' | 'tokens_cache_read' | 'tokens_cache_write', label: string, costKey: 'cost_in' | 'cost_out' | 'cost_cache_read' | 'cost_cache_write'): Col<SpendRow> => ({
    id: key, label, wide: true, value: (r) => r.t[key],
    cell: (r) => harnessCol && costKey in r.t ? <>{dash(r.t[key], k)} <span className="muted">· {dash(r.t[costKey], money)}</span></> : dash(r.t[key], k),
  })
  const name: Col<SpendRow> = {
    id: 'name', label: head, value: (r) => r.name,
    cell: (r) => <><Dot harness={r.harness} />{r.name}{r.detail ? <div className="muted">{r.detail}</div> : null}</>,
  }
  const cols: Col<SpendRow>[] = [
    ...(harnessCol ? [{ id: 'harness', label: 'Harness', wide: true, text: true, value: (r: SpendRow) => harnessLabel(r.harness), cell: (r: SpendRow) => harnessLabel(r.harness) }] : []),
    tokens('tokens_in', 'In', 'cost_in'), tokens('tokens_out', 'Out', 'cost_out'), tokens('tokens_cache_read', 'Cache read', 'cost_cache_read'), tokens('tokens_cache_write', 'Cache write', 'cost_cache_write'),
    ...(harnessCol ? [
      { id: 'cost_api_total', label: 'Token est.', wide: true, value: (r: SpendRow) => r.t.cost_api_total ?? null, cell: (r: SpendRow) => dash(r.t.cost_api_total, money) },
      // Under the % of week measure the Cost column already is the share.
      ...(measure === 'week' ? [] : [{ id: 'week', label: '% of week', wide: true, value: (r: SpendRow) => (weekShare(r.t) ? weekShare(r.t)! : null), cell: (r: SpendRow) => weekText(r.t) }]),
    ] : []),
    { id: 'cost', label: 'Cost', value: (r) => cost(r), cell: (r) => measureText(cost(r), measure) },
  ]
  return (
    <>
      <div className="usage-sub"><b>{head === 'Model' ? 'Models' : 'Agents'}</b>{harnessCol ? <ModelsHelp startOpen={helpOpen} /> : null}<span className="muted">{PERIOD_NAME[days]} · {data.length} {data.length === 1 ? head.toLowerCase() : head.toLowerCase() + 's'} · {measureText(total, measure)}</span></div>
      <DataTable
        key={days + measure}
        className={className}
        rows={data}
        cols={cols}
        rowKey={(r) => r.key}
        name={name}
        cost={cost}
        initial={{ id: 'cost', dir: 'desc' }}
        phoneLine={(r) => (harnessCol ? harnessLabel(r.harness) + ' · ' : '') + tokenLine(r.t, harnessCol) + (harnessCol && measure !== 'week' && weekText(r.t) ? ` · ${weekText(r.t)} of week` : '')}
      />
    </>
  )
}

// `helpOpen` starts the ? panel open, for the story and screenshots.
export function ModelsTab({ u, days, helpOpen }: { u: Usage; days: UsagePeriod; helpOpen?: boolean }) {
  const bar = <UsageFilter u={u} />
  if (!u.by_model.length) return <>{bar}<p className="muted">{u.filtered_agents?.length ? 'No model spend for these types in this period' : 'No model spend yet'}</p></>
  return <>{bar}<SpendTable head="Model" className="usage-models" days={days} harnessCol helpOpen={helpOpen}
    rows={u.by_model.map((x) => ({ key: x.harness + x.model, name: modelName(x.model), harness: x.harness, detail: null, src: x }))} /></>
}

export function AgentsTab({ u, days }: { u: Usage; days: UsagePeriod }) {
  const { agents } = useUsageState()
  // On an older daemon the rows and the totals below are filtered here; the other tabs still count every agent.
  const bar = <UsageFilter u={u} olderNote="This daemon does not filter usage by agent type: the rows and totals on this tab count only those types; the other tabs count every agent." />
  if (!u.by_agent.length) return <>{bar}<p className="muted">{u.filtered_agents?.length ? 'No agent of these types spent in this period' : 'No agent spend yet'}</p></>
  // The daemon already filtered; this also covers a daemon that ignores `agents=`.
  const kept = u.by_agent.filter((x) => keepsType(agents, x.type))
  if (!kept.length) return <>{bar}<p className="muted">No agent of these types spent in this period</p></>
  return <>{bar}<SpendTable head="Agent" className="usage-agents" days={days}
    rows={kept.map((x) => ({ key: x.agent_id ?? x.agent, name: x.agent, harness: x.harness, detail: `${harnessLabel(x.harness)}${x.model ? ` · ${modelName(x.model)}` : ''}`, src: x }))} /></>
}

// Spend per day as simple bars, scaled to the largest day.
function DayBars({ rows, value }: { rows: Usage['by_day']; value: (r: Usage['by_day'][number]) => number }) {
  const { measure } = useUsageState()
  const max = Math.max(0.0001, ...rows.map(value))
  return (
    <div className="dbars">
      {rows.map((r) => (
        <div className="dbar" key={r.day}>
          <span className="dbar-day">{r.day}</span>
          <span className="dbar-track"><i style={{ width: (value(r) / max) * 100 + '%' }} /></span>
          <span className="dbar-val">{measureText(value(r), measure)}</span>
        </div>
      ))}
    </div>
  )
}

export function DaysTab({ u }: { u: Usage }) {
  const { measure } = useUsageState()
  const bar = <UsageFilter u={u} />
  if (!u.by_day.length) return <>{bar}<p className="muted">{u.filtered_agents?.length ? 'No spend by these types in this period' : 'No spend in this period'}</p></>
  type D = Usage['by_day'][number]
  const cost = (r: D) => (measure === 'api' ? r.cost_usd : measureValue(r.modes, measure) ?? 0)
  const name: Col<D> = { id: 'day', label: 'Day', value: (r) => r.day, cell: (r) => r.day }
  const cols: Col<D>[] = [
    { id: 'in', label: 'Tokens in', wide: true, value: (r) => r.tokens_in, cell: (r) => k(r.tokens_in) },
    { id: 'cost', label: 'Spend', value: (r) => cost(r), cell: (r) => measureText(cost(r), measure) },
  ]
  return (
    <>
      {bar}
      <DayBars rows={u.by_day} value={cost} />
      <DataTable key={measure} className="usage-days" rows={u.by_day} cols={cols} rowKey={(r) => r.day} name={name}
        cost={(r) => cost(r)} initial={{ id: 'day', dir: 'desc' }} phoneLine={(r) => `Tokens in ${k(r.tokens_in)}`} />
    </>
  )
}
