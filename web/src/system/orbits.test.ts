import { describe, expect, it } from 'vitest'
import { bezAt, edgeT, flightRoute, routeAt, swingArc } from './flights'
import type { TreeIn } from './layout'
import { orbitLayout, separate, STRETCH, TALL } from './orbits'

// The view's sizes: a 216 by 96 card, gaps of 24 and 32.
const DIMS = { w: 216, h: 96, gapX: 24, gapY: 32 }

// The system check's fixture (web/check/system.mjs): the human, cos, release and assistant, and
// seven teams of a manager, its developers, and a reviewer: 43 agents.
const TEAMS: [string, number][] = [['system-view', 4], ['cost', 4], ['its', 5], ['waiting', 3], ['mail-ui', 4], ['voice', 3], ['storage-ops', 3]]
function fixture(teams: [string, number][], deep = false): TreeIn[] {
  const out: TreeIn[] = [{ id: 'human', parent: null }, { id: 'cos', parent: 'human' }, { id: 'release', parent: 'cos' }, { id: 'assistant', parent: 'cos' }]
  for (const [m, k] of teams) {
    out.push({ id: m, parent: 'cos' })
    for (let i = 1; i <= k; i++) out.push({ id: `${m}-dev${i}`, parent: m })
    out.push({ id: `${m}-review`, parent: m })
    // A sub-manager with its own team, a level further out.
    if (deep) { out.push({ id: `${m}-sub`, parent: m }); for (let i = 1; i <= 3; i++) out.push({ id: `${m}-sub${i}`, parent: `${m}-sub` }) }
  }
  return out
}
const F43 = fixture(TEAMS)
// 120 agents: twelve teams of varied sizes, some two levels deep.
const F120 = fixture(Array.from({ length: 12 }, (_, i) => [`team${i}`, 2 + (i * 5) % 7] as [string, number]), true)

function overlaps(l: ReturnType<typeof orbitLayout>, w: number, h: number): string[] {
  const ps = [...l.pos.entries()]
  const out: string[] = []
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
    const [ia, a] = ps[i], [ib, b] = ps[j]
    const apart = a.x + w <= b.x + 1e-6 || b.x + w <= a.x + 1e-6 || a.y + h <= b.y + 1e-6 || b.y + h <= a.y + 1e-6
    if (!apart) out.push(`${ia}/${ib}`)
  }
  return out
}
const centre = (l: ReturnType<typeof orbitLayout>, id: string) => { const p = l.pos.get(id)!; return { x: p.x + DIMS.w / 2, y: p.y + DIMS.h / 2 } }
const angleOf = (l: ReturnType<typeof orbitLayout>, id: string) => { const c = centre(l, id); return Math.atan2(c.y - l.hub.y, (c.x - l.hub.x) / STRETCH) }

describe('orbitLayout', () => {
  const l = orbitLayout(F43, DIMS)

  it('places every card, cos at the hub and the human straight above it', () => {
    expect(F43.length).toBe(44)
    expect(l.pos.size).toBe(F43.length)
    expect(centre(l, 'cos')).toEqual(l.hub)
    const h = centre(l, 'human')
    expect(h.x).toBeCloseTo(l.hub.x, 0)
    expect(h.y).toBeLessThan(l.hub.y)
  })

  it('never overlaps two cards, for 43 agents and for 120', () => {
    expect(overlaps(l, DIMS.w, DIMS.h)).toEqual([])
    expect(F120.length).toBeGreaterThanOrEqual(121)
    const big = orbitLayout(F120, DIMS)
    expect(big.pos.size).toBe(F120.length)
    expect(overlaps(big, DIMS.w, DIMS.h)).toEqual([])
  })

  it('keeps the gaps between cards too', () => {
    expect(overlaps(l, DIMS.w + DIMS.gapX - 1, DIMS.h + DIMS.gapY - 1)).toEqual([])
  })

  it('is the same every time: no jitter', () => {
    const again = orbitLayout(F43, DIMS)
    for (const [id, p] of l.pos) expect(again.pos.get(id)).toEqual(p)
  })

  it('starts at 0, 0 and reports a size that holds every card', () => {
    const ps = [...l.pos.values()]
    expect(Math.min(...ps.map((p) => p.x))).toBeCloseTo(0)
    expect(Math.min(...ps.map((p) => p.y))).toBeCloseTo(0)
    for (const p of ps) { expect(p.x + DIMS.w).toBeLessThanOrEqual(l.width + 1e-6); expect(p.y + DIMS.h).toBeLessThanOrEqual(l.height + 1e-6) }
  })

  it('puts the managers on the inner orbit and their teams further out, in their wedge', () => {
    const r = (id: string) => { const c = centre(l, id); return Math.hypot((c.x - l.hub.x) / STRETCH, c.y - l.hub.y) }
    for (const [m, k] of TEAMS) {
      for (let i = 1; i <= k; i++) expect(r(`${m}-dev${i}`)).toBeGreaterThan(r(m))
      // The team keeps to its manager's side of the hub.
      const d = Math.abs(((angleOf(l, `${m}-dev1`) - angleOf(l, m) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI)
      expect(d).toBeLessThan(Math.PI / 2)
    }
  })

  it('draws one spoke per shown child, centre to centre', () => {
    expect(l.wires.length).toBe(F43.length - 1)
    for (const w of l.wires) {
      expect(w.kind).toBe('spoke')
      const p = centre(l, w.from), c = centre(l, w.id)
      expect(w.bez[0]).toBeCloseTo(p.x); expect(w.bez[1]).toBeCloseTo(p.y)
      expect(w.bez[6]).toBeCloseTo(c.x); expect(w.bez[7]).toBeCloseTo(c.y)
    }
    // A spoke from the hub is straight.
    const s = l.wires.find((w) => w.from === 'cos')!
    const mid = bezAt(s.bez, 0.5)
    const c = centre(l, s.id)
    expect(Math.abs((c.x - l.hub.x) * (mid.y - l.hub.y) - (c.y - l.hub.y) * (mid.x - l.hub.x))).toBeLessThan(1e-3 * Math.hypot(c.x - l.hub.x, c.y - l.hub.y) ** 2)
  })

  it('leaves out a folded team', () => {
    const f = orbitLayout(F43, DIMS, new Set(['its']))
    expect(f.pos.has('its')).toBe(true)
    expect(f.pos.has('its-dev1')).toBe(false)
    expect(overlaps(f, DIMS.w, DIMS.h)).toEqual([])
  })

  it('works with the human alone, and with roots besides cos', () => {
    expect(orbitLayout([{ id: 'human', parent: null }], DIMS).pos.size).toBe(1)
    const two = orbitLayout([...F43, { id: 'other', parent: 'human' }, { id: 'other-dev', parent: 'other' }], DIMS)
    expect(two.pos.size).toBe(F43.length + 2)
    expect(two.wires.find((w) => w.id === 'other')?.from).toBe('human')
    expect(overlaps(two, DIMS.w, DIMS.h)).toEqual([])
  })
})

describe('separate', () => {
  it('pushes overlapping boxes apart on their shorter overlap, the fixed one staying', () => {
    const a = { p: { x: 0, y: 0 }, fixed: true }, b = { p: { x: 10, y: 50 } }
    separate([a, b], 100, 60)
    expect(a.p).toEqual({ x: 0, y: 0 })
    expect(b.p).toEqual({ x: 10, y: 60 })
  })
  it('splits a push between two free boxes, and goes outward on a tie', () => {
    const a = { p: { x: 5, y: 0 } }, b = { p: { x: 5, y: 0 } }
    separate([a, b], 10, 100)
    expect(Math.abs(a.p.x - b.p.x)).toBeCloseTo(10)
    expect(a.p.x + b.p.x).toBeCloseTo(10)
  })
})

describe('flights on the orbits', () => {
  const l = orbitLayout(F43, DIMS)
  const card = (id: string) => l.pos.get(id)!
  const dims = { cardH: DIMS.h, landIn: 0, pad: 16, gap: 16, corner: 6, lift: 192, top: -16, hub: l.hub }

  it('rides a spoke from stack to stack, leaving and entering on the cards\' edges', () => {
    const w = l.wires.find((x) => x.id === 'its')!
    const t1 = edgeT(w.bez, card('cos'), DIMS.h, true), t2 = edgeT(w.bez, card('its'), DIMS.h, false)
    expect(t1).toBeGreaterThan(0)
    expect(t2).toBeLessThan(1)
    expect(t1).toBeLessThan(t2)
    const r = flightRoute(card('cos'), card('its'), { bez: w.bez, down: true, kind: 'spoke' }, dims)
    const s = routeAt(r, 0), e = routeAt(r, 1)
    expect(s.x).toBeCloseTo(card('cos').x + DIMS.w); expect(s.y).toBeCloseTo(card('cos').y)
    expect(e.x).toBeCloseTo(card('its').x + DIMS.w); expect(e.y).toBeCloseTo(card('its').y)
    // Up the wire, the same route backwards.
    const up = flightRoute(card('its'), card('cos'), { bez: w.bez, down: false, kind: 'spoke' }, dims)
    expect(routeAt(up, 0).x).toBeCloseTo(e.x)
    expect(up.len).toBeCloseTo(r.len)
  })

  it('swings mail between teams through the middle', () => {
    const a = { x: l.hub.x - 1000, y: l.hub.y }, b = { x: l.hub.x + 1000, y: l.hub.y + 10 }
    const far = swingArc(a, b, l.hub)
    expect(Math.hypot(bezAt(far, 0.5).x - l.hub.x, bezAt(far, 0.5).y - l.hub.y)).toBeLessThan(60)
    // Neighbours: a gentle arc, staying well out from the hub.
    const c = { x: l.hub.x + 1000, y: l.hub.y + 300 }
    const near = swingArc(b, c, l.hub)
    expect(Math.hypot(bezAt(near, 0.5).x - l.hub.x, bezAt(near, 0.5).y - l.hub.y)).toBeGreaterThan(600)
    const r = flightRoute(card('its-dev1'), card('voice-dev1'), null, dims)
    expect(r.segs.length).toBe(1)
  })

  it('stands tall on the phone (S-606), without overlaps, managers folded or not', () => {
    const managers = new Set(TEAMS.map(([t]) => t))
    for (const folded of [managers, new Set<string>()]) {
      const wide = orbitLayout(F43, DIMS, folded), tall = orbitLayout(F43, { ...DIMS, stretch: TALL }, folded)
      expect(overlaps(tall, DIMS.w, DIMS.h)).toEqual([])
      expect(tall.height / tall.width).toBeGreaterThan(wide.height / wide.width)
      for (const o of tall.orbits) expect(o.rx).toBeLessThan(o.ry)
    }
  })
})
