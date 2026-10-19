// Cost by agent type, and Cost by model (S-1491): the kept agents' cost split by registry type or by harness and
// model, from the summary's `by_type` and `by_model`. In Time mode the type card reads Time by agent type, the
// working agent-hours of the same rows, so a time figure never sits under a cost heading. Rows are largest first,
// each with a bar against the largest and its share; a Measure mode that can't be computed is a dash and sorts last.
import { useState } from 'react'
import { measureText } from '../measure'
import { harnessColor, harnessLabel } from '../shared'
import { setUsageState, type UsageMeasure, type UsageMode } from '../state'
import type { ActModelCost, ActTypeCost } from '../types'
import { configParts, costIn, hours, share, width } from './format'

export const BREAKDOWN_SHOWN = 8

interface Item { key: string; name: string; harness?: string; count: number; value: number | null; onTap?: () => void }

function Rows({ items, text, empty }: { items: Item[]; text: (v: number | null) => string; empty: string }) {
  const [all, setAll] = useState(false)
  const sorted = [...items].sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || a.name.localeCompare(b.name))
  const total = sorted.reduce((n, r) => n + (r.value ?? 0), 0)
  const max = sorted[0]?.value ?? 0
  const shown = all ? sorted : sorted.slice(0, BREAKDOWN_SHOWN)
  if (!items.length) return <p className="muted ax-none">{empty}</p>
  return (
    <>
      {shown.map((r) => (
        <div className="ax-share" key={r.key} data-key={r.key}>
          <span className="nm">
            {r.harness ? <i className="hdot" style={{ background: harnessColor(r.harness) }} title={harnessLabel(r.harness)} /> : null}
            {r.onTap ? <button type="button" className="ax-agent-name" onClick={r.onTap} title={`Count only ${r.name}`}>{r.name}</button> : r.name}
          </span>
          <span className="v">{text(r.value)}</span>
          <span className="meter" aria-hidden><i style={{ width: width(r.value ?? 0, max), background: 'var(--indigo-500)' }} /></span>
          <span className="who">{r.count} {r.count === 1 ? 'agent' : 'agents'}{r.value == null ? '' : ` · ${share(r.value, total)}`}</span>
        </div>
      ))}
      {sorted.length > BREAKDOWN_SHOWN ? (
        <button type="button" className="btn text ax-more" onClick={() => setAll(!all)}>{all ? `Show top ${BREAKDOWN_SHOWN}` : `Show all ${sorted.length}`}</button>
      ) : null}
    </>
  )
}

export function CostByType({ rows, mode, measure }: { rows: ActTypeCost[]; mode: UsageMode; measure: UsageMeasure }) {
  const cost = mode === 'cost'
  const items = rows.filter((r) => (cost ? true : r.working_s > 0)).map((r): Item => ({
    key: r.type, name: r.type, count: r.count, value: cost ? costIn(r, measure) : r.working_s,
    // Tapping a type counts only that type, as its button in the Agent types row does.
    onTap: () => setUsageState({ agents: [r.type] }),
  }))
  return (
    <section className="ax-card ax-types">
      <div className="ax-head"><h3>{cost ? 'Cost by agent type' : 'Time by agent type'}</h3><span className="muted ax-unit">{cost ? 'API $, % of week or Real $' : 'working agent-hours'}</span></div>
      <Rows items={items} text={(v) => (cost ? measureText(v, measure) : hours(v))} empty={cost ? 'No cost in this window yet' : 'No working time in this window yet'} />
    </section>
  )
}

export function CostByModel({ rows, measure }: { rows: ActModelCost[]; measure: UsageMeasure }) {
  const items = rows.map((r): Item => {
    const p = configParts(r.model)
    return { key: r.model, name: p.model, harness: p.harness, count: r.count, value: costIn(r, measure) }
  })
  return (
    <section className="ax-card ax-bottlenecks ax-models">
      <div className="ax-head"><h3>Cost by model</h3><span className="muted ax-unit">waits and bottlenecks have no cost</span></div>
      <Rows items={items} text={(v) => measureText(v, measure)} empty="No cost in this window yet" />
    </section>
  )
}
