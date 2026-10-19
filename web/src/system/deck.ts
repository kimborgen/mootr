// The flight deck (S-459): the mail sheets in the air over the system view, and the one
// requestAnimationFrame loop that moves them. Sheets and their trails are plain DOM in a layer
// of the world, so they pan and zoom with it; each frame writes only their `transform`, from the
// path math in flights.ts, and React never renders per frame. The loop runs only while a sheet
// flies. The view hears about holds (a stack waiting for its sheet) and hits (a card that just
// got mail) through `onChange`. An ITSA done sends a done sheet up the wire the same way
// (S-463), in the same cap and bursts, and the parent's roll-up waits for the children it carries
// (`doneKids`).
import type { Laid } from './layout'
import { durationMs } from '../ui/duration'
import { type Air, flightMs, flightRoute, type MailIn, mapRoute, overshoot, plan, type Plan, pose, type Pt, type Route, routeAt, routeD, shownCard, tiltSign } from './flights'

// At most this many sheets in the air; past it, mail lands without flying (S-445 proposal).
export const FLIGHT_CAP = 24
// How far a free arc's sheet tilts at its ends, in degrees.
const TILT = 14

// What the deck needs of the view, set on every render.
export interface Geo {
  laid: Laid
  parentOf: (id: string) => string | null
  card: number
  cardH: number
  pad: number
  // The gap between rows of cards in a column.
  rowGap: number
  // A sheet's height, and how far in from a card's right edge its stack sits.
  sheetH: number
  landIn: number
  human: string
  // How much further right a card's stack sits, in world px: a far chip grown to fit its name
  // (S-572) carries its stack out with its corner.
  grow?: (id: string) => number
}
// `done`: a done sheet (S-463), whose `mails` are the ITSAs it carries. `off`: after a relayout
// mid-flight (S-572), how far the sheet stood from its new route at `u0`, blended out by the landing.
interface Flight extends Air { el: HTMLElement; count: HTMLElement; trail: SVGPathElement; route: Route; over: number; dur: number; tilt: number; warn: boolean; done: boolean; off?: Pt; u0?: number }
type Launch = Plan['launch'][number]
export interface Hit { warn: boolean; until: number }

const NS = 'http://www.w3.org/2000/svg'

export class Deck {
  geo: Geo | null = null
  // Cards with sheets on the way: the stack count each showed before the first one left.
  readonly holds = new Map<string, number>()
  readonly hits = new Map<string, Hit>()
  // The ITSAs done sheets carry, each with the parent ITSA whose roll-up it advances on landing.
  readonly doneKids = new Map<string, string | null>()
  private air: Flight[] = []
  private raf = 0
  private probe: HTMLElement
  private n = 0
  private timers = new Set<ReturnType<typeof setTimeout>>()

  private layer: HTMLElement
  private svg: SVGSVGElement
  private onChange: () => void
  private countOf: (card: string) => number

  // `countOf`: the count a card's stack shows now, held while sheets fly to it.
  constructor(layer: HTMLElement, svg: SVGSVGElement, onChange: () => void, countOf: (card: string) => number) {
    this.layer = layer
    this.svg = svg
    this.onChange = onChange
    this.countOf = countOf
    this.probe = document.createElement('i')
    this.probe.className = 'sv-probe'
    layer.appendChild(this.probe)
  }

  // A duration token in ms, read when it's needed, so reduced motion and a check's override apply.
  ms(token: string): number {
    this.probe.style.transitionDuration = `var(${token})`
    return durationMs(getComputedStyle(this.probe).transitionDuration)
  }

  // Cards mode's stack offset past a card's corner (--sv-stack-out, a screen length) in world
  // units, at the zoom now (--sv-k, which the view sets on this flight layer), as zoom.ts places
  // the stacks there.
  private stackOut(): number {
    this.probe.style.width = 'var(--sv-stack-out)'
    const w = this.probe.getBoundingClientRect().width
    this.probe.style.width = ''
    const k = parseFloat(getComputedStyle(this.layer).getPropertyValue('--sv-k')) || 1
    return w / k
  }

  mail(m: MailIn): void {
    const g = this.geo
    if (!g) return
    const maxMs = this.ms('--duration-flight')
    const now = performance.now()
    // Mail never joins a done sheet, but shares the cap with them.
    const p = plan(m, this.air.filter((f) => !f.done), {
      shown: (id) => shownCard(id, g.laid.pos, g.parentOf), now, cap: FLIGHT_CAP, flying: this.air.length, burst: this.ms('--duration-tick'), still: maxMs === 0, human: g.human,
    })
    for (const l of p.land) this.hit(l.to, l.warn)
    for (const j of p.join) {
      const f = this.air.find((x) => x.key === j.key)
      if (!f) continue
      f.mails.push(j.mail)
      f.count.textContent = String(f.mails.length)
      // An ask or a mail to the human that joins turns the sheet the warning hue.
      if (j.warn && !f.warn) { f.warn = true; f.el.classList.add('warn'); f.trail.classList.add('warn') }
      // A count bump: the badge stamps once.
      f.count.classList.remove('bump')
      void f.count.offsetWidth
      f.count.classList.add('bump')
    }
    for (const l of p.launch) this.fly(l, g, maxMs, now)
    if (p.launch.length) this.onChange()
    if (this.air.length && !this.raf) this.raf = requestAnimationFrame(this.step)
  }

  // The route between two cards in the layout now: on their wire, or a free arc.
  private routeFor(from: string, to: string, g: Geo) {
    const wire = g.laid.wires.find((w) => (w.id === to && w.from === from) || (w.id === from && w.from === to))
    const pa = g.laid.pos.get(from), pb = g.laid.pos.get(to)
    if (!pa || !pb) return null
    const a = g.grow ? { ...pa, w: pa.w + g.grow(from) } : pa, b = g.grow ? { ...pb, w: pb.w + g.grow(to) } : pb
    const route = flightRoute(a, b, wire ? { bez: wire.bez, down: wire.id === to, kind: wire.kind } : null,
      { cardH: g.cardH, landIn: g.landIn, pad: g.pad, gap: g.rowGap, corner: g.sheetH / 2, lift: g.cardH * 2, top: -g.pad, hub: g.laid.hub, out: g.laid.stacksOut ? this.stackOut() : 0 })
    return { route, wire }
  }

  // The layout changed under sheets in the air (S-572: a mode switch, a fold, a spawn): each takes
  // the route between its cards' new places, starting from where it is now (`map` takes an old
  // world point to the new world, when the camera moved), and the gap between the two closes
  // by the landing, so it lands on its card's new stack in its own time.
  relayout(map: (p: Pt) => Pt): void {
    const g = this.geo
    if (!g || !this.air.length) return
    const now = performance.now()
    const shown = (id: string) => shownCard(id, g.laid.pos, g.parentOf)
    for (const f of this.air) {
      const { u } = pose(f.dur ? (now - f.t0) / f.dur : 1, f.over)
      const cur = map(this.at(f, u))
      // A card folded away: the sheet makes for the card that now stands for it.
      const a = shown(f.from), b = shown(f.to)
      const r = a && b && a !== b ? this.routeFor(a, b, g) : null
      if (!r) {
        // Nowhere new to go: it keeps its course, carried with the camera.
        f.route = mapRoute(f.route, map)
        if (f.off) { const o = map({ x: f.off.x, y: f.off.y }), z = map({ x: 0, y: 0 }); f.off = { x: o.x - z.x, y: o.y - z.y } }
        f.trail.setAttribute('d', routeD(f.route))
        continue
      }
      const u0 = Math.min(u, 1)
      const on = routeAt(r.route, u0)
      f.route = r.route
      f.off = { x: cur.x - on.x, y: cur.y - on.y }
      f.u0 = u0
      f.trail.setAttribute('d', routeD(r.route))
    }
  }

  // A sheet's point at path share u, with what's left of a relayout's gap.
  private at(f: Flight, u: number): Pt {
    const p = routeAt(f.route, u)
    if (!f.off || f.u0 == null) return p
    const w = f.u0 >= 1 ? 1 : Math.min(1, Math.max(0, (u - f.u0) / (1 - f.u0)))
    // Smoothstep, so the sheet leaves its old line and meets the new one without a kink.
    const k = 1 - w * w * (3 - 2 * w)
    return { x: p.x + f.off.x * k, y: p.y + f.off.y * k }
  }

  // One sheet into the air, on its wire or a free arc; false when either card has no place.
  private fly(l: Launch, g: Geo, maxMs: number, now: number, done = false): boolean {
    const r = this.routeFor(l.from, l.to, g)
    if (!r) { this.hit(l.to, l.warn); return false }
    const { route, wire } = r
    const len = route.len
    // The shortest hop is 5/11 of the longest: 400 of 880 ms.
    const dur = flightMs(len, (maxMs * 5) / 11, maxMs, g.card * 3)
    if (!done && !this.holds.has(l.to)) this.holds.set(l.to, this.countOf(l.to))
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'sv-fly' + (l.warn ? ' warn' : '') + (done ? ' done' : '')
    if (l.thread) el.dataset.thread = l.thread
    el.tabIndex = -1
    el.setAttribute('aria-hidden', 'true')
    if (!done) el.title = 'Open the thread'
    // The sheet itself, inside the moving box, so CSS can keep it at screen size when zoomed out.
    const sh = document.createElement('span')
    sh.className = 'sh'
    const count = document.createElement('span')
    count.className = 'n'
    sh.appendChild(count)
    el.appendChild(sh)
    const trail = document.createElementNS(NS, 'path')
    trail.setAttribute('class', 'sv-trail' + (wire ? ' wire' : '') + (l.warn ? ' warn' : '') + (done ? ' done' : ''))
    trail.setAttribute('d', routeD(route))
    this.svg.appendChild(trail)
    this.layer.appendChild(el)
    // Shown on the next frame, so its opacity transitions in.
    requestAnimationFrame(() => trail.classList.add('on'))
    const f: Flight = { key: 'f' + ++this.n, from: l.from, to: l.to, mails: l.mails, t0: now, el, count, trail, route, over: overshoot(len, g.sheetH), dur, tilt: wire ? 0 : tiltSign(route) * TILT, warn: l.warn, done }
    if (l.mails.length > 1) count.textContent = String(l.mails.length)
    this.place(f, 0)
    this.air.push(f)
    return true
  }

  // An ITSA done (S-463): a done sheet carries `child` from its owner's card up to `to`'s, and
  // the roll-up of `parent` leaves it out until the sheet lands. It plans as mail does: a burst to
  // one card rides one sheet with a count, and past the deck's cap, under reduced motion, or when
  // both ends show on one card, it lands at once.
  done(from: string, to: string, child: string, parent: string | null): void {
    const g = this.geo
    if (!g) return
    const maxMs = this.ms('--duration-flight')
    const now = performance.now()
    const p = plan({ id: child, from, to: [to], ask: false, thread: null }, this.air.filter((f) => f.done), {
      shown: (id) => shownCard(id, g.laid.pos, g.parentOf), now, cap: FLIGHT_CAP, flying: this.air.length, burst: this.ms('--duration-tick'), still: maxMs === 0, human: g.human,
    })
    for (const l of p.land) this.hit(l.to, false)
    for (const j of p.join) {
      const f = this.air.find((x) => x.key === j.key)
      if (!f) continue
      f.mails.push(child)
      this.doneKids.set(child, parent)
      this.recount(f)
    }
    for (const l of p.launch) if (this.fly(l, g, maxMs, now, true)) this.doneKids.set(child, parent)
    this.onChange()
    if (this.air.length && !this.raf) this.raf = requestAnimationFrame(this.step)
  }

  // Lets go of carried ITSAs that are no longer done under the parent they were sent to (reopened,
  // gone, or moved), so no roll-up waits for them; their sheet still lands.
  dropDone(stale: (child: string, parent: string | null) => boolean): void {
    let changed = false
    for (const [child, parent] of this.doneKids) {
      if (!stale(child, parent)) continue
      this.doneKids.delete(child)
      changed = true
      for (const f of this.air) if (f.done && f.mails.includes(child)) { f.mails = f.mails.filter((x) => x !== child); this.recount(f) }
    }
    if (changed) this.onChange()
  }

  // A sheet's count badge: shown from two, and stamped once per change.
  private recount(f: Flight) {
    f.count.textContent = f.mails.length > 1 ? String(f.mails.length) : ''
    f.count.classList.remove('bump')
    void f.count.offsetWidth
    f.count.classList.add('bump')
  }

  // Sheets in the air, for the checks.
  get flying() { return this.air.length }
  // Puts every sheet at time share t without landing it, for the checks: until the next frame.
  seek(t: number) { for (const f of this.air) this.place(f, t) }

  // How much bigger a lifted sheet is: --sv-lift (system.css), which the stacks' landing shares.
  private get liftScale(): number {
    return (this.lift ??= parseFloat(getComputedStyle(this.layer).getPropertyValue('--sv-lift')) || 1)
  }
  private lift: number | undefined

  private place(f: Flight, t: number) {
    const { u, lift } = pose(t, f.over)
    const p = this.at(f, u)
    const tilt = f.tilt * (Math.min(1, u) * 2 - 1) * lift
    f.el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) rotate(${tilt.toFixed(1)}deg) scale(${(1 + (this.liftScale - 1) * lift).toFixed(3)})`
  }

  private step = (now: number) => {
    this.raf = 0
    const landed: Flight[] = []
    for (const f of this.air) {
      const t = f.dur ? (now - f.t0) / f.dur : 1
      if (t >= 1) landed.push(f)
      else this.place(f, t)
    }
    for (const f of landed) this.land(f)
    if (this.air.length) this.raf = requestAnimationFrame(this.step)
  }

  private land(f: Flight) {
    this.air = this.air.filter((x) => x !== f)
    f.el.remove()
    f.trail.classList.remove('on')
    this.later(() => f.trail.remove(), this.ms('--duration-base'))
    if (f.done) for (const c of f.mails) this.doneKids.delete(c)
    if (!f.done && !this.air.some((x) => x.to === f.to && !x.done)) this.holds.delete(f.to)
    this.hit(f.to, f.warn)
  }

  // A card that got mail is marked a moment: under reduced motion this is all that shows.
  private hit(card: string, warn: boolean) {
    const until = performance.now() + this.ms('--duration-mark')
    const was = this.hits.get(card)
    this.hits.set(card, { warn: warn || (!!was && was.warn), until })
    this.onChange()
    this.later(() => {
      const h = this.hits.get(card)
      if (h && h.until <= performance.now() + 1) { this.hits.delete(card); this.onChange() }
    }, until - performance.now())
  }

  private later(fn: () => void, ms: number) {
    const t = setTimeout(() => { this.timers.delete(t); fn() }, ms)
    this.timers.add(t)
  }

  stop() {
    cancelAnimationFrame(this.raf)
    this.raf = 0
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    for (const f of this.air) { f.el.remove(); f.trail.remove() }
    this.air = []
    this.holds.clear()
    this.doneKids.clear()
    this.hits.clear()
    this.probe.remove()
  }
}
