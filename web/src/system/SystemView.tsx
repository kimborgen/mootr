// The system view, `w:system` (S-458, epic S-445): the whole stam system on one page. A header of
// instruments (agents by state, ITSAs, the subscription windows, the day's spend), then the org
// tree of agents as cards with wires between parent and child, which pans, zooms, and fits. A
// pane narrower than 600 px (S-1067) draws the Tree as it is on a desktop, branching top-down, as
// full cards at any zoom, as Cards does there; Cards and Stars stand tall there. All of them pan,
// pinch and double-tap to zoom (S-606).
// Clicking a card opens its details beside the tree (a bottom sheet on the phone), with links to
// the agent's world, its conversation, and its ITSA. Mail flies between the cards and stacks on
// them until read (S-459, deck.ts). Cost, ITSAs, spawns and archives move too (S-463): numbers
// roll, a status change stamps, a done ITSA's sheet travels up the wire to its parent's roll-up,
// and cards grow out of their parent, shrink back into it, and glide to new places, all by
// `transform` and `opacity` through Motion, on springs timed by the duration tokens, so reduced
// motion, which zeroes them, makes every change instant.
// The header's switch picks the layout: the Tree, or Cards on orbits round the chief of staff
// (S-460, orbits.ts), or Stars, orbs sized by spend on rings round it (S-539, stars.ts,
// StarCard.tsx), the same cards, wires, flights and panel.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { AnimatePresence, MotionConfig } from 'motion/react'
import { openInbox, openMail, selectAgent, selectIssue, selectThread, showView } from '../actions'
import { costTitle, k, live, money, model, stateLabel, STATE_COLOR, stateOf } from '../format'
import { RestBadge } from '../waits'
import { Glyph, PlainGlyph } from '../Glyph'
import { Icon } from '../Icon'
import { HarnessMark } from '../spawn'
import { workColumnIds, type Field } from '../itsa/fields'
import { statusInfo, StatusGlyph, statusLabel, toneVar } from '../itsa/itsa'
import { useWaiting } from '../itsa/WaitingList'
import * as shell from '../shell/layout'
import { onMailEvent, refreshSlow, useData } from '../store'
import type { Agent, Itsa, ItsaStatus } from '../types'
import { WORK_COLUMNS, type CellContext, type WorkColumn } from '../work/columns'
import { useWorkExtras } from '../work/data'
import { fieldColumns } from '../work/field-columns'
import { LINK_KINDS, linkKind } from '../work/links'
import { loadStore, loadWork } from '../work/views'
import { WORK_LAYOUT_EVENT } from '../work/WorkView'
import { Deck } from './deck'
import { stackCount } from './flights'
import { hash } from '../api'
import { FindBox, FindButton, FindDrop, type Find, useFind } from './Find'
import { columnWidth, descendants, packLayout, type Laid } from './layout'
import { asMode, type Mode, modeOf, MODES, pickMode, type Px, saveMode, storedMode } from './modes'
import { cardBadges, contextShare, type Badge, HUMAN, itsaCounts, type Move, ownedItsa, rollupOf, stateCounts, STATES, statesOf, statusMoves, systemNodes } from './model'
import { Rise, Roll, TimingContext } from './Roll'
import { boxOf, type Findable, frame, subtree } from './scale'
import { readTiming, type Timing, tokenMs } from './springs'
import { shortName } from './names'
import { lineWidth, Morph, nameFit, rebase, STAGE, type View } from './transition'
import { StarCard } from './StarCard'
import { activityOf, cardSig, type Exit, type ExitTo, type Far, SystemCard, type CardModel, type CardPlace } from './SystemCard'
import { meters, sparkPath, useSystemUsage } from './usage'
import { roomOf, roomsRight, zoomCard, zoomCards, zoomStars } from './zoom'
import { useCull, useFolds } from './useScale'
import { durationMs } from '../ui/duration'
import './system.css'

// Below this pane width the view is the phone's: tall Cards and Stars, full cards in the Tree.
export const NARROW_BELOW = 600
// The least zoom, Fit's too: at it a far chip still holds a readable name. Past it the view pans.
const ZOOM_MIN = 0.35
const ZOOM_MAX = 2
// Below this zoom a card's own text would draw under about 10 px, so it shows as a chip drawn at
// screen size instead (semantic zoom): mark, name, unread, the ITSA, and activity as room allows.
const FAR = 0.8
// Cards draws every card in full at any zoom (S-705): Stars is the view for when no cards are wanted. So it
// zooms out until the whole layout fits, down to this floor.
const ZOOM_FLOOR = 0.002
// Cards zoomed out past this draws each card as a still copy (SystemCard's FlatCard), which keeps a few hundred cheap.
const FLAT_BELOW = 0.35
// The phone's Tree draws full cards as Cards does (S-1067): it is a canvas to zoom in on, not a layout to fit.
const fullOf = (shape: string, narrow: boolean) => shape === 'cards' || (narrow && shape === 'tree')
const isFlat = (shape: string, narrow: boolean, k: number) => fullOf(shape, narrow) && k < FLAT_BELOW
const isFar = (shape: string, narrow: boolean, k: number) => !fullOf(shape, narrow) && k < FAR
// Cards zoomed out on a phone (S-784): the one column stops filling the width, so the top-level
// subtrees pack side by side into it. The two thresholds are the share of the stage's width the
// column takes on screen; the gap between them is the hysteresis, so one zoom holds one
// arrangement instead of flickering between them. Fit is zoom 1 and always the one readable column.
const PACK_AT = 0.55
const UNPACK_AT = 0.72
const PACK_MAX_K = 0.9
// The two-column option at Fit (S-784), off by default: two columns of full cards fit a 360 px
// phone only with names under 14 px, so it is an experiment (`#view=system&cardsCols=2`) the user can
// compare against the one column, never a setting.
const cardsColsOf = () => (new URLSearchParams(location.hash.slice(1)).get('cardsCols') === '2' ? 2 : 0)
// A press that moves less than this is a click, not a drag.
const DRAG_PX = 4
// Two taps of a finger this close in time and place are a double tap, which zooms in by ZOOM_TAP.
const TAP_MS = 450
const TAP_PX = 24
const ZOOM_TAP = 2
// What the phone's − and + buttons zoom by, about the middle of the stage.
const ZOOM_STEP = 1.5

// The px values the layout needs, read from the tokens through a probe, so the CSS and the layout
// never disagree and no size is written here.
function readPx(host: HTMLElement): Px {
  const probe = document.createElement('div')
  probe.className = 'sv-probe'
  host.appendChild(probe)
  const v = (name: string) => { probe.style.width = `var(${name})`; return probe.getBoundingClientRect().width }
  const px: Px = {
    card: v('--sv-card-w'), cardH: v('--sv-card-h'), gapX: v('--sv-gap-x'), gapY: v('--sv-gap-y'), orbitGap: v('--sv-orbit-gap'), indent: v('--sv-indent'), rowGap: v('--sv-row-gap'),
    pad: v('--sv-pad'), sheetH: v('--sv-sheet-h'), landIn: v('--sv-land-in'),
    chipMax: v('--sv-chip-max'), chipClear: v('--sv-chip-clear'), stackOver: v('--sv-stack-over'), stackOut: v('--sv-stack-out'),
    orbMin: v('--sv-orb-min'), orbMax: v('--sv-orb-max'), orbHuman: v('--sv-orb-human'), starLabelW: v('--sv-star-label-w'), starLabelH: v('--sv-star-label-h'), starLabelGap: v('--sv-star-label-gap'), starGap: v('--sv-star-gap'),
    slowMs: (() => { probe.style.transitionDuration = 'var(--duration-slow)'; return durationMs(getComputedStyle(probe).transitionDuration) })(),
  }
  probe.remove()
  return px
}

// The Work columns the human shows (the Work page's layout, shared through settings), so the
// Work columns settings choose what a card and the panel show too.
function useWorkCols(fields: ReturnType<typeof useWorkExtras>['fields']): string[] {
  const [cols, setCols] = useState<string[]>(() => WORK_COLUMNS.map((c) => c.id))
  useEffect(() => {
    let dead = false
    const read = () => loadWork().then(() => { if (!dead) setCols(loadStore(workColumnIds(WORK_COLUMNS.map((c) => c.id), fields ?? [])).layout.cols) }).catch(() => {})
    void read()
    window.addEventListener(WORK_LAYOUT_EVENT, read)
    return () => { dead = true; window.removeEventListener(WORK_LAYOUT_EVENT, read) }
  }, [fields])
  return cols
}

function useSize(el: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const e = el.current
    if (!e) return
    setSize({ w: e.clientWidth, h: e.clientHeight })
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setSize({ w: e.clientWidth, h: e.clientHeight }))
    ro.observe(e)
    return () => ro.disconnect()
  }, [el])
  return size
}

export function SystemView({ viewKey }: { viewKey: string }) {
  const d = useData()
  shell.useShell()
  const shown = shell.leaves(shell.mainWorld().root).some((l) => l.active === viewKey)
  const extras = useWorkExtras()
  const usage = useSystemUsage(shown)
  const cols = useWorkCols(extras.fields)
  const fields = useMemo(() => extras.fields ?? [], [extras.fields])
  const stage = useRef<HTMLDivElement>(null)
  const world = useRef<HTMLDivElement>(null)
  // Mode transitions (S-572): the morph that stages them, and what it reads before a switch.
  const morph = useRef<Morph | null>(null)
  const view = useRef<View>({ x: 0, y: 0, k: 1 })
  const timingNow = useRef<Timing>({ slow: 0, tick: 0, keep: 0, ease: null })
  const size = useSize(stage)
  const narrow = size.w > 0 && size.w < NARROW_BELOW
  // The phone keeps its own mode (modes.ts): until the pane is measured, the window guesses which.
  const linked = useRef(asMode(hash.get('mode')))
  const [mode, setModeState] = useState<Mode>(() => pickMode(linked.current, storedMode(innerWidth < NARROW_BELOW)))
  const modeNow = useRef(mode)
  modeNow.current = mode
  const modeKey = useRef<boolean | null>(null)
  // Once measured, and when the pane crosses the line, the mode is the last chosen on this kind of
  // screen. A link's mode is the viewer's choice from then on.
  useLayoutEffect(() => {
    if (!size.w || modeKey.current === narrow) return
    modeKey.current = narrow
    const m = linked.current ?? asMode(storedMode(narrow)) ?? 'tree'
    if (linked.current) { saveMode(m, narrow); linked.current = null }
    if (m !== modeNow.current) setModeState(m)
  }, [narrow, size.w])
  const [px, setPx] = useState<Px | null>(null)
  useLayoutEffect(() => { if (stage.current) setPx(readPx(stage.current)) }, [])
  // A switch is measured before it renders, so the transition (transition.ts) starts from what
  // shows now, mid-way or at rest.
  const setMode = useCallback((m: Mode) => {
    if (m === modeNow.current) return
    // The tokens as they are now (a check may have slowed them, reduced motion may have turned on).
    if (probe.current) { timingNow.current = readTiming(probe.current); setTiming(timingNow.current) }
    morph.current?.capture(world.current, view.current, track.current.shape ?? '', track.current.laid, timingNow.current.slow === 0)
    saveMode(m, modeKey.current ?? false)
    setModeState(m)
  }, [])
  // A link opened with the app already open carries its mode too.
  useEffect(() => {
    const on = () => { const m = asMode(new URLSearchParams(location.hash.slice(1)).get('mode')); if (m) setMode(m) }
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [setMode])
  const shape: Mode = mode
  // The phone's Tree and Cards draw full cards at any zoom (S-1067, S-705).
  const full = fullOf(shape, narrow)
  const [sel, setSel] = useState<string | null>(null)
  // The two-column option (S-784): a link's `&cardsCols=2` and nothing else, so it can't leak into
  // a later visit the way a stored setting would.
  const [cardsCols, setCardsCols] = useState(cardsColsOf)
  useEffect(() => {
    const on = () => setCardsCols(cardsColsOf())
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])

  // The tree, and which nodes are folded (useScale): the focus, or nothing at rest, with the
  // human's own toggles on top (S-705).
  const nodes = useMemo(() => systemNodes(d.agents), [d.agents])
  const nodesSig = nodes.map((n) => n.id + '<' + n.parent).join(' ')
  // Stars size their orbs by spend (S-539), to the cent.
  const costSig = shape === 'stars' ? nodes.map((n) => Math.round((n.cost ?? 0) * 100)).join(' ') : ''
  const statusOf = useCallback((s: string) => statusInfo(s), [d.itsaStatuses]) // eslint-disable-line react-hooks/exhaustive-deps
  const { folded, toggle: toggleFold, focus, setFocus, reveal } = useFolds(nodes, nodesSig, narrow)
  // Whether the phone's Cards has packed its top-level subtrees side by side (S-784). Set by the
  // zoom (`apply`, with hysteresis); `colW` keeps the width the one column would take, which sets
  // the thresholds whatever the arrangement shows now.
  const [packed, setPacked] = useState(false)
  const packedNow = useRef(false)
  packedNow.current = packed
  const colW = useRef(0)
  const laid: Laid | null = useMemo(() => {
    if (!px || !size.w) return null
    // The phone's Cards: one column at the fit (the mode's own tall layout), and past where the
    // column stops filling the width — or under the two-column experiment — the top-level subtrees
    // packed into columns that suit the pane's own shape.
    if (narrow && shape === 'cards') {
      const dims = { w: px.card, h: px.cardH, indent: px.indent, rowGap: px.rowGap }
      colW.current = columnWidth(nodes, dims, folded)
      if (packed || cardsCols > 1) return packLayout(nodes, { ...dims, gapX: px.gapX, gapY: px.gapY }, folded, cardsCols > 1 ? cardsCols : 0, size.h ? size.w / size.h : 1)
    }
    return (modeOf(shape).layout ?? modeOf('tree').layout!)(nodes, px, folded, narrow)
  }, [nodesSig, costSig, folded, px, shape, narrow, packed, cardsCols, size.h]) // eslint-disable-line react-hooks/exhaustive-deps

  // Mail in flight (deck.ts): sheets in the air, the stacks they hold back, and the cards just
  // hit. The deck tells the view when those change; nothing renders per frame.
  const trails = useRef<SVGSVGElement>(null)
  const flights = useRef<HTMLDivElement>(null)
  const deck = useRef<Deck | null>(null)
  const [flightTick, setFlightTick] = useState(0)
  const shownModels = useRef(new Map<string, CardModel>())

  // The motion tokens, read through a probe: Motion's springs and the rolls take their lengths
  // from them, so reduced motion and a check's override reach them too. They change only with
  // the root's style (a check slowing them) or the reduced-motion setting, so they are read then,
  // not after every render: a read forces a style recalc of every card (S-462).
  const probe = useRef<HTMLElement>(null)
  const [timing, setTiming] = useState<Timing>({ slow: 0, tick: 0, keep: 0, ease: null })
  timingNow.current = timing
  useLayoutEffect(() => {
    const el = probe.current
    if (!el) return
    const read = () => { const t = readTiming(el); setTiming((o) => (t.slow !== o.slow || t.tick !== o.tick || t.keep !== o.keep || String(t.ease) !== String(o.ease) ? t : o)) }
    read()
    const mo = new MutationObserver(read)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
    const mq = matchMedia('(prefers-reduced-motion: reduce)')
    mq.addEventListener('change', read)
    return () => { mo.disconnect(); mq.removeEventListener('change', read) }
  }, [])

  // ITSA status changes (S-463), seen in the render that brings them so the card stamps in the
  // same frame. One reaching done stays on its owner's card a moment (`recent`) and is queued to
  // send its done sheet up the wire, which the layout effect below launches.
  const doneStatus = doneOf(d.itsaStatuses)
  const moves = useRef({ itsas: null as Itsa[] | null, recent: new Map<string, number>(), queue: [] as Move[] })
  const mv = moves.current
  if (d.loaded.itsas && d.itsas !== mv.itsas) {
    if (mv.itsas) for (const x of statusMoves(mv.itsas, d.itsas, doneStatus)) if (x.done && x.owner) { mv.recent.set(x.id, performance.now() + timing.keep); mv.queue.push(x) }
    mv.itsas = d.itsas
  }
  const [, bumpDone] = useState(0)
  const recent = new Set([...mv.recent].filter(([, until]) => until > performance.now()).map(([id]) => id))
  useEffect(() => {
    if (!mv.recent.size) return
    const next = Math.min(...mv.recent.values()) - performance.now()
    const t = setTimeout(() => { const now = performance.now(); for (const [id, u] of mv.recent) if (u <= now + 1) mv.recent.delete(id); bumpDone((n) => n + 1) }, Math.max(0, next) + 20)
    return () => clearTimeout(t)
  })
  // The ITSAs whose done sheet is on the way: launched, and queued to launch.
  const flyingKids = new Set([...(deck.current?.doneKids.keys() ?? []), ...mv.queue.map((x) => x.id)])

  // Each card's model.
  // The human's card: what waits on them, counted as the Mail, Issues and Work badges count it.
  const waiting = useWaiting().length
  const humanBadges = useMemo((): Badge[] => waiting ? [{ kind: 'word', id: 'waiting', word: `${waiting} waiting on you`, tone: 'warn', title: 'Asks, decisions, and ITSAs waiting on you' }] : [], [waiting])
  const models = useMemo(() => {
    const out = new Map<string, CardModel>()
    const kidsOf = new Map<string, number>()
    for (const n of nodes) if (n.parent) kidsOf.set(n.parent, (kidsOf.get(n.parent) ?? 0) + 1)
    const agentsBy = new Map(d.agents.map((a) => [a.id, a]))
    // The ITSAs by owner and by parent, so each card looks at its own, not all of them.
    const byOwner = new Map<string, Itsa[]>(), byParent = new Map<string, Itsa[]>()
    for (const x of d.itsas) {
      if (x.owner) byOwner.set(x.owner, [...(byOwner.get(x.owner) ?? []), x])
      if (x.parent_id) byParent.set(x.parent_id, [...(byParent.get(x.parent_id) ?? []), x])
    }
    for (const n of nodes) {
      const a = n.id === HUMAN ? null : agentsBy.get(n.id) ?? null
      const own = a ? ownedItsa(a.id, byOwner.get(a.id) ?? [], (s) => statusOf(s).category, (s) => statusOf(s).human, recent) : null
      const hidden = folded.has(n.id) ? descendants(nodes, n.id) : []
      // A folded card stands for its subtree: its stack holds the subtree's unread mail.
      const base = (a ? a.unread ?? 0 : d.unread) + hidden.reduce((s, id) => s + (agentsBy.get(id)?.unread ?? 0), 0)
      const hit = deck.current?.hits.get(n.id)
      out.set(n.id, {
        id: n.id, short: shortName(a?.name ?? 'You', n.parent && n.parent !== HUMAN ? agentsBy.get(n.parent)?.name : null), agent: a, activity: a ? activityOf(a) : '', it: own?.it ?? null, owns: own?.count ?? 0,
        badges: own ? cardBadges(own.it, cols, fields) : a ? [] : humanBadges,
        unread: stackCount(base, deck.current?.holds.get(n.id)), hit: hit ? (hit.warn ? 'warn' : 'mail') : '',
        ctx: a ? contextShare(a, d.thresholds.enforceTokens) : 0, ctxLevel: a?.context_level ?? 0,
        // The human's card doesn't fold: folding everything shows nothing.
        kids: folded.has(n.id) || !a ? 0 : kidsOf.get(n.id) ?? 0,
        folded: hidden.length ? { n: hidden.length, states: statesOf(hidden.map((id) => agentsBy.get(id)).filter((x): x is Agent => !!x)) } : null,
        rollup: own ? rollupOf(own.it, byParent.get(own.it.id) ?? [], doneStatus, flyingKids) : null,
      })
    }
    return out
  }, [nodes, folded, d.agents, d.itsas, d.unread, d.thresholds, cols, fields, statusOf, humanBadges, flightTick, recent.size, doneStatus]) // eslint-disable-line react-hooks/exhaustive-deps
  shownModels.current = models
  // Each card's signature, worked out once per model, for the cards drawn.
  const sigs = useMemo(() => new Map<string, string>(), [models])
  const sigOf = (m: CardModel) => { let x = sigs.get(m.id); if (x == null) sigs.set(m.id, (x = cardSig(m))); return x }

  // The deck lives as long as the world layer, and hears every mail the stream reports.
  useEffect(() => {
    if (!flights.current || !trails.current || deck.current) return
    deck.current = new Deck(flights.current, trails.current, () => setFlightTick((t) => t + 1), (id) => shownModels.current.get(id)?.unread ?? 0)
    // For headless UI checks (web/check/system.mjs), beside main.tsx's stamDebug.
    Object.assign((window as unknown as { stamDebug?: object }).stamDebug ?? {}, { systemDeck: deck.current })
  })
  useEffect(() => () => { deck.current?.stop(); deck.current = null }, [])
  // A far chip's growth in world px, from where it is drawn (only the Tree's chips carry their stack).
  const chipGrow = (id: string) => {
    if ((shape !== 'tree' && shape !== 'cards') || !stage.current?.classList.contains('far')) return 0
    const el = world.current?.querySelector<HTMLElement>(`.sv-card[data-card="${CSS.escape(id)}"]`)
    const chip = el?.querySelector<HTMLElement>('.sv-chip')
    return el && chip ? Math.max(0, (chip.getBoundingClientRect().width - el.getBoundingClientRect().width) / view.current.k) : 0
  }
  if (deck.current && laid && px) {
    deck.current.geo = { laid, parentOf: (id) => nodes.find((n) => n.id === id)?.parent ?? null, card: px.card, cardH: px.cardH, pad: px.pad, rowGap: px.rowGap, sheetH: px.sheetH, landIn: px.landIn, human: HUMAN, grow: chipGrow }
  }
  // Launch the queued done sheets once the deck knows the layout: each from its owner's card to
  // the card of whoever owns the parent ITSA, or else to its owner's parent agent.
  // A carried ITSA that is no longer done under the same parent is let go.
  useLayoutEffect(() => {
    if (!deck.current) return
    const byId = new Map(d.itsas.map((i) => [i.id, i]))
    deck.current.dropDone((child, parent) => { const c = byId.get(child); return !c || c.status !== doneStatus || c.parent_id !== parent })
  }, [d.itsas, doneStatus])
  useLayoutEffect(() => {
    if (!deck.current?.geo || !mv.queue.length) return
    const q = mv.queue.splice(0)
    for (const x of q) {
      const parentOwner = x.parent ? d.itsas.find((i) => i.id === x.parent)?.owner : null
      const to = parentOwner && parentOwner !== x.owner ? parentOwner : nodes.find((n) => n.id === x.owner)?.parent ?? null
      if (to) deck.current.done(x.owner!, to, x.id, x.parent)
    }
    setFlightTick((t) => t + 1)
  })
  useEffect(() => onMailEvent((e) => {
    // The human's count comes from their threads: fetch them when their mail moves.
    if (e.type === 'sent' ? e.to.includes(HUMAN) : e.by === HUMAN) void refreshSlow()
    if (e.type === 'sent') deck.current?.mail(e)
  }), [])

  // Cards that leave (archived, or folded away) shrink back into their nearest ancestor still
  // shown, and cards that arrive grow out of it (AnimatePresence, SystemCard): where from is
  // worked out here, in the render that changes the layout. Every agent's parent is remembered,
  // so an archived one still knows where to go.
  const track = useRef({ laid: null as Laid | null, shape: null as string | null, packed: false, swap: false, jump: false, order: [] as string[], parents: new Map<string, string | null>(), entering: new Map<string, CardPlace>() })
  const [, bump] = useState(0)
  const tr = track.current

  for (const n of nodes) tr.parents.set(n.id, n.parent)
  const near = (l: Laid, id: string): CardPlace | null => {
    for (let p = tr.parents.get(id) ?? null, i = 0; p && i < 64; p = tr.parents.get(p) ?? null, i++) { const q = l.pos.get(p); if (q) return { x: q.x, y: q.y, w: q.w } }
    return null
  }
  // Into or out of Stars, cards become orbs or back (S-539): each new one glides from where its
  // other self stood, centre to centre, as the old one fades where it is.
  const tall = (s: string | null, q: { w: number }) => (s === 'stars' ? q.w : px?.cardH ?? 0)
  // A mode switch (S-572) hands every card to the morph instead, which starts from where each was
  // drawn; so does a relayout while the morph runs, measured here before it commits. The phone's
  // Cards packing its subtrees (S-784) is the same kind of switch: the cards travel on springs.
  const mo = morph.current
  if (laid && tr.laid !== laid && mo && (mo.pending ? tr.shape !== shape || tr.packed !== packed : mo.active)) {
    if (!mo.pending) mo.capture(world.current, view.current, tr.shape ?? '', tr.laid, timing.slow === 0)
    tr.swap = (tr.shape === 'stars') !== (shape === 'stars') || tr.swap
    tr.jump = true
    tr.entering.clear()
    tr.laid = laid
    tr.shape = shape
    tr.packed = packed
  }
  if (laid && tr.laid !== laid) {
    const was = tr.laid
    tr.swap = !!was && (tr.shape === 'stars') !== (shape === 'stars')
    tr.entering.clear()
    if (was) for (const id of laid.pos.keys()) {
      const q = was.pos.get(id), p = laid.pos.get(id)!
      if (tr.swap && q) { tr.entering.set(id, { x: q.x + q.w / 2 - p.w / 2, y: q.y + tall(tr.shape, q) / 2 - tall(shape, p) / 2, w: p.w }); continue }
      if (q) continue
      const from = near(was, id)
      if (from) tr.entering.set(id, from)
    }
    tr.laid = laid
    tr.shape = shape
    tr.packed = packed
  }
  // The entering mark (it passes under its parent) lasts the grow.
  useEffect(() => {
    if (!tr.entering.size) return
    const t = setTimeout(() => { tr.entering.clear(); tr.swap = false; bump((n) => n + 1) }, timing.slow * 3)
    return () => clearTimeout(t)
  })
  // A card still laid out but leaving was culled: it goes at once, in place. A mode swap's
  // cards leave where they are.
  const exitTo: ExitTo = (id) => (!laid || tr.swap ? null : laid.pos.has(id) ? 'culled' : near(laid, id))
  // A card leaving for its star (or a star for its card) fades as the morph carries it.
  const exit: Exit = { to: exitTo, morph: tr.jump && tr.swap ? timingNow.current.slow * STAGE.leave : null }

  // Pan and zoom: the world layer's transform (`view`, above), written to the element, never to
  // React state, except the far flag when zoom crosses FAR.
  const touched = useRef(false)
  const [far, setFar] = useState(false)
  const [flat, setFlat] = useState(false)
  // Only the cards near the viewport mount (useScale); each move of the view re-measures.
  const { mounted, now: cullNow } = useCull(laid, stage, view, px?.cardH ?? 0, size)
  const cullRef = useRef(cullNow)
  cullRef.current = cullNow
  // A mode switch's morph is running (transition.ts): the view shows data-moving.
  const [moving, setMoving] = useState(false)
  // The chips and stacks drawn at screen size take the zoom (zoom.ts), and the sheets in
  // flight read it from their layer, so a zoom's frame restyles only them.
  const rooms = useMemo(() => (laid && px && (shape === 'tree' || shape === 'cards') ? roomsRight(laid.pos, px.cardH) : undefined), [laid, px, shape])
  const zoomNow = useRef(() => {})
  zoomNow.current = () => {
    const w = world.current, k = view.current.k
    if (!w || !px) return
    flights.current?.style.setProperty('--sv-k', String(k))
    // On the phone a far card's and an orb's hit area keeps a finger's size on screen (system.css):
    // few cards mount there, so one inherited value is cheap.
    if (narrow) w.style.setProperty('--sv-unk', String(1 / k))
    zoomCards(w, k, isFar(shape, narrow, k), full ? 'cards' : shape, px, rooms)
    if (shape === 'stars' && laid) zoomStars(w, k, k < FAR, laid.pos, px.starLabelGap)
  }
  // Before the names are measured, so that measure lays out the new zoom too, once.
  useLayoutEffect(() => zoomNow.current())
  // A far chip, in the Tree or in Cards, grows to fit its name (zoom.ts): what each one's row
  // needs is measured after each render that could change it, and set on the card as
  // --sv-chip-fit. The name's text is measured by a range, whose boxes are the whole name however
  // the box around it is cut or wrapped, so the fit shrinks as well as grows. The stack moves out
  // with a grown chip's corner, and the deck lands there. Each card keeps what its fit was
  // measured for (its name and fold count), so a card mounted afresh (back from Stars, or culled
  // and panned back) or renamed gets its fit, and the rest aren't measured again: a zoom that
  // mounts a few cards measures only those (S-462). Nothing is measured while a mode switch
  // scales the cards, and all of it once the switch settles, or once a font arrives.
  const [fonts, setFonts] = useState(0)
  useEffect(() => {
    const on = () => setFonts((n) => n + 1)
    document.fonts?.addEventListener('loadingdone', on)
    return () => document.fonts?.removeEventListener('loadingdone', on)
  }, [])
  useLayoutEffect(() => {
    const w = world.current
    if (!w || !far || moving) return
    if (shape !== 'tree' && shape !== 'cards') return
    const v = '--sv-chip-fit'
    const ms: [HTMLElement, string, number][] = []
    const range = document.createRange()
    for (const el of w.querySelectorAll<HTMLElement>('.sv-card[data-card]')) {
      const m = models.get(el.dataset.card!)
      const sig = `${fonts} ${m?.short} ${m?.folded?.n ?? ''}`
      if (el.dataset.fit === sig && el.style.getPropertyValue(v)) continue
      const r = el.querySelector<HTMLElement>(':scope > .sv-chip'), b = r?.querySelector<HTMLElement>('.c1 b'), t = b
      // A row not drawn (its chip hidden for now) has nothing to measure: it is measured once it shows.
      if (!r || !b || !t || !r.offsetWidth) continue
      range.selectNodeContents(t)
      // On one line, however it is drawn now: a name wrapped onto two lines (system.css) adds up.
      // The name's boxes are as drawn, under every transform above them: a card still on its spring
      // scales them too. Taken back to the chip's own size, the fit doesn't depend on that (S-1030).
      const drawn = r.getBoundingClientRect().width, laid = parseFloat(getComputedStyle(r).width) || r.offsetWidth
      const sc = drawn > 0 && laid > 0 ? drawn / laid : 1
      ms.push([el, sig, nameFit(r.offsetWidth, b.clientWidth, lineWidth(range.getClientRects()) / sc)])
    }
    const k = view.current.k
    for (const [el, sig, fit] of ms) {
      el.dataset.fit = sig
      if (el.style.getPropertyValue(v) !== fit + 'px') { el.style.setProperty(v, fit + 'px'); if (px) zoomCard(el, k, true, shape, px, roomOf(el, px, rooms)) }
    }
  }, [far, shape, models, moving, mounted, fonts])
  // The switch between the phone's one column and its packed subtrees (S-784) runs through the mode
  // morph (S-572): the cards travel on springs, and under reduced motion the old picture crossfades
  // into the new. It is measured before the relayout, as a mode switch is.
  const flipPacked = useCallback((next: boolean) => {
    if (next === packedNow.current) return
    packedNow.current = next
    if (shape === 'cards') morph.current?.capture(world.current, view.current, tr.shape ?? '', tr.laid, timingNow.current.slow === 0)
    setPacked(next)
  }, [shape]) // eslint-disable-line react-hooks/exhaustive-deps
  const apply = useCallback(() => {
    const v = view.current
    if (world.current) world.current.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`
    zoomNow.current()
    setFar((f) => (f !== isFar(shape, narrow, v.k) ? !f : f))
    setFlat((f) => (f !== isFlat(shape, narrow, v.k) ? !f : f))
    // Pack the subtrees once the one column no longer fills the stage's width, and keep the column
    // until it does again: the two thresholds are the hysteresis, so a zoom holds one arrangement.
    const W = stage.current?.clientWidth ?? 0
    if (narrow && shape === 'cards' && cardsCols < 2 && px && colW.current > 0 && W > 0) {
      const share = (colW.current * v.k) / Math.max(1, W - px.pad * 2)
      flipPacked(packedNow.current ? !(share > UNPACK_AT || v.k >= PACK_MAX_K) : share < PACK_AT && v.k < PACK_MAX_K)
    } else flipPacked(false)
    cullRef.current()
  }, [shape, narrow, cardsCols, flipPacked]) // eslint-disable-line react-hooks/exhaustive-deps
  // The least zoom: Cards goes as far out as shows the whole layout.
  const minZoom = () => {
    const el = stage.current
    if (!full || !laid || !px || !el) return ZOOM_MIN
    const pad = px.pad * 4
    return Math.max(ZOOM_FLOOR, Math.min(ZOOM_MIN, (el.clientWidth - pad) / laid.width, (el.clientHeight - pad) / (laid.height + px.pad)))
  }
  // At the least zoom Cards shows the whole layout, centred in the stage, wherever the gesture was.
  const wholeAtLeast = (v: View): View => {
    const el = stage.current
    if (!full || !laid || !el || v.k > minZoom() * 1.001) return v
    return { k: v.k, x: (el.clientWidth - laid.width * v.k) / 2, y: (el.clientHeight - laid.height * v.k) / 2 }
  }
  const fit = useCallback(() => {
    if (!laid || !px || !stage.current) return
    const W = stage.current.clientWidth, H = stage.current.clientHeight
    const pad = px.pad * 2
    if (narrow && shape === 'tree') {
      // The phone's Tree (S-1067) opens at a readable card size with the chief of staff at the top
      // centre, whatever the tree's width: you pan to explore, not zoom out to fit.
      const root = laid.pos.get(nodes[0]?.id ?? '') ?? [...laid.pos.values()][0]
      view.current = { k: 1, x: W / 2 - (root ? root.x + root.w / 2 : laid.width / 2), y: pad }
    } else if (shape === 'cards') {
      // The two-column option (S-784): two columns of full cards fit a 360 px phone only by zooming
      // out until the names drop under 14 px, which is why it is off by default. Fit fits their width
      // inside the stage's margin, as the one column's does, so a card's cost and stack stay clear of
      // the edge (and of the zoom buttons' corner).
      if (cardsCols > 1 && narrow) {
        const kk = Math.max(minZoom(), Math.min(1, (W - pad * 2) / Math.max(1, laid.width)))
        view.current = { k: kk, x: (W - laid.width * kk) / 2, y: pad }
      } else {
        // Cards' Fit keeps its names readable: zoom 1, whatever the size of the layout (S-705). A layout that
        // fits is centred. Else on a phone, the column hangs from the top, its left at the margin when it is
        // wider than the screen; on a desktop the ring centres on cos. Zooming out is the way to see it whole.
        const kk = 1, over = laid.width > W - pad * 2 || laid.height > H - pad * 2
        if (!over) view.current = { k: kk, x: (W - laid.width) / 2, y: laid.hub ? Math.max(pad, (H - laid.height) / 2) : pad }
        else if (narrow) view.current = { k: kk, x: laid.width <= W - px.pad * 2 ? (W - laid.width) / 2 : px.pad, y: pad }
        else if (laid.hub) view.current = { k: kk, x: W / 2 - laid.hub.x, y: H / 2 - laid.hub.y }
        else view.current = { k: kk, x: (W - laid.width) / 2, y: pad }
      }
    } else {
      const want = Math.min(1, (W - pad * 2) / laid.width, (H - pad * 2) / (laid.height + px.pad)), kk = Math.max(ZOOM_MIN, want)
      // The orbits centre in the stage; the tree hangs from its top. Orbits too big to fit at the least
      // zoom centre on their hub, and the rest is a pan away.
      const hub = want < ZOOM_MIN ? laid.hub : undefined
      view.current = hub ? { k: kk, x: W / 2 - hub.x * kk, y: H / 2 - hub.y * kk } : { k: kk, x: (W - laid.width * kk) / 2, y: laid.hub ? Math.max(pad, (H - laid.height * kk) / 2) : pad }
    }
    touched.current = false
    apply()
  }, [laid, px, apply, narrow, shape, cardsCols, nodes]) // eslint-disable-line react-hooks/exhaustive-deps
  // A new mode fits afresh.
  useLayoutEffect(() => { touched.current = false }, [shape]) // eslint-disable-line react-hooks/exhaustive-deps
  // Fit on the first layout and whenever the stage or the tree changes size, until the human moves it.
  // Fit and apply cull too, so the cull follows the new view before the paint.
  useLayoutEffect(() => { if (!touched.current) fit(); else apply() }, [fit, apply, size.w, size.h, laid?.width, laid?.height]) // eslint-disable-line react-hooks/exhaustive-deps
  // Zoom to some cards (a search pick, a focus), once the layout that shows them is in: `after`
  // is the layout they were asked for in, when a fold change will replace it.
  const target = useRef<{ ids: string[]; want: number; after: Laid | null } | null>(null)
  const zoomTo = (ids: string[], want: number, refold: boolean) => { target.current = { ids, want, after: refold ? laid : null }; bump((n) => n + 1) }
  useLayoutEffect(() => {
    const t = target.current
    const el = stage.current
    if (!t || !laid || !px || !el || laid === t.after) return
    target.current = null
    const box = boxOf(t.ids.map((id) => laid.pos.get(id)).filter((p) => !!p), px.cardH)
    if (!box) return
    view.current = frame(box, el.clientWidth, el.clientHeight, px.pad * 2, minZoom(), ZOOM_MAX, t.want)
    touched.current = true
    apply()
  })
  const focusOn = (id: string) => { setFocus(id); setSel(null); zoomTo([id, ...subtree(nodes, id)], 1, true) }
  const leaveFocus = () => { setFocus(null); touched.current = false }

  // After a layout change has fitted: the morph plays a mode switch from what it measured, and
  // sheets in the air take their cards' new places (deck.relayout), the camera's move folded in.
  const lastView = useRef<View | null>(null)
  useLayoutEffect(() => {
    if (!stage.current) return
    if (!morph.current) {
      morph.current = new Morph(stage.current)
      // For headless UI checks (web/check/system.mjs): seek and resume a switch.
      Object.assign((window as unknown as { stamDebug?: object }).stamDebug ?? {}, { systemMorph: morph.current })
    }
    const mo = morph.current
    const was = mo.fromView ?? lastView.current
    if (mo.pending) {
      if (tr.jump && laid && world.current) {
        // The far flag for the new zoom, now, so the morph measures what will show.
        stage.current.classList.toggle('far', isFar(shape, narrow, view.current.k))
        mo.play({
          // The tokens as they are now: a check may have slowed them since the last render.
          world: world.current, view: view.current, laid, shape, slow: probe.current ? tokenMs(probe.current, '--duration-slow') : timing.slow, ease: timing.ease, crossMs: probe.current ? tokenMs(probe.current, '--duration-crossfade') : 0,
          onDone: () => { tr.jump = false; tr.swap = false; setMoving(false) },
        })
        setMoving(true)
      } else mo.drop()
    }
    if (was && laid) deck.current?.relayout(rebase(was, view.current))
    lastView.current = { ...view.current }
  }, [laid]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => morph.current?.stop(false), [])

  // A gesture's move renders what it brings into view (the cull, the far flag) before the frame
  // paints, as Fit does from its layout effect, so a card never shows a frame late (S-462).
  const applyNow = () => flushSync(apply)
  const zoomAt = (cx: number, cy: number, nk: number) => {
    const v = view.current
    const kk = Math.max(minZoom(), Math.min(ZOOM_MAX, nk))
    view.current = wholeAtLeast({ k: kk, x: cx - (cx - v.x) * (kk / v.k), y: cy - (cy - v.y) * (kk / v.k) })
    touched.current = true
    applyNow()
  }
  // The wheel's listener lives across renders, so it calls the latest zoomAt (whose least zoom reads the layout).
  const zoomAtRef = useRef(zoomAt)
  zoomAtRef.current = zoomAt
  const zoomBy = (f: number) => { const el = stage.current; if (el) zoomAt(el.clientWidth / 2, el.clientHeight / 2, view.current.k * f) }
  useEffect(() => {
    const el = stage.current
    if (!el) return
    // A trackpad sends several wheels a frame: they add up, and zoom once in the next frame.
    let raf = 0, at = { x: 0, y: 0, f: 1 }
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      // A trackpad pinch arrives as a wheel with ctrl held, in finer steps.
      at = { x: e.clientX, y: e.clientY, f: at.f * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)) }
      if (!raf) raf = requestAnimationFrame(() => {
        raf = 0
        const r = el.getBoundingClientRect(), z = at
        at = { x: 0, y: 0, f: 1 }
        zoomAtRef.current(z.x - r.left, z.y - r.top, view.current.k * z.f)
      })
    }
    el.addEventListener('wheel', wheel, { passive: false })
    // Android raises contextmenu for a hold, and a pinch whose second finger lands late is one: it would open the
    // action sheet over the stage and cancel the gesture. A finger on the stage opens no menu (S-705).
    const menu = (e: Event) => { if (touch.current) { e.preventDefault(); e.stopPropagation() } }
    el.addEventListener('contextmenu', menu, true)
    return () => { el.removeEventListener('wheel', wheel); el.removeEventListener('contextmenu', menu, true); cancelAnimationFrame(raf) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef<{ x: number; y: number; v: { x: number; y: number; k: number }; dist: number; moved: boolean } | null>(null)
  const suppress = useRef(false)
  // The last finger's tap, and what was selected before it: a double tap undoes the first tap's pick.
  const tap = useRef<{ t: number; x: number; y: number; sel: string | null } | null>(null)
  const touch = useRef(false)
  const [grab, setGrab] = useState(false)
  const start = () => {
    const ps = [...pointers.current.values()]
    const mid = ps.reduce((a, p) => ({ x: a.x + p.x / ps.length, y: a.y + p.y / ps.length }), { x: 0, y: 0 })
    const dist = ps.length > 1 ? Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y) : 0
    gesture.current = { ...mid, v: { ...view.current }, dist, moved: gesture.current?.moved ?? false }
  }
  const onDown = (e: React.PointerEvent) => {
    if ((e.pointerType === 'mouse' && e.button !== 0)) return
    touch.current = e.pointerType === 'touch'
    // A click that never came (a browser's own gesture took it) doesn't eat the next one.
    if (!pointers.current.size) suppress.current = false
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    start()
  }
  const onMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const g = gesture.current
    const ps = [...pointers.current.values()]
    const mid = ps.reduce((a, p) => ({ x: a.x + p.x / ps.length, y: a.y + p.y / ps.length }), { x: 0, y: 0 })
    if (!g.moved && Math.hypot(mid.x - g.x, mid.y - g.y) < DRAG_PX && ps.length < 2) return
    if (!g.moved) { g.moved = true; setGrab(true); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) }
    const r = stage.current!.getBoundingClientRect()
    let kk = g.v.k
    if (ps.length > 1 && g.dist) kk = Math.max(minZoom(), Math.min(ZOOM_MAX, g.v.k * Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y) / g.dist))
    // The point under the gesture's start stays under its middle.
    const ox = g.x - r.left, oy = g.y - r.top
    view.current = wholeAtLeast({ k: kk, x: mid.x - r.left - (ox - g.v.x) * (kk / g.v.k), y: mid.y - r.top - (oy - g.v.y) * (kk / g.v.k) })
    touched.current = true
    applyNow()
  }
  const onUp = (e: React.PointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return
    const moved = !!gesture.current?.moved
    if (moved) suppress.current = true
    if (pointers.current.size) start()
    else { gesture.current = null; setGrab(false) }
    if (e.pointerType !== 'touch' || pointers.current.size || e.type !== 'pointerup') return
    const last = tap.current
    if (moved) tap.current = null
    else if (last && e.timeStamp - last.t < TAP_MS && Math.hypot(e.clientX - last.x, e.clientY - last.y) < TAP_PX) {
      tap.current = null
      suppress.current = true
      setSel(last.sel)
      const r = stage.current!.getBoundingClientRect()
      // At the most zoom, a double tap goes back to the fit.
      if (view.current.k >= ZOOM_MAX - 1e-3) flushSync(fit)
      else zoomAt(e.clientX - r.left, e.clientY - r.top, view.current.k * ZOOM_TAP)
    } else tap.current = { t: e.timeStamp, x: e.clientX, y: e.clientY, sel }
  }

  // Clicks: a fold control folds, a stack opens the inbox, a card opens its panel; double-click
  // goes to the agent's world.
  const click = (e: React.MouseEvent) => {
    if (suppress.current) { suppress.current = false; return }
    const t = e.target as HTMLElement
    const fold = t.closest<HTMLElement>('[data-fold]')
    if (fold) return toggleFold(fold.dataset.fold!)
    const sheet = t.closest<HTMLElement>('[data-thread]')
    if (sheet) return selectThread(sheet.dataset.thread)
    const inbox = t.closest<HTMLElement>('[data-inbox]')
    if (inbox) return inbox.dataset.inbox === HUMAN ? openHumanInbox() : openInbox(inbox.dataset.inbox!)
    const card = t.closest<HTMLElement>('[data-card]')
    setSel(card ? (card.dataset.card === sel ? null : card.dataset.card!) : null)
  }
  const dbl = (e: React.MouseEvent) => {
    // A finger's double tap zooms (onUp); the agent's world is a button in its sheet.
    if (touch.current) return
    const card = (e.target as HTMLElement).closest<HTMLElement>('[data-card]')
    if (card && card.dataset.card !== HUMAN) selectAgent(card.dataset.card!)
  }
  // Enter on a card's name button clicks it; Escape closes the panel, then leaves the focus.
  const key = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return
    if (sel) setSel(null)
    else if (focus) leaveFocus()
  }
  // The focus also leaves on Escape pressed outside the view's own controls (nothing focused).
  useEffect(() => {
    if (!focus || !shown) return
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && document.activeElement === document.body) leaveFocus() }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [focus, shown]) // eslint-disable-line react-hooks/exhaustive-deps
  // Find: every agent by name and the ITSAs it owns, in the tree's order.
  const findable = useMemo((): Findable[] => {
    const agentsBy = new Map(d.agents.map((a) => [a.id, a]))
    const owns = new Map<string, { key: string; title: string }[]>()
    for (const it of d.itsas) if (it.owner && statusOf(it.status).category !== 'closed') owns.set(it.owner, [...(owns.get(it.owner) ?? []), { key: it.key, title: it.title }])
    return nodes.filter((n) => agentsBy.has(n.id)).map((n) => ({ id: n.id, name: agentsBy.get(n.id)!.name, itsas: owns.get(n.id) ?? [] }))
  }, [nodes, d.agents, d.itsas, statusOf])
  const find = useFind(findable, (id) => { const refold = reveal(id); setSel(id); zoomTo([id], 1, refold) })
  useEffect(() => { if (sel && !models.has(sel)) setSel(null) }, [models, sel])

  const ctx: CellContext = { now: Date.now(), extras }
  // The cards in a stable order: the order they were last drawn in, then new ones, so React
  // never moves a DOM node mid-motion; AnimatePresence keeps a leaving card in its place.
  const cards: ReactNode[] = []
  const starDims = useMemo(() => (px ? { orbMax: px.orbMax, stackOver: px.stackOver } : null), [px])
  const cardFar: Far = flat ? 'flat' : far ? 'chip' : ''
  if (laid) {
    const was = tr.order.filter((id) => laid.pos.has(id))
    const seen = new Set(was)
    const order = [...was, ...[...laid.pos.keys()].filter((id) => !seen.has(id))]
    tr.order = order
    for (const id of order) {
      if (!mounted?.has(id) && id !== sel) continue
      const p = laid.pos.get(id)!
      const m = models.get(id)
      // Stars draws each card as an orb (StarCard), keyed apart so a mode change mounts afresh.
      if (m) cards.push(shape === 'stars'
        ? <StarCard key={'*' + id} m={m} sig={sigOf(m)} place={{ x: p.x, y: p.y, w: p.w }} selected={sel === id} enter={tr.entering.get(id) ?? null} jump={tr.jump} dims={starDims!} />
        : <SystemCard key={id} m={m} sig={sigOf(m)} place={{ x: p.x, y: p.y, w: p.w }} selected={sel === id} enter={tr.entering.get(id) ?? null} jump={tr.jump} far={cardFar} />)
    }
  }
  const selModel = sel ? models.get(sel) ?? null : null
  return (
    <MotionConfig reducedMotion="user"><TimingContext.Provider value={timing}>
    <div className={'sv' + (narrow ? ' narrow' : '') + (selModel ? ' has-panel' : '')} data-mode={shape} data-focus={focus ?? undefined} data-moving={moving || undefined} onKeyDown={key}>
      <i ref={probe} className="sv-probe" aria-hidden="true" />
      <Header narrow={narrow} onFit={fit} usage={usage} mode={mode} onMode={setMode} find={find} focus={focus ? models.get(focus)?.agent?.name ?? null : null} onLeaveFocus={leaveFocus} />
      <div className="sv-body">
        <div ref={stage} className={'sv-stage' + (grab ? ' grab' : '') + (far ? ' far' : '')} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
          onClick={click} onDoubleClick={dbl} aria-label="Agent tree">
          {!d.loaded.agents ? null : <div ref={world} className="sv-world" data-laid={laid?.pos.size} data-cols={laid?.cols} style={laid ? { width: laid.width, height: laid.height } : undefined}>
            {laid ? <svg key={shape + nodesSig + [...folded].join()} className="sv-wires" width={laid.width} height={laid.height} aria-hidden="true">
              {/* The orbits' guides, faint, under the wires. */}
              {laid.hub && laid.orbits ? laid.orbits.map((o, i) => <ellipse key={'o' + i} className="sv-orbit" cx={laid.hub!.x} cy={laid.hub!.y} rx={o.rx} ry={o.ry} />) : null}
              {laid.wires.map((w) => <path key={w.id} className={'sv-wire ' + w.kind} d={w.d} data-child={w.id} />)}</svg> : null}
            <svg ref={trails} className="sv-trails" width={laid?.width ?? 0} height={laid?.height ?? 0} aria-hidden="true" />
            {/* A card's presence moves nothing around it: without this, each render (every cull
                change while zooming) gives every card a new presence context and re-renders it (S-671). */}
            <AnimatePresence initial={false} custom={exit} presenceAffectsLayout={false}>{cards}</AnimatePresence>
            <div ref={flights} className="sv-flights" />
          </div>}
        </div>
        {narrow ? <span className="sv-zoom" role="group" aria-label="Zoom">
          <button type="button" className="btn" aria-label="Zoom in" title="Zoom in" onClick={() => zoomBy(ZOOM_STEP)}><Icon name="plus" /></button>
          <button type="button" className="btn" aria-label="Zoom out" title="Zoom out" onClick={() => zoomBy(1 / ZOOM_STEP)}><Icon name="minus" /></button>
        </span> : null}
        <FindDrop f={find} narrow={narrow} />
        {selModel ? <Panel m={selModel} cols={cols} fields={fields} ctx={ctx} narrow={narrow} onClose={() => setSel(null)}
          onFocus={selModel.agent && nodes.some((n) => n.parent === selModel.id) && focus !== selModel.id ? () => focusOn(selModel.id) : undefined} /> : null}
      </div>
    </div>
    </TimingContext.Provider></MotionConfig>
  )
}

// The status a done sheet carries: the closed category's first, as the header's "done today" reads it.
const doneOf = (statuses: ItsaStatus[]) => statuses.find((s) => s.category === 'closed')?.name ?? 'done'
const whole = (v: number) => String(Math.round(v))
const pct = (v: number) => Math.round(v) + '%'

function openHumanInbox() {
  if (shell.isPhone()) openMail()
  else shell.open('main', 'mail:human')
}

// The header's instruments. The phone keeps the agent counts and the day's spend, with the switch,
// Fit and Find on a row of their own under them, a finger's size (S-606).
function Header({ narrow, onFit, usage, mode, onMode, find, focus, onLeaveFocus }: { narrow: boolean; onFit: () => void; usage: ReturnType<typeof useSystemUsage>; mode: Mode; onMode: (m: Mode) => void; find: Find; focus: string | null; onLeaveFocus: () => void }) {
  const d = useData()
  const s = stateCounts(d.agents)
  const ic = itsaCounts(d.itsas, d.itsaStatuses)
  const firstOf = (c: string, or: string) => d.itsaStatuses.find((x) => x.category === c)?.name ?? or
  const ms = meters(usage)
  const days = (usage?.by_day ?? []).slice(-14)
  const spark = sparkPath(days, 72, 20)
  const modes = <span className="seg sv-modes" role="group" aria-label="Layout">
    {MODES.map((m) => <button key={m.id} type="button" className={m.id === mode ? 'on' : ''} aria-pressed={m.id === mode} disabled={!m.layout}
      title={m.title} onClick={() => onMode(m.id)}>{m.label}</button>)}
  </span>
  const fitBtn = <button type="button" className="btn text sv-fit" onClick={onFit} title="Fit the whole system"><Icon name="scan" />Fit</button>
  return (
    <header className={'sv-head' + (!narrow && find.open ? ' finding' : '')}>
      <h2>System</h2>
      <span className="sv-grp" title={STATES.filter((x) => s.by[x]).map((x) => `${s.by[x]} ${x}`).join(', ')}>
        <b><Roll value={s.total} fmt={whole} /></b>{s.total === 1 ? 'agent' : 'agents'}
        {STATES.filter((x) => s.by[x]).map((x) => <span key={x} className="sv-st"><span className="dot" style={{ background: `var(--st-${x})` }} aria-hidden="true" /><Roll value={s.by[x]} fmt={whole} /></span>)}
      </span>
      {!narrow ? <>
        <span className="sv-sep sv-itsas" />
        <span className="sv-grp sv-itsas" title="ITSAs active, in review, and done today">
          <span className="sv-st"><StatusGlyph status={firstOf('active', 'in_progress')} title="Active" /><b><Roll value={ic.active} fmt={whole} /></b>active</span>
          <span className="sv-st"><StatusGlyph status={firstOf('review', 'in_review')} title="In review" /><b><Roll value={ic.review} fmt={whole} /></b>review</span>
          <span className="sv-st"><StatusGlyph status={firstOf('closed', 'done')} title="Done today" /><b><Roll value={ic.doneToday} fmt={whole} /></b>done today</span>
        </span>
        {ms.length ? <span className="sv-sep sv-meters" /> : null}
        {ms.map((m) => <span key={m.id} className={'sv-grp sv-meter' + (m.pct >= 80 ? ' warn' : '') + (m.minor ? ' minor' : '')} title={m.title}>
          <span className="sv-meter-lbl">{m.label}</span>
          {m.minor || !m.harness ? null : <span className="sv-meter-mark" role="img" aria-label={m.label} title={m.label}><HarnessMark harness={m.harness} /></span>}
          <span className="track" aria-hidden="true"><i style={{ transform: `scaleX(${Math.min(1, m.pct / 100)})` }} /></span><b><Roll value={m.pct} fmt={pct} /></b></span>)}
      </> : null}
      <span className="sv-sep" />
      <span className="sv-grp" title="Spend today, API-equivalent; the line is the last days">Today<b className="sv-spend">{usage ? <><Roll value={usage.today.cost_usd} fmt={money} /><Rise value={usage.today.cost_usd} fmt={money} /></> : '–'}</b>
        {!narrow && spark ? <svg className="sv-spark" viewBox="0 0 72 20" preserveAspectRatio="none" aria-hidden="true"><path d={spark} /></svg> : null}</span>
      <span className="spacer" />
      {focus ? <button type="button" className="sv-focus" onClick={onLeaveFocus} title="Show the whole tree (Esc)" aria-label={`Focused on ${focus}: show the whole tree`}>
        <span className="sv-focus-nm">{focus}</span><Icon name="x" size="xs" /></button> : null}
      {!narrow ? <span className="sv-keys">{find.open ? <FindBox f={find} autoFocus /> : <FindButton f={find} label />}{modes}{fitBtn}</span> : <span className="sv-tools">{modes}{fitBtn}<FindButton f={find} /></span>}
    </header>
  )
}

// The side panel (a bottom sheet on the phone): every shown Work column of the card's ITSA, the
// agent's own facts, and the links out.
function Panel({ m, cols, fields, ctx, narrow, onClose, onFocus }: { m: CardModel; cols: string[]; fields: Field[]; ctx: CellContext; narrow: boolean; onClose: () => void; onFocus?: () => void }) {
  const d = useData()
  const a = m.agent
  const it = m.it
  const ref = useRef<HTMLElement>(null)
  useEffect(() => { ref.current?.querySelector<HTMLElement>('.sv-close')?.focus({ preventScroll: true }) }, [m.id])
  // A sheet just opened by a tap lets a second tap through to the stage for a moment, so a double
  // tap on a card low on the screen zooms rather than landing on the sheet (S-606).
  const [fresh, setFresh] = useState(narrow)
  useEffect(() => {
    if (!narrow) return
    setFresh(true)
    const t = setTimeout(() => setFresh(false), TAP_MS)
    return () => clearTimeout(t)
  }, [m.id, narrow])
  const byCol = useMemo(() => new Map<string, WorkColumn>([...WORK_COLUMNS, ...fieldColumns(fields)].map((c) => [c.id, c])), [fields])
  const rows = it ? cols.filter((id) => id !== 'work').map((id) => byCol.get(id)).filter((c): c is WorkColumn => !!c) : []
  const thread = it?.thread_id
  const kids = d.agents.filter((x) => live(x) && (x.parents ?? []).includes(m.id)).length
  const own = a ? a.unread ?? 0 : d.unread
  return (
    <aside ref={ref} className={'sv-panel' + (narrow ? ' sheet' : '') + (narrow && fresh ? ' fresh' : '')} aria-label={a ? `${a.name} details` : 'Your details'} onKeyDown={(e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onClose() } }}>
      {narrow ? <div className="sv-grip" aria-hidden="true" /> : null}
      <div className="sv-ph">
        {a ? <Glyph agent={a} /> : <PlainGlyph name="user" />}
        <h3>{a?.name ?? 'You'}</h3>
        {a ? <span className="sv-mdl">{model(a).label}</span> : null}
        <button type="button" className="icon-btn sv-close" onClick={onClose} title="Close (Esc)" aria-label="Close the details"><Icon name="x" /></button>
      </div>
      {a ? <p className="sv-sub">{stateLabel(a)} · {activityOf(a)}</p> : <p className="sv-sub">Asks and results arrive here.</p>}
      <div className="sv-links">
        {a ? <button type="button" className="btn" onClick={() => selectAgent(a.id)}><Icon name="arrow-right" size="xs" />Open its world</button> : null}
        {onFocus ? <button type="button" className="btn" onClick={onFocus} title="Show only its team"><Icon name="network" size="xs" />Focus</button> : null}
        {a?.view ? <button type="button" className="btn" onClick={() => showView(a.id, 'conversation')}><Icon name="message-square" size="xs" />Conversation</button> : null}
        {a ? <button type="button" className="btn" onClick={() => showView(a.id, 'terminal')}><Icon name="terminal" size="xs" />Terminal</button> : null}
        {it ? <button type="button" className="btn" onClick={() => selectIssue(it.id)}><Icon name="list-checks" size="xs" />{it.key}</button> : null}
        {thread ? <button type="button" className="btn" onClick={() => selectThread(thread)}><Icon name="mail" size="xs" />{it!.key} thread</button> : null}
      </div>
      {it ? <section>
        <div className="eyebrow">ITSA</div>
        <button type="button" className="sv-itsa" onClick={() => selectIssue(it.id)} title={`Open ${it.key}`}>
          <StatusGlyph status={it.status} /><span className="sv-key">{it.key}</span><span>{it.title}</span></button>
        <table className="sv-facts"><tbody>
          {rows.map((c) => ({ c, v: cell(c, it, ctx) })).filter((x) => x.v != null).map(({ c, v }) => <tr key={c.id} data-col={c.id}><th scope="row">{c.label}</th><td>{v}</td></tr>)}
        </tbody></table>
        {m.owns > 1 ? <p className="muted sv-note">Owns {m.owns} open ITSAs; this is the one {waitsFirst(it)}.</p> : null}
      </section> : null}
      <section>
        <div className="eyebrow">{a ? 'Agent' : 'Inbox'}</div>
        <table className="sv-facts"><tbody>
          {/* Its own unread: a folded card's stack also counts its subtree's. */}
          <tr><th scope="row">Unread</th><td>{own ? <button type="button" className="sv-linkish" onClick={() => (a ? openInbox(a.id) : openHumanInbox())}>{own} unread</button> : <span className="muted">none</span>}</td></tr>
          {a ? <>
            <tr><th scope="row">State</th><td><span className="sv-state"><span className="dot" style={{ background: `var(--st-${STATE_COLOR[stateOf(a)] ?? 'off'})` }} />{stateLabel(a)}</span>{a.resting ? <> <RestBadge a={a} /></> : null}</td></tr>
            <tr><th scope="row">Context</th><td>{k(a.context_tokens)} of {k(d.thresholds.enforceTokens)}</td></tr>
            {a.cost ? <tr><th scope="row">Cost</th><td title={costTitle(a.cost, kids > 0)}>{money(a.cost.own.api ?? a.cost_usd ?? 0)}{kids ? <span className="muted"> · tree {money(a.cost.tree.api ?? 0)}</span> : null}</td></tr> : null}
            {kids ? <tr><th scope="row">Children</th><td>{kids}</td></tr> : null}
            <tr><th scope="row">Machine</th><td>{a.machine}</td></tr>
            {a.role ? <tr><th scope="row">Role</th><td className="sv-role">{a.role}</td></tr> : null}
          </> : null}
        </tbody></table>
      </section>
    </aside>
  )
}

const waitsFirst = (it: Itsa) => (statusInfo(it.status).human ? 'waiting on you' : 'shown on the card')
function cell(c: WorkColumn, it: Itsa, ctx: CellContext): ReactNode {
  if (c.id === 'status') return <span className="w-status" style={{ color: toneVar(it.status) }}><StatusGlyph status={it.status} />{statusLabel(it.status)}</span>
  // A column with nothing for this ITSA is left out of the panel; a link column draws a
  // component, so it is checked by the links it would show.
  if ((LINK_KINDS as string[]).includes(c.id) && !(it.links ?? []).some((l) => linkKind(l) === c.id)) return null
  return c.render({ it, depth: 0, context: false }, ctx) ?? null
}
