// Mail flights on the system view (S-459), the pure part: the path a sheet flies, where on it
// the sheet is at a given moment, and which mail flies at all. A path is one cubic Bézier,
// evaluated analytically each frame (no offset-path, no getPointAtLength). Parent and child mail
// rides the wire's own curve; other mail flies a free arc, a parabola above the tree. Bursts coalesce: mail to a card that a sheet is already
// flying to rides that sheet as a count, and past the cap mail lands without flying.

// A cubic Bézier: start, two controls, end, as x and y pairs.
export type Bez = [number, number, number, number, number, number, number, number]
export interface Pt { x: number; y: number }

export function bezAt(b: Bez, t: number): Pt {
  const u = 1 - t
  const a = u * u * u, c = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t
  return { x: a * b[0] + c * b[2] + d * b[4] + e * b[6], y: a * b[1] + c * b[3] + d * b[5] + e * b[7] }
}
// The derivative: the direction of travel.
export function bezTangent(b: Bez, t: number): Pt {
  const u = 1 - t
  const a = 3 * u * u, c = 6 * u * t, d = 3 * t * t
  return {
    x: a * (b[2] - b[0]) + c * (b[4] - b[2]) + d * (b[6] - b[4]),
    y: a * (b[3] - b[1]) + c * (b[5] - b[3]) + d * (b[7] - b[5]),
  }
}
export const reverse = (b: Bez): Bez => [b[6], b[7], b[4], b[5], b[2], b[3], b[0], b[1]]
// Its length, along a polyline: once per flight, at launch.
export function bezLength(b: Bez, steps = 24): number {
  let len = 0, p = bezAt(b, 0)
  for (let i = 1; i <= steps; i++) { const q = bezAt(b, i / steps); len += Math.hypot(q.x - p.x, q.y - p.y); p = q }
  return len
}
// A free arc from a to b: a quadratic raised to a cubic, its apex above the higher end by a share
// of the distance, up to `lift`, but not above `top` (the tree's own top, so mail to the human
// stays in view).
export function freeArc(a: Pt, b: Pt, o: { lift: number; top?: number }): Bez {
  const dist = Math.hypot(b.x - a.x, b.y - a.y)
  // The arc's highest point, and the control that puts the quadratic's turn exactly there: the
  // root of q² − 2Yq + Y(a + b) − ab = 0 below Y.
  const Y = Math.min(Math.min(a.y, b.y), Math.max(o.top ?? -Infinity, Math.min(a.y, b.y) - Math.min(o.lift, dist * 0.25)))
  return quadToCubic(a, { x: (a.x + b.x) / 2, y: Y - Math.sqrt((Y - a.y) * (Y - b.y)) }, b)
}
export const quadToCubic = (a: Pt, q: Pt, b: Pt): Bez => {
  return [a.x, a.y, a.x + (2 / 3) * (q.x - a.x), a.y + (2 / 3) * (q.y - a.y), b.x + (2 / 3) * (q.x - b.x), b.y + (2 / 3) * (q.y - b.y), b.x, b.y]
}

// ---- Routes: a flight's whole path, from stack corner to stack corner ----

// A route is a chain of cubics, walked by length, so a sheet keeps its speed across the joins.
export interface Route { segs: Bez[]; lens: number[]; len: number }
export function route(segs: Bez[]): Route {
  const lens = segs.map((b) => bezLength(b))
  return { segs, lens, len: lens.reduce((a, b) => a + b, 0) }
}
// A route moved point by point, as when the camera moves under it (S-572): a map of the plane
// that keeps lines straight, as a pan and zoom does, maps a cubic by its control points.
export const mapRoute = (r: Route, map: (p: Pt) => Pt): Route => route(r.segs.map((b) => {
  const out = [] as number[]
  for (let i = 0; i < 8; i += 2) { const q = map({ x: b[i], y: b[i + 1] }); out.push(q.x, q.y) }
  return out as Bez
}))
export const reverseRoute = (r: Route): Route => ({ segs: r.segs.map(reverse).reverse(), lens: [...r.lens].reverse(), len: r.len })
// The point `u` of the way along (by length). Past the end (u > 1) it carries on along the end's
// tangent, so the landing can overshoot.
// Which way a sheet on a free arc tilts: toward where it lands, by the stack points it flies
// between, not the cards' corners, which a grown chip or Cards' outset stack moves apart (S-462).
// 1 leans right, -1 left; a straight drop leans right.
export const tiltSign = (r: Route): 1 | -1 => (routeAt(r, 1).x >= routeAt(r, 0).x ? 1 : -1)

export function routeAt(r: Route, u: number): Pt {
  const last = r.segs[r.segs.length - 1]
  if (u > 1) {
    const t = bezTangent(last, 1)
    const m = Math.hypot(t.x, t.y) || 1
    return { x: last[6] + (t.x / m) * (u - 1) * r.len, y: last[7] + (t.y / m) * (u - 1) * r.len }
  }
  let s = Math.max(0, u) * r.len
  for (let i = 0; i < r.segs.length; i++) {
    if (s <= r.lens[i] || i === r.segs.length - 1) return bezAt(r.segs[i], r.lens[i] ? Math.min(1, s / r.lens[i]) : 1)
    s -= r.lens[i]
  }
  return { x: last[6], y: last[7] }
}
// The route as an SVG path, for its trail.
export const routeD = (r: Route) => r.segs.map((b, i) => (i ? '' : `M${r1(b[0])} ${r1(b[1])}`) + `C${r1(b[2])} ${r1(b[3])} ${r1(b[4])} ${r1(b[5])} ${r1(b[6])} ${r1(b[7])}`).join('')
const r1 = (v: number) => Math.round(v * 10) / 10

export const line = (a: Pt, b: Pt): Bez => [a.x, a.y, a.x + (b.x - a.x) / 3, a.y + (b.y - a.y) / 3, a.x + (2 * (b.x - a.x)) / 3, a.y + (2 * (b.y - a.y)) / 3, b.x, b.y]
// A polyline with its corners rounded by up to `r`, as the wires' rails are.
export function rails(pts: Pt[], r: number): Bez[] {
  const p = pts.filter((q, i) => !i || q.x !== pts[i - 1].x || q.y !== pts[i - 1].y)
  const out: Bez[] = []
  let at = p[0]
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[i - 1], c = p[i], b = p[i + 1]
    const la = Math.hypot(c.x - a.x, c.y - a.y), lb = Math.hypot(b.x - c.x, b.y - c.y)
    const rr = Math.min(r, la / 2, lb / 2)
    const pin = { x: c.x - ((c.x - a.x) / la) * rr, y: c.y - ((c.y - a.y) / la) * rr }
    const pout = { x: c.x + ((b.x - c.x) / lb) * rr, y: c.y + ((b.y - c.y) / lb) * rr }
    if (pin.x !== at.x || pin.y !== at.y) out.push(line(at, pin))
    if (rr > 0) out.push(quadToCubic(pin, c, pout))
    at = pout
  }
  const end = p[p.length - 1]
  if (end.x !== at.x || end.y !== at.y || !out.length) out.push(line(at, end))
  return out
}
// A cubic leaving p in direction dp and arriving at q in direction dq (unit vectors), its
// controls `k` out along them.
const join = (p: Pt, dp: Pt, q: Pt, dq: Pt, k: number): Bez => [p.x, p.y, p.x + dp.x * k, p.y + dp.y * k, q.x - dq.x * k, q.y - dq.y * k, q.x, q.y]
const unit = (v: Pt): Pt => { const m = Math.hypot(v.x, v.y) || 1; return { x: v.x / m, y: v.y / m } }

export interface Card { x: number; y: number; w: number }
export interface RouteDims {
  // A card's height, how far in from its right edge its stack sits, the pad and the gap
  // between rows, and the round of a rail's corner.
  cardH: number
  landIn: number
  pad: number
  gap: number
  corner: number
  // A free arc's most lift, and the highest it may go.
  lift: number
  top: number
  // The Cards mode's hub (S-460): mail with no wire between its cards swings round it instead.
  hub?: Pt
  // How far a stack sits out past the card's top-right corner, up and to the right (Cards mode,
  // where cards are drawn small and the sheets at screen size).
  out?: number
}
// Where mail rests on a card: its stack, at the top-right corner. Every flight starts and ends
// here, so a resting sheet never covers the card's text.
export const stackSpot = (c: Card, d: Pick<RouteDims, 'landIn' | 'out'>): Pt => ({ x: c.x + c.w - d.landIn + (d.out ?? 0), y: c.y - (d.out ?? 0) })

// The stretch of a cubic between t0 and t1 (de Casteljau).
export function splitBez(b: Bez, t0: number, t1: number): Bez {
  const at = (bb: Bez, t: number): [Bez, Bez] => {
    const l = (a: number, c: number) => a + (c - a) * t
    const x01 = l(bb[0], bb[2]), y01 = l(bb[1], bb[3]), x12 = l(bb[2], bb[4]), y12 = l(bb[3], bb[5]), x23 = l(bb[4], bb[6]), y23 = l(bb[5], bb[7])
    const xa = l(x01, x12), ya = l(y01, y12), xb = l(x12, x23), yb = l(y12, y23)
    const x = l(xa, xb), y = l(ya, yb)
    return [[bb[0], bb[1], x01, y01, xa, ya, x, y], [x, y, xb, yb, x23, y23, bb[6], bb[7]]]
  }
  const right = at(b, t0)[1]
  return t1 >= 1 ? right : at(right, (t1 - t0) / (1 - t0))[0]
}
// Where a cubic whose y only grows reaches y.
export function tAtY(b: Bez, y: number): number {
  let lo = 0, hi = 1
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (bezAt(b, m).y < y) lo = m; else hi = m }
  return (lo + hi) / 2
}

// The route between two cards. `wire` is the parent-to-child wire when they are parent and child,
// with `down` true when the mail goes from the parent; null for any other two cards. Every route
// keeps to the gaps between cards: from the parent's stack down its right side to the gap under
// it, along that gap to the wire, along the wire, and along the gap above the child into its
// stack. A curve wire is ridden as it is drawn; a rail (a desktop column)
// becomes its trunk in the gutter, `gap` being the gap between its rows; a child right under its
// parent skips the trunk. Other mail flies a free arc. Mail up the tree takes the route backwards.
export function flightRoute(from: Card, to: Card, wire: { bez: Bez; down: boolean; kind: 'curve' | 'rail' | 'spoke' | 'ray' } | null, d: RouteDims): Route {
  const a = stackSpot(from, d), b = stackSpot(to, d)
  if (!wire) return route([d.hub ? swingArc(a, b, d.hub) : freeArc(a, b, { lift: d.lift, top: d.top })])
  const P = wire.down ? from : to, C = wire.down ? to : from
  const pS = wire.down ? a : b, cS = wire.down ? b : a
  const r = d.corner
  let down: Route
  if (wire.kind === 'ray') {
    // Off the parent's stack onto the ray where it leaves the parent's orb, along it, and off
    // where it meets the child's orb, into the child's stack.
    const w = wire.bez
    const F = { x: w[0], y: w[1] }, G = { x: w[6], y: w[7] }
    const k = (p: Pt, q: Pt) => Math.hypot(q.x - p.x, q.y - p.y) / 2
    down = route([
      join(pS, unit({ x: F.x - pS.x, y: F.y - pS.y }), F, unit(bezTangent(w, 0)), k(pS, F)),
      w,
      join(G, unit(bezTangent(w, 1)), cS, unit({ x: cS.x - G.x, y: cS.y - G.y }), k(G, cS)),
    ])
  } else if (wire.kind === 'spoke') {
    // Off the parent's stack onto the wire where it leaves the parent's card, along it, and off
    // where it meets the child's card, into the child's stack.
    const w = wire.bez
    // Cards that overlap (t2 before t1) leave a stretch of no length, at t1.
    const t1 = edgeT(w, P, d.cardH, true), t2 = Math.max(t1, edgeT(w, C, d.cardH, false))
    const F = bezAt(w, t1), G = bezAt(w, t2)
    const k = (p: Pt, q: Pt) => Math.hypot(q.x - p.x, q.y - p.y) / 2
    down = route([
      join(pS, unit({ x: F.x - pS.x, y: F.y - pS.y }), F, unit(bezTangent(w, t1)), k(pS, F)),
      splitBez(w, t1, t2),
      join(G, unit(bezTangent(w, t2)), cS, unit({ x: cS.x - G.x, y: cS.y - G.y }), k(G, cS)),
    ])
  } else if (wire.kind === 'rail') {
    const xr = Math.max(P.x + P.w, C.x + C.w) + d.pad / 2, below = P.y + d.cardH + d.gap / 2, turn = C.y - d.gap / 2, tx = wire.bez[0]
    const pts = turn <= below
      ? [pS, { x: xr, y: pS.y }, { x: xr, y: below }, { x: cS.x, y: below }, cS]
      : [pS, { x: xr, y: pS.y }, { x: xr, y: below }, { x: tx, y: below }, { x: tx, y: turn }, { x: cS.x, y: turn }, cS]
    down = route(rails(pts, r))
  } else {
    const w = wire.bez
    const xr = P.x + P.w + d.pad / 2, yb = P.y + d.cardH + 2 * r, ya = C.y - 2 * r
    const t1 = tAtY(w, yb + r), t2 = tAtY(w, ya - r)
    const F = bezAt(w, t1), G = bezAt(w, t2)
    const e1 = { x: F.x + r, y: yb }, e2 = { x: G.x + r, y: ya }
    down = route([
      ...rails([pS, { x: xr, y: pS.y }, { x: xr, y: yb }, e1], r),
      join(e1, { x: -1, y: 0 }, F, unit(bezTangent(w, t1)), r),
      splitBez(w, t1, t2),
      join(G, unit(bezTangent(w, t2)), e2, { x: 1, y: 0 }, r),
      ...rails([e2, { x: cS.x, y: ya }, cS], r),
    ])
  }
  return wire.down ? down : reverseRoute(down)
}

// Where a wire crosses a card's edge: leaving it (`out`, the wire starting inside), or entering it
// (the wire ending inside), by bisection, the wire crossing the edge once.
export function edgeT(w: Bez, c: Card, h: number, out: boolean): number {
  const inside = (t: number) => { const p = bezAt(w, t); return p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + h }
  let lo = 0, hi = 1
  for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (inside(m) === out) lo = m; else hi = m }
  return (lo + hi) / 2
}
// Mail between two cards with no wire between them on the orbits (S-460): a quadratic whose
// control is pulled toward the hub, all the way for cards on opposite sides, so mail between
// teams swings through the middle, and less for neighbours, which it joins by a gentle arc.
export function swingArc(a: Pt, b: Pt, hub: Pt): Bez {
  const va = { x: a.x - hub.x, y: a.y - hub.y }, vb = { x: b.x - hub.x, y: b.y - hub.y }
  const cos = (va.x * vb.x + va.y * vb.y) / ((Math.hypot(va.x, va.y) * Math.hypot(vb.x, vb.y)) || 1)
  const f = SWING_IN + (SWING_OUT - SWING_IN) * Math.max(0, cos)
  return quadToCubic(a, { x: hub.x + ((a.x + b.x) / 2 - hub.x) * f, y: hub.y + ((a.y + b.y) / 2 - hub.y) * f }, b)
}
// How far a swing's control sits from the hub, as a share of the chord's middle: for cards on
// opposite sides, and for cards side by side.
export const SWING_IN = 0.1
export const SWING_OUT = 0.75

// The flight's duration: the longest hop takes `max` (--duration-flight), shorter hops scale
// down to `min`; `ref` is the distance that counts as the longest.
export const flightMs = (len: number, min: number, max: number, ref: number) => Math.round(min + (max - min) * Math.min(1, Math.max(0, len / ref)))

const easeOut = (t: number) => 1 - (1 - t) ** 3
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
// The phases of a flight, as shares of its time: a lift at launch, the travel, and the settle
// after the overshoot.
export const LIFT_END = 0.14
export const SETTLE_FROM = 0.84
// Where the sheet is at time share t (0 to 1): `u`, how far along the path (past 1 while it
// overshoots), and `lift`, 0 to 1, how lifted it is (drawn bigger, toward the viewer, in place,
// so it never rises into the card above). It lifts first (anticipation), travels lifted, runs
// `over` past the end, and settles back onto it as it lowers.
export function pose(t: number, over: number): { u: number; lift: number } {
  t = Math.min(1, Math.max(0, t))
  if (t < LIFT_END) return { u: 0, lift: easeOut(t / LIFT_END) }
  if (t < SETTLE_FROM) return { u: easeInOut((t - LIFT_END) / (SETTLE_FROM - LIFT_END)) * (1 + over), lift: 1 }
  const s = easeOut((t - SETTLE_FROM) / (1 - SETTLE_FROM))
  return { u: 1 + over * (1 - s), lift: 1 - s }
}
// The overshoot as a share of the path: about half a sheet's height, and never more than the bounce
// limit allows (0.2 of the landing's last fifth: 4% of the path).
export const overshoot = (len: number, px: number) => (len > 0 ? Math.min(0.04, px / 2 / len) : 0)

// ---- Which mail flies ----

// A mail as the stream reports it.
export interface MailIn { id: string; from: string; to: string[]; ask: boolean; thread: string | null }
// A flight in the air: its card ends, the mail it carries, when it left.
export interface Air { key: string; from: string; to: string; mails: string[]; t0: number }
export interface Plan {
  // New flights: from and to are the cards shown.
  launch: { from: string; to: string; mails: string[]; warn: boolean; thread: string | null }[]
  // Mail that joins a flight already in the air, by its key; `warn` turns the sheet the warning hue.
  join: { key: string; mail: string; warn: boolean }[]
  // Mail that lands at once: no sender card, a sender that is its own recipient's card, past the
  // cap, or reduced motion.
  land: { to: string; mail: string; warn: boolean }[]
}
export interface PlanOpts {
  // The card a mail to or from this id shows on: the agent's own, or its nearest shown ancestor
  // when it is folded away; null when it has no card.
  shown: (id: string) => string | null
  now: number
  // At most this many sheets in the air, counting `flying` (all the deck's, when `air` is only the
  // ones this mail may join; air's own length otherwise).
  cap: number
  flying?: number
  // Mail to a card that a sheet from another sender left for within this many ms joins it.
  burst: number
  still: boolean
  human: string
}
export function plan(m: MailIn, air: readonly Air[], o: PlanOpts): Plan {
  const out: Plan = { launch: [], join: [], land: [] }
  const warn = (to: string) => m.ask || to === o.human
  const from = o.shown(m.from)
  let flying = o.flying ?? air.length
  for (const r of new Set(m.to)) {
    const to = o.shown(r)
    if (!to) continue
    if (o.still || !from || from === to) { out.land.push({ to, mail: m.id, warn: warn(r) }); continue }
    // The same pair, while in the air; or any sender, if its sheet has only just left.
    const same = air.find((f) => f.to === to && (f.from === from || o.now - f.t0 < o.burst)) ?? out.launch.find((f) => f.to === to && f.from === from)
    if (same) {
      if ('key' in same) out.join.push({ key: same.key, mail: m.id, warn: warn(r) })
      else { same.mails.push(m.id); same.warn ||= warn(r) }
      continue
    }
    if (flying >= o.cap) { out.land.push({ to, mail: m.id, warn: warn(r) }); continue }
    out.launch.push({ from, to, mails: [m.id], warn: warn(r), thread: m.thread })
    flying++
  }
  return out
}

// The card shown for an id: itself when laid out, or its nearest laid-out ancestor.
export function shownCard(id: string, laid: { has(id: string): boolean }, parentOf: (id: string) => string | null): string | null {
  for (let x: string | null = id, i = 0; x && i < 64; x = parentOf(x), i++) if (laid.has(x)) return x
  return null
}

// What a card's stack shows while sheets fly to it: the count from before the first one left,
// so the stack grows when the mail lands, not when it was sent; a read still shrinks it.
export const stackCount = (base: number, held: number | undefined) => (held === undefined ? base : Math.min(base, held))
