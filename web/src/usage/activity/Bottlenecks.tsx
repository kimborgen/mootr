// Bottlenecks (S-1011): the wait and slow-work leaves that can be fixed, largest first. Each row: its
// label (a "you" tag for the human's), agent-hours, a thin bar against the largest, the agents it hit
// and the top two, and its single longest span when that is most of it ("one 12 h pause"). The top
// eight show; the rest behind "Show all N". Tapping an agent's name scopes the tab to it (S-1012).
import { useState } from 'react'
import { setUsageState } from '../state'
import type { ActBottleneck } from '../types'
import { GROUP_COLOR, hours, isYou, longestNote, width } from './format'

export const BOTTLENECKS_SHOWN = 8

function Row({ b, max }: { b: ActBottleneck; max: number }) {
  const long = longestNote(b)
  return (
    <div className="ax-bn" data-key={b.key}>
      <span className="nm">{b.label}{isYou(b) ? <span className="ax-tag you">you</span> : null}</span>
      <span className="v">{hours(b.seconds)}</span>
      <span className="meter" aria-hidden><i style={{ width: width(b.seconds, max), background: GROUP_COLOR[b.group] }} /></span>
      <span className="who">
        {b.agents} {b.agents === 1 ? 'agent' : 'agents'}{long ? `, ${long}` : ''}
        {b.top.slice(0, 2).map((a) => <span key={a.id}> · <button type="button" className="ax-agent-name" onClick={() => setUsageState({ scope: { kind: 'agent', id: a.id } })}>{a.name}</button> {hours(a.seconds)}</span>)}
      </span>
    </div>
  )
}

export function Bottlenecks({ rows }: { rows: ActBottleneck[] }) {
  const [all, setAll] = useState(false)
  const max = rows[0]?.seconds ?? 0
  const shown = all ? rows : rows.slice(0, BOTTLENECKS_SHOWN)
  return (
    <section className="ax-card ax-bottlenecks">
      <div className="ax-head"><h3>Bottlenecks</h3><span className="muted ax-unit">agent-hours</span></div>
      {rows.length ? shown.map((b) => <Row key={b.key} b={b} max={max} />) : <p className="muted ax-none">No waits or slow work in this window</p>}
      {rows.length > BOTTLENECKS_SHOWN ? (
        <button type="button" className="btn text ax-more" onClick={() => setAll(!all)}>{all ? `Show top ${BOTTLENECKS_SHOWN}` : `Show all ${rows.length}`}</button>
      ) : null}
    </section>
  )
}
