// Mode transitions (S-572): a switch between Tree, Cards and Stars runs in stages (Heer and
// Robertson): the old wires fade, the cards and orbs travel on springs, then the new wires grow
// back out of their parents. Every node is measured on screen before the switch and after it
// (FLIP), so the camera's own jump to the new fit is folded into the travel. Travel is polar,
// along the shortest arc, round the hub when either end is radial, so nothing crosses the
// middle; the stagger sweeps by angle into a radial mode and cascades by depth into the tree.
// A card that becomes a star collapses into its mark as the mark swells into the orb, and back.
// A switch mid-way measures where everything is and retargets from there, keeping its speed.
// One requestAnimationFrame loop writes only the CSS `translate`, `scale` and `opacity` of each
// node and wire, which compose with the `transform` Motion owns, so React never renders per
// frame. Under reduced motion the switch is a crossfade of the old picture into the new.
// Every length is a share of --duration-slow, as springs.ts's are.
import type { Pt } from './flights'
import type { Laid } from './layout'
import { type Bezier, type Preset, SPRINGS } from './springs'

export type { Pt }
// The world layer's pan and zoom: screen = world · k + (x, y).
export interface View { x: number; y: number; k: number }

// ---- Pure: paths, springs, stagger ----

// The signed turn from angle a to angle b the short way round, in (-π, π].
export function shortestArc(a: number, b: number): number {
  let d = (b - a) % (2 * Math.PI)
  if (d > Math.PI) d -= 2 * Math.PI
  if (d <= -Math.PI) d += 2 * Math.PI
  return d
}

// A node's path from `a` to `b`: polar round a hub that moves from h0 to h1 when there is one
// (the radius and the angle each interpolate, the angle the short way round), else straight.
export type Path = (t: number) => Pt
export function travel(a: Pt, b: Pt, hub: { h0: Pt; h1: Pt } | null): Path {
  if (!hub) return (t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
  const { h0, h1 } = hub
  const r0 = Math.hypot(a.x - h0.x, a.y - h0.y), r1 = Math.hypot(b.x - h1.x, b.y - h1.y)
  // A node at the hub has no angle of its own: it takes the other end's.
  const t0 = r0 > 0.5 ? Math.atan2(a.y - h0.y, a.x - h0.x) : Math.atan2(b.y - h1.y, b.x - h1.x)
  const t1 = r1 > 0.5 ? Math.atan2(b.y - h1.y, b.x - h1.x) : t0
  const dt = shortestArc(t0, t1)
  return (t) => {
    const hx = h0.x + (h1.x - h0.x) * t, hy = h0.y + (h1.y - h0.y) * t
    const r = r0 + (r1 - r0) * t, th = t0 + dt * t
    return { x: hx + r * Math.cos(th), y: hy + r * Math.sin(th) }
  }
}

// A preset as a spring's stiffness and damping (mass 1), the way Motion turns a bounce and a
// visual duration into them, so a mode change moves as a Motion card move does.
export interface SpringK { k: number; c: number }
export function springOf(p: Preset, slowMs: number): SpringK {
  const vis = Math.max(1e-3, (p.slows * slowMs) / 1000)
  const root = (2 * Math.PI) / (vis * 1.2)
  const k = root * root
  return { k, c: 2 * Math.min(1, Math.max(0.05, 1 - p.bounce)) * Math.sqrt(k) }
}
// One step of a spring from x (with velocity v, per second) toward 1, over dt seconds, in
// fixed sub-steps so a slow frame never blows it up.
export function springStep(s: { x: number; v: number }, sp: SpringK, dt: number): void {
  const n = Math.max(1, Math.ceil(dt / 0.004))
  const h = dt / n
  for (let i = 0; i < n; i++) {
    s.v += (-sp.k * (s.x - 1) - sp.c * s.v) * h
    s.x += s.v * h
  }
}
export const settled = (s: { x: number; v: number }) => Math.abs(1 - s.x) < 1e-3 && Math.abs(s.v) < 1e-2

// The stagger: each node's delay in ms. Into the tree it cascades by depth, a step a level,
// the steps shrunk so the deepest waits at most `spread`; into a radial mode it sweeps
// clockwise from straight up round the hub, a full turn over `spread`.
export interface Staggered { id: string; depth: number; at: Pt }
export function stagger(items: Staggered[], by: 'depth' | 'angle', step: number, spread: number, hub?: Pt): Map<string, number> {
  const out = new Map<string, number>()
  if (by === 'angle' && hub) {
    for (const it of items) {
      const dx = it.at.x - hub.x, dy = it.at.y - hub.y
      // The hub itself leads.
      if (Math.hypot(dx, dy) < 0.5) { out.set(it.id, 0); continue }
      // Clockwise on screen from 12 o'clock, as a share of the turn.
      const a = (Math.atan2(dx, -dy) + 2 * Math.PI) % (2 * Math.PI)
      out.set(it.id, (a / (2 * Math.PI)) * spread)
    }
    return out
  }
  const deepest = Math.max(1, ...items.map((i) => i.depth))
  const s = Math.min(step, spread / deepest)
  for (const it of items) out.set(it.id, it.depth * s)
  return out
}

// A cubic-bezier() easing as a function of time share, solved for x by Newton's method then
// bisection, as CSS does. Linear when there's no curve.
export function easing(b: Bezier | null): (t: number) => number {
  if (!b) return (t) => t
  const [x1, y1, x2, y2] = b
  const f = (t: number, p1: number, p2: number) => 3 * (1 - t) * (1 - t) * t * p1 + 3 * (1 - t) * t * t * p2 + t * t * t
  const df = (t: number, p1: number, p2: number) => 3 * (1 - t) * (1 - t) * p1 + 6 * (1 - t) * t * (p2 - p1) + 3 * t * t * (1 - p2)
  return (x) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let t = x
    for (let i = 0; i < 6; i++) {
      const d = df(t, x1, x2)
      if (Math.abs(d) < 1e-6) break
      t -= (f(t, x1, x2) - x) / d
    }
    if (!(t >= 0 && t <= 1) || Math.abs(f(t, x1, x2) - x) > 1e-4) {
      let lo = 0, hi = 1
      t = x
      for (let i = 0; i < 30; i++) { if (f(t, x1, x2) < x) lo = t; else hi = t; t = (lo + hi) / 2 }
    }
    return f(t, y1, y2)
  }
}

// The width a far chip's row needs for its whole name: the row as drawn, less the name's box as
// drawn, plus the name's own text (S-572). Measured that way it shrinks as well as grows.
export const nameFit = (row: number, box: number, text: number) => Math.ceil(row - box + text)
// A name's width on one line, from its text's boxes as drawn: each line's span, added up, so a
// name wrapped onto two lines (S-462) measures as it would on one. Boxes on a line may repeat.
export function lineWidth(rects: Iterable<{ left: number; right: number; top: number }>): number {
  const lines = new Map<number, { l: number; r: number }>()
  for (const q of rects) {
    const k = Math.round(q.top), x = lines.get(k)
    lines.set(k, x ? { l: Math.min(x.l, q.left), r: Math.max(x.r, q.right) } : { l: q.left, r: q.right })
  }
  let w = 0
  for (const x of lines.values()) w += x.r - x.l
  return w
}

// When a node starts to travel, in ms from the switch: after the old wires have begun to fade,
// at its turn in the stagger; one already moving (a switch mid-way) carries straight on.
export const startAt = (delay: number, slow: number, moving: boolean) => (moving ? 0 : slow * STAGE.start + delay)

// Where an old world point is in the new world, once the camera has moved from `a` to `b`, so
// what was on screen stays put.
export const rebase = (a: View, b: View) => (p: Pt): Pt => ({ x: (p.x * a.k + a.x - b.x) / b.k, y: (p.y * a.k + a.y - b.y) / b.k })

// The stages' timings, as shares of --duration-slow (220 ms at rest): the old wires fade over
// 0.75 of it; travel starts 0.3 in; the stagger spreads over at most 1.25 (275 ms, inside the
// system-view-motion skill's 300) in steps of 0.15 (33 ms); a wire grows over one slow once its
// child is 0.7 of its spring's length in; a card leaving for a star fades over 1.5. With the
// spring's 440 ms that is about 870 ms end to end at most, inside the skill's 600-900.
export const STAGE = { fade: 0.75, start: 0.3, step: 0.15, spread: 1.25, growAt: 0.7, grow: 1, leave: 1.5 }
// A wire starts its growth this big, from its parent's end; an orbit guide from this big round the hub.
const WIRE_FROM = 0.3
const ORBIT_FROM = 0.94
// The card's end of a morph: a card arriving from a star starts, and one leaving for a star ends,
// this much smaller round its mark (never scale(0); system-view-motion's 0.9 to 0.97, a little
// further since it is fading too).
export const MORPH_CARD = 0.85

// ---- The DOM side ----

// One node as measured: its anchor's centre on screen, relative to the stage, and its screen
// scale (screen px per own px), and the anchor's screen width (the mark, for a morph).
interface Seen { kind: 'card' | 'star'; at: Pt; z: number; mark: Pt; markW: number; opacity: number; vel: Pt; moving: boolean }
// One node in motion.
interface Mover {
  el: HTMLElement
  // Its anchor, own px, and its transform origin, own px.
  origin: Pt
  // The natural placement once the overlay is cleared: the anchor's screen centre and the scale.
  nat: Pt
  natZ: number
  path: Path
  z0: number
  z1: number
  len: number
  // Fades in over the first half (a morph's arrival), or nothing.
  fadeIn: boolean
  // When it starts, ms from the switch (startAt).
  delay: number
  s: { x: number; v: number }
}
interface Grower { el: SVGGraphicsElement; at: number; orbit: boolean }
interface Fader { el: HTMLElement | SVGElement; from: number; to: number; t0: number; ms: number; remove: boolean }

// The node's id, kind, and mark: every card and star carries `data-tid`, leaving ones too.
const kindOf = (el: HTMLElement): 'card' | 'star' => (el.classList.contains('sv-star') ? 'star' : 'card')
// The mark as drawn: the orb, or a card's glyph, on its far chip when the chip is what shows.
function markOf(el: HTMLElement): HTMLElement | null {
  if (kindOf(el) === 'star') return el.querySelector<HTMLElement>('.sv-orb')
  const chip = el.querySelector<HTMLElement>('.sv-chip')
  if (chip && getComputedStyle(chip).display !== 'none') return chip.querySelector<HTMLElement>('.glyph')
  return el.querySelector<HTMLElement>('.sv-r1 > .glyph')
}

export interface Play { world: HTMLElement; view: View; laid: Laid; shape: string; slow: number; ease: Bezier | null; crossMs: number; onDone: () => void }

export class Morph {
  private stage: HTMLElement
  private seen = new Map<string, Seen[]>()
  private from: { shape: string; hub: Pt | null; view: View } | null = null
  private movers: Mover[] = []
  private growers: Grower[] = []
  private faders: Fader[] = []
  private ghost: HTMLElement | null = null
  private raf = 0
  private t0 = 0
  private last = 0
  private sp: SpringK = { k: 1, c: 1 }
  private timing = { slow: 0, ease: (t: number) => t }
  private onDone: (() => void) | null = null

  constructor(stage: HTMLElement) { this.stage = stage }

  get active() { return !!this.raf || this.held != null }

  private stageAt(): Pt { const r = this.stage.getBoundingClientRect(); return { x: r.left, y: r.top } }

  // Before a switch: where every node is on screen now, mid-way or at rest, and the old wires (or
  // under reduced motion the whole old picture) kept as a ghost over the stage to fade out.
  capture(world: HTMLElement | null, view: View, shape: string, laid: Laid | null, reduce: boolean): void {
    if (!world) return
    const o = this.stageAt()
    const now = performance.now()
    const vel = new Map<string, Pt>()
    const moving = new Set<string>()
    // A node already moving keeps its speed into the new path.
    for (const m of this.movers) {
      const id = m.el.dataset.tid!
      const p = progress(m, now - this.t0)
      if (p == null) continue
      moving.add(id)
      const a = m.path(Math.max(0, p - 0.01)), b = m.path(Math.min(1.5, p + 0.01))
      vel.set(id, { x: ((b.x - a.x) / 0.02) * m.s.v, y: ((b.y - a.y) / 0.02) * m.s.v })
    }
    this.seen.clear()
    for (const el of world.querySelectorAll<HTMLElement>('[data-tid]')) {
      const id = el.dataset.tid!
      const r = el.getBoundingClientRect()
      const mk = markOf(el)
      const mr = mk?.getBoundingClientRect() ?? r
      const s: Seen = {
        kind: kindOf(el), at: { x: r.left + r.width / 2 - o.x, y: r.top + r.height / 2 - o.y }, z: r.width / (el.offsetWidth || 1),
        mark: { x: mr.left + mr.width / 2 - o.x, y: mr.top + mr.height / 2 - o.y }, markW: mr.width,
        opacity: parseFloat(getComputedStyle(el).opacity) || 0, vel: vel.get(id) ?? { x: 0, y: 0 }, moving: moving.has(id),
      }
      // Leaving nodes are kept only when nothing else stands for the id.
      const list = this.seen.get(id) ?? []
      if (el.classList.contains('leave')) { if (!list.length) list.push(s) } else list.unshift(s)
      this.seen.set(id, list)
    }
    this.from = { shape, hub: laid?.hub ? { x: laid.hub.x * view.k + view.x, y: laid.hub.y * view.k + view.y } : null, view: { ...view } }
    // The old wires, or the whole picture, kept on the stage where they are on screen.
    const src = reduce ? world : world.querySelector<SVGSVGElement>('.sv-wires')
    if (src) {
      const g = document.createElement('div')
      g.className = 'sv-ghost'
      g.setAttribute('aria-hidden', 'true')
      // The clone holds the old cards' buttons: none of them takes focus or a click.
      g.inert = true
      g.style.transform = world.style.transform
      const c = src.cloneNode(true) as HTMLElement
      c.removeAttribute('data-tid')
      for (const x of c.querySelectorAll('[data-tid],[data-card],[data-fold],[data-inbox],[data-thread]')) for (const a of ['data-tid', 'data-card', 'data-fold', 'data-inbox', 'data-thread']) x.removeAttribute(a)
      if (reduce) { c.style.transform = 'none'; c.classList.remove('sv-world') }
      g.appendChild(c)
      g.querySelector('.sv-wires')?.classList.add('staged')
      this.ghost?.remove()
      this.ghost = g
    }
  }

  // Drops what capture kept, when no switch followed (the phone's outline took the change).
  drop(): void { this.ghost?.remove(); this.ghost = null; this.from = null; this.seen.clear() }
  get pending() { return !!this.from }
  // The camera before the switch, for the flights' rebase.
  get fromView(): View | null { return this.from?.view ?? null }

  // After the switch has rendered and the camera has fitted: from where each node was to where
  // it now is, staged. Runs before the browser paints, so nothing shows at its new place first.
  play(o: Play): void {
    const from = this.from
    this.from = null
    if (!from) return
    // A switch mid-way: what was moving lets go, measured already.
    this.stop(false)
    this.onDone = o.onDone
    const { world, view, laid, shape, slow } = o
    const now = performance.now()
    this.t0 = now
    this.last = now
    const ghost = this.ghost
    this.ghost = null
    if (ghost) this.stage.appendChild(ghost)
    const svg = world.querySelector<SVGSVGElement>('.sv-wires')
    svg?.classList.add('staged')
    // Reduced motion: no travel. The old picture fades out over the new one fading in.
    if (!slow) {
      this.timing = { slow: 0, ease: easing(o.ease) }
      if (ghost) this.faders.push({ el: ghost, from: 1, to: 0, t0: now, ms: o.crossMs, remove: true })
      this.faders.push({ el: world, from: 0, to: 1, t0: now, ms: o.crossMs, remove: false })
      world.style.opacity = '0'
      this.seen.clear()
      this.loop()
      return
    }
    this.timing = { slow, ease: easing(o.ease) }
    this.sp = springOf(SPRINGS.move, slow)
    if (ghost) this.faders.push({ el: ghost, from: 1, to: 0, t0: now, ms: slow * STAGE.fade, remove: true })
    const at = this.stageAt()
    const els = [...world.querySelectorAll<HTMLElement>('[data-tid]')]
    // Writes first, then reads, so the layout is worked out once.
    for (const el of els) {
      el.style.translate = ''
      el.style.scale = ''
      const p = laid.pos.get(el.dataset.tid!)
      if (p && !el.classList.contains('leave')) el.style.transform = `translate(${p.x}px, ${p.y}px) scale(1)`
    }
    const hub1 = laid.hub ? { x: laid.hub.x * view.k + view.x, y: laid.hub.y * view.k + view.y } : null
    const hub = hub1 || from.hub ? { h0: from.hub ?? hub1!, h1: hub1 ?? from.hub! } : null
    const natOf = new Map<HTMLElement, { at: Pt; z: number; mark: Pt; markW: number; origin: Pt; size: Pt }>()
    for (const el of els) {
      const r = el.getBoundingClientRect()
      const mk = markOf(el)
      const mr = mk?.getBoundingClientRect() ?? r
      const z = r.width / (el.offsetWidth || 1)
      const og = getComputedStyle(el).transformOrigin.split(' ').map(parseFloat)
      natOf.set(el, {
        at: { x: r.left + r.width / 2 - at.x, y: r.top + r.height / 2 - at.y }, z, mark: { x: mr.left + mr.width / 2 - at.x, y: mr.top + mr.height / 2 - at.y }, markW: mr.width,
        origin: { x: og[0] || 0, y: og[1] || 0 }, size: { x: el.offsetWidth, y: el.offsetHeight },
      })
    }
    // The stagger, by where each node ends up.
    const radial = shape !== 'tree'
    const delays = stagger(els.filter((el) => !el.classList.contains('leave')).map((el) => ({ id: el.dataset.tid!, depth: laid.pos.get(el.dataset.tid!)?.depth ?? 0, at: natOf.get(el)!.at })),
      radial ? 'angle' : 'depth', slow * STAGE.step, slow * STAGE.spread, hub1 ?? undefined)
    const newOf = new Map<string, HTMLElement>()
    for (const el of els) if (!el.classList.contains('leave')) newOf.set(el.dataset.tid!, el)
    this.movers = []
    for (const el of els) {
      const id = el.dataset.tid!
      const n = natOf.get(el)!
      const was = this.seen.get(id) ?? []
      const leaving = el.classList.contains('leave')
      const kind = kindOf(el)
      const same = was.find((s) => s.kind === kind)
      const other = was.find((s) => s.kind !== kind)
      let a: Pt, b: Pt, z0: number, z1: number, nat: Pt, fadeIn = false
      if (leaving) {
        // Leaving for its other self: it travels with the newcomer's mark and fades (Motion's exit).
        const to = newOf.get(id)
        if (!to || !same) continue
        const tn = natOf.get(to)!
        a = same.mark; b = tn.mark; nat = n.mark
        z0 = same.z
        z1 = kind === 'star' ? same.z * (tn.markW / Math.max(1, same.markW)) : same.z * MORPH_CARD
      } else if (same && (!other || same.opacity >= other.opacity)) {
        // The same node in a new place: centre to centre, carrying its scale.
        a = same.at; b = n.at; nat = n.at
        z0 = same.z; z1 = n.z
        fadeIn = same.opacity < 0.99
      } else if (other) {
        // Born of its other self: its mark starts at the old mark, at the old mark's size.
        a = other.mark; b = n.mark; nat = n.mark
        z1 = n.z
        z0 = kind === 'star' ? n.z * (other.markW / Math.max(1, n.markW)) : n.z * MORPH_CARD
        fadeIn = true
      } else continue
      const delay = startAt(delays.get(id) ?? 0, slow, !!(same ?? other)?.moving)
      const len = Math.hypot(b.x - a.x, b.y - a.y)
      const v0 = (same ?? other)?.vel ?? { x: 0, y: 0 }
      // Speed carried over from a switch mid-way, along the new chord.
      const sv = len > 1 ? (v0.x * (b.x - a.x) + v0.y * (b.y - a.y)) / (len * len) : 0
      // Where its anchor sits in its own box: its centre, or for a morph its mark's centre.
      const m: Mover = { el, origin: n.origin, nat, natZ: n.z, path: travel(a, b, hub), z0, z1, len, fadeIn, delay, s: { x: 0, v: sv } }
      this.movers.push(m)
      // Kept where it was until its turn.
      this.place(m, 0, view)
    }
    this.view = view
    // The new wires and guides start hidden; each grows from its parent's end once its child has
    // mostly arrived, an orbit guide with the first of them.
    this.growers = []
    if (svg) {
      const lag = (SPRINGS.move.slows * slow) * STAGE.growAt
      const first = slow * STAGE.start + lag
      for (const w of svg.querySelectorAll<SVGPathElement>('.sv-wire')) {
        const id = w.dataset.child ?? ''
        const st = /^M\s*(-?[\d.]+)[ ,](-?[\d.]+)/.exec(w.getAttribute('d') ?? '')
        if (st) { w.style.transformBox = 'view-box'; w.style.transformOrigin = `${st[1]}px ${st[2]}px` }
        w.style.opacity = '0'
        this.growers.push({ el: w, at: slow * STAGE.start + (delays.get(id) ?? 0) + lag, orbit: false })
      }
      for (const e of svg.querySelectorAll<SVGEllipseElement>('.sv-orbit')) {
        e.style.transformBox = 'view-box'
        e.style.transformOrigin = `${e.getAttribute('cx')}px ${e.getAttribute('cy')}px`
        e.style.opacity = '0'
        this.growers.push({ el: e, at: first, orbit: true })
      }
    }
    this.seen.clear()
    this.loop()
  }

  private view: View = { x: 0, y: 0, k: 1 }

  // A node's anchor at screen point A, drawn at screen scale z: the translate and scale that,
  // composed outside its transform about its origin, put it there.
  private place(m: Mover, p: number, v: View): void {
    const A = m.path(p)
    const z = m.z0 + (m.z1 - m.z0) * p
    const s = z / (m.natZ || 1)
    const tx = (A.x - v.x - s * (m.nat.x - v.x)) / v.k - m.origin.x * (1 - s)
    const ty = (A.y - v.y - s * (m.nat.y - v.y)) / v.k - m.origin.y * (1 - s)
    m.el.style.translate = `${tx.toFixed(2)}px ${ty.toFixed(2)}px`
    m.el.style.scale = s.toFixed(4)
    if (m.fadeIn) m.el.style.opacity = String(Math.min(1, Math.max(0, p * 2)))
  }

  private loop() { if (!this.raf) this.raf = requestAnimationFrame(this.step) }

  private step = (now: number) => {
    this.raf = 0
    const dt = Math.min(0.064, (now - this.last) / 1000)
    this.last = now
    const t = now - this.t0
    let busy = false
    for (const m of this.movers) {
      if (t < m.delay) { busy = true; continue }
      springStep(m.s, this.sp, dt)
      if (settled(m.s)) { m.s.x = 1; m.s.v = 0 } else busy = true
      this.place(m, m.s.x, this.view)
    }
    const grow = this.timing.slow * STAGE.grow
    for (const g of this.growers) {
      const u = grow ? Math.min(1, Math.max(0, (t - g.at) / grow)) : 1
      const e = this.timing.ease(u)
      g.el.style.opacity = String(e)
      g.el.style.scale = String((g.orbit ? ORBIT_FROM : WIRE_FROM) + (1 - (g.orbit ? ORBIT_FROM : WIRE_FROM)) * e)
      if (u < 1) busy = true
    }
    for (const f of this.faders) {
      const u = f.ms ? Math.min(1, (now - f.t0) / f.ms) : 1
      f.el.style.opacity = String(f.from + (f.to - f.from) * this.timing.ease(u))
      if (u < 1) busy = true
    }
    if (busy) this.loop()
    else this.stop(true)
  }

  // Ends the motion: every node and wire back to its own place and Motion's hands.
  stop(done: boolean): void {
    cancelAnimationFrame(this.raf)
    this.raf = 0
    this.held = null
    for (const m of this.movers) { m.el.style.translate = ''; m.el.style.scale = ''; if (m.fadeIn) m.el.style.opacity = '' }
    for (const g of this.growers) { g.el.style.opacity = ''; g.el.style.scale = '' }
    for (const f of this.faders) { if (f.remove) f.el.remove(); else f.el.style.opacity = '' }
    this.movers = []
    this.growers = []
    this.faders = []
    if (done) { const d = this.onDone; this.onDone = null; d?.() }
  }

  // For the checks: holds every node, wire and ghost at time `ms` into the switch, until the next frame.
  seek(ms: number): void {
    const n = Math.max(1, Math.round(ms / 4))
    // Re-run the springs from the start in fixed steps to the moment asked for.
    for (const m of this.movers) { m.s.x = 0; m.s.v = 0 }
    for (let i = 1; i <= n; i++) {
      const t = (i * ms) / n
      for (const m of this.movers) if (t >= m.delay) springStep(m.s, this.sp, ms / n / 1000)
    }
    for (const m of this.movers) this.place(m, m.s.x, this.view)
    const grow = this.timing.slow * STAGE.grow
    for (const g of this.growers) { const e = this.timing.ease(grow ? Math.min(1, Math.max(0, (ms - g.at) / grow)) : 1); g.el.style.opacity = String(e); g.el.style.scale = String((g.orbit ? ORBIT_FROM : WIRE_FROM) + (1 - (g.orbit ? ORBIT_FROM : WIRE_FROM)) * e) }
    for (const f of this.faders) { const u = f.ms ? Math.min(1, ms / f.ms) : 1; f.el.style.opacity = String(f.from + (f.to - f.from) * this.timing.ease(u)) }
    // Held here until resume().
    cancelAnimationFrame(this.raf)
    this.raf = 0
    this.held = ms
  }
  private held: number | null = null
  // For the checks: picks up from where seek held it.
  resume(): void {
    if (this.held == null) return
    this.t0 = performance.now() - this.held
    this.last = performance.now()
    this.held = null
    this.loop()
  }
  // Still moving, or held mid-way by a check.

}

// How far a mover is along its path at `t` ms in, or null before its turn.
function progress(m: Mover, t: number): number | null {
  return t < m.delay ? null : m.s.x
}
