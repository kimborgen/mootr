// The Usage overview's two charts (S-660): spend per bucket as stacked columns, and "where it
// went" as a ranked bar list of the same groups. Plain SVG, no chart library. It draws what
// GET /api/usage/series returns and nothing it invents: no rows, no spend, a plain message.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { measureText } from '../measure'
import { useUsageState, type UsageMeasure } from '../state'
import { AllAgentsLabel } from '../AgentTypeBar'
import {
  axisLabel, bucketLabel, colorVar, labelEvery, niceTicks, previousColumns, rankGroups, stackAll, OTHER, MAX_COLUMN_PX,
  type Column, type ColorMap, type DrillKind, type DrillTarget, type Series,
} from './math'
import { Loading } from '../../Loading'

export const GROUP_BY: { kind: DrillKind; label: string }[] = [
  { kind: 'tree', label: 'Tree' },
  { kind: 'itsa', label: 'ITSA' },
  { kind: 'model', label: 'Model' },
  { kind: 'harness', label: 'Harness' },
]

const H = 200
const PAD = { l: 44, r: 8, t: 8, b: 22 }
const GAP = 2 // the surface gap between stacked segments
const RADIUS = 3

// A rect with only its top corners rounded, for the top segment of a column.
function topRounded(x: number, y: number, w: number, h: number, r: number): string {
  const c = Math.max(0, Math.min(r, w / 2, h))
  return `M${x},${y + h}V${y + c}Q${x},${y} ${x + c},${y}H${x + w - c}Q${x + w},${y} ${x + w},${y + c}V${y + h}Z`
}

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null)
  const [w, setW] = useState(640)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => setW(Math.max(240, Math.round(el.getBoundingClientRect().width)) || 640)
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

interface Props {
  series: Series | null
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  group: DrillKind
  onGroup: (k: DrillKind) => void
  onDrill: (t: DrillTarget) => void
  colors: ColorMap
  // A type filter is set and these panels count every agent (S-1845): each title gets an "All agents" label.
  allAgents?: boolean
}

// The period's own label: Today for hourly buckets, else the number of days it draws.
export const periodLabel = (s: Series) => (s.bucket === 'hour' ? 'Today' : `${s.rows.length} days`)

// Two raised panels: spend per bucket (about two thirds) and where it went (one third); they
// stack on a phone.
export function SpendCharts({ series, loading, error, onRetry, group, onGroup, onDrill, colors, allAgents }: Props) {
  const { measure } = useUsageState()
  const ranked = useMemo(() => (series ? rankGroups(series, measure) : []), [series, measure])
  const prevCols = useMemo(() => (series ? previousColumns(series, measure) : []), [series, measure])
  const total = ranked.reduce((a, r) => a + r.value, 0)
  const has = !!series && series.rows.length > 0 && total > 0
  const drill = (id: string) => { if (id !== OTHER && id !== 'unattributed') onDrill({ kind: group, id }) }
  const paint = (g: { id: string; harness?: string }) => colorVar(colors, group, g)
  const label = GROUP_BY.find((g) => g.kind === group)?.label.toLowerCase() ?? group
  const topValue = Math.max(0.000001, ...ranked.map((x) => x.value))
  const drillable = ranked.some((r) => r.id !== OTHER)
  const empty = error && !series ? (
    <div className="uc-error" role="alert"><p>Could not load spend: {error}</p>{onRetry ? <button className="btn text" onClick={onRetry}>Retry</button> : null}</div>
  ) : loading && !series ? <Loading className="muted uc-empty" label="Loading spend" /> : <p className="muted uc-empty">No spend in this period</p>
  return (
    <section className="uc" aria-label="Spend overview">
      <div className="uc-panel uc-spend">
        <div className="uc-head">
          <span className="uc-title">Spend per {series?.bucket === 'hour' ? 'hour' : 'day'}</span>
          {allAgents ? <AllAgentsLabel /> : null}
          <span className="uc-by muted">by</span>
          <div className="seg" role="group" aria-label="Group by">
            {GROUP_BY.map((g) => (
              <button key={g.kind} className={g.kind === group ? 'on' : ''} aria-pressed={g.kind === group} onClick={() => onGroup(g.kind)}>{g.label}</button>
            ))}
          </div>
        </div>
        {!has ? empty : (
          <>
            <div className="uc-legend" aria-label="Legend">
              {ranked.map((g) => (
                <button key={g.id} className="uc-key" disabled={g.id === OTHER} onClick={() => drill(g.id)} title={g.name}>
                  <i style={{ background: paint(g) }} /><span>{g.name}</span>
                </button>
              ))}
            </div>
            <Columns series={series!} prev={prevCols} paint={paint} onDrill={drill} measure={measure} />
          </>
        )}
      </div>
      <div className="uc-panel uc-where">
        <div className="uc-head">
          <span className="uc-title">Where it went</span>
          {allAgents ? <AllAgentsLabel /> : null}
          {series ? <span className="muted uc-by">{periodLabel(series)} · by {label}</span> : null}
        </div>
        {!has ? empty : (
          <>
            <div className="uc-bars">
              {ranked.map((r) => (
                <button key={r.id} className="uc-bar" disabled={r.id === OTHER} onClick={() => drill(r.id)} title={r.name}>
                  <i className="uc-dot" style={{ background: paint(r) }} />
                  <span className="uc-name">{r.name}</span>
                  <span className="uc-val">{measureText(r.value, measure)}<span className="uc-share"> · {Math.round(r.share * 100)}%</span></span>
                  <span className="uc-track"><i style={{ width: Math.max(r.value > 0 ? 1 : 0, (r.value / topValue) * 100) + '%', background: paint(r) }} /></span>
                </button>
              ))}
            </div>
            {drillable ? <p className="muted uc-note">Click a segment or a bar to see its details.</p> : null}
          </>
        )}
      </div>
    </section>
  )
}

export function Columns({ series, prev, paint, onDrill, measure = 'api' }: { series: Series; prev: Column[]; paint: (g: { id: string; harness?: string }) => string; onDrill: (id: string) => void; measure?: UsageMeasure }) {
  const [wrap, W] = useWidth()
  const nPrev = prev.length
  const cols = useMemo(() => [...prev, ...stackAll(series, measure)], [prev, series, measure])
  const names = useMemo(() => new Map(series.groups.map((g) => [g.id, g])), [series])
  const n = cols.length
  const max = Math.max(...cols.map((c) => c.total), 0)
  const { ticks, top } = niceTicks(max)
  const iw = W - PAD.l - PAD.r
  const ih = H - PAD.t - PAD.b
  const slot = iw / n
  const y = (v: number) => PAD.t + ih - (v / top) * ih
  const [hover, setHover] = useState<number | null>(null)
  const [focus, setFocus] = useState<{ i: number; s: number } | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const every = labelEvery(n, iw)
  const active = hover ?? focus?.i ?? null
  const col = active == null ? null : cols[active]
  const curW = Math.min(slot * 0.72, MAX_COLUMN_PX)
  const curX = (i: number) => PAD.l + i * slot + (slot - curW) / 2
  const labelOf = (i: number) => bucketLabel(cols[i].t, series.bucket) + (i < nPrev ? ' (previous period)' : '')

  // Real DOM focus moves with the arrow keys: left and right between columns, up and down between
  // a column's segments (down from the lowest, or a column, lands on the column's bottom segment).
  const focusAt = (i: number, k?: number) => {
    const sel = k == null ? `[data-i="${i}"]:not([data-k])` : `[data-i="${i}"][data-k="${k}"]`
    svgRef.current?.querySelector<SVGElement>(sel)?.focus()
  }
  const key = (e: KeyboardEvent) => {
    const el = (e.target as Element).closest<SVGElement>('[data-i]')
    if (!el) return
    const i = Number(el.dataset.i)
    const k = el.dataset.k == null ? null : Number(el.dataset.k)
    const top = cols[i].segments.length - 1
    let handled = true
    if (e.key === 'ArrowRight') focusAt(Math.min(n - 1, i + 1))
    else if (e.key === 'ArrowLeft') focusAt(Math.max(0, i - 1))
    else if (e.key === 'ArrowUp') { if (top >= 0) focusAt(i, k == null ? top : Math.min(top, k + 1)) }
    else if (e.key === 'ArrowDown') { if (top >= 0) focusAt(i, k == null ? 0 : Math.max(0, k - 1)) }
    else if (e.key === 'Enter' || e.key === ' ') { const sg = cols[i].segments[k ?? top]; if (sg) onDrill(sg.id) }
    else handled = false
    if (handled) e.preventDefault()
  }

  const tipLeft = active == null ? 0 : Math.min(Math.max(curX(active) + curW / 2, 90), W - 90)
  return (
    <div className="uc-chart" ref={wrap} onMouseLeave={() => setHover(null)}>
      <svg ref={svgRef} width={W} height={H} role="group" aria-label="Spend per bucket, stacked by group. Arrow keys move between columns and segments; Enter drills into the segment." onKeyDown={key}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="uc-grid" x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} />
            <text className="uc-tick" x={PAD.l - 6} y={y(t)} textAnchor="end" dominantBaseline="middle">{measureText(t, measure)}</text>
          </g>
        ))}
        <line className="uc-axis" x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} />
        {cols.map((c, i) => {
          const focused = focus?.i === i
          return (
            <g key={c.t} data-i={i} className={'uc-col' + (active === i ? ' on' : '') + (i < nPrev ? ' prev' : '')} tabIndex={(focus?.i ?? n - 1) === i ? 0 : -1}
              role="button" aria-label={`${labelOf(i)}: ${measureText(c.total, measure)}`}
              onMouseEnter={() => setHover(i)}
              onFocus={(e) => { const kk = (e.target as Element).getAttribute('data-k'); setFocus({ i, s: kk == null ? Math.max(0, c.segments.length - 1) : Number(kk) }) }}
              onBlur={(e) => { if (!(e.relatedTarget instanceof Element && svgRef.current?.contains(e.relatedTarget))) setFocus(null) }}>
              <rect className="uc-hit" x={PAD.l + i * slot} y={PAD.t} width={slot} height={ih + PAD.b} />
              {c.segments.map((s, k) => {
                const isTop = k === c.segments.length - 1
                const yy = y(s.y1)
                const h = Math.max(0.5, y(s.y0) - yy - (k > 0 ? GAP : 0))
                const g: { id: string; name?: string; harness?: string } = names.get(s.id) ?? { id: s.id }
                const sel = focused && focus.s === k
                const props = { fill: paint(g), className: 'uc-seg' + (sel ? ' sel' : ''), onClick: () => onDrill(s.id), 'data-i': i, 'data-k': k, tabIndex: -1, role: 'button', 'aria-label': `${labelOf(i)}, ${g.name ?? s.id} ${measureText(s.value, measure)}` }
                return isTop
                  ? <path key={s.id} d={topRounded(curX(i), yy, curW, h, RADIUS)} {...props} />
                  : <rect key={s.id} x={curX(i)} y={yy} width={curW} height={h} {...props} />
              })}
              {i % every === 0 ? <text className="uc-x" x={curX(i) + curW / 2} y={H - 6} textAnchor="middle">{axisLabel(c.t, series.bucket, i === 0 || i === nPrev, slot * every >= 40)}</text> : null}
            </g>
          )
        })}
      </svg>
      {nPrev ? <p className="muted uc-note">The previous {periodLabel(series)} are dimmed, for comparison.</p> : null}
      {col ? (
        <div className="uc-tip" role="tooltip" style={{ left: tipLeft }}>
          <div className="uc-tip-h">{bucketLabel(col.t, series.bucket)}{active != null && active < nPrev ? <span className="uc-tip-sub">Previous period</span> : null}</div>
          {[...col.segments].reverse().map((s) => (
            <div key={s.id} className="uc-tip-r"><i style={{ background: paint(names.get(s.id) ?? { id: s.id }) }} /><span>{names.get(s.id)?.name ?? s.id}</span><b>{measureText(s.value, measure)}</b></div>
          ))}
          <div className="uc-tip-r tot"><span>Total</span><b>{measureText(col.total, measure)}</b></div>
        </div>
      ) : null}
    </div>
  )
}
