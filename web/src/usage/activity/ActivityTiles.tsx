// The Activity tab's four tiles (S-1011), on the Usage page's Tile: working agent-hours with a
// per-day sparkline, the time agents waited on the human, friction and its two largest parts, and
// cost per working hour in the page's Measure. In Cost mode (S-1491) the four tiles are cost: the total, cost per
// working hour, and the type and the tree that cost the most with their share; no tile shows hours.
import { sparkPath } from '../../system/usage'
import { measureText } from '../measure'
import type { UsageMeasure, UsageMode } from '../state'
import { Tile } from '../Tiles'
import type { ActSummary } from '../types'
import { categoryRows, costIn, frictionNote, hours, share, topCategory, youNote } from './format'

// The row with the largest cost in the measure, and its share of the total ("developer · 42%").
function topCost<T extends { cost_usd: number; modes?: ActSummary['tiles']['cost']['modes'] }>(rows: T[], total: number | null, measure: UsageMeasure) {
  const ranked = rows.map((r) => ({ r, v: costIn(r, measure) })).filter((x): x is { r: T; v: number } => x.v != null && x.v > 0).sort((a, b) => b.v - a.v)
  return ranked[0] ? { ...ranked[0], pct: total ? share(ranked[0].v, total) : null } : null
}

function CostTiles({ d, measure }: { d: ActSummary; measure: UsageMeasure }) {
  const t = d.tiles
  const total = costIn(t.cost, measure)
  const perHour = costIn(t.cost_per_working_hour, measure)
  const type = topCost(d.by_type ?? [], total, measure)
  const tree = topCost(d.trees ?? [], total, measure)
  const topLine = (x: ReturnType<typeof topCost>) => (x ? `${measureText(x.v, measure)}${x.pct ? ` · ${x.pct}` : ''}` : '')
  return (
    <>
      <div className="tiles ax-tiles">
        <Tile label="Cost" value={measureText(total, measure)}>{total == null ? 'not known in this measure' : 'the usage table\'s, in all'}</Tile>
        <Tile label="Cost per working hour" value={measureText(perHour, measure)}>
          {perHour == null ? (t.cost_per_working_hour ? 'not known in this measure' : 'no working time yet') : 'per working agent-hour'}
        </Tile>
        <Tile label="Top type" value={type ? `${type.r.type} · ${type.pct ?? '—'}` : '—'}>{type ? `${topLine(type)} · ${type.r.count} ${type.r.count === 1 ? 'agent' : 'agents'}` : 'no cost by type'}</Tile>
        <Tile label="Top tree" value={tree ? `${tree.r.name} · ${tree.pct ?? '—'}` : '—'}>{tree ? `${topLine(tree)} · ${tree.r.agents} ${tree.r.agents === 1 ? 'agent' : 'agents'}` : 'no cost by tree'}</Tile>
      </div>
      <p className="muted ax-note ax-nocost">Waiting, friction and idle time have no recorded cost, so they only show in Time mode.</p>
    </>
  )
}

export function ActivityTiles({ d, measure, mode }: { d: ActSummary; measure: UsageMeasure; mode: UsageMode }) {
  if (mode === 'cost') return <CostTiles d={d} measure={measure} />
  const t = d.tiles
  const spark = sparkPath(t.working_by_day.map((x) => ({ cost_usd: x.working_s })), 64, 20)
  const perHour = costIn(t.cost_per_working_hour, measure)
  // The real category with the largest share of the cost (estimated), to say where the hour's cost goes.
  const top = topCategory(categoryRows(d, 'cost', measure))
  const total = costIn(t.cost, measure)
  return (
    <div className="tiles ax-tiles">
      <Tile label="Working" value={hours(t.working_s)} spark={spark || undefined}>
        agent-hours, {share(t.working_s, d.clock.total_s)} of {hours(d.clock.total_s)} on the clock
      </Tile>
      <Tile label="Waiting on you" value={hours(t.you.seconds)}>{youNote(t.you)}</Tile>
      <Tile label="Friction" value={hours(t.friction.seconds)}>{frictionNote(t.friction.parts)}</Tile>
      <Tile label="Cost per working hour" value={measureText(perHour, measure)}>
        {perHour == null ? (t.cost_per_working_hour ? 'not known in this measure' : 'no working time yet')
          : top && total ? `${top.label} takes ${share(top.value ?? 0, total)} of it (est.)` : `${measureText(total, measure)} in all`}
      </Tile>
    </div>
  )
}
