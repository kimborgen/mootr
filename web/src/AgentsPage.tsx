// The Agents page, `w:agents` (S-1428, S-1432). On the desktop, the agents table (AgentsTable.tsx) under a page
// header: the title, the live count, the scope chips (S-2937), the grouping, the search, the column picker and the
// legend. On a phone the page is the agent list (AgentsPhone, S-1432). Counts come from the sidebar's sources.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from 'react'
import { agentMenu, selectAgent } from './actions'
import { AgentsBulk } from './AgentsBulk'
import { AgentsTable } from './AgentsTable'
import { keepChecked, rangeOf } from './agents-bulk'
import { OpenAskLink, openAskRow } from './mail/OpenAskLink'
import { menuOpen, type MenuItem, showMenu } from './ui/menu'
import { costCell, costTitle, live, model } from './format'
import { Glyph } from './Glyph'
import { Icon } from './Icon'
import { showLegend } from './legend'
import { Loading } from './Loading'
import { useWaiting } from './itsa/WaitingList'
import { durationMs } from './ui/duration'
import { MachinesStrip } from './MachinesSide'
import { spawnMenu } from './spawn'
import { useData } from './store'
import type { Agent, Ask } from './types'
import { usePhone } from './ui/phone'
import { useLongPress } from './ui/longpress'
import { getUi, setUi, useUi } from './ui/state'
import { waitLabel, waitsOf } from './waits'
import { DetailsView } from './views/DetailsView'
import { useAgentsView, setAgentsView } from './agents-table-view'
import { ALL_COLS, COLUMNS, GROUPS, SCOPES, activityOf, buildLines, factsOf, headerStep, nextSort, orderOf, scopeAgents, scopeCounts, toggleCol, type ColumnId, type Group, type Scope, type Sort, type SortCol } from './agents-table'

// The rows the table draws at once. A larger list pages in with a button below it, so an archive of hundreds
// doesn't draw every row at each render.
const PAGE = 100
// The desk's width (S-3048) at which the detail pane opens when the human hasn't set it, and below which an open
// pane lies over the table rather than taking its width from it.
const PANE_OPEN_AT = 1100
const PANE_OVERLAY_BELOW = 900
// How long a pick by the keys waits before the pane shows its agent (S-3088): the --duration-pick-wait token, 150 ms
// where the page has no stylesheet (a test). Holding an arrow key moves the row at once; the pane follows only the pick that stays.
const panePickWait = () => durationMs(getComputedStyle(document.documentElement).getPropertyValue('--duration-pick-wait')) || 150
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

// The header's steps when it is too narrow (S-3182), taken one at a time, each only while the header still overflows:
// the machines strip collapses to one button; Spawn becomes its icon; the scope chips become one select; the title hides.
// Before any step, the count, the group select and the search give way in CSS, each to its least width.
const LEVEL_STRIP = 1
const LEVEL_SPAWN = 2
const LEVEL_SCOPE = 3
const LEVEL_TITLE = 4
// The header's items in the form each is drawn in. A form the header hasn't drawn yet has no width, so it isn't stepped to back.
type Form = 'title' | 'scope' | 'scopeSel' | 'strip' | 'stripC' | 'spawn' | 'spawnI'
type Sizes = Partial<Record<Form, number>>
// The header items that give way in CSS, each counted at its least width (its CSS min-width) when a step is judged.
const GIVE_WAY = '.agents-count, .agents-search, .agents-group'
// The px kept free when the header steps back to a form, so the step back doesn't overflow again.
const FIT_SLACK = 8

// The form a header item is drawn in, or none for an item that doesn't change (the columns and legend buttons).
function formOf(k: Element): Form | null {
  if (k.matches('.agents-spawn.compact')) return 'spawnI'
  if (k.matches('.agents-spawn')) return 'spawn'
  if (k.matches('.agents-scope-select')) return 'scopeSel'
  if (k.matches('.agents-scope')) return 'scope'
  if (k.matches('.agents-title')) return 'title'
  if (k.matches('.mstrip-collapsed')) return 'stripC'
  if (k.matches('.mstrip')) return 'strip'
  return null
}

// The width the header needs at a level: its items in that level's forms, the give-way items at their least widths, the
// rest as drawn, and the gaps between them. Infinite until every form it needs has been drawn once.
function headerNeed(head: HTMLElement, level: number, sizes: Sizes, strip: boolean): number {
  const gap = parseFloat(getComputedStyle(head).columnGap) || 0
  const forms: (Form | null)[] = [
    level < LEVEL_TITLE ? 'title' : null,
    level < LEVEL_SCOPE ? 'scope' : 'scopeSel',
    strip ? (level < LEVEL_STRIP ? 'strip' : 'stripC') : null,
    level < LEVEL_SPAWN ? 'spawn' : 'spawnI',
  ]
  let need = 0
  let items = 0
  for (const f of forms) {
    if (!f) continue
    if (sizes[f] === undefined) return Infinity
    need += sizes[f]
    items++
  }
  for (const k of [...head.children] as HTMLElement[]) {
    if (formOf(k)) continue
    items++
    need += k.matches(GIVE_WAY) ? parseFloat(getComputedStyle(k).minWidth) || 0 : k.getBoundingClientRect().width
  }
  return need + gap * (items - 1)
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

// The phone's page (S-1432): a list of two-line rows grouped by tree, in the sidebar's order, under the header and the
// scope chips. A tap opens the agent's world; a long press opens its menu (agentMenu), and the rows are read from the
// same store and lookups as the desk's table.
export function AgentsPhone() {
  const { agents, itsas, machine, loaded, asks } = useData()
  const waiting = useWaiting().length
  const { scope } = useAgentsView()
  const ui = useUi()
  const collapsed = ui.collapsed
  // Select mode (S-3282): a tap checks a row rather than opening it. The checked set holds ids, never agents, so a poll's
  // new objects still reach the bar.
  const selecting = !!ui.agentSelect
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set())
  const dock = useRef<HTMLDivElement>(null)
  const [dockH, setDockH] = useState(0)
  const [pages, setPages] = useState(1)
  const facts = useMemo(() => factsOf(agents, itsas, machine, scope), [agents, itsas, machine, scope])
  const all = useMemo(() => buildLines(agents, facts, { group: 'tree', query: '', sort: null, collapsed, scope }), [agents, facts, collapsed, scope])
  const lines = useMemo(() => all.slice(0, PAGE * pages), [all, pages])
  const counts = useMemo(() => scopeCounts(agents), [agents])
  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents])
  // The rows the list shows in scope, in its order: Select all covers these, and the checked set keeps only these, so a
  // poll that drops an agent (archived, gone) drops it from the set too.
  const listed = useMemo(() => orderOf(all), [all])
  const listedSet = useMemo(() => new Set(listed), [listed])
  useEffect(() => { setChecked((c) => keepChecked(c, listedSet)) }, [listedSet])
  // Leaving select mode, by Done, Esc or Back, clears the set.
  useEffect(() => { if (!selecting) setChecked(new Set()) }, [selecting])
  // Leaving the list by any other route (a tab, Open, the search palette) ends select mode too, so it never outlives the list.
  useEffect(() => () => { if (getUi().agentSelect) setUi({ agentSelect: false }) }, [])
  // Esc leaves select mode, unless a menu is open: its own Esc closes the menu first.
  useEffect(() => {
    if (!selecting) return
    const esc = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape' && !menuOpen()) setUi({ agentSelect: false }) }
    addEventListener('keydown', esc)
    return () => removeEventListener('keydown', esc)
  }, [selecting])
  const selIds = useMemo(() => listed.filter((id) => checked.has(id)), [listed, checked])
  const selAgents = useMemo(() => {
    const byAgent = new Map(agents.map((a) => [a.id, a]))
    return selIds.map((id) => byAgent.get(id)).filter((a): a is Agent => !!a)
  }, [agents, selIds])
  const bar = selecting && selAgents.length > 0
  // The bar's height, measured, so the list's last row scrolls clear of the bar that covers its foot.
  useLayoutEffect(() => {
    const el = dock.current
    const measure = () => setDockH(el ? el.getBoundingClientRect().height : 0)
    measure()
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [bar])
  const allIn = listed.length > 0 && listed.every((id) => checked.has(id))
  const selectAll = () => setChecked(new Set(listed))
  const toggleRow = useCallback((id: string) => setChecked((c) => { const next = new Set(c); if (next.has(id)) next.delete(id); else next.add(id); return next }), [])
  // Each row's tree parent by its index: the nearest row above it one level shallower.
  const parentOf = useMemo(() => {
    const at: string[] = []
    const out = new Map<number, string>()
    lines.forEach((l, i) => {
      if (l.kind !== 'agent') return
      at[l.depth] = l.agent.name
      if (l.depth > 0) out.set(i, at[l.depth - 1])
    })
    return out
  }, [lines])
  const lp = useLongPress((at) => showMenu(at.x, at.y, agentMenu(byId.get(at.el.dataset.id!))), '.arow[data-id]')
  const spawn = (e: MouseEvent<HTMLButtonElement>) => { const r = e.currentTarget.getBoundingClientRect(); spawnMenu(r.left, r.bottom + 4, {}, e.currentTarget) }
  const empty = !agents.length
    ? (loaded.agents ? <div className="pad muted">{SCOPE_EMPTY.live}</div> : <Loading />)
    : lines.length ? null : <div className="pad muted">{SCOPE_EMPTY[scope]}</div>
  return <section className="agents-view agents-phone" id="agents-view" aria-label="Agents">
    <div className="agents-head">
      {selecting ? <>
        <span className="agents-count" data-select-count>{selIds.length} selected</span>
        <button type="button" className="btn text agents-select-all" data-select-all disabled={!listed.length || allIn} onClick={selectAll}>Select all</button>
        <button type="button" className="btn text agents-select-done" data-select-done onClick={() => setUi({ agentSelect: false })}>Done</button>
      </> : <>
        <h2 className="agents-title">Agents</h2>
        <span className="agents-count" data-agents-count>{counts.live} live{waiting ? <> · <span className="asks">{waiting} asks or waits</span></> : null}</span>
        <button type="button" className="icon-btn" data-legend-open title="What the marks mean" aria-label="What the marks mean" aria-haspopup="dialog" onClick={(e) => showLegend(e.currentTarget)}><Icon name="circle-help" size="xs" /></button>
        <button type="button" className="btn text agents-select" data-select-on onClick={() => setUi({ agentSelect: true })}>Select</button>
        <button type="button" className="icon-btn agents-spawn-m" data-agents-spawn title="Spawn agent" aria-label="Spawn agent" aria-haspopup="menu" onClick={spawn}><Icon name="plus" /></button>
      </>}
    </div>
    <div className="agents-chips" role="radiogroup" aria-label="Scope">
      {SCOPES.map((s) => <button key={s.id} type="button" role="radio" aria-checked={scope === s.id} className={'agents-chip' + (scope === s.id ? ' on' : '')} data-scope-chip={s.id}
        onClick={() => { setAgentsView({ scope: s.id }); setPages(1) }}>{s.label} <span className="count">{counts[s.id]}</span></button>)}
    </div>
    <div className="agents-list" role="tree" aria-label="Agents" aria-multiselectable={selecting || undefined} {...lp} data-agents-list style={dockH ? { paddingBottom: dockH } : undefined}>
      {lines.map((l, i) => l.kind === 'agent'
        ? <AgentRow key={l.agent.id + (l.dup ? ':dup' : '')} a={l.agent} depth={l.depth} dup={l.dup} parent={parentOf.get(i) ?? null} ask={openAskRow(l.agent.open_ask, asks)}
            kids={facts.kids.get(l.agent.id) ?? 0} hasKids={facts.hasKids.has(l.agent.id)} open={!collapsed[l.agent.id]} owned={facts.owned.get(l.agent.id)?.key ?? null}
            selecting={selecting} on={checked.has(l.agent.id)} onPick={toggleRow} />
        : null)}
      {empty}
      {all.length > lines.length ? <button type="button" className="btn text agents-more" data-agents-more onClick={() => setPages(pages + 1)}>
        Show {Math.min(PAGE, all.length - lines.length)} more</button> : null}
    </div>
    {bar ? <div className="agents-bulk-dock" ref={dock}>
      <AgentsBulk agents={selAgents} onClear={() => setChecked(new Set())} compact />
    </div> : null}
  </section>
}

// One agent's row on the phone (S-1432): line 1 is the harness mark, the name and the cost; line 2 is the top wait or the
// activity, then the model, then the ITSA key. A row deeper than the cap stays at it and shows its parent. Memoised on
// its props; the store replaces every agent object when one changes, so such a change still redraws every row.
const INDENT_CAP = 3
const INDENT = 12
// In select mode (S-3282) the checkbox takes the fold chevron's slot, so a row's text never moves, and a tap on the row
// checks it (onPick) rather than opening the agent.
const AgentRow = memo(function AgentRow({ a, depth, dup, parent, kids, hasKids, open, owned, ask, selecting, on, onPick }: { a: Agent; depth: number; dup: boolean; parent: string | null; kids: number; hasKids: boolean; open: boolean; owned: string | null; ask: Ask | undefined; selecting: boolean; on: boolean; onPick: (id: string) => void }) {
  const lvl = Math.min(depth, INDENT_CAP)
  // The top wait that isn't a child count, else the activity: a parent's state shows here as a leaf's does. A folded row
  // shows its child count after the model.
  const top = waitsOf(a).find((w) => w.kind !== 'children')
  const second = top ? waitLabel(top) : activityOf(a)
  const deep = depth > INDENT_CAP && parent
  const toggle = () => setUi({ collapsed: { ...getUi().collapsed, [a.id]: open } })
  return <div className={`arow ${live(a) ? '' : 'off'}${dup ? ' dup' : ''}${on ? ' on' : ''}`} data-id={a.id} data-dup={dup ? 1 : undefined} data-lp=""
    style={{ paddingLeft: 8 + lvl * INDENT }} role="treeitem" aria-level={depth + 1} aria-expanded={kids && !dup && !selecting ? open : undefined} aria-selected={selecting ? on : undefined}>
    {selecting
      ? <span className="arow-chev arow-check" data-check={a.id} onClick={() => onPick(a.id)}><input type="checkbox" className="agents-check" checked={on} readOnly tabIndex={-1} aria-label={`Select ${a.name}`} /></span>
      : kids && !dup ? <button type="button" className="arow-chev" data-chev={a.id} aria-label={open ? 'Fold' : 'Unfold'} onClick={toggle}><Icon name={open ? 'chevron-down' : 'chevron-right'} size="xs" /></button> : <span className="arow-chev" />}
    <button type="button" className="arow-main" data-open={a.id} onClick={() => (selecting ? onPick(a.id) : selectAgent(a.id))}>
      <span className="arow-l1"><Glyph agent={a} /><span className="arow-name">{a.name}</span>{a.cost ? <span className="arow-cost" title={costTitle(a.cost, hasKids)}>
        <span className="sr-only">{hasKids ? `own ${costCell(a.cost.own, a.cost.mode)}, tree ${costCell(a.cost.tree, a.cost.mode)}` : costCell(a.cost.own, a.cost.mode)}</span>
        <span aria-hidden="true">{costCell(a.cost.own, a.cost.mode)}{hasKids ? <span className="cost-tree">/{costCell(a.cost.tree, a.cost.mode)}</span> : null}</span></span> : null}</span>
      <span className="arow-l2">
        <span className="arow-state">{second}</span>
        <span className="arow-model">{model(a).label}</span>
        {kids && !open ? <span className="arow-kids">{kids === 1 ? '1 child' : `${kids} children`}</span> : null}
        {owned ? <span className="arow-itsa">{owned}</span> : null}
        {deep ? <span className="arow-parent">↳ {parent}</span> : null}
      </span>
    </button>
    {ask ? <OpenAskLink row={ask} className="arow-ask" /> : null}
    <button type="button" className="icon-btn arow-more" data-more={a.id} aria-label={`Actions for ${a.name}`} title="More"
      onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); showMenu(r.left, r.bottom + 4, agentMenu(a), e.currentTarget) }}><Icon name="ellipsis" size="xs" /></button>
  </div>
})

// The columns menu: each picked column numbered in the order it shows, and a reset to every column.
const colsItems = (picked: ColumnId[]): MenuItem[] => [{ section: 'Columns, in order' }, ...COLUMNS.map((c) => {
  const at = picked.indexOf(c.id)
  return { label: c.label, checked: at >= 0, checkbox: true, glyph: <span className="colnum">{at >= 0 ? at + 1 : ''}</span>, action: () => setAgentsView({ cols: toggleCol(picked, c.id) }) }
}), 'sep', { label: 'All columns', action: () => setAgentsView({ cols: ALL_COLS }) }]

function AgentsDesk({ picked }: { picked: string | null }) {
  const { agents, itsas, machine, machines, thresholds, loaded } = useData()
  const waiting = useWaiting().length
  const { cols, group, scope, pane } = useAgentsView()
  const collapsed = useUi().collapsed
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort | null>(null)
  const [cursor, setCursor] = useState<string | null>(picked)
  // The agent the detail pane shows (S-3048). It trails the cursor by PANE_PICK_WAIT after a key pick, and a click shows at once;
  // a pick that moves on, or the page's leaving, clears the wait, so no fetch fires for an agent no longer picked.
  const [shown, setShown] = useState<string | null>(picked)
  useEffect(() => {
    if (cursor === shown) return
    // A cleared pick empties the pane at once, so an old agent never shows under the next pick.
    if (cursor === null) return setShown(null)
    const t = setTimeout(() => setShown(cursor), panePickWait())
    return () => clearTimeout(t)
  }, [cursor, shown])
  const [pages, setPages] = useState(1)
  // The checked agents (S-3117), by id only: they are read from the agents list at each render, so a poll's new
  // data reaches them. The anchor is the row a Shift-click counts from; it is kept out of state, as nothing draws it.
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set())
  const anchor = useRef<string | null>(null)
  const search = useRef<HTMLInputElement>(null)
  const desk = useRef<HTMLElement>(null)
  // The detail pane (S-3048, S-3616): it shows only with a pick, and only when the saved choice allows it: the human's choice
  // (Space) if there is one, else from the page's width on. It opens when the pick's wait ends and closes at once when the pick clears.
  const width = useWidth(desk)
  const allowed = pane ?? width >= PANE_OPEN_AT
  const open = allowed && !!cursor && !!shown
  const overlay = open && width < PANE_OVERLAY_BELOW
  // The header's steps (S-3182): the header is judged after each draw and on each resize of the header. A step is taken
  // while it overflows, and a step back once the header holds the form back with room to spare.
  const head = useRef<HTMLDivElement>(null)
  const sizes = useRef<Sizes>({})
  const overflowAt = useRef<number | null>(null)
  const overflowNeed = useRef<number | null>(null)
  const [level, setLevel] = useState(0)
  // The judge reads the level and whether there is a strip from here, since the resize observer's callback is set once.
  const now = useRef({ level, strip: machines.length > 0 })
  now.current = { level, strip: machines.length > 0 }
  const judge = () => {
    const el = head.current
    if (!el) return
    for (const k of [...el.children] as HTMLElement[]) {
      const f = formOf(k)
      if (f) sizes.current[f] = k.getBoundingClientRect().width
    }
    const { level: at, strip } = now.current
    const overflows = el.scrollWidth > el.clientWidth + 0.5
    // The estimate of this level and of the level below: a step back waits for a wider header or a smaller estimate (headerStep),
    // so the step up and the step back never alternate at one width. Without that wait React stops the page with error #185 (S-3489).
    const here = headerNeed(el, at, sizes.current, strip)
    const below = at > 0 ? headerNeed(el, at - 1, sizes.current, strip) : Infinity
    const next = headerStep({ level: at, max: LEVEL_TITLE, overflows, width: el.clientWidth, here, need: below, slack: FIT_SLACK, overflowAt: overflowAt.current, overflowNeed: overflowNeed.current })
    overflowAt.current = next.overflowAt
    overflowNeed.current = next.overflowNeed
    if (next.level !== at) setLevel(next.level)
  }
  useLayoutEffect(judge)
  useEffect(() => {
    const el = head.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(judge)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const facts = useMemo(() => factsOf(agents, itsas, machine, scope), [agents, itsas, machine, scope])
  const all = useMemo(() => buildLines(agents, facts, { group, query, sort, collapsed, scope }), [agents, facts, group, query, sort, collapsed, scope])
  const lines = useMemo(() => all.slice(0, PAGE * pages), [all, pages])
  const order = useMemo(() => orderOf(lines), [lines])
  const counts = useMemo(() => scopeCounts(agents), [agents])
  const running = counts.live
  // A new scope starts at its first page, with nothing checked. The picked row stays picked when the scope still lists its agent.
  const pick = (s: Scope) => {
    setAgentsView({ scope: s })
    setPages(1)
    setCursor((c) => (c && scopeAgents(agents, s).some((a) => a.id === c) ? c : null))
    if (s !== scope) clearChecked()
  }
  // Every agent the table lists, in its order, under the scope and the search: the header's check-all covers these, and the
  // checked set keeps only these. An agent that leaves the scope, the search or the list is dropped, so a bulk action never
  // reaches a row the table doesn't show.
  const listed = useMemo(() => orderOf(all), [all])
  const listedSet = useMemo(() => new Set(listed), [listed])
  useEffect(() => { setChecked((c) => keepChecked(c, listedSet)) }, [listedSet])
  const selIds = useMemo(() => listed.filter((id) => checked.has(id)), [listed, checked])
  const selAgents = useMemo(() => {
    const byAgent = new Map(agents.map((a) => [a.id, a]))
    return selIds.map((id) => byAgent.get(id)).filter((a): a is Agent => !!a)
  }, [agents, selIds])
  const inView = selIds.length
  const checkAll = inView === 0 ? 'none' : inView === listed.length ? 'all' : 'some'
  const clearChecked = () => { setChecked(new Set()); anchor.current = null }
  // A checkbox toggles its row. Shift-click checks the rows from the anchor (the last row checked or picked) to this one.
  const onCheck = (id: string, shift: boolean) => {
    const from = anchor.current
    const ids = shift && from ? rangeOf(listed, from, id) : [id]
    const on = !checked.has(id)
    setChecked((c) => { const next = new Set(c); for (const x of ids) { if (on) next.add(x); else next.delete(x) } return next })
    anchor.current = id
  }
  const onCheckAll = () => {
    const every = checkAll === 'all'
    setChecked((c) => { const next = new Set(c); for (const id of listed) { if (every) next.delete(id); else next.add(id) } return next })
  }
  const onSpawn = (e: MouseEvent<HTMLButtonElement>) => { const r = e.currentTarget.getBoundingClientRect(); spawnMenu(r.left, r.bottom + 4, {}, e.currentTarget) }

  // j, k and the arrows move the cursor (the selection), Enter opens its agent, / searches, Esc clears the search,
  // Space shows or hides the detail pane (with a pick, and not with a modifier held), x checks the picked row and Esc clears the checked rows. Keys typed into a
  // field, and Enter or Space on a button, link or fold (a sort header, Columns, the legend, the pane's own controls),
  // are left alone; so is x with a modifier.
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
    else if (e.key === ' ' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); if (cursor) setAgentsView({ pane: !allowed }) }
    else if (e.key === '/') { e.preventDefault(); search.current?.focus() }
    else if (e.key === 'Enter' && cursor) selectAgent(cursor)
    else if (e.key === 'x' && !e.metaKey && !e.ctrlKey && !e.altKey && cursor) { e.preventDefault(); onCheck(cursor, false) }
    else if (e.key === 'Escape' && checked.size) { e.preventDefault(); clearChecked() }
  }
  const empty = !agents.length
    ? (loaded.agents ? <div className="pad muted">{SCOPE_EMPTY.live}</div> : <Loading />)
    : lines.length ? null : query ? <div className="pad muted">No agent matches “{query}”.</div> : <div className="pad muted">{SCOPE_EMPTY[scope]}</div>

  return <section ref={desk} className="agents-view agents-desk" id="agents-view" aria-label="Agents" onKeyDown={key}>
    <div ref={head} className="agents-head">
      {level < LEVEL_TITLE ? <h2 className="agents-title">Agents</h2> : null}
      <span className="agents-count" data-agents-count>{running} live{waiting ? <> · <span className="asks">{waiting} asks or waits</span></> : null}</span>
      {level < LEVEL_SCOPE ? <div className="seg agents-scope" role="radiogroup" aria-label="Scope">
        {SCOPES.map((s) => <button key={s.id} type="button" role="radio" aria-checked={scope === s.id} className={scope === s.id ? 'on' : ''} data-scope-chip={s.id}
          onClick={() => pick(s.id)}>{s.label} <span className="count">{counts[s.id]}</span></button>)}
      </div> : <select className="agents-scope-select" data-scope-select aria-label="Scope" value={scope} onChange={(e) => pick(e.target.value as Scope)}>
        {SCOPES.map((s) => <option key={s.id} value={s.id}>{s.label} {counts[s.id]}</option>)}
      </select>}
      <select className="agents-group" aria-label="Group by" value={group} onChange={(e) => setAgentsView({ group: e.target.value as Group })}>
        {GROUPS.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
      </select>
      <input ref={search} type="search" className="agents-search" placeholder="Search agents" aria-label="Search agents" autoComplete="off" spellCheck={false} value={query} onChange={(e) => setQuery(e.target.value)} />
      <MachinesStrip machines={machines} collapsed={level >= LEVEL_STRIP} />
      <button type="button" className="icon-btn" data-agents-cols title="Columns" aria-label="Columns" aria-haspopup="menu"
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); showMenu(r.left, r.bottom + 4, colsItems(cols), e.currentTarget) }}><Icon name="columns-2" size="xs" /></button>
      <button type="button" className="icon-btn" data-legend-open title="What the marks mean" aria-label="What the marks mean" aria-haspopup="dialog" onClick={(e) => showLegend(e.currentTarget)}><Icon name="circle-help" size="xs" /></button>
      {level < LEVEL_SPAWN
        ? <button type="button" className="btn primary agents-spawn" data-agents-spawn aria-haspopup="menu" onClick={onSpawn}><Icon name="plus" size="xs" />Spawn</button>
        : <button type="button" className="btn primary agents-spawn compact" data-agents-spawn title="Spawn agent" aria-label="Spawn agent" aria-haspopup="menu" onClick={onSpawn}><Icon name="plus" size="xs" /></button>}
    </div>
    <div className={`agents-body${overlay ? ' overlay' : ''}`}>
      <div className="agents-main">
        <AgentsTable lines={lines} facts={facts} group={group} gone={scope === 'stopped' || scope === 'archived'} cols={cols} sort={sort} cursor={cursor} enforce={thresholds.enforceTokens}
          checked={checked} checkAll={checkAll} onCheck={onCheck} onCheckAll={onCheckAll}
          onSort={(c: SortCol) => setSort((s) => nextSort(s, c))} onPick={(id) => { setCursor(id); setShown(id); anchor.current = id }} empty={empty} />
        {all.length > lines.length ? <button type="button" className="btn text agents-more" data-agents-more onClick={() => setPages(pages + 1)}>
          Show {Math.min(PAGE, all.length - lines.length)} more</button> : null}
        {selAgents.length ? <AgentsBulk agents={selAgents} onClear={clearChecked} /> : null}
      </div>
      {open ? <aside className="agents-pane" aria-label="Selected agent" data-agents-pane>
        <DetailsView key={shown!} id={shown!} />
      </aside> : null}
    </div>
  </section>
}
