// The system view's Stars mode (S-539), pure so it tests without a browser: the agents as orbs on
// rings around the chief of staff, each orb sized by its spend. The tree is turned inside out
// around the centre: the centre's parent (the human) joins its children on the first ring, and
// each node's children sit on the next ring out, in the wedge its subtree's leaves earn. Every
// orb then takes the first place out along its angle where its footprint (the orb and its two
// label lines under it) touches no other, so crowded neighbours step out by turns. It depends only
// on the tree: the same tree always lands in the same place, and nothing drifts or simulates.
import { type Bez, splitBez } from './flights'
import { build, type Laid, type Pos, type TreeIn, type Wire } from './layout'

export interface StarDims {
  // An orb's least and largest radius, and the human's.
  rMin: number
  rMax: number
  rHuman: number
  // The label block under an orb: its width (names ellipsize to it), height, and gap to the orb.
  labelW: number
  labelH: number
  labelGap: number
  // The least clear space between two footprints, and around the whole layout.
  gap: number
  pad: number
  // The rings' ellipse, across and down (STRETCH unless given): a phone's tall pane wants them tall.
  stretch?: { x: number; y: number }
}
// An orb: its centre, radius, ring (0 for the centre), and angle and distance out on its ring, before
// the ring is stretched to its ellipse.
export interface Star { cx: number; cy: number; r: number; ring: number; angle: number; rho: number }
// The layout as the deck reads any layout (`pos` is each orb's square, `wires` the links between
// orbs), plus the orbs themselves, the rings' radii, and the centre.
export interface StarLaid extends Laid { stars: Map<string, Star>; rings: number[]; cx: number; cy: number }
// A node with its spend in dollars, which sizes its orb.
export type StarIn = TreeIn & { cost?: number }

// An orb's radius from its spend: area for dollars, so the radius follows the square root of the
// spend over the largest, clamped to the dims' range.
export function orbRadius(cost: number, maxCost: number, d: Pick<StarDims, 'rMin' | 'rMax'>): number {
  if (!(maxCost > 0) || !(cost > 0)) return d.rMin
  return Math.max(d.rMin, Math.min(d.rMax, d.rMax * Math.sqrt(cost / maxCost)))
}

// A footprint: the box an orb and its labels cover, centred on the orb horizontally.
export interface Box { x0: number; y0: number; x1: number; y1: number }
export function footprint(s: Pick<Star, 'cx' | 'cy' | 'r'>, d: StarDims): Box {
  const w = Math.max(2 * s.r, d.labelW) / 2
  return { x0: s.cx - w, y0: s.cy - s.r, x1: s.cx + w, y1: s.cy + s.r + d.labelGap + d.labelH }
}
// The room an orb is given: the footprint of the largest orb, so a spend that grows an orb never
// moves it or any other.
const slot = (s: Pick<Star, 'cx' | 'cy'>, d: StarDims) => footprint({ cx: s.cx, cy: s.cy, r: d.rMax }, d)
export const touches = (a: Box, b: Box, gap: number) => a.x0 < b.x1 + gap && b.x0 < a.x1 + gap && a.y0 < b.y1 + gap && b.y0 < a.y1 + gap

// How far out an orb looks for a free place at a time, in px.
const STEP_PX = 2
// The rings are ellipses, wider than tall: a desktop stage is wide, and so is a label, so orbs on
// the top and bottom of a ring, which sit side by side, get the most room.
export const STRETCH = { x: 1.3, y: 0.8 }
// The phone's: taller than wide, as its pane is (S-606).
export const TALL = { x: 0.8, y: 1.3 }
const onEllipse = (s: { x: number; y: number }) => (a: number, rho: number) => ({ x: Math.cos(a) * rho * s.x, y: Math.sin(a) * rho * s.y })

// `center`: the node at the middle, the first child of the root (the first chief of staff) unless
// given. Each node's `cost` sizes its orb; the root (the human) takes rHuman.
export function starsLayout(nodes: StarIn[], dims: StarDims, folded: ReadonlySet<string> = new Set(), center?: string): StarLaid {
  const stretch = dims.stretch ?? STRETCH, at = onEllipse(stretch)
  const cost = new Map(nodes.map((n) => [n.id, n.cost ?? 0]))
  const root = build(nodes, folded)
  const kidsOf = new Map<string, string[]>()
  const parentOf = new Map<string, string | null>()
  root.each((n) => { kidsOf.set(n.id!, (n.children ?? []).map((k) => k.id!)); parentOf.set(n.id!, n.parent?.id ?? null) })
  const mid = center && kidsOf.has(center) ? center : kidsOf.get(root.id!)![0] ?? root.id!
  // The tree turned around the centre: each node's neighbours away from it, its parent first.
  const out = new Map<string, string[]>()
  const ring = new Map<string, number>([[mid, 0]])
  const up = new Map<string, string>()
  const queue = [mid]
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]
    const p = parentOf.get(id) ?? null
    const next = [...(p !== null ? [p] : []), ...kidsOf.get(id)!].filter((x) => !ring.has(x))
    out.set(id, next)
    for (const x of next) { ring.set(x, ring.get(id)! + 1); up.set(x, id); queue.push(x) }
  }
  // A node's weight is the share of its parent's wedge it takes: its subtree's leaves, each leaf
  // counting more the nearer it sits to the centre, since an inner ring has less arc to give.
  const depth = Math.max(0, ...ring.values())
  const weight = new Map<string, number>()
  for (const id of [...queue].reverse()) {
    const ks = out.get(id)!
    weight.set(id, ks.length ? ks.reduce((s, k) => s + weight.get(k)!, 0) : depth / Math.max(1, ring.get(id)!))
  }
  // Wedges: the centre's first neighbour (the human, when there is one) straight up.
  const angle = new Map<string, number>([[mid, 0]])
  const wedge = (id: string, a0: number, a1: number) => {
    const ks = out.get(id)!
    const total = ks.reduce((s, k) => s + weight.get(k)!, 0)
    let a = a0
    for (const k of ks) {
      const w = ((a1 - a0) * weight.get(k)!) / total
      angle.set(k, a + w / 2)
      wedge(k, a, a + w)
      a += w
    }
  }
  const first = out.get(mid)![0]
  const start = -Math.PI / 2 - (first ? (Math.PI * weight.get(first)!) / weight.get(mid)! : 0)
  wedge(mid, start, start + 2 * Math.PI)

  const maxCost = Math.max(0, ...queue.filter((id) => id !== root.id).map((id) => cost.get(id) ?? 0))
  const rOf = (id: string) => (id === root.id ? dims.rHuman : orbRadius(cost.get(id) ?? 0, maxCost, dims))
  const radius = new Map(queue.map((id) => [id, rOf(id)]))
  // A footprint's size, as the space each orb needs around it on its ring.
  const fw = Math.max(2 * dims.rMax, dims.labelW) + dims.gap
  const fh = 2 * dims.rMax + dims.labelGap + dims.labelH + dims.gap
  // Each ring's orbs by angle.
  const onRing: string[][] = Array.from({ length: depth + 1 }, () => [])
  for (const id of queue) onRing[ring.get(id)!].push(id)
  for (const ids of onRing) ids.sort((x, y) => angle.get(x)! - angle.get(y)!)
  // The first ring is a circle a footprint out from the centre, wide enough that its orbs, spread
  // round it, sit a footprint apart; each moves the least from where its wedge put it, so a small
  // orb beside a big team isn't crowded, and the human stays straight above the centre.
  const n1 = onRing[1]?.length ?? 0
  const rings = [0, Math.max(fh, n1 > 1 ? fw / (2 * Math.sin(Math.PI / n1)) : 0)]
  if (n1 > 1) spread(onRing[1], angle, 2 * Math.asin(Math.min(1, fw / (2 * rings[1]))))
  if (ring.get(root.id!) === 1) {
    const tilt = -Math.PI / 2 - angle.get(root.id!)!
    for (const id of onRing[1]) angle.set(id, angle.get(id)! + tilt)
  }
  const stars = new Map<string, Star>()
  const slots: Box[] = []
  const put = (id: string, rho: number) => {
    const a = angle.get(id)!, q = at(a, rho)
    const s = { cx: q.x, cy: q.y, r: radius.get(id)!, ring: ring.get(id)!, angle: a, rho }
    stars.set(id, s)
    slots.push(slot(s, dims))
  }
  const free = (id: string, rho: number) => {
    const q = at(angle.get(id)!, rho), b = slot({ cx: q.x, cy: q.y }, dims)
    return slots.every((o) => !touches(b, o, dims.gap))
  }
  // The first ring then grows until every orb on it is clear of the centre's and of each other's:
  // squeezed into its ellipse, the ring's top and bottom sit nearer the centre than its sides.
  put(mid, 0)
  const ring1Clear = () => (onRing[1] ?? []).every((id, i) => {
    const q = at(angle.get(id)!, rings[1]), b = slot({ cx: q.x, cy: q.y }, dims)
    return slots.every((o) => !touches(b, o, dims.gap)) && onRing[1].slice(0, i).every((o) => { const p = at(angle.get(o)!, rings[1]); return !touches(b, slot({ cx: p.x, cy: p.y }, dims), dims.gap) })
  })
  while (!ring1Clear()) rings[1] += STEP_PX
  for (const id of onRing[1] ?? []) put(id, rings[1])
  // Each ring further out starts a footprint past the last one's start; each orb on it, in turn
  // round the ring, takes the first place out along its angle where its footprint is clear of
  // every orb placed so far. Crowded neighbours step out by turns, and a ring with room stays a
  // circle. It depends only on the tree, so it lands the same every time.
  for (let d = 2; d <= depth; d++) {
    rings.push(rings[d - 1] + fh)
    for (const id of onRing[d]) {
      let rho = rings[d]
      while (!free(id, rho)) rho += STEP_PX
      put(id, rho)
    }
  }

  // To world coordinates, everything inside the pad.
  const boxes = queue.map((id) => slot(stars.get(id)!, dims))
  const x0 = Math.min(...boxes.map((b) => b.x0)) - dims.pad, y0 = Math.min(...boxes.map((b) => b.y0)) - dims.pad
  const x1 = Math.max(...boxes.map((b) => b.x1)) + dims.pad, y1 = Math.max(...boxes.map((b) => b.y1)) + dims.pad
  for (const s of stars.values()) { s.cx -= x0; s.cy -= y0 }
  const cx = -x0, cy = -y0
  const pos = new Map<string, Pos>()
  // Each orb's square, in the tree's order, so the deck lands mail on its top-right corner.
  for (const id of queue) { const s = stars.get(id)!; pos.set(id, { x: s.cx - s.r, y: s.cy - s.r, w: 2 * s.r, depth: s.ring }) }
  const wires: Wire[] = []
  for (const id of queue) {
    const p = up.get(id)
    if (!p) continue
    const bez = ray(stars.get(p)!, stars.get(id)!, cx, cy, stretch)
    wires.push({ id, from: p, kind: 'ray', d: bezD(bez), bez })
  }
  // The rings as the view's guides round the hub, which mail with no wire swings through.
  return { pos, wires, width: x1 - x0, height: y1 - y0, stars, rings, cx, cy, hub: { x: cx, y: cy }, orbits: rings.slice(1).map((r) => ({ rx: r * stretch.x, ry: r * stretch.y })) }
}

// Spreads orbs round a ring so neighbours sit at least `gap` apart, each moving the least from
// where it was: pairs too close push apart evenly, in a fixed number of passes, so it's the same
// every time. When the ring can't hold them all, they share it evenly.
function spread(ids: string[], angle: Map<string, number>, gap: number) {
  const n = ids.length
  if (gap * n >= 2 * Math.PI) {
    const a0 = angle.get(ids[0])!
    ids.forEach((id, i) => angle.set(id, a0 + (2 * Math.PI * i) / n))
    return
  }
  for (let pass = 0; pass < 64; pass++) {
    let moved = false
    for (let i = 0; i < n; i++) {
      const a = ids[i], b = ids[(i + 1) % n]
      const d = angle.get(b)! + (i + 1 === n ? 2 * Math.PI : 0) - angle.get(a)!
      if (d >= gap - 1e-9) continue
      const push = (gap - d) / 2
      angle.set(a, angle.get(a)! - push)
      angle.set(b, angle.get(b)! + push)
      moved = true
    }
    if (!moved) break
  }
}

// A link from an orb to one a ring further out, as d3's radial links curve: it leaves along the
// parent's angle and arrives along the child's, the controls on the circle halfway between, then
// trimmed to the two orbs' edges so a sheet riding it starts and lands on them.
export function ray(p: Star, c: Star, cx: number, cy: number, stretch = STRETCH): Bez {
  const m = (p.rho + c.rho) / 2, at = onEllipse(stretch)
  const q1 = at(p.rho ? p.angle : c.angle, m), q2 = at(c.angle, m)
  const b: Bez = [p.cx, p.cy, cx + q1.x, cy + q1.y, cx + q2.x, cy + q2.y, c.cx, c.cy]
  const t0 = leave(b, p.cx, p.cy, p.r, false), t1 = leave(b, c.cx, c.cy, c.r, true)
  return t1 > t0 ? splitBez(b, t0, t1) : b
}
// Where a cubic crosses the circle of radius r round (x, y): from its start, or back from its end.
function leave(b: Bez, x: number, y: number, r: number, fromEnd: boolean): number {
  const at = (t: number) => {
    const u = 1 - t
    const px = u * u * u * b[0] + 3 * u * u * t * b[2] + 3 * u * t * t * b[4] + t * t * t * b[6]
    const py = u * u * u * b[1] + 3 * u * u * t * b[3] + 3 * u * t * t * b[5] + t * t * t * b[7]
    return Math.hypot(px - x, py - y)
  }
  let lo = fromEnd ? 0.5 : 0, hi = fromEnd ? 1 : 0.5
  for (let i = 0; i < 32; i++) {
    const m = (lo + hi) / 2
    if ((at(m) < r) !== fromEnd) lo = m; else hi = m
  }
  return (lo + hi) / 2
}
const r1 = (v: number) => Math.round(v * 10) / 10
const bezD = (b: Bez) => `M${r1(b[0])} ${r1(b[1])}C${r1(b[2])} ${r1(b[3])} ${r1(b[4])} ${r1(b[5])} ${r1(b[6])} ${r1(b[7])}`
