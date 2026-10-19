// The Cards mode's layout (S-460): the same cards as the tree, on orbits around the chief of staff.
// The human and cos's children sit on the inner orbit, each in a wedge of the circle sized by the
// agents under it; each team fans out across its wedge on the orbits further out, siblings
// alternating between two staggered radii so neighbours clear each other. The orbits are
// ellipses, wider than tall, as the cards are. Then a rectangle pass pushes apart any two cards
// that still overlap: plain arithmetic in a fixed order, no forces and no randomness, so the same
// agents always land in the same places and the page is calm at rest. Wires run centre to centre,
// bowed a little toward the hub. d3-hierarchy builds the tree and counts each wedge's leaves.
import { build, type Laid, type Pos, type TreeIn, type Wire } from './layout'
import { type Bez, type Pt, quadToCubic } from './flights'

export interface OrbitDims {
  // A card's width and height, and the least space between two cards across and down.
  w: number
  h: number
  gapX: number
  gapY: number
  // How much wider than tall the orbits are (STRETCH unless given): below 1 they stand tall, for a phone.
  stretch?: number
}
// An orbit's guide, centred on the hub: its semi-axes.
export interface Orbit { rx: number; ry: number }
export interface Orbited extends Laid { hub: Pt; orbits: Orbit[] }

type N = ReturnType<typeof build>

// How much wider than tall an orbit is.
export const STRETCH = 1.5
// The phone's: taller than wide, as its pane is (S-606).
export const TALL = 0.5
// The human's share of the inner orbit, in leaves, and the least share of any other member: so the
// human has the top to itself, and a lone agent next to a big team still has room.
const HUMAN_SHARE = 3
const MIN_SHARE = 2.5
// How far the inner orbit's members lean from their wedge's middle toward even spacing.
const EVEN = 0.5
// How far a wire bows toward the hub: its control point is the chord's middle moved this share of
// the chord's length toward the hub.
export const BOW = 0.15
// The rectangle pass's most sweeps; it stops at the first sweep that moves nothing.
const SWEEPS = 800
// An orbit too crowded for its cards grows by this factor, at most this many times.
const GROW = 1.04
const GROW_STEPS = 80

const kids = (n: N) => (n.children ?? []) as N[]

export function orbitLayout(nodes: TreeIn[], dims: OrbitDims, folded: ReadonlySet<string> = new Set()): Orbited {
  const { w: W, h: H, gapX, gapY } = dims, stretch = dims.stretch ?? STRETCH
  const root = build(nodes, folded)
  // The hub is the first root under the human (the chief of staff leads them), or the human alone.
  const hub = kids(root)[0] ?? root
  // The inner orbit: the human on top, then cos's children, then any other roots, each a team.
  const ring = hub === root ? kids(root) : [root, ...kids(hub), ...kids(root).slice(1)]
  const team = (m: N) => (m === root ? [] : kids(m))
  const leaves = (m: N) => (m === root ? HUMAN_SHARE : Math.max(MIN_SHARE, m.leaves().length))
  const share = new Map<N, number>()
  const weigh = (n: N): number => { const ks = kids(n); const v = ks.length ? ks.reduce((s, k) => s + weigh(k), 0) : 1; share.set(n, v); return v }
  weigh(root)

  // Each node's level (1 on the inner orbit) and its angle, from its slice of its wedge.
  const level = new Map<N, number>()
  const angle = new Map<N, number>()
  const nth = new Map<N, number>()
  const ws = ring.map(leaves)
  const unit = (Math.PI * 2) / Math.max(1e-9, ws.reduce((a, b) => a + b, 0))
  let a = -Math.PI / 2 - ((ws[0] ?? 0) * unit) / 2
  // `nth`: a node's place round its orbit, counted in angle order across teams, so the stagger
  // alternates at a team's edge too.
  const seen: number[] = []
  const fan = (n: N, a0: number, a1: number, l: number) => {
    level.set(n, l)
    angle.set(n, (a0 + a1) / 2)
    nth.set(n, (seen[l] = (seen[l] ?? -1) + 1))
    const ks = l === 1 ? team(n) : kids(n)
    const tot = ks.reduce((s, k) => s + share.get(k)!, 0)
    let at = a0
    for (const k of ks) { const span = ((a1 - a0) * share.get(k)!) / tot; fan(k, at, at + span, l + 1); at += span }
  }
  ring.forEach((m, i) => { fan(m, a, a + ws[i] * unit, 1); a += ws[i] * unit })
  // On the inner orbit, a member sits between the middle of its wedge and an even share of the
  // circle, so small members next to the human don't crowd the top.
  ring.forEach((m, i) => angle.set(m, angle.get(m)! * (1 - EVEN) + (-Math.PI / 2 + (i * 2 * Math.PI) / ring.length) * EVEN))

  // The orbits' radii (their y semi-axis). Each orbit starts a step outside the one before: a
  // card and a gap, across at the sides as well as down at the top, so a card never sits on its
  // parent's orbit; the inner one starts that step out from the hub. Then it grows until no two of
  // its own cards overlap. From the second orbit out, siblings alternate between it and a card's
  // step further (`stagger`), so neighbours clear each other at the top and at the sides.
  const step = Math.max(H + gapY, (W + gapX) / stretch)
  const stagger = step
  const byLevel: N[][] = []
  for (const [n, l] of level) (byLevel[l] ??= []).push(n)
  const radii: number[] = []
  const place = (n: N, r: number): Pt => {
    const rr = r + (level.get(n)! > 1 && nth.get(n)! % 2 ? stagger : 0)
    const t = angle.get(n)!
    return { x: Math.cos(t) * rr * stretch, y: Math.sin(t) * rr }
  }
  for (let l = 1; l < byLevel.length; l++) {
    let r = l === 1 ? step : radii[l - 1] + (l > 2 ? stagger : 0) + step
    for (let i = 0; i < GROW_STEPS && crowded((byLevel[l] ?? []).map((n) => place(n, r)), W + gapX, H + gapY); i++) r *= GROW
    radii[l] = r
  }

  // Centres, the hub at 0, 0.
  const c = new Map<N, Pt>([[hub, { x: 0, y: 0 }]])
  for (const n of level.keys()) c.set(n, place(n, radii[level.get(n)!]))
  // The hub and the human hold still, so the human stays straight above cos.
  separate([...c.entries()].map(([n, p]) => ({ p, fixed: n === hub || n === root })), W + gapX, H + gapY)

  // Top-left places, shifted so the world starts at 0, 0.
  const all = [...c.values()]
  const x0 = Math.min(...all.map((p) => p.x)) - W / 2, y0 = Math.min(...all.map((p) => p.y)) - H / 2
  const pos = new Map<string, Pos>()
  for (const [n, p] of c) pos.set(n.id!, { x: p.x - W / 2 - x0, y: p.y - H / 2 - y0, w: W, depth: n.depth })
  const at = (n: N): Pt => { const p = c.get(n)!; return { x: p.x - x0, y: p.y - y0 } }
  const hubAt = { x: -x0, y: -y0 }
  const wires: Wire[] = []
  root.each((n) => {
    if (!n.parent || !c.has(n as N)) return
    const bez = spoke(at(n.parent as N), at(n as N), hubAt)
    wires.push({ id: n.id!, from: n.parent.id!, kind: 'spoke', d: bezD(bez), bez })
  })
  return {
    pos, wires, hub: hubAt, stacksOut: true,
    orbits: radii.slice(1).map((r, i) => { const m = r + (i ? stagger / 2 : 0); return { rx: m * stretch, ry: m } }),
    width: Math.max(...all.map((p) => p.x)) + W / 2 - x0,
    height: Math.max(...all.map((p) => p.y)) + H / 2 - y0,
  }
}

// A wire from one centre to another: a quadratic whose control is the chord's middle moved toward
// the hub by a share of the chord, so a spoke from the hub is straight and the rest curve gently
// round it, however far out.
export function spoke(p: Pt, q: Pt, hub: Pt): Bez {
  const m = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }
  const d = Math.hypot(m.x - hub.x, m.y - hub.y)
  const k = d ? Math.min(d, BOW * Math.hypot(q.x - p.x, q.y - p.y)) / d : 0
  return quadToCubic(p, { x: m.x + (hub.x - m.x) * k, y: m.y + (hub.y - m.y) * k }, q)
}
const r1 = (v: number) => Math.round(v * 10) / 10
export const bezD = (b: Bez) => `M${r1(b[0])} ${r1(b[1])}C${r1(b[2])} ${r1(b[3])} ${r1(b[4])} ${r1(b[5])} ${r1(b[6])} ${r1(b[7])}`

// The rectangle pass: each pair of boxes (`sx` by `sy`, round their centres) that overlap is pushed
// apart along the axis it overlaps least on, half each, or all of it onto the one that isn't fixed.
// A tie with both centres in line goes outward from the origin. Sweeps run until one moves nothing.
export function separate(items: { p: Pt; fixed?: boolean }[], sx: number, sy: number, sweeps = SWEEPS): number {
  for (let s = 0; s < sweeps; s++) {
    let moved = false
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const A = items[i], B = items[j]
      if (A.fixed && B.fixed) continue
      const dx = B.p.x - A.p.x, dy = B.p.y - A.p.y
      const ox = sx - Math.abs(dx), oy = sy - Math.abs(dy)
      if (ox <= 1e-6 || oy <= 1e-6) continue
      moved = true
      const kA = A.fixed ? 0 : B.fixed ? 1 : 0.5, kB = 1 - kA
      if (ox < oy) {
        const g = sgn(dx, B.p.x + A.p.x)
        A.p.x -= g * ox * kA; B.p.x += g * ox * kB
      } else {
        const g = sgn(dy, B.p.y + A.p.y)
        A.p.y -= g * oy * kA; B.p.y += g * oy * kB
      }
    }
    if (!moved) return s
  }
  return sweeps
}
// Whether any two boxes (`sx` by `sy`, round their centres) overlap.
function crowded(ps: Pt[], sx: number, sy: number): boolean {
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) if (Math.abs(ps[i].x - ps[j].x) < sx - 1e-6 && Math.abs(ps[i].y - ps[j].y) < sy - 1e-6) return true
  return false
}
const sgn = (d: number, outward: number) => (d > 0 ? 1 : d < 0 ? -1 : outward < 0 ? -1 : 1)
