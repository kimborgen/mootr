// The Agents page, `w:agents` (S-1428, S-1432). On the desktop, the agents table (AgentsTable.tsx) under a page
// header: the title, the live count, the scope chips (S-2937), the grouping, the search, the column picker and the
// legend. On a phone the page keeps the agent tree it had (S-1428); the phone list is a later PR. Counts come from
// the sidebar's sources.
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { selectAgent } from './actions'
import { AgentsTable } from './AgentsTable'
import { type MenuItem, showMenu } from './ui/menu'
import { live } from './format'
import { Icon } from './Icon'
import { showLegend } from './legend'
import { Loading } from './Loading'
import { useWaiting } from './itsa/WaitingList'
import { Tree, TreeTools } from './Tree'
import { useData } from './store'
import { usePhone } from './ui/phone'
import { useUi } from './ui/state'
import { DetailsView } from './views/DetailsView'
import { useAgentsView, setAgentsView } from './agents-table-view'
import { ALL_COLS, COLUMNS, GROUPS, SCOPES, buildLines, factsOf, nextSort, orderOf, scopeAgents, scopeCounts, toggleCol, type ColumnId, type Group, type Scope, type Sort, type SortCol } from './agents-table'

// The rows the table draws at once. A larger list pages in with a button below it, so an archive of hundreds
// doesn't draw every row at each render.
const PAGE = 100
// The desk's width (S-3048) at which the detail pane opens when the human hasn't set it, and below which an open
// pane lies over the table rather than taking its width from it.
const PANE_OPEN_AT = 1100
const PANE_OVERLAY_BELOW = 900
// What an empty scope says.
const SCOPE_EMPTY: Record<Scope, string> = {
  live: 'No agents running. Press + to add one.',
  waiting: 'No agent is waiting on anything.',
  stopped: 'No stopped agents.',
  archived: 'No archived agents.',
}

// `picked` is the row selected at first, for the stories and tests; the page then keeps its own selection.
export function AgentsPage({ picked = null }: { picked?: string | null } = {}) {
  return usePhone() ? <AgentsPhone /> : <AgentsDesk picked={picked} />
}

// The width of an element as it resizes, or 0 until it is first measured.
function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return width
}

// The phone's page: the agent tree, as S-1428 left it.
function AgentsPhone() {
  const { agents } = useData()
  const waiting = useWaiting().length
  return <section className="agents-view" id="agents-view" aria-label="Agents">
    <div className="agents-head">
      <h2 className="agents-title">Agents</h2>
      <span className="agents-count" data-agents-count>{agents.filter(live).length} live{waiting ? <> · <span className="asks">{waiting} waiting</span></> : null}</span>
      <TreeTools />
    </div>
    <Tree page />
  </section>
}

// The columns menu: each picked column numbered in the order it shows, and a reset to every column.
const colsItems = (picked: ColumnId[]): MenuItem[] => [{ section: 'Columns, in order' }, ...COLUMNS.map((c) => {
  const at = picked.indexOf(c.id)
  return { label: c.label, checked: at >= 0, checkbox: true, glyph: <span className="colnum">{at >= 0 ? at + 1 : ''}</span>, action: () => setAgentsView({ cols: toggleCol(picked, c.id) }) }
}), 'sep', { label: 'All columns', action: () => setAgentsView({ cols: ALL_COLS }) }]

function AgentsDesk({ picked }: { picked: string | null }) {
  const { agents, itsas, machine, thresholds, loaded } = useData()
  const waiting = useWaiting().length
  const { cols, group, scope, pane } = useAgentsView()
  const collapsed = useUi().collapsed
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort | null>(null)
  const [cursor, setCursor] = useState<string | null>(picked)
  const [pages, setPages] = useState(1)
  const search = useRef<HTMLInputElement>(null)
  const desk = useRef<HTMLElement>(null)
  // The detail pane (S-3048): open when the human has said so, else open from the page's width on.
  const width = useWidth(desk)
  const open = pane ?? width >= PANE_OPEN_AT
  const overlay = open && width < PANE_OVERLAY_BELOW
  const facts = useMemo(() => factsOf(agents, itsas, machine), [agents, itsas, machine])
  const all = useMemo(() => buildLines(agents, facts, { group, query, sort, collapsed, scope }), [agents, facts, group, query, sort, collapsed, scope])
  const lines = useMemo(() => all.slice(0, PAGE * pages), [all, pages])
  const order = useMemo(() => orderOf(lines), [lines])
  const counts = useMemo(() => scopeCounts(agents), [agents])
  const running = counts.live
  // A new scope starts at its first page. The picked row stays picked when the scope still lists its agent.
  const pick = (s: Scope) => {
    setAgentsView({ scope: s })
    setPages(1)
    setCursor((c) => (c && scopeAgents(agents, s).some((a) => a.id === c) ? c : null))
  }

  // j, k and the arrows move the cursor (the selection), Enter opens its agent, / searches, Esc clears the search,
  // and Space shows or hides the detail pane. Keys typed into a field, and Enter or Space on a button, link or fold
  // (a sort header, Columns, the legend, the pane's own controls), are left alone.
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && query) { e.preventDefault(); return setQuery('') }
    const target = e.target as HTMLElement
    if (target.isContentEditable || target.matches('input, select, textarea, button, a, summary')) return
    const move = (d: number) => {
      if (!order.length) return
      const i = cursor ? order.indexOf(cursor) : -1
      setCursor(order[Math.max(0, Math.min(order.length - 1, i + d))])
    }
    if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); move(1) }
    else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
    else if (e.key === ' ') { e.preventDefault(); setAgentsView({ pane: !open }) }
    else if (e.key === '/') { e.preventDefault(); search.current?.focus() }
    else if (e.key === 'Enter' && cursor) selectAgent(cursor)
  }
  const empty = !agents.length
    ? (loaded.agents ? <div className="pad muted">{SCOPE_EMPTY.live}</div> : <Loading />)
    : lines.length ? null : query ? <div className="pad muted">No agent matches “{query}”.</div> : <div className="pad muted">{SCOPE_EMPTY[scope]}</div>

  return <section ref={desk} className="agents-view agents-desk" id="agents-view" aria-label="Agents" onKeyDown={key}>
    <div className="agents-head">
      <h2 className="agents-title">Agents</h2>
      <span className="agents-count" data-agents-count>{running} live{waiting ? <> · <span className="asks">{waiting} asks or waits</span></> : null}</span>
      <div className="seg agents-scope" role="radiogroup" aria-label="Scope">
        {SCOPES.map((s) => <button key={s.id} type="button" role="radio" aria-checked={scope === s.id} className={scope === s.id ? 'on' : ''} data-scope-chip={s.id}
          onClick={() => pick(s.id)}>{s.label} <span className="count">{counts[s.id]}</span></button>)}
      </div>
      <select className="agents-group" aria-label="Group by" value={group} onChange={(e) => setAgentsView({ group: e.target.value as Group })}>
        {GROUPS.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
      </select>
      <input ref={search} type="search" className="agents-search" placeholder="Search agents" aria-label="Search agents" autoComplete="off" spellCheck={false} value={query} onChange={(e) => setQuery(e.target.value)} />
      <button type="button" className="icon-btn" data-agents-cols title="Columns" aria-label="Columns" aria-haspopup="menu"
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); showMenu(r.left, r.bottom + 4, colsItems(cols), e.currentTarget) }}><Icon name="columns-2" size="xs" /></button>
      <button type="button" className="icon-btn" data-legend-open title="What the marks mean" aria-label="What the marks mean" aria-haspopup="dialog" onClick={(e) => showLegend(e.currentTarget)}><Icon name="circle-help" size="xs" /></button>
    </div>
    <div className={`agents-body${overlay ? ' overlay' : ''}`}>
      <div className="agents-main">
        <AgentsTable lines={lines} facts={facts} group={group} gone={scope === 'stopped' || scope === 'archived'} cols={cols} sort={sort} cursor={cursor} enforce={thresholds.enforceTokens}
          onSort={(c: SortCol) => setSort((s) => nextSort(s, c))} onPick={(id) => setCursor(id)} empty={empty} />
        {all.length > lines.length ? <button type="button" className="btn text agents-more" data-agents-more onClick={() => setPages(pages + 1)}>
          Show {Math.min(PAGE, all.length - lines.length)} more</button> : null}
      </div>
      {open ? <aside className="agents-pane" aria-label="Selected agent" data-agents-pane>
        {cursor ? <DetailsView key={cursor} id={cursor} /> :<div className="details pad"><div className="empty-pane"><p>Select an agent to see its details here.</p></div></div>}
      </aside> : null}
    </div>
  </section>
}
