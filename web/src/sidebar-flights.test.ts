// S-699: the agents sidebar's mail motion, the pure part. Where a flight's route runs (the tree's
// indent gutter), how a flight is clipped when only one of its rows is on screen, which mail flies
// at all (the cap, a burst between the same pair), and what the gate's no means.
import { describe, expect, it } from 'vitest'
import { type Air, edgeEnd, edgeOf, FLIGHT_CAP, flyMs, flyPose, gutterRoute, inList, overFor, plan, railX, type PlanOpts } from './sidebar-flights'
import { routeAt } from './system/flights'

const close = (a: { x: number; y: number }, b: { x: number; y: number }) => { expect(a.x).toBeCloseTo(b.x, 6); expect(a.y).toBeCloseTo(b.y, 6) }
const pts = (r: ReturnType<typeof gutterRoute>, n = 200) => Array.from({ length: n + 1 }, (_, i) => routeAt(r, i / n))

describe('the gutter a flight rides', () => {
  it('sits just left of the row glyph, one rail per indent level', () => {
    expect(railX(22)).toBe(20)
    expect(railX(36)).toBe(34)
    // A root row has no rail of its own: the envelope keeps its own width inside the list.
    expect(railX(8)).toBe(8)
    expect(railX(0)).toBe(8)
  })
  it('runs from the sender row, down the trunk, into the landing point', () => {
    const from = { x: 34, y: 100 }
    const to = { x: 300, y: 400 }
    const r = gutterRoute(from, to, 20)
    close(routeAt(r, 0), from)
    close(routeAt(r, 1), to)
    // The trunk is leftmost of the two rails, and the whole vertical run happens on it.
    expect(Math.min(...pts(r).map((p) => p.x))).toBeCloseTo(20, 3)
    expect(Math.max(...pts(r).map((p) => p.x))).toBeCloseTo(300, 3)
  })
  it('never leaves the rows it flies between, however far apart', () => {
    const from = { x: 20, y: 500 }
    const to = { x: 340, y: 40 }
    for (const p of pts(gutterRoute(from, to, 20))) {
      expect(p.y).toBeGreaterThanOrEqual(40 - 1e-6)
      expect(p.y).toBeLessThanOrEqual(500 + 1e-6)
    }
  })
})

describe('clipping an end that is off screen', () => {
  it('leaves or enters by the side the hidden end lies beyond', () => {
    expect(edgeOf(10, 300)).toBe('top')
    expect(edgeOf(900, 300)).toBe('bottom')
  })
  it('counts an end the list does not show as out, so it clips rather than aims off screen', () => {
    // A 400 px list showing content from y=60.
    expect(inList(60, 60, 400)).toBe(true)
    expect(inList(460, 60, 400)).toBe(true)
    // A landing point below the fold, and one scrolled past above it.
    expect(inList(461, 60, 400)).toBe(false)
    expect(inList(59, 60, 400)).toBe(false)
  })
  it('clips to the list edge the reader can see, not the hidden row', () => {
    expect(edgeEnd('top', 20, 60, 400)).toEqual({ x: 20, y: 60 })
    expect(edgeEnd('bottom', 20, 60, 400)).toEqual({ x: 20, y: 460 })
    // A flight that leaves ends on the edge, not at the row it cannot reach.
    const out = gutterRoute({ x: 34, y: 120 }, edgeEnd('bottom', 20, 60, 400), 20)
    close(routeAt(out, 1), { x: 20, y: 460 })
  })
})

describe('the flight', () => {
  it('takes 400 to 880 ms across the list, by distance', () => {
    expect(flyMs(0, 880, 600)).toBe(400)
    expect(flyMs(600, 880, 600)).toBe(880)
    expect(flyMs(300, 880, 600)).toBe(640)
    // A list taller than the reference never stretches a flight past the longest hop.
    expect(flyMs(2000, 880, 2000)).toBe(880)
  })
  it('crosses the path and settles on its landing, overshooting a little', () => {
    const over = overFor(240)
    expect(over).toBeGreaterThan(0)
    expect(over).toBeLessThanOrEqual(0.04)
    expect(flyPose(0, over, false)).toEqual({ u: 0, o: 0 })
    expect(flyPose(1, over, false).u).toBeCloseTo(1, 6)
    expect(flyPose(0.5, over, false).o).toBe(1)
    const us = Array.from({ length: 101 }, (_, i) => flyPose(i / 100, over, false).u)
    expect(Math.max(...us)).toBeCloseTo(1 + over, 4)
  })
  it('fades out when it leaves at the list edge, and lands opaque otherwise', () => {
    expect(flyPose(0.5, 0.02, true).o).toBe(1)
    expect(flyPose(1, 0.02, true).o).toBe(0)
    expect(flyPose(1, 0.02, false).o).toBe(1)
  })
})

describe('plan: which mail flies', () => {
  const ends = new Set(['human', 'cos', 'mgr', 'dev1', 'dev2'])
  const o: PlanOpts = { end: (id) => ends.has(id), cap: FLIGHT_CAP, still: false }
  const mail = (p: Partial<{ id: string; from: string; to: string[] }> = {}) => ({ id: 'm1', from: 'cos', to: ['mgr'], ...p })

  it('flies one envelope per recipient row', () => {
    const p = plan(mail({ to: ['mgr', 'dev1'] }), [], o)
    expect(p.launch.map((l) => l.to)).toEqual(['mgr', 'dev1'])
    expect(p.launch[0]).toMatchObject({ from: 'cos', mails: ['m1'] })
  })
  it('coalesces a burst between the same pair into one flight with a count', () => {
    const air: Air[] = [{ key: 'f1', from: 'cos', to: 'mgr', mails: ['m0'] }]
    expect(plan(mail({ id: 'm2' }), air, o).join).toEqual([{ key: 'f1', mail: 'm2' }])
    // A recipient named twice is still one row, so one envelope carries it once.
    const p = plan(mail({ to: ['mgr', 'mgr'] }), [], o)
    expect(p.launch).toEqual([{ from: 'cos', to: 'mgr', mails: ['m1'] }])
    // Only the same pair: another sender to the same row starts its own flight.
    expect(plan(mail({ from: 'dev1' }), air, o).launch).toHaveLength(1)
  })
  it('caps the envelopes in the air and lands the rest', () => {
    const air: Air[] = Array.from({ length: FLIGHT_CAP - 1 }, (_, i) => ({ key: 'f' + i, from: 'x', to: 'y' + i, mails: [] }))
    const p = plan(mail({ to: ['mgr', 'dev1', 'dev2'] }), air, o)
    expect(FLIGHT_CAP).toBe(6)
    expect(p.launch.map((l) => l.to)).toEqual(['mgr'])
    expect(p.land.map((l) => l.to)).toEqual(['dev1', 'dev2'])
  })
  it('lands everything when the gate says no', () => {
    const p = plan(mail({ to: ['mgr', 'human'] }), [], { ...o, still: true })
    expect(p.launch).toEqual([])
    expect(p.land).toEqual([{ to: 'mgr', mail: 'm1' }, { to: 'human', mail: 'm1' }])
  })
  it('lands mail with no row at an end, or an agent mailing itself', () => {
    expect(plan(mail({ from: 'ghost' }), [], o).land).toHaveLength(1)
    expect(plan(mail({ to: ['ghost'] }), [], o).land).toHaveLength(1)
    expect(plan(mail({ to: ['cos'] }), [], o).land).toHaveLength(1)
  })
  it('treats the human as an end: mail to or from them flies to the list top', () => {
    expect(plan(mail({ to: ['human'] }), [], o).launch).toEqual([{ from: 'cos', to: 'human', mails: ['m1'] }])
    expect(plan(mail({ from: 'human', to: ['mgr'] }), [], o).launch).toEqual([{ from: 'human', to: 'mgr', mails: ['m1'] }])
    // Mail between two other rows still flies when the human is not an end.
    expect(plan(mail({ from: 'human', to: ['human'] }), [], o).land).toHaveLength(1)
  })
})
