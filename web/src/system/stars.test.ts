import { describe, expect, it } from 'vitest'
import { bezAt } from './flights'
import { footprint, orbRadius, type StarDims, type StarIn, starsLayout, TALL, touches } from './stars'

// As the tokens give them (system.css).
const DIMS: StarDims = { rMin: 12, rMax: 24, rHuman: 20, labelW: 96, labelH: 28, labelGap: 4, gap: 8, pad: 16 }

// A system like web/check/system.mjs's fixture: the human, cos, release and assistant, and
// managers with `team` developers and a reviewer each. Costs from a seeded generator.
function system(teams: number[]): StarIn[] {
  let seed = 7
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const nodes: StarIn[] = [{ id: 'human', parent: null }, { id: 'cos', parent: 'human', cost: 31.4 }, { id: 'release', parent: 'cos', cost: 6.2 }, { id: 'assistant', parent: 'cos', cost: 1.1 }]
  teams.forEach((k, t) => {
    const m = 'mgr' + t
    nodes.push({ id: m, parent: 'cos', cost: 3 + rnd() * 9 })
    for (let i = 0; i <= k; i++) nodes.push({ id: `${m}-${i}`, parent: m, cost: rnd() * 6 })
  })
  return nodes
}
// 43 agents, as the check's fixture: seven teams.
const S43 = system([4, 4, 5, 3, 4, 3, 3])
// 120 agents: eleven bigger teams and the three at the top.
const S120 = system([9, 8, 9, 8, 9, 8, 9, 8, 9, 9, 9])

const noOverlaps = (l: ReturnType<typeof starsLayout>) => {
  const all = [...l.stars.entries()].map(([id, s]) => ({ id, b: footprint(s, DIMS) }))
  const bad: string[] = []
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) if (touches(all[i].b, all[j].b, 0)) bad.push(`${all[i].id} ${all[j].id}`)
  return bad
}

describe('starsLayout', () => {
  it('has the fixtures it claims', () => {
    expect(S43.length - 1).toBe(43)
    expect(S120.length - 1).toBe(120)
  })

  it('never overlaps two orbs or their labels: 43 agents', () => {
    const l = starsLayout(S43, DIMS)
    expect(l.stars.size).toBe(44)
    expect(noOverlaps(l)).toEqual([])
  })

  it('never overlaps two orbs or their labels: 120 agents', () => {
    const l = starsLayout(S120, DIMS)
    expect(l.stars.size).toBe(121)
    expect(noOverlaps(l)).toEqual([])
  })

  it('puts cos at the centre and the human straight above it, on the first ring', () => {
    const l = starsLayout(S43, DIMS)
    const c = l.stars.get('cos')!, h = l.stars.get('human')!
    expect([c.cx, c.cy]).toEqual([l.cx, l.cy])
    expect(h.ring).toBe(1)
    expect(h.cx).toBeCloseTo(c.cx)
    expect(h.cy).toBeLessThan(c.cy)
    expect(l.stars.get('mgr0')!.ring).toBe(1)
    expect(l.stars.get('mgr0-0')!.ring).toBe(2)
  })

  it('keeps every footprint inside the layout', () => {
    const l = starsLayout(S120, DIMS)
    for (const s of l.stars.values()) {
      const b = footprint(s, DIMS)
      expect(b.x0).toBeGreaterThanOrEqual(0)
      expect(b.y0).toBeGreaterThanOrEqual(0)
      expect(b.x1).toBeLessThanOrEqual(l.width)
      expect(b.y1).toBeLessThanOrEqual(l.height)
    }
  })

  it('keeps every orb in place when spend changes', () => {
    const a = starsLayout(S43, DIMS), b = starsLayout(S43.map((n) => ({ ...n, cost: (n.cost ?? 0) * 3 + 1 })), DIMS)
    for (const [id, s] of a.stars) expect([s.cx, s.cy]).toEqual([b.stars.get(id)!.cx, b.stars.get(id)!.cy])
    expect([a.width, a.height]).toEqual([b.width, b.height])
  })

  it('is the same every time: nothing drifts', () => {
    const a = starsLayout(S43, DIMS), b = starsLayout(S43, DIMS)
    expect([...a.stars]).toEqual([...b.stars])
    expect(a.wires).toEqual(b.wires)
  })

  it('keeps a team inside its manager wedge', () => {
    const l = starsLayout(S43, DIMS)
    const ang = (id: string) => l.stars.get(id)!.angle
    // Team 2 sits between teams 1 and 3, by angle.
    expect(Math.max(ang('mgr1-0'), ang('mgr1-4'))).toBeLessThan(Math.min(ang('mgr2-0'), ang('mgr2-5')))
    expect(Math.max(ang('mgr2-0'), ang('mgr2-5'))).toBeLessThan(Math.min(ang('mgr3-0'), ang('mgr3-3')))
  })

  it('sizes orbs by spend on a square-root scale, clamped', () => {
    expect(orbRadius(100, 100, DIMS)).toBe(24)
    expect(orbRadius(64, 100, DIMS)).toBeCloseTo(19.2)
    expect(orbRadius(1, 100, DIMS)).toBe(12)
    expect(orbRadius(0, 0, DIMS)).toBe(12)
    const l = starsLayout(S43, DIMS)
    expect(l.stars.get('cos')!.r).toBe(24)
    expect(l.stars.get('human')!.r).toBe(20)
  })

  it('links each orb to the one it hangs from, edge to edge, the human to cos', () => {
    const l = starsLayout(S43, DIMS)
    expect(l.wires.length).toBe(43)
    const w = l.wires.find((x) => x.id === 'human')!
    expect(w.from).toBe('cos')
    expect(w.kind).toBe('ray')
    for (const x of l.wires) {
      const p = l.stars.get(x.from)!, c = l.stars.get(x.id)!
      const s = bezAt(x.bez, 0), e = bezAt(x.bez, 1)
      expect(Math.hypot(s.x - p.cx, s.y - p.cy)).toBeCloseTo(p.r, 0)
      expect(Math.hypot(e.x - c.cx, e.y - c.cy)).toBeCloseTo(c.r, 0)
    }
  })

  it('keeps a sparse first ring clear of the centre, where the squeezed ellipse runs closest', () => {
    for (const kids of [1, 2, 3]) {
      const nodes: StarIn[] = [{ id: 'human', parent: null }, { id: 'cos', parent: 'human', cost: 9 }, ...Array.from({ length: kids }, (_, i) => ({ id: 'k' + i, parent: 'cos', cost: 1 }))]
      expect(noOverlaps(starsLayout(nodes, DIMS))).toEqual([])
    }
  })

  it('leaves a folded node subtree out', () => {
    const l = starsLayout(S43, DIMS, new Set(['mgr0']))
    expect(l.stars.has('mgr0')).toBe(true)
    expect(l.stars.has('mgr0-0')).toBe(false)
    expect(l.stars.size).toBe(44 - 5)
  })

  it('stands tall on the phone (S-606), without overlaps', () => {
    const wide = starsLayout(S43, DIMS), tall = starsLayout(S43, { ...DIMS, stretch: TALL })
    expect(noOverlaps(tall)).toEqual([])
    expect(tall.height).toBeGreaterThan(tall.width)
    expect(tall.height / tall.width).toBeGreaterThan(wide.height / wide.width)
    for (const o of tall.orbits!) expect(o.rx).toBeLessThan(o.ry)
  })
})
