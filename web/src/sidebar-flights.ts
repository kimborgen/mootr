// Mail motion in the agents sidebar (S-699): the pure part, so the route, the clipping, the
// coalescing and the cap are testable without a browser. A mail between two rows of the tree
// flies one small envelope along the indent gutter from the sender's row to the recipient's
// unread badge. An end with no row on screen — including the human, who has no row at all —
// becomes the list's own top or bottom edge, so the envelope enters or leaves clipped to the
// list. Mail that cannot fly (no row at either end, an agent mailing itself, past the cap, or
// the gate saying no) lands at once: the badge stamps from the store either way.
import { type Pt, flightMs, overshoot, pose, rails, route, type Route } from './system/flights'

// At most this many envelopes in the air; past it, mail lands without flying (S-699).
export const FLIGHT_CAP = 6
// How far the gutter route's corners round.
export const CORNER = 6
// The share of a flight the envelope fades in over, and out over when it leaves at the list's edge.
export const FADE_IN = 0.14
export const FADE_OUT = 0.22

// A point in the list's own coordinates (content px), so a flight scrolls with the rows.
export type End = Pt

// A row's rail: the indent line its own children hang from, just left of the row's glyph. The
// envelope rides the rails, so it travels in the gutter and never crosses a row's text on its way
// down the list. `paddingLeft` is the row's own indent (8 px plus 14 per level); a root row has no
// rail of its own, so it uses the list's own leading gutter, which keeps the envelope's 14 px
// inside the list.
export const railX = (paddingLeft: number) => Math.max(8, paddingLeft - 2)

// The route from one end to another along the gutter: across to the trunk, along it, and into the
// landing point, its corners rounded. The trunk is the leftmost of the two rails.
export function gutterRoute(from: End, to: End, trunk: number): Route {
  return route(rails([from, { x: trunk, y: from.y }, { x: trunk, y: to.y }, to], CORNER))
}

// Whether an end lies inside the band the list shows: a landing point below the fold is clipped to
// the list's edge rather than aimed off screen (S-699 review).
export const inList = (y: number, top: number, height: number) => y >= top && y <= top + height

// Which side of the list a flight leaves or enters by, when only one end is on screen: the side
// the end with no row lies beyond.
export const edgeOf = (hidden: number, shown: number): 'top' | 'bottom' => (hidden < shown ? 'top' : 'bottom')

// The point a clipped end becomes: the list's own top or bottom edge, in the list's coordinates,
// so the envelope enters or leaves where the reader can see it rather than reaching off screen.
export const edgeEnd = (edge: 'top' | 'bottom', trunk: number, top: number, height: number): End =>
  ({ x: trunk, y: edge === 'top' ? top : top + height })

// The flight's length: the longest hop across the list takes `max` (--duration-flight) and a
// shorter one scales down to 5/11 of it, as the system view's flights do.
export const flyMs = (len: number, max: number, list: number) => flightMs(len, (max * 5) / 11, max, Math.max(1, Math.min(list, 900)))

// How far a flight runs past its landing before settling back: about half an envelope, never more
// than the bounce limit allows. The last leg is horizontal, so it overshoots along the row.
export const overFor = (len: number) => overshoot(len, 8)

// Where the envelope is at the time share `t` of its flight: `u`, how far along the route it is
// (past 1 while it overshoots), and `o`, the opacity to draw it at. A flight that leaves at the
// list's edge fades out as it goes; every flight fades in as it starts.
export function flyPose(t: number, over: number, exits: boolean): { u: number; o: number } {
  const ramp = (x: number) => Math.min(1, Math.max(0, x))
  const out = exits ? ramp((1 - t) / FADE_OUT) : 1
  return { u: pose(t, over).u, o: Math.min(ramp(t / FADE_IN), out) }
}

// ---- Which mail flies ----

// A mail as the live stream reports it (store.ts's MailEvent).
export interface MailIn { id: string; from: string; to: string[] }
// A flight in the air: the two rows it flies between, and the mail it carries.
export interface Air { key: string; from: string; to: string; mails: string[] }
export interface Plan {
  // New flights, one per recipient row.
  launch: { from: string; to: string; mails: string[] }[]
  // Mail that rides a flight already in the air, by its key.
  join: { key: string; mail: string }[]
  // Mail that lands at once, with no flight of its own.
  land: { to: string; mail: string }[]
}
export interface PlanOpts {
  // Whether an id can be an end at all: a row in the tree, or the human (the list's top edge).
  end: (id: string) => boolean
  // At most this many envelopes in the air.
  cap: number
  // The gate said no (the tree is scrolling, reduced motion, or the kind is off): nothing flies.
  still: boolean
}

// Plans one mail against the flights already in the air: a burst between the same pair rides the
// flight it finds rather than starting a second, and past the cap the rest land at once.
export function plan(m: MailIn, air: readonly Air[], o: PlanOpts): Plan {
  const out: Plan = { launch: [], join: [], land: [] }
  let flying = air.length
  const from = o.end(m.from) ? m.from : null
  for (const r of new Set(m.to)) {
    if (o.still || !from || !o.end(r) || from === r) { out.land.push({ to: r, mail: m.id }); continue }
    const inAir = air.find((f) => f.from === from && f.to === r)
    const pending = out.launch.find((f) => f.from === from && f.to === r)
    if (inAir) { out.join.push({ key: inAir.key, mail: m.id }); continue }
    if (pending) { pending.mails.push(m.id); continue }
    if (flying >= o.cap) { out.land.push({ to: r, mail: m.id }); continue }
    out.launch.push({ from, to: r, mails: [m.id] })
    flying++
  }
  return out
}
