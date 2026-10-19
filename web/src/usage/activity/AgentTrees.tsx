// Agents by tree (S-1012): the root agents of the scope with their subtrees' totals, each root's direct
// children indented under it. Each row: the harness mark, the name, "· type · N agents", the cost in
// the page's Measure and the working hours, and a thin bar split by the clock groups (the clock bar's
// colours). [Cost | Working | Friction] sorts. The top eight roots show, the rest behind "Show all N",
// and a root's top three children, the rest one tap into its tree (scoped to one tree, its top ten,
// then Show all); the legend once below. Tapping a row
// scopes the tab to that tree (S-661's drill scope). In Cost mode (S-1491) the rows sort by cost and show only the
// cost in the Measure, with a thin bar of its share of the largest root; no hours, no sort control.
import { useState } from 'react'
import { measureText } from '../measure'
import { harnessColor, harnessLabel } from '../shared'
import { setUsageState, type UsageMeasure, type UsageMode } from '../state'
import type { ActTree, ActTreeRow } from '../types'
import { costIn, GROUP_ORDER, GROUP_COLOR, GROUP_SHORT, hours, sortTrees, treeParts, width, type TreeSort } from './format'

export const TREES_SHOWN = 8
// A root's largest children show; the rest open with the tree's own scope. Scoped to one tree, its
// top ten children show, the rest behind "Show all N".
export const CHILDREN_SHOWN = 3
export const SCOPED_CHILDREN_SHOWN = 10
const SORTS: { id: TreeSort; label: string }[] = [{ id: 'working', label: 'Working' }, { id: 'friction', label: 'Friction' }]

function Row({ r, measure, mode, max, child }: { r: ActTreeRow; measure: UsageMeasure; mode: UsageMode; max: number; child?: boolean }) {
  const cost = mode === 'cost'
  const own = costIn(r, measure)
  const parts = treeParts(r)
  const total = parts.reduce((n, p) => n + p.seconds, 0)
  const meta = [r.type, `${r.agents} ${r.agents === 1 ? 'agent' : 'agents'}`].filter(Boolean).join(' · ')
  return (
    <button type="button" className={'ax-tree' + (child ? ' child' : '')} data-id={r.id} onClick={() => setUsageState({ scope: { kind: 'tree', id: r.id } })}
      title={`Activity for ${r.name}'s tree`}>
      <span className="nm">
        <i className="hdot" style={{ background: harnessColor(r.harness ?? '') }} title={harnessLabel(r.harness ?? '')} />
        <b>{r.name}</b><span className="muted"> · {meta}</span>
      </span>
      <span className="v">{cost ? measureText(own, measure) : hours(r.working_s)}</span>
      {cost ? (
        <span className="ax-stack thin" role="img" aria-label={`cost ${measureText(own, measure)}`}>
          <i style={{ width: width(own ?? 0, max), background: 'var(--indigo-500)' }} />
        </span>
      ) : (
        <span className="ax-stack thin" role="img" aria-label={parts.filter((p) => p.seconds > 0).map((p) => `${GROUP_SHORT[p.key]} ${hours(p.seconds)}`).join(', ')}>
          {parts.filter((p) => p.seconds > 0).map((p) => <i key={p.key} style={{ width: width(p.seconds, total), background: p.color }} />)}
        </span>
      )}
    </button>
  )
}

export function AgentTrees({ trees, measure, mode }: { trees: ActTree[]; measure: UsageMeasure; mode: UsageMode }) {
  const [pick, setBy] = useState<TreeSort>('working')
  const by: TreeSort = mode === 'cost' ? 'cost' : pick
  const [all, setAll] = useState(false)
  const [allKids, setAllKids] = useState(false)
  // "Show all" belongs to the scope it was opened in: another scope (another tree, or back to every tree) starts closed.
  const scopeKey = trees.length === 1 ? trees[0].id : ''
  const [seen, setSeen] = useState(scopeKey)
  if (seen !== scopeKey) {
    setSeen(scopeKey)
    setAll(false)
    setAllKids(false)
  }
  const sorted = sortTrees(trees, by, measure)
  const max = Math.max(0, ...trees.flatMap((t) => [costIn(t, measure) ?? 0, ...t.children.map((c) => costIn(c, measure) ?? 0)]))
  const shown = all ? sorted : sorted.slice(0, TREES_SHOWN)
  // One root (the tab scoped to a tree) has no further tree to open: its children open in place.
  const scoped = trees.length === 1
  const kids = scoped ? (allKids ? Infinity : SCOPED_CHILDREN_SHOWN) : CHILDREN_SHOWN
  return (
    <section className="ax-card ax-trees">
      <div className="ax-head">
        <h3>Agents by tree</h3>
        {mode === 'cost' ? <span className="muted ax-unit">by cost</span> : (
          <div className="seg" role="group" aria-label="Sort by">
            {SORTS.map((x) => <button key={x.id} type="button" className={by === x.id ? 'on' : ''} aria-pressed={by === x.id} onClick={() => setBy(x.id)}>{x.label}</button>)}
          </div>
        )}
      </div>
      {!trees.length ? <p className="muted ax-none">No agent activity in this window yet</p> : (
        <>
          {shown.map((t) => (
            <div className="ax-tree-group" key={t.id}>
              <Row r={t} measure={measure} mode={mode} max={max} />
              {sortTrees(t.children, by, measure).slice(0, kids).map((c) => <Row key={c.id} r={c} measure={measure} mode={mode} max={max} child />)}
              {scoped ? (t.children.length > SCOPED_CHILDREN_SHOWN ? (
                <button type="button" className="btn text ax-tree-more" onClick={() => setAllKids(!allKids)}>
                  {allKids ? `Show top ${SCOPED_CHILDREN_SHOWN}` : `Show all ${t.children.length}`}
                </button>
              ) : null) : t.children.length > kids ? (
                <button type="button" className="btn text ax-tree-more" onClick={() => setUsageState({ scope: { kind: 'tree', id: t.id } })}>
                  {t.children.length - kids} more under {t.name}
                </button>
              ) : null}
            </div>
          ))}
          {trees.length > TREES_SHOWN ? (
            <button type="button" className="btn text ax-more" onClick={() => setAll(!all)}>{all ? `Show top ${TREES_SHOWN}` : `Show all ${trees.length}`}</button>
          ) : null}
          {mode === 'cost' ? null : (
            <div className="stack-legend ax-legend">
              {GROUP_ORDER.map((k) => <span key={k}><i style={{ background: GROUP_COLOR[k] }} />{GROUP_SHORT[k]}</span>)}
            </div>
          )}
        </>
      )}
    </section>
  )
}
