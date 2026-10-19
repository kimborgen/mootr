// Mail motion in the agents sidebar (S-699): a small envelope rides the tree's indent gutter from
// the sender's row to the recipient's row, landing on the unread badge, which stamps as the count
// arrives (sidebar-motion.tsx's Stamp). It is the sidebar's answer to the system view's mail
// sheets (system/flights.ts, system/deck.ts): an end with no row — or the human, who has no row,
// or a landing point the list doesn't show — becomes the list's own top or bottom edge, so the
// envelope enters or leaves clipped to the list; a burst between the same pair rides one flight
// with a count; at most FLIGHT_CAP fly at once. Every flight asks the S-696 gate at its start, so
// nothing moves while the tree scrolls, for a list that isn't on screen, under reduced motion, or
// with the kind off in Settings › Motion. It moves by `transform` and `opacity` alone, on the
// tokens the sidebar's hidden probe carries, and Motion writes them frame by frame, so React never
// renders per frame.
import { useEffect, useRef, useState, type RefObject } from 'react'
import { animate } from 'motion/react'
import { Icon } from './Icon'
import { canAnimate, isVisible } from './motion-gate'
import { type End, edgeEnd, edgeOf, FLIGHT_CAP, flyMs, flyPose, gutterRoute, inList, overFor, plan, railX } from './sidebar-flights'
import { onMailEvent } from './store'
import { type Bezier, parseBezier, readTiming, tokenMs } from './system/springs'
import { type Route, routeAt } from './system/flights'

// The human: not an agent row, so their end of a flight is the top of the list (system/model.ts).
const HUMAN = 'human'
// How far in from a row's right edge a landing falls when the row has no unread badge at all.
const LAND_IN = 12

// The flight in the air: the route in the list's own coordinates, and how it is drawn.
interface Spec {
  key: string
  from: string
  to: string
  mails: string[]
  route: Route
  ms: number
  ease: Bezier | null
  over: number
  // It leaves by the list's edge (an end with no row, or a landing point the list doesn't show),
  // so it fades out as it goes.
  exits: boolean
}

// The flight's own tokens, read from the body where the root's tokens cascade. `tokenMs` reads
// through a throwaway probe, so nothing is written to a live element and the flying layer never
// carries an implicit `transition: all` (S-1023).
function flightTiming(): { ms: number; ease: Bezier | null } {
  const el = document.body
  return { ms: tokenMs(el, '--duration-flight'), ease: parseBezier(getComputedStyle(el).getPropertyValue('--ease-flight')) ?? readTiming(el).ease }
}

// An id as the inside of an attribute selector, quoted and escaped (CSS.escape is not everywhere).
const quoted = (id: string) => `"${id.replace(/["\\]/g, '\\$&')}"`

// The row an agent shows in. The tree shows an agent with several parents once per path, so the
// first row on screen wins; a row that exists but is scrolled out still says where the agent lies,
// which is the side a clipped flight enters or leaves by.
function rowOf(tree: HTMLElement, id: string): HTMLElement | null {
  const rows = [...tree.querySelectorAll<HTMLElement>(`.node[data-id=${quoted(id)}]`)]
  return rows.find((r) => isVisible(r)) ?? rows[0] ?? null
}

// A row's own rail: the indent line its children hang from, 2px left of its glyph.
const railOf = (row: HTMLElement) => railX(parseFloat(getComputedStyle(row).paddingLeft) || 0)
// A viewport point in the list's own coordinates, so a flight stays on its row as the list scrolls
// under it. The flight layer sits at the list's padding box, which is `clientLeft`/`clientTop`
// inside its box, and the layer itself scrolls with the content.
function pointIn(tree: HTMLElement, x: number, y: number): End {
  const base = tree.getBoundingClientRect()
  return { x: x - base.left - tree.clientLeft + tree.scrollLeft, y: y - base.top - tree.clientTop + tree.scrollTop }
}
const middleOf = (tree: HTMLElement, box: DOMRect): End => pointIn(tree, box.left + box.width / 2, box.top + box.height / 2)

// Where an envelope lands: the recipient's unread badge, in the list's own coordinates. A live row
// hides its badge while its count is 0 (`.node .meta .badge.empty`), so it is measured shown and
// put back: that is the slot the arriving count takes. A row with no badge at all lands at the end
// of its facts, so a flight still has a target.
function landEnd(tree: HTMLElement, row: HTMLElement, id: string): End {
  const badge = row.querySelector<HTMLElement>(`[data-inbox=${quoted(id)}]`)
  if (badge) {
    const was = badge.style.display
    const hidden = !badge.getBoundingClientRect().width
    if (hidden) badge.style.display = 'inline-flex'
    const at = middleOf(tree, badge.getBoundingClientRect())
    if (hidden) badge.style.display = was
    return at
  }
  const r = row.getBoundingClientRect()
  return pointIn(tree, r.right - LAND_IN, r.top + r.height / 2)
}

// The whole geometry of one flight: null when it cannot fly (no row at an end, or neither end
// inside the list). The list's own top edge is what the human rides to and from, and what a clipped
// end becomes, so nothing is drawn outside the list.
function place(tree: HTMLElement, from: string, to: string, key: string, mails: string[]): Spec | null {
  const fromRow = from === HUMAN ? null : rowOf(tree, from)
  const toRow = to === HUMAN ? null : rowOf(tree, to)
  if ((from !== HUMAN && !fromRow) || (to !== HUMAN && !toRow)) return null
  const railFrom = fromRow ? railOf(fromRow) : null
  const railTo = toRow ? railOf(toRow) : null
  const trunk = Math.min(railFrom ?? Infinity, railTo ?? Infinity)
  if (!Number.isFinite(trunk)) return null
  const top = tree.scrollTop
  const list = tree.clientHeight
  const human: End = { x: trunk, y: top }
  let a = fromRow ? { x: railFrom!, y: middleOf(tree, fromRow.getBoundingClientRect()).y } : human
  let b = toRow ? landEnd(tree, toRow, to) : human
  // An end whose point the list doesn't show is clipped to the edge it lies beyond, not seen: a
  // landing point below the fold would otherwise be aimed off screen with no fade (S-699 review).
  const seenFrom = inList(a.y, top, list)
  const seenTo = inList(b.y, top, list)
  if (!seenFrom && !seenTo) return null
  const exits = !toRow || !seenTo
  if (seenFrom && !seenTo) b = edgeEnd(edgeOf(b.y, a.y), trunk, top, list)
  else if (!seenFrom && seenTo) a = edgeEnd(edgeOf(a.y, b.y), trunk, top, list)
  const route = gutterRoute(a, b, trunk)
  const { ms, ease } = flightTiming()
  return { key, from, to, mails, route, ms: flyMs(route.len, ms, list), ease, over: overFor(route.len), exits }
}

// The mail in flight over the agent tree. `tree` is the tree element itself (`.tree`), which is the
// list's scroll container: the layer is drawn inside it, so a flight scrolls with the rows.
export function MailFlights({ tree }: { tree: RefObject<HTMLElement | null> }) {
  const layer = useRef<HTMLDivElement>(null)
  const [air, setAir] = useState<Spec[]>([])
  // The same flights, readable now: a mail event arrives outside a render, and a burst must
  // coalesce against what is in the air at that moment.
  const live = useRef<Spec[]>([])
  const runs = useRef(new Map<string, { stop: () => void }>())
  const seq = useRef(0)

  useEffect(() => () => {
    for (const run of runs.current.values()) run.stop()
    runs.current.clear()
    live.current = []
  }, [])

  useEffect(() => onMailEvent((e) => {
    const el = tree.current
    if (!el || e.type !== 'sent') return
    const found = plan({ id: e.id, from: e.from, to: e.to }, live.current, {
      end: (id) => id === HUMAN || !!rowOf(el, id),
      cap: FLIGHT_CAP,
      still: !canAnimate('mail', el),
    })
    const next = live.current.slice()
    let changed = false
    for (const j of found.join) {
      const i = next.findIndex((f) => f.key === j.key)
      if (i >= 0) { next[i] = { ...next[i], mails: [...next[i].mails, j.mail] }; changed = true }
    }
    for (const l of found.launch) {
      const spec = place(el, l.from, l.to, 'f' + ++seq.current, l.mails)
      if (spec) { next.push(spec); changed = true }
    }
    // Mail that landed (no route, or the gate off) needs nothing from here: its badge stamps when
    // the store's count arrives.
    if (!changed) return
    live.current = next
    setAir(next)
  }), [tree])

  const land = (key: string) => {
    runs.current.delete(key)
    live.current = live.current.filter((f) => f.key !== key)
    setAir(live.current)
  }

  // One envelope's flight: Motion runs the clock on the token duration and its curve, and the
  // route is read analytically for the transform and the opacity of each frame.
  const start = (el: HTMLSpanElement | null, s: Spec) => {
    if (!el || runs.current.has(s.key)) return
    const first = routeAt(s.route, 0)
    el.style.transform = `translate3d(${first.x.toFixed(1)}px, ${first.y.toFixed(1)}px, 0)`
    el.style.opacity = '0'
    runs.current.set(s.key, animate(0, 1, {
      duration: Math.max(1, s.ms) / 1000,
      ease: s.ease ?? 'easeOut',
      onUpdate: (t) => {
        const { u, o } = flyPose(t, s.over, s.exits)
        const p = routeAt(s.route, u)
        el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`
        el.style.opacity = String(Math.round(o * 100) / 100)
      },
      onComplete: () => land(s.key),
    }))
  }

  return (
    <div className="mail-flights" ref={layer} aria-hidden="true">
      {air.map((s) => (
        <span key={s.key} className="mail-fly" data-fly={s.key} data-from={s.from} data-to={s.to} data-exits={s.exits ? '1' : undefined} ref={(el) => { start(el, s) }}>
          <Icon name="mail" size="xs" />
          {s.mails.length > 1 ? <span className="n">{s.mails.length}</span> : null}
        </span>
      ))}
    </div>
  )
}
