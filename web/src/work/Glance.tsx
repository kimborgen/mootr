// The Work page on a phone, or in a pane too narrow for the table (S-301): a glance at what
// needs the human and what is moving, not a second issue list. Three sections, in order:
// Needs you (the first few, the rest one tap away), Moving (the work in flight, grouped by its
// root issue, with its agents and cost), and Ready to try (in review, or with somewhere to test
// it). It shows and doesn't act (S-363): a card opens its ITSA, where the actions are, and its
// links (branch, PR, test env, and the rest) sit under it with their icons. The Issues page
// browses and edits the rest, so the page ends with a way there instead of a backlog. With a
// filter, quick filter (S-1515, the chip row) or sort set (S-1514, from the Filter button's sheet) the moving and ready sections give
// way to one card list of the matches in the chosen order; Needs you stays on top, unfiltered.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Icon, type IconName } from '../Icon'
import { HEALTH, openBoard, openItsa, statusInfo, statusLabel, StatusGlyph, toneVar } from '../itsa/itsa'
import { stateOf } from '../format'
import { useData } from '../store'
import { isPhone, phoneShow } from '../shell/layout'
import type { Agent, Itsa } from '../types'
import type { Field } from '../itsa/fields'
import { Agents, LinkChip } from './columns'
import { fieldColId } from '../itsa/fields'
import { useCellPress } from './long-press'
import { cardFields, FieldValue } from './field-columns'
import type { WorkExtras } from './data'
import { costIndex, glance, LOOSE, type GlanceGroup } from './glance'
import { fmtIssueCost, LINK_KINDS, linkKind, type IssueCost } from './links'
import { agentIdsOf, since } from './model'
import type { NeedsRow } from './needs'
import { openNeeds } from './openNeeds'
import { activeCount, clearAll, FilterSheet } from './filter-sheet'
import { QuickBar } from './quick-bar'
import { setGroup, setQuick } from './views'
import type { HeaderLive } from './header-menu'
import { onWorkSheetChange, setWorkSheet, workSheetOpen } from './sheet-state'
import type { WorkColumn } from './columns'

// How many Needs-you rows show before "Show N more": enough to act on, few enough that the
// moving work still starts on the first screen.
export const NEEDS_SHOWN = 3

// The agents by id and the costs by issue key, built once per change so a card's lookups are
// map hits, not scans.
interface Index { agents: Map<string, Agent>; costs: Map<string, IssueCost> }

function Section({ id, icon, title, count, children }: { id: string; icon: IconName; title: string; count: number; children: ReactNode }) {
  return <section className="wg-sec" data-sec={id} aria-label={title}>
    <h3 className="wg-head"><Icon name={icon} size="xs" /><span>{title}</span><span className="count">{count}</span></h3>
    {children}
  </section>
}

const keyOpen = (fn: () => void) => (e: React.KeyboardEvent) => {
  if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); fn() }
}

// A Needs-you row: what it is, who asks and since when. It opens where the human answers.
function NeedCard({ n, now, ix }: { n: NeedsRow; now: number; ix: Index }) {
  const who = n.agent?.name ?? (n.it.owner ? ix.agents.get(n.it.owner)?.name : undefined)
  const why = [statusLabel(n.it.status), who, n.it.summary].filter(Boolean).join(' · ')
  return <div className="wg-card wg-need" role="button" tabIndex={0} data-need={n.key} data-kind={n.kind}
    aria-label={`${n.it.key ? n.it.key + ' ' : ''}${n.it.title}`} onClick={() => openNeeds(n)} onKeyDown={keyOpen(() => openNeeds(n))}>
    <div className="wg-top">
      <span className="wg-title">{n.it.key ? <span className="ikey">{n.it.key}</span> : null}{n.it.title}</span>
      <time className="w-time" dateTime={n.since}>{since(n.since, now)}</time>
    </div>
    <div className="wg-why" style={{ color: toneVar(n.it.status) }}><StatusGlyph status={n.it.status} /><span>{why}</span></div>
  </div>
}

// An ITSA's links in the table's column order, drawn as the table draws them.
function Links({ it }: { it: Itsa }) {
  const links = (it.links ?? []).map((l) => ({ l, kind: linkKind(l) })).sort((a, b) => LINK_KINDS.indexOf(a.kind) - LINK_KINDS.indexOf(b.kind))
  if (!links.length) return null
  return <div className="wg-links">{links.map(({ l, kind }) => <LinkChip key={l.n} l={l} className={`wg-link k-${kind}`} cell={kind} />)}</div>
}

// A moving or ready-to-try ITSA: title and status, then its agents and cost, then its links.
function ItemCard({ it, ix, fields, sub, live }: { it: Itsa; ix: Index; fields: Field[]; sub?: boolean; live?: HeaderLive }) {
  const cost = fmtIssueCost(ix.costs.get(it.key), 'total')
  const health = it.health && it.health !== 'on_track' ? HEALTH[it.health] : null
  const row = { it, depth: 0, context: false }
  const agents = agentIdsOf(it).map((id) => ix.agents.get(id)).filter((a): a is Agent => !!a)
  const hasAgents = agents.length > 0
  // The shown fields with a value: chips join the meta line, the rest follow it labelled.
  const { chips, meta } = cardFields(it, fields)
  // A long-press or right-click on a value opens its filter menu; the click that ends a long-press doesn't open the ITSA (S-1518).
  const press = useCellPress(live, row)
  return <div className={'wg-card' + (sub ? ' sub' : '')} role="button" tabIndex={0} data-itsa={it.id} {...press.handlers}
    aria-label={`${it.key} ${it.title}`} onClickCapture={(e) => { if (press.swallow()) { e.stopPropagation(); e.preventDefault() } }} onClick={() => openItsa(it.id)} onKeyDown={keyOpen(() => openItsa(it.id))}>
    <div className="wg-top">
      <span className="wg-title"><span className="ikey">{it.key}</span>{it.title}</span>
      <span className="w-status" data-cell="status" style={{ color: toneVar(it.status) }}><StatusGlyph status={it.status} />{statusLabel(it.status)}</span>
    </div>
    {hasAgents || cost || health || chips.length ? <div className="wg-meta">
      {hasAgents ? <Agents row={row} list={agents} /> : null}
      {health ? <span className="w-health" data-cell="health" style={{ color: health.tone }}><span className="w-dot" aria-hidden="true" />{health.label}</span> : null}
      {chips.map(({ f, v }) => <span key={f.id} className="wg-field" data-field={f.key} data-cell={fieldColId(f)}><FieldValue f={f} v={v} /></span>)}
      {cost ? <span className="w-cost" data-cell="cost">{cost}</span> : null}
    </div> : null}
    {meta.length ? <div className="wg-fields">{meta.map(({ f, v }) => <span key={f.id} className="wg-field" data-field={f.key} data-cell={fieldColId(f)}><span className="wg-flabel">{f.label}</span><FieldValue f={f} v={v} /></span>)}</div> : null}
    <Links it={it} />
  </div>
}

// A group of moving work. Under a root that isn't moving itself, a quiet head names the root
// and opens it; a root that moves leads its group as a card, its descendants indented below.
function Group({ g, ix, fields, live }: { g: GlanceGroup; ix: Index; fields: Field[]; live?: HeaderLive }) {
  const lead = g.root && g.items[0]?.id === g.root.id
  return <div className="wg-group" data-group={g.id === LOOSE ? 'loose' : g.id}>
    {g.root && !lead ? <button type="button" className="wg-ghead" onClick={() => openItsa(g.root!.id)}>
      <StatusGlyph status={g.root.status} /><span className="ikey">{g.root.key}</span><span className="w-gname">{g.root.title}</span>
    </button> : null}
    {g.items.map((it, i) => <ItemCard key={it.id} it={it} ix={ix} fields={fields} live={live} sub={!!g.root && !(lead && i === 0)} />)}
  </div>
}

// What the Filter button needs: the page's live layout and edit, the columns the sheet lists, the
// ITSAs that pass the filters in the sort order, and how many the other settings leave without them.
export interface GlanceFilter { view?: { name: string; dirty: boolean; open: (e: React.MouseEvent<HTMLButtonElement>) => void }; live: HeaderLive; cols: WorkColumn[]; matches: Itsa[]; of: number
  // The summary line under the matches (totals.ts totalLine).
  line?: string
  // A column grouping's groups (S-1520), in order; the list shows each under a head.
  groups?: { id: string; label: string; items: Itsa[] }[]
  // The grouping column's label while a column grouping is on, for the chip that clears it; and the columns the sheet's Group by lists.
  groupLabel?: string; groupCols?: WorkColumn[] }

export function Glance({ itsas, needs, extras, now, fields = [], filter }: { itsas: Itsa[]; needs: NeedsRow[]; extras: WorkExtras; now: number; fields?: Field[]; filter?: GlanceFilter }) {
  const [allNeeds, setAllNeeds] = useState(false)
  // The sheet's state is shared with the browser history, so a back press closes it. Focus returns to the button.
  const sheet = useSyncExternalStore(onWorkSheetChange, workSheetOpen)
  const filterBtn = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)
  useEffect(() => { if (wasOpen.current && !sheet) filterBtn.current?.focus(); wasOpen.current = sheet }, [sheet])
  useEffect(() => () => setWorkSheet(false), [])
  const { agents, itsaStatuses } = useData()
  const ix: Index = useMemo(() => ({ agents: new Map(agents.map((a) => [a.id, a])), costs: costIndex(extras.costs) }), [agents, extras.costs])
  // The needs rows are rebuilt each render; their ITSA ids are what the glance depends on.
  const needIds = needs.map((n) => n.itsaId ?? '').join(' ')
  const { moving, toTry } = useMemo(() => {
    const info = new Map(itsaStatuses.map((s) => [s.name, s]))
    const status = (s: string) => info.get(s) ?? statusInfo(s)
    return glance(itsas, {
      category: (s) => status(s).category, human: (s) => status(s).human,
      agentState: (id) => { const a = ix.agents.get(id); return a ? stateOf(a) : undefined },
      needs: new Set(needIds.split(' ').filter(Boolean)),
    })
  }, [itsas, itsaStatuses, ix, needIds])
  const nMoving = moving.reduce((n, g) => n + g.items.length, 0)
  const shown = allNeeds ? needs : needs.slice(0, NEEDS_SHOWN)
  const active = filter ? activeCount(filter.live.layout) : 0
  return <div className="w-glance">
    <div className="wg-bar">
      {filter?.view ? <button type="button" className="btn wg-view" data-view-picker aria-haspopup="menu" aria-label={`View: ${filter.view.name}${filter.view.dirty ? ', edited since saved' : ''}`} onClick={filter.view.open}>
        <span className="w-tname">View: {filter.view.name}</span>{filter.view.dirty ? <span className="w-tdot" aria-hidden="true" data-dirty /> : null}<Icon name="chevron-down" size="xs" /></button> : null}
      <p className="wg-lede">What needs you now, and what’s moving.</p>
      {filter ? <button ref={filterBtn} type="button" className={'btn wg-filter' + (active ? ' on' : '')} data-active={active} aria-haspopup="dialog"
        aria-label={active ? `Sort and filter, ${active} set` : 'Sort and filter'} onClick={() => setWorkSheet(true)}>
        <Icon name="sliders-horizontal" size="xs" />Filter{active ? <span className="count">{active}</span> : null}</button> : null}
    </div>
    {filter ? <QuickBar className="wg-quick" on={filter.live.layout.quick} onToggle={(id) => filter.live.edit((l) => setQuick(l, id))} /> : null}
    {filter && sheet ? <FilterSheet live={filter.live} cols={filter.cols} count={active ? filter.matches.length : filter.of} groupCols={filter.groupCols} onClose={() => setWorkSheet(false)} /> : null}
    <Section id="needs" icon="shield-alert" title="Needs you" count={needs.length}>
      {needs.length ? shown.map((n) => <NeedCard key={n.key} n={n} now={now} ix={ix} />) : <p className="wg-none">Nothing needs you.</p>}
      {needs.length > shown.length ? <button type="button" className="btn text wg-more" onClick={() => setAllNeeds(true)}>Show {needs.length - shown.length} more</button> : null}
    </Section>
    {filter && (active || filter.groups) ? <section className="wg-sec" data-sec="matches" aria-label="Matching issues">
      <div className="wg-result"><span className="wg-n" data-matches>{filter.matches.length} of {filter.of}</span>
        {filter.groups ? <button type="button" className="btn wg-groupchip" data-group-chip aria-label={`Grouped by ${filter.groupLabel ?? 'column'}, clear grouping`} onClick={() => filter.live.edit((l) => setGroup(l, 'issues'))}>
          <span className="wg-groupname">Grouped by {filter.groupLabel ?? 'column'}</span><Icon name="x" size="xs" /></button> : null}
        {active ? <button type="button" className="btn text wg-clear" onClick={() => filter.live.edit(clearAll)}>Clear</button> : null}</div>
      {filter.groups ? (filter.groups.length ? filter.groups.map((g) => <div key={g.id} className="wg-group" data-group={g.id}>
        <h4 className="wg-ghead static"><span className="w-gname">{g.label}</span><span className="count">{g.items.length}</span></h4>
        {g.items.map((it) => <ItemCard key={it.id} it={it} ix={ix} fields={fields} live={filter?.live} />)}
      </div>) : <p className="wg-none">Nothing matches.</p>)
        : filter.matches.length ? filter.matches.map((it) => <ItemCard key={it.id} it={it} ix={ix} fields={fields} live={filter?.live} />) : <p className="wg-none">Nothing matches.</p>}
      {filter.line ? <p className="wg-totals" data-totals>{filter.line}</p> : null}
    </section> : <>
      <Section id="moving" icon="play" title="Moving" count={nMoving}>
        {moving.length ? moving.map((g) => <Group key={g.id} g={g} ix={ix} fields={fields} live={filter?.live} />) : <p className="wg-none">No work in flight.</p>}
      </Section>
      {toTry.length ? <Section id="try" icon="square-check" title="Ready to try" count={toTry.length}>
        {toTry.map((it) => <ItemCard key={it.id} it={it} ix={ix} fields={fields} live={filter?.live} />)}
      </Section> : null}
    </>}
    <button type="button" className="btn text wg-browse" onClick={() => (isPhone() ? phoneShow('issues') : openBoard(null))}>
      Browse every issue<Icon name="chevron-right" size="xs" /></button>
  </div>
}
