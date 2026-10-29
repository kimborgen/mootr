// One card on the system view (S-458): an agent as an instrument tile, drawn from the agent card
// layout (S-1438). Row 1 is its mark, name, model, and cost (its own; its tree's on hover); row 2 the
// ITSA it owns, as the shared IssueCard nested (S-1438 PR 4); row 3 the badges the agent layout
// places there; row 4 what it is doing. A hairline context bar runs along its foot, unread mail
// stacks against its top-right corner, and a manager has a fold control. Memoised by a signature of
// what it shows, so a poll that changes one agent redraws one card.
// Its motion (S-463): Motion places it by one transform string, so a layout change glides it to
// its new place (FLIP), a spawn grows out of its parent and an archive shrinks back into it; a
// status change stamps the ITSA's mark and washes its row; its cost rolls, with a "+$" rising.
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { animate, motion, useIsPresent } from 'motion/react'
import { costShort, costTitle, model, stateLabel } from '../format'
import { Glyph, PlainGlyph } from '../Glyph'
import { Icon } from '../Icon'
import { isClosed, StatusGlyph, statusLabel } from '../itsa/itsa'
import { IssueCard, type IssueCardActions, type IssueCardState } from '../itsa/IssueCard'
import { defaultCardLayout, type CardLayout } from '../card-layout'
import type { Field } from '../itsa/fields'
import { FieldValue } from '../work/field-columns'
import type { CardItem } from '../work/card-items'
import type { CellContext } from '../work/columns'
import type { WorkExtras } from '../work/data'
import { activityOf as itsaActivityOf, costOf, linkKind } from '../work/links'
import { waitLabel, waitsOf } from '../waits'
import type { Agent, Itsa } from '../types'
import type { Badge } from './model'
import { Rise, Roll, useTiming } from './Roll'
import { type Bezier, cardTransform, spring, SPRINGS, tween } from './springs'

// What the cards draw their layouts with, given by the view: the agent and issue card layouts, and the
// items, fields and context the nested issue card draws from. Without a view a card takes the defaults.
// The context holds only what changes when a layout or a field does, so a poll that brings new data leaves its value
// as it was and re-renders no card. The per-card data (cx) rides on each card's model, with its cxSig in the card's sig.
export interface CardLayouts { agent: CardLayout; issue: CardLayout; items: Map<string, CardItem>; fields: Field[] }
const DEFAULT_LAYOUTS: CardLayouts = { agent: defaultCardLayout('agent'), issue: defaultCardLayout('issue'), items: new Map(), fields: [] }
export const CardLayoutsContext = createContext<CardLayouts>(DEFAULT_LAYOUTS)
// The nested issue card takes no gestures of its own: the agent card's click opens the ITSA.
const NO_ACTIONS: IssueCardActions = { onOpen: () => {}, onPointerDown: () => {}, onKeyDown: () => {}, onMenu: () => {} }

// The card's own facts, built per render by the view; `sig` is them as a string for memo.
export interface CardModel {
  id: string
  // The name its chip, its Cards name row and its star label show: without the words it shares
  // with its parent's (names.ts, S-572).
  short: string
  agent: Agent | null
  // Its activity line (activityOf), worked out with the model: it names the agent a wait is for,
  // whose rename changes no field of this agent's own.
  activity: string
  it: Itsa | null
  owns: number
  badges: Badge[]
  // The cell context the nested issue card's items draw from, and its signature: the ITSA's own cost, activity and
  // (for a GitHub link) watch state. A card re-renders only when this changes, not on every poll.
  cx: CellContext
  cxSig: string
  unread: number
  ctx: number
  ctxLevel: number
  // Children shown under it, and when folded, what the fold hides.
  kids: number
  folded: { n: number; states: { state: string; n: number }[] } | null
  // Mail just landed on it (S-459): marked a moment, in the warning hue for the human or an ask.
  hit: '' | 'mail' | 'warn'
  // Its ITSA's children done of all (S-463), advancing as each done sheet lands.
  rollup: { done: number; total: number } | null
}
export interface CardPlace { x: number; y: number; w: number }

// The most sheets a stack draws; the count says the rest.
export const STACK_MAX = 4
// A spawn starts this much smaller and an archive ends so, never scale(0) (system-view-motion:
// 0.9 to 0.97). A unitless factor, so no token holds it.
export const GROW_FROM = 0.96
// A stamp: from 1.15 and a slight turn, to rest (system-view-motion).
const STAMP_FROM = 'scale(1.15) rotate(-6deg)'
const STAMP_TO = 'scale(1) rotate(0deg)'
const whole = (v: number) => String(Math.round(v))

export function activityOf(a: Agent): string {
  if (a.activity_detail) return a.activity_detail
  const w = waitsOf(a)[0]
  if (w) return `Waiting for ${waitLabel(w)}`
  const last = a.last_message?.split('\n').find((l) => l.trim())
  return last?.trim() || stateLabel(a)
}

// Everything a card draws, so the memo (SystemCard) redraws it exactly when one changes.
export const cardSig = (m: CardModel) => JSON.stringify([m.short, m.agent, m.activity, m.it, m.owns, m.badges.map((b) => (b.kind === 'word' ? [b.id, b.word, b.tone, b.title] : [b.id, b.f, b.v])), m.cxSig, m.unread, m.ctx, m.ctxLevel, m.kids, m.folded, m.hit, m.rollup])

// The signature of the data a nested issue card's items can draw from (the ITSA's cost, activity and, for a GitHub
// link, watch state): so a poll that changes another ITSA's data leaves this card's sig, and its render, as they were.
export const issueCxSig = (it: Itsa | null, extras: WorkExtras): string => (it
  ? JSON.stringify([costOf(extras.costs, it.key), itsaActivityOf(extras.activity, it.key), it.links?.some((l) => linkKind(l) === 'github') ? extras.watch : null])
  : '')

// The agent's own cost in its cost mode: in dollars the live stream's cost_usd, which an
// agent.changed event carries between polls, else the poll's.
export function ownCost(a: Agent): number | null {
  const c = a.cost
  if (!c) return a.cost_usd ?? null
  return c.mode === 'api' && a.cost_usd != null ? a.cost_usd : c.own[c.mode] ?? null
}

// Where an archived or folded card shrinks back to: its nearest ancestor still shown, given to
// the exiting card through AnimatePresence's `custom`. 'culled' is a card still in the tree that
// scrolled out of view (S-540): it goes at once, where it is. `morph`: in a switch into or out of
// Stars (S-572, transition.ts), the card leaves for its other self instead, fading over these ms
// while the transition moves it.
export type ExitTo = (id: string) => CardPlace | 'culled' | null
export interface Exit { to: ExitTo; morph: number | null }

// A card that grows where it lands rather than out of its parent (the phone's outline).
const inPlace = (a: CardPlace, b: CardPlace) => a.x === b.x && a.y === b.y

// The exit of a card or a star: back into its parent, or in a morph a fade where it is.
export function exitOf(c: Exit | undefined, id: string, place: CardPlace, slow: number, ease: Bezier | null, at: (p: CardPlace, k?: number) => object) {
  if (c?.morph != null) return { opacity: 0, transition: { opacity: tween(c.morph, ease) } }
  const p = c?.to(id) ?? place
  // A culled card (S-540) goes at once, in place.
  if (p === 'culled') return { opacity: 1, transition: { duration: 0 } }
  return { ...at(p, GROW_FROM), transition: { ...spring(SPRINGS.shrink, slow), opacity: tween(slow * 1.5, ease) } }
}

// `enter`: where a new card grows from (its parent). `jump`: a mode switch moves it (transition.ts),
// so Motion puts it straight at its new place. `far`: zoomed out past where its rows read
// (S-462), it draws only what shows then, so a far card costs a chip, not its hidden rows: the
// chip and the name button, which keeps the keyboard reaching it. A card drawn near that zooms
// out keeps its rows (hidden) until it next redraws, so crossing the zoom doesn't redraw every
// card at once.
// `flat`: Cards zoomed far out (S-705), where every card still draws in full but as a plain, still copy of it
// (FlatCard): the same rows, none of the motion, rolls or hooks, so hundreds cost a paint, not a frame's script.
export type Far = '' | 'chip' | 'flat'
interface Props { m: CardModel; sig: string; place: CardPlace; selected: boolean; enter: CardPlace | null; jump: boolean; far: Far }

function Card({ m, place, selected, enter, jump, far }: Props) {
  const a = m.agent
  const human = !a
  const L = useContext(CardLayoutsContext)
  const { slow, ease } = useTiming()
  // Exiting, under AnimatePresence: it stays drawn while it shrinks away, but is no longer a card.
  const leaving = !useIsPresent()
  const here = !!enter && inPlace(enter, place)
  const at = (p: CardPlace, k = 1) => ({ transform: cardTransform(p.x, p.y, k), opacity: k === 1 ? 1 : 0 })
  const name = a?.name ?? 'You'
  const label = human ? 'You: asks and results arrive here' : `${name}, ${stateLabel(a)}${m.it ? `, ${m.it.key} ${m.it.title}` : ''}`
  const mode = a?.cost?.mode ?? 'api'
  // Kept from render to render: a new format rewrites the roll's text (Roll).
  const fmtCost = useMemo(() => (v: number) => costShort(v, mode), [mode])
  const own = a ? ownCost(a) : null
  const dollars = mode === 'api' || mode === 'subscription'
  // A status change on the same ITSA stamps its mark once (adjusting state in render, so the
  // stamp starts in the same frame as the new mark).
  const [st, setSt] = useState({ id: m.it?.id ?? null, status: m.it?.status ?? null, n: 0 })
  if ((m.it?.id ?? null) !== st.id || (m.it?.status ?? null) !== st.status) {
    setSt({ id: m.it?.id ?? null, status: m.it?.status ?? null, n: m.it && m.it.id === st.id ? st.n + 1 : st.n })
  }
  // The roll-up stamps as it advances, on the same element, so its number keeps rolling.
  const [ru, setRu] = useState({ done: m.rollup?.done ?? 0, n: 0 })
  if ((m.rollup?.done ?? 0) !== ru.done) setRu({ done: m.rollup?.done ?? 0, n: (m.rollup?.done ?? 0) > ru.done ? ru.n + 1 : ru.n })
  const rollEl = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!ru.n || !rollEl.current || !slow) return
    const a = animate(rollEl.current, { transform: [STAMP_FROM, STAMP_TO] }, spring(SPRINGS.stamp, slow))
    return () => a.stop()
  }, [ru.n]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    // A group, not a button: it holds the stack and fold buttons. Its name is the button that opens
    // the panel; a click anywhere else on the card does the same (SystemView's click).
    <motion.div className={'sv-card' + (human ? ' human' : '') + (m.hit ? ' hit ' + m.hit : '') + (selected ? ' sel' : '') + (enter ? ' enter' : '') + (leaving ? ' leave' : '')} data-card={leaving ? undefined : m.id} data-tid={m.id} role="group"
      aria-label={label} aria-hidden={leaving || undefined} style={{ width: place.w }}
      // A far chip is drawn at screen size and its name must never draw under 14 px (S-462), so it fades in
      // without the grow, whose scale would shrink the name until the spring rests (S-1030).
      initial={enter ? { ...at(enter, far ? 1 : GROW_FROM), opacity: 0 } : false}
      // The place on a spring; the fade on an ease-out tween, so a spawn shows from its first frame.
      // One that grows in place (the phone's) draws over the cards gliding from under it, so it is
      // solid within a quarter of the spring, rather than showing their text through it.
      animate={{ ...at(place), transition: jump ? { duration: 0 } : { ...spring(!enter ? SPRINGS.move : here ? SPRINGS.appear : SPRINGS.grow, slow), opacity: tween(here ? slow / 4 : slow, ease) } }}
      // A far chip leaves without the shrink too: it fades while it travels, its name never under 14 px (S-462).
      variants={{ out: (c: Exit | undefined) => exitOf(c, m.id, place, slow, ease, far ? (p, k) => ({ ...at(p, 1), opacity: k === 1 ? 1 : 0 }) : at) }}
      exit="out">
      <div className="sv-r1">
        {far ? null : a ? <Glyph agent={a} /> : <PlainGlyph name="user" />}
        <button type="button" className="sv-nm" data-open tabIndex={leaving ? -1 : 0} aria-pressed={selected} aria-label={`${name}: details`} title={name}>
          <span className="full">{name}</span><span className="short" aria-hidden="true">{m.short}</span></button>
        {a && !far ? (L.agent.slots.HEAD ?? []).map((id) => id === 'model'
          ? <span key={id} className="sv-mdl" title={a.model ?? 'default model'}>{model(a).label.split(' ')[0]}</span>
          : id === 'cost' ? a.cost ? <span key={id} className={'sv-cost' + (m.kids ? ' has-tree' : '')} title={costTitle(a.cost, m.kids > 0)}>
            {own == null ? <span className="own">{costShort(null, mode)}</span> : <Roll className="own" value={own} fmt={fmtCost} />}
            {m.kids ? <span className="tree">tree {costShort(a.cost.tree[mode], mode)}</span> : null}
            {dollars ? <Rise value={own} fmt={fmtCost} /> : null}
          </span> : null
          : registryNode(L, id, 'inline', m)) : null}
      </div>
      {far || !shows(L.agent, 'ISSUE', 'issue') ? null : <div className="sv-r2">
        {/* The wash after a stamp: the accent's subtle fill, fading out by opacity alone. */}
        {st.n ? <span key={'w' + st.n} className={'sv-wash' + (m.it && isClosed(m.it) ? ' done' : '')} aria-hidden="true" /> : null}
        {m.it ? <IssueCard itsa={m.it} layout={L.issue} size="nested" state={issueState(L, m.cx)} actions={NO_ACTIONS} nested={{ skip: L.agent.slots.BADGES ?? [],
          lead: <motion.span key={st.n} className="sv-stamp" initial={st.n ? { transform: STAMP_FROM } : false} animate={{ transform: STAMP_TO }} transition={spring(SPRINGS.stamp, slow)}>
            <StatusGlyph status={m.it.status} title={statusLabel(m.it.status)} /></motion.span>,
          trail: <>
            {m.rollup ? <span ref={rollEl} className="sv-rollup" title={`${m.rollup.done} of ${m.rollup.total} child ITSAs done`}>
              <Roll value={m.rollup.done} fmt={whole} />/{m.rollup.total}</span> : null}
            {m.owns > 1 ? <span className="sv-more" title={`Owns ${m.owns} open ITSAs`}>+{m.owns - 1}</span> : null}
          </>,
        }} /> : <span className="sv-tt muted">{human ? 'Asks and results arrive here' : 'No ITSA'}</span>}
      </div>}
      {far ? null : <div className="sv-r3">{badgeNodes(L, m)}</div>}
      {far ? null : <div className="sv-r4">{a ? footNodes(L, m) : <span>{m.unread ? `${m.unread} unread` : 'Nothing unread'}</span>}</div>}
      {a && !far && L.agent.hairline !== false ? <div className={'sv-ctx' + (m.ctxLevel >= 2 ? ' l2' : m.ctxLevel >= 1 ? ' l1' : '')} title={`Context ${Math.round(m.ctx * 100)}% of the compaction limit`}>
        <i style={{ transform: `scaleX(${m.ctx})` }} /></div> : null}
      {/* The far zoom's chip: drawn at screen size over the card's place, so it reads at any zoom.
          Drawn near too (hidden), so a mode switch measures it as soon as it shows. */}
      <div className="sv-chip" aria-hidden="true">
        <div className="c1">{a ? <Glyph agent={a} /> : <PlainGlyph name="user" />}<b className={/[\s-]/.test(m.short) ? undefined : 'one'}>{m.short}</b>
          {m.folded ? <span className="c-more">+{m.folded.n}</span> : null}
</div>
        {m.it ? <div className="c2"><StatusGlyph status={m.it.status} /><span className="sv-key">{m.it.key}</span><span className="sv-tt">{m.it.title}</span></div>
          : human && m.badges[0]?.kind === 'word' ? <div className="c2 warn">{m.badges[0].word}</div> : null}
        <div className="c3">{a ? m.activity : ''}</div>
      </div>
      <Stack id={m.id} n={m.unread} name={name} />
      {m.kids || m.folded ? <button type="button" className={'sv-fold' + (m.folded ? ' shut' : '')} data-fold={m.id}
        aria-expanded={!m.folded} aria-label={`${m.folded ? 'Show' : 'Fold'} ${name}'s ${m.folded ? m.folded.n : m.kids} ${(m.folded ? m.folded.n : m.kids) === 1 ? 'agent' : 'agents'}`}>
        {m.folded ? <>+{m.folded.n}{m.folded.states.map((s) => <span key={s.state} className="dot" style={{ background: `var(--st-${s.state})` }} title={`${s.n} ${s.state}`} />)}</> : <Icon name="chevron-up" size="xs" />}
      </button> : null}
    </motion.div>
  )
}

// Whether a layout's slot holds an item.
const shows = (lay: CardLayout, slot: string, id: string) => (lay.slots[slot] ?? []).includes(id)

// The badges an issue-side item draws from the view's computed badges (cardBadges), so one that has no value draws nothing.
const issueSide = (id: string) => id === 'health' || id === 'review' || id === 'tests' || id.startsWith('field:')

// A registry item the layout places, drawn for this card: its inline form on a row, or its chip form in BADGES. Nothing when
// its form is empty, so an item with no value takes no room (S-2777).
const registryNode = (L: CardLayouts, id: string, form: 'inline' | 'chip', m: CardModel): ReactNode => {
  const item = L.items.get(id)
  const node = form === 'inline' ? item?.inline({ it: m.it, agent: m.agent, cx: m.cx }) : item?.chip?.({ it: m.it, agent: m.agent, cx: m.cx })
  return node ? <span key={id} className="sv-item">{node}</span> : null
}

// An agent card's BADGES in the layout's order: an issue-side item draws its computed badge, and an agent-side item its chip.
// A human card draws the badges the view gives it.
function badgeNodes(L: CardLayouts, m: CardModel): ReactNode[] {
  const draw = (b: Badge) => b.kind === 'word'
    ? <span key={b.id} className={('badge ' + b.tone).trim()} title={b.title}>{b.word}</span>
    : <span key={b.id} className="sv-field" title={b.f.label}><FieldValue f={b.f} v={b.v} /></span>
  if (!m.agent) return m.badges.map(draw)
  return (L.agent.slots.BADGES ?? []).flatMap((id): ReactNode[] => {
    const b = m.badges.find((x) => x.id === id)
    if (b) return [draw(b)]
    return issueSide(id) ? [] : [registryNode(L, id, 'chip', m)]
  })
}

// An agent card's FOOT, in the layout's order: each item's inline form, or the human's unread count.
const footNodes = (L: CardLayouts, m: CardModel): ReactNode[] => (L.agent.slots.FOOT ?? []).map((id) => registryNode(L, id, 'inline', m))

// The issue card's state on an agent card: no column (so its status shows wherever the layout puts it), the
// view's items, fields and context. Only the nested card reads it, and it draws the agent's own ITSA.
const issueState = (L: CardLayouts, cx: CellContext): IssueCardState => ({ column: '', mode: 'status', parentKey: null, dragging: false, items: L.items, fields: L.fields, cx })

// The card as a still copy (S-705): what Card draws, as plain markup. It takes its place at once, rolls and
// stamps nothing, and carries no state, so a card zoomed far out in Cards costs a paint.
function FlatCard({ m, place, selected }: Props) {
  const a = m.agent
  const human = !a
  const name = a?.name ?? 'You'
  const mode = a?.cost?.mode ?? 'api'
  const own = a ? ownCost(a) : null
  const L = useContext(CardLayoutsContext)
  return (
    <div className={'sv-card flat' + (human ? ' human' : '') + (m.hit ? ' hit ' + m.hit : '') + (selected ? ' sel' : '')} data-card={m.id} data-tid={m.id} role="group"
      aria-label={human ? 'You: asks and results arrive here' : `${name}, ${stateLabel(a)}${m.it ? `, ${m.it.key} ${m.it.title}` : ''}`}
      style={{ width: place.w, transform: cardTransform(place.x, place.y, 1) }}>
      <div className="sv-r1">
        {a ? <Glyph agent={a} /> : <PlainGlyph name="user" />}
        <button type="button" className="sv-nm" data-open aria-pressed={selected} aria-label={`${name}: details`} title={name}>
          <span className="full">{name}</span><span className="short" aria-hidden="true">{m.short}</span></button>
        {a ? (L.agent.slots.HEAD ?? []).map((id) => id === 'model'
          ? <span key={id} className="sv-mdl">{model(a).label.split(' ')[0]}</span>
          : id === 'cost' ? a.cost ? <span key={id} className="sv-cost"><span className="own">{costShort(own, mode)}</span></span> : null
          : registryNode(L, id, 'inline', m)) : null}
      </div>
      {shows(L.agent, 'ISSUE', 'issue') ? <div className="sv-r2">
        {m.it ? <IssueCard itsa={m.it} layout={L.issue} size="nested" state={issueState(L, m.cx)} actions={NO_ACTIONS} nested={{ skip: L.agent.slots.BADGES ?? [] }} />
          : <span className="sv-tt muted">{human ? 'Asks and results arrive here' : 'No ITSA'}</span>}
      </div> : null}
      <div className="sv-r3">{badgeNodes(L, m)}</div>
      <div className="sv-r4">{a ? footNodes(L, m) : <span>{m.unread ? `${m.unread} unread` : 'Nothing unread'}</span>}</div>
      <Stack id={m.id} n={m.unread} name={name} />
      {m.kids || m.folded ? <button type="button" className={'sv-fold' + (m.folded ? ' shut' : '')} data-fold={m.id} aria-expanded={!m.folded}
        aria-label={`${m.folded ? 'Show' : 'Fold'} ${name}'s agents`}>
        {m.folded ? <>+{m.folded.n}</> : <Icon name="chevron-up" size="xs" />}
      </button> : null}
    </div>
  )
}

// Unread mail as sheets against the card's corner (S-459): up to STACK_MAX and the count. Each
// sheet is keyed by its place in the count, so a new one mounts on top and drops in, and on a
// read the top one slips into the card as a ghost while the count stamps.
export function Stack({ id, n, name }: { id: string; n: number; name: string }) {
  const was = useRef(n)
  const prev = was.current
  useEffect(() => { was.current = n }, [n])
  const shown = Math.min(STACK_MAX, n)
  // The sheet keys, bottom to top: the top one is the count itself.
  const keys = Array.from({ length: shown }, (_, i) => n - shown + 1 + i)
  // Read: the sheet that was on top slips in.
  const gone = prev > n && prev > 0 ? prev : 0
  if (!n && !gone) return null
  return (
    <button type="button" className="sv-stack" data-inbox={id} title={`${n} unread: open the inbox`} aria-label={`${n} unread mail for ${name}: open the inbox`} disabled={!n}>
      {n ? <span key={n} className={'n' + (prev !== n ? ' bump' : '')}>{n}</span> : null}
      {keys.map((k, i) => <span key={k} className={'sheet' + (k > prev ? ' land' : '')} style={{ '--i': i } as CSSProperties} />)}
      {gone ? <span key={'r' + gone} className="sheet read" style={{ '--i': Math.min(STACK_MAX, prev) - 1 } as CSSProperties} aria-hidden="true" /> : null}
    </button>
  )
}

const CardOrFlat = (p: Props) => (p.far === 'flat' ? <FlatCard {...p} /> : <Card {...p} />)
export const SystemCard = memo(CardOrFlat, (p, n) => p.sig === n.sig && p.selected === n.selected && p.place.x === n.place.x && p.place.y === n.place.y && p.place.w === n.place.w && p.enter === n.enter && p.jump === n.jump && (p.far === n.far || (!p.far && n.far === 'chip')))
