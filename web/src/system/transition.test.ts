import { describe, expect, it } from 'vitest'
import { SPRINGS } from './springs'
import { easing, lineWidth, nameFit, rebase, settled, shortestArc, springOf, springStep, stagger, STAGE, startAt, travel } from './transition'
import { mapRoute, route, routeAt } from './flights'
import { shortName } from './names'

const near = (a: number, b: number, e = 1e-6) => Math.abs(a - b) < e

describe('lineWidth', () => {
  it('adds up the lines of a wrapped name, counting repeated boxes on a line once', () => {
    expect(lineWidth([{ left: 10, right: 60, top: 0 }])).toBe(50)
    expect(lineWidth([{ left: 10, right: 60, top: 0 }, { left: 10, right: 40, top: 16 }])).toBe(80)
    expect(lineWidth([{ left: 10, right: 60, top: 0.2 }, { left: 10, right: 60, top: 0 }, { left: 10, right: 40, top: 16 }])).toBe(80)
  })
})

describe('shortestArc', () => {
  it('turns the short way round', () => {
    expect(shortestArc(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2)
    // From just below +x to just above it: a small turn, not most of a circle.
    expect(shortestArc(-0.1, 0.1)).toBeCloseTo(0.2)
    expect(shortestArc(3, -3)).toBeCloseTo(2 * Math.PI - 6)
    expect(shortestArc(Math.PI * 0.9, -Math.PI * 0.9)).toBeCloseTo(Math.PI * 0.2)
  })
  it('keeps every turn within half a circle', () => {
    for (let a = -7; a < 7; a += 0.37) for (let b = -7; b < 7; b += 0.41) {
      const d = shortestArc(a, b)
      expect(d).toBeGreaterThan(-Math.PI - 1e-9)
      expect(d).toBeLessThanOrEqual(Math.PI + 1e-9)
      expect(near(Math.cos(a + d), Math.cos(b), 1e-9) && near(Math.sin(a + d), Math.sin(b), 1e-9)).toBe(true)
    }
  })
})

describe('travel', () => {
  const hub = { x: 0, y: 0 }
  it('runs straight with no hub', () => {
    const p = travel({ x: 0, y: 0 }, { x: 10, y: 20 }, null)
    expect(p(0.5)).toEqual({ x: 5, y: 10 })
  })
  it('swings round the hub at its radius, never through the middle', () => {
    // From the left of the hub to its right, at the same radius: every point stays on the circle.
    const p = travel({ x: -100, y: 1 }, { x: 100, y: 1 }, { h0: hub, h1: hub })
    for (let t = 0; t <= 1; t += 0.05) expect(Math.hypot(p(t).x, p(t).y)).toBeCloseTo(Math.hypot(100, 1), 6)
    expect(p(0).x).toBeCloseTo(-100)
    expect(p(1).x).toBeCloseTo(100)
    expect(p(1).y).toBeCloseTo(1)
  })
  it('takes the shorter arc', () => {
    // Just above +x to just below it goes through +x, not round the far side.
    const p = travel({ x: 100, y: -10 }, { x: 100, y: 10 }, { h0: hub, h1: hub })
    expect(p(0.5).x).toBeGreaterThan(99)
  })
  it('grows the radius and follows a moving hub', () => {
    const p = travel({ x: 10, y: 0 }, { x: 130, y: 100 }, { h0: { x: 0, y: 0 }, h1: { x: 100, y: 100 } })
    expect(p(0)).toEqual({ x: 10, y: 0 })
    expect(p(1).x).toBeCloseTo(130)
    expect(p(1).y).toBeCloseTo(100)
    const m = p(0.5)
    expect(Math.hypot(m.x - 50, m.y - 50)).toBeCloseTo(20)
  })
  it('gives a node at the hub the other end\'s angle', () => {
    const p = travel({ x: 0, y: 0 }, { x: 0, y: 50 }, { h0: hub, h1: hub })
    expect(p(0.5).x).toBeCloseTo(0)
    expect(p(0.5).y).toBeCloseTo(25)
  })
})

describe('springs', () => {
  it('matches the preset\'s length and settles at the end', () => {
    const sp = springOf(SPRINGS.move, 220)
    const s = { x: 0, v: 0 }
    let t = 0, peak = 0
    while (!settled(s) && t < 3) { springStep(s, sp, 1 / 60); t += 1 / 60; peak = Math.max(peak, s.x) }
    expect(settled(s)).toBe(true)
    // Bounce 0.1: a small overshoot, well under the system-view-motion skill's 0.2.
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThan(1.05)
    // The move's 440 ms visual length: there or near by then, settled within a second.
    expect(t).toBeLessThan(1)
  })
  it('keeps going from a carried speed, as a switch mid-way does', () => {
    const sp = springOf(SPRINGS.move, 220)
    const a = { x: 0, v: 0 }, b = { x: 0, v: 3 }
    springStep(a, sp, 0.05)
    springStep(b, sp, 0.05)
    expect(b.x).toBeGreaterThan(a.x)
  })
  it('steps the same however the frames fall', () => {
    const sp = springOf(SPRINGS.move, 220)
    const a = { x: 0, v: 0 }, b = { x: 0, v: 0 }
    springStep(a, sp, 0.1)
    for (let i = 0; i < 25; i++) springStep(b, sp, 0.004)
    expect(a.x).toBeCloseTo(b.x, 6)
  })
})

describe('stagger', () => {
  const slow = 220
  it('cascades by depth, a step a level', () => {
    const d = stagger([{ id: 'a', depth: 0, at: { x: 0, y: 0 } }, { id: 'b', depth: 1, at: { x: 0, y: 0 } }, { id: 'c', depth: 2, at: { x: 0, y: 0 } }], 'depth', slow * STAGE.step, slow * STAGE.spread)
    expect(d.get('a')).toBe(0)
    expect(d.get('b')).toBeCloseTo(slow * STAGE.step)
    expect(d.get('c')).toBeCloseTo(2 * slow * STAGE.step)
  })
  it('shrinks the steps of a deep tree so the whole spread stays within about 300 ms', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ id: 'n' + i, depth: i, at: { x: 0, y: 0 } }))
    const d = stagger(items, 'depth', slow * STAGE.step, slow * STAGE.spread)
    expect(Math.max(...d.values())).toBeLessThanOrEqual(300)
    expect(Math.max(...d.values())).toBeCloseTo(slow * STAGE.spread)
  })
  it('sweeps clockwise from straight up round the hub', () => {
    const hub = { x: 100, y: 100 }
    const d = stagger([
      { id: 'hub', depth: 0, at: hub },
      { id: 'up', depth: 1, at: { x: 100, y: 0 } },
      { id: 'right', depth: 1, at: { x: 200, y: 100 } },
      { id: 'down', depth: 1, at: { x: 100, y: 200 } },
      { id: 'left', depth: 1, at: { x: 0, y: 100 } },
    ], 'angle', slow * STAGE.step, slow * STAGE.spread, hub)
    expect(d.get('hub')).toBe(0)
    expect(d.get('up')).toBeCloseTo(0)
    expect(d.get('right')!).toBeCloseTo((slow * STAGE.spread) / 4)
    expect(d.get('down')!).toBeCloseTo((slow * STAGE.spread) / 2)
    expect(d.get('left')!).toBeCloseTo((slow * STAGE.spread) * 3 / 4)
    expect(Math.max(...d.values())).toBeLessThanOrEqual(300)
  })
})

describe('easing and rebase', () => {
  it('solves a cubic-bezier as CSS does', () => {
    const e = easing([0.2, 0, 0, 1])
    expect(e(0)).toBe(0)
    expect(e(1)).toBe(1)
    // An ease-out: well past half way at half time.
    expect(e(0.5)).toBeGreaterThan(0.75)
    for (let t = 0; t < 1; t += 0.1) expect(e(t + 0.1)).toBeGreaterThanOrEqual(e(t))
    expect(easing(null)(0.3)).toBe(0.3)
  })
  it('keeps a point where it was on screen when the camera moves', () => {
    const a = { x: 10, y: 20, k: 0.5 }, b = { x: -30, y: 5, k: 2 }
    const p = { x: 100, y: 40 }
    const q = rebase(a, b)(p)
    expect(q.x * b.k + b.x).toBeCloseTo(p.x * a.k + a.x)
    expect(q.y * b.k + b.y).toBeCloseTo(p.y * a.k + a.y)
  })
})

describe('shortName', () => {
  it('drops the words a child shares with its parent', () => {
    expect(shortName('system-view-dev3', 'system-view')).toBe('dev3')
    expect(shortName('cost-review', 'cost')).toBe('review')
    expect(shortName('cost-review', 'cost-manager')).toBe('review')
    expect(shortName('its_dev1', 'its')).toBe('dev1')
  })
  it('cuts only at whole words', () => {
    expect(shortName('systematic', 'system')).toBe('systematic')
    expect(shortName('system-viewer', 'system-view')).toBe('viewer')
  })
  it('keeps the full name when nothing is shared or nothing would be left', () => {
    expect(shortName('release', 'cos')).toBe('release')
    expect(shortName('cost', 'cost')).toBe('cost')
    expect(shortName('cost', 'cost-review')).toBe('cost')
    expect(shortName('cost-', 'cost')).toBe('cost-')
    expect(shortName('cos', null)).toBe('cos')
  })
  it('tells siblings apart', () => {
    const kids = ['waiting-dev1', 'waiting-dev2', 'waiting-review', 'waiting-test'].map((n) => shortName(n, 'waiting'))
    expect(new Set(kids).size).toBe(4)
    expect(kids).toEqual(['dev1', 'dev2', 'review', 'test'])
  })
})

describe('review fixes', () => {
  it('fits a chip to its whole name, shrinking as well as growing', () => {
    // A row of 100 whose name box shows 40 of a 70 px name needs 130.
    expect(nameFit(100, 40, 70)).toBe(130)
    // Grown to fit (the box now holds all 70), it stays at 130, not more.
    expect(nameFit(130, 70, 70)).toBe(130)
    // The name gets shorter (40 px of text in the grown box): the fit shrinks back.
    expect(nameFit(130, 70, 40)).toBe(100)
  })
  it('lets a node already moving carry straight on when a switch retargets it', () => {
    expect(startAt(200, 220, true)).toBe(0)
    expect(startAt(200, 220, false)).toBeCloseTo(220 * STAGE.start + 200)
  })
  it('carries a sheet\'s route with the camera when it has nowhere new to go', () => {
    const r = route([[0, 0, 10, 0, 20, 0, 30, 0]])
    const m = rebase({ x: 0, y: 0, k: 1 }, { x: 10, y: 0, k: 2 })
    const q = mapRoute(r, m)
    // Where it was on screen, it still is.
    for (const u of [0, 0.5, 1]) {
      const a = routeAt(r, u), b = routeAt(q, u)
      expect(b.x * 2 + 10).toBeCloseTo(a.x)
      expect(b.y * 2).toBeCloseTo(a.y)
    }
  })
})
