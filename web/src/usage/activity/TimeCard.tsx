// Where the time goes (S-1011): one clock bar of the scope's agent-hours, split into working, other
// agents and jobs, the human, friction and idle, with a legend row per group (hours and share); then
// working time by what the work was for. In Cost mode (the page's Time | Cost switch, S-1491) it is Where
// the cost goes instead: the categories by their cost in the page's Measure, an estimate (item cost per
// category, scaled to the usage total), marked "est.", with no clock bar, since the clock is time.
import { measureText } from '../measure'
import type { UsageMeasure, UsageMode } from '../state'
import type { ActSummary } from '../types'
import { categoryRows, clockRows, hours, share, width } from './format'

function Stack({ label, parts, total }: { label: string; parts: { key: string; value: number; color: string; title: string }[]; total: number }) {
  return (
    <div className="ax-stack" role="img" aria-label={label}>
      {parts.filter((p) => p.value > 0).map((p) => <i key={p.key} title={p.title} style={{ width: width(p.value, total), background: p.color }} />)}
    </div>
  )
}

export function TimeCard({ d, measure, mode }: { d: ActSummary; measure: UsageMeasure; mode: UsageMode }) {
  const by = mode
  const clock = clockRows(d)
  const total = d.clock.total_s
  const cats = categoryRows(d, by, measure)
  const catTotal = cats.reduce((n, c) => n + (c.value ?? 0), 0)
  const fmt = (v: number | null) => (by === 'time' ? hours(v) : measureText(v, measure))
  return (
    <section className="ax-card ax-time">
      <div className="ax-head"><h3>{by === 'time' ? 'Where the time goes' : 'Where the cost goes'}</h3></div>
      {by === 'time' ? (
        <>
          <div className="ax-bar-label"><span><b>The clock</b> agent-hours, agents at once each count</span><span>{hours(total)}</span></div>
          <Stack label={clock.map((g) => `${g.label} ${hours(g.seconds)}`).join(', ')} total={total}
            parts={clock.map((g) => ({ key: g.key, value: g.seconds, color: g.color, title: `${g.label} ${hours(g.seconds)}` }))} />
          <div className="ax-rows">
            {clock.map((g) => (
              <div className="ax-row" key={g.key} data-group={g.key}>
                <i className="sw" style={{ background: g.color }} />
                <span className="nm">{g.label}{g.hint ? <span className="muted"> · {g.hint}</span> : null}</span>
                <span className="v">{hours(g.seconds)}</span>
                <span className="s">{share(g.seconds, total)}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}
      <div className="ax-bar-label ax-cat-label">
        <span><b>{by === 'time' ? 'Working' : 'Cost'}</b> by what the work was for{by === 'cost' ? ', est.' : ''}</span>
        <span>{by === 'time' ? hours(d.tiles.working_s) : measureText(cats.some((c) => c.value == null) ? null : catTotal, measure)}</span>
      </div>
      {cats.length ? (
        <>
          <Stack label={cats.map((c) => `${c.label} ${fmt(c.value)}`).join(', ')} total={catTotal}
            parts={cats.map((c) => ({ key: c.key, value: c.value ?? 0, color: c.color, title: `${c.label} ${fmt(c.value)}` }))} />
          <div className="ax-rows">
            {cats.map((c) => (
              <div className={c.muted ? 'ax-row muted' : 'ax-row'} key={c.key} data-category={c.key}>
                <i className="sw" style={{ background: c.color }} />
                <span className="nm">{c.label}</span>
                <span className="v">{fmt(c.value)}</span>
                <span className="s">{by === 'cost' ? (c.value == null ? '' : `est. ${share(c.value, catTotal)}`) : share(c.value ?? 0, catTotal)}</span>
              </div>
            ))}
          </div>
        </>
      ) : <p className="muted ax-none">{by === 'time' ? 'No working time in this window yet' : 'No cost in this window yet'}</p>}
    </section>
  )
}
