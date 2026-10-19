import { describe, expect, it } from 'vitest'
import { type Air, type Bez, bezAt, splitBez, bezLength, bezTangent, flightMs, flightRoute, freeArc, line, type MailIn, overshoot, plan, pose, rails, reverse, route, routeAt, stackCount, tiltSign, stackSpot, shownCard } from './flights'
import { treeLayout, type TreeIn } from './layout'
import { starsLayout } from './stars'

const straight: Bez = [0, 0, 10, 0, 20, 0, 30, 0]
const close = (a: { x: number; y: number }, b: { x: number; y: number }) => { expect(a.x).toBeCloseTo(b.x, 6); expect(a.y).toBeCloseTo(b.y, 6) }

describe('the tilt', () => {
  it('leans toward the stack the sheet lands on, not the card it lands on', () => {
    // Two cards whose corners say left, while the stacks (a grown chip's corner) say right.
    expect(tiltSign(route([line({ x: 100, y: 0 }, { x: 140, y: 80 })]))).toBe(1)
    expect(tiltSign(route([line({ x: 140, y: 0 }, { x: 100, y: 80 })]))).toBe(-1)
    expect(tiltSign(route([line({ x: 50, y: 0 }, { x: 50, y: 80 })]))).toBe(1)
  })
})

describe('the Bézier', () => {
  it('starts and ends on its end points', () => {
    const b: Bez = [1, 2, 5, -7, 9, 14, 20, 3]
    close(bezAt(b, 0), { x: 1, y: 2 })
    close(bezAt(b, 1), { x: 20, y: 3 })
  })
  it('runs evenly along a straight line', () => {
    close(bezAt(straight, 0.5), { x: 15, y: 0 })
    expect(bezLength(straight)).toBeCloseTo(30, 6)
    close(bezTangent(straight, 0.3), { x: 30, y: 0 })
  })
  it('reverses end to end', () => {
    const b: Bez = [1, 2, 5, -7, 9, 14, 20, 3]
    close(bezAt(reverse(b), 0.25), bezAt(b, 0.75))
  })
  it('carries on along the end tangent past the end, for the overshoot', () => {
    close(routeAt(route([straight]), 1.1), { x: 33, y: 0 })
    close(routeAt(route([straight]), -1), { x: 0, y: 0 })
  })
})

describe('free arcs', () => {
  const a = { x: 0, y: 100 }, b = { x: 400, y: 100 }
  it('rise above the tree, at most `lift`', () => {
    const arc = freeArc(a, b, { lift: 60 })
    const top = bezAt(arc, 0.5)
    expect(top.x).toBeCloseTo(200)
    expect(top.y).toBeCloseTo(40)
    expect(Math.min(...Array.from({ length: 21 }, (_, i) => bezAt(arc, i / 20).y))).toBeGreaterThanOrEqual(39.99)
  })
  it('turns at its lift, but never above the top', () => {
    const ys = (arc: Bez) => Array.from({ length: 401 }, (_, i) => bezAt(arc, i / 400).y)
    // Ends at different heights: the highest point is the lift above the higher end.
    expect(Math.min(...ys(freeArc({ x: 0, y: 300 }, { x: 400, y: 100 }, { lift: 50 })))).toBeCloseTo(50, 1)
    // Mail to the top of the tree stays under `top`.
    expect(Math.min(...ys(freeArc({ x: 0, y: 300 }, { x: 400, y: 20 }, { lift: 200, top: -10 })))).toBeCloseTo(-10, 1)
  })
  it('a short hop rises by a share of its length', () => {
    const top = bezAt(freeArc({ x: 0, y: 0 }, { x: 40, y: 0 }, { lift: 60 }), 0.5)
    expect(top.y).toBeCloseTo(-10)
  })
})

describe('the flight', () => {
  it('takes 400 to 880 ms, by distance', () => {
    expect(flightMs(0, 400, 880, 900)).toBe(400)
    expect(flightMs(450, 400, 880, 900)).toBe(640)
    expect(flightMs(5000, 400, 880, 900)).toBe(880)
  })
  it('lifts in place, travels, overshoots a little, and settles on the end', () => {
    expect(pose(0, 0.04)).toEqual({ u: 0, lift: 0 })
    expect(pose(0.1, 0.04).u).toBe(0)
    expect(pose(0.1, 0.04).lift).toBeGreaterThan(0.5)
    const us = Array.from({ length: 101 }, (_, i) => pose(i / 100, 0.04).u)
    expect(Math.max(...us)).toBeCloseTo(1.04, 2)
    expect(pose(1, 0.04)).toEqual({ u: 1, lift: 0 })
    // It only ever moves forward until the overshoot.
    const peak = us.indexOf(Math.max(...us))
    for (let i = 1; i <= peak; i++) expect(us[i]).toBeGreaterThanOrEqual(us[i - 1])
  })
  it('overshoots about half a sheet, never past the bounce limit', () => {
    expect(overshoot(600, 12)).toBeCloseTo(0.01)
    expect(overshoot(100, 12)).toBe(0.04)
    expect(overshoot(0, 12)).toBe(0)
  })
})

describe('plan: which mail flies', () => {
  const laid = new Set(['human', 'cos', 'mgr', 'dev1'])
  const parents: Record<string, string> = { cos: 'human', mgr: 'cos', dev1: 'mgr', dev2: 'mgr', deep: 'dev2' }
  const shown = (id: string) => shownCard(id, laid, (x) => parents[x] ?? null)
  const o = { shown, now: 1000, cap: 24, burst: 440, still: false, human: 'human' }
  const mail = (p: Partial<MailIn>): MailIn => ({ id: 'm1', from: 'cos', to: ['mgr'], ask: false, thread: 't1', ...p })

  it('counts every sheet in the deck against the cap, not only those it may join (S-463)', () => {
    // 24 in the air, none of them joinable (done sheets): the mail lands at once.
    expect(plan(mail({}), [], { ...o, flying: 24 })).toMatchObject({ launch: [], land: [{ to: 'mgr' }] })
    expect(plan(mail({}), [], { ...o, flying: 23 }).launch).toHaveLength(1)
  })
  it('rides a burst of completions to one card on one sheet (S-463)', () => {
    // Done sheets plan as mail: a second child done from another card joins the sheet just left.
    const air = [{ key: 'f1', from: 'dev1', to: 'mgr', mails: ['c1'], t0: 900 }]
    expect(plan({ id: 'c2', from: 'cos', to: ['mgr'], ask: false, thread: null }, air, o).join).toEqual([{ key: 'f1', mail: 'c2', warn: false }])
  })
  it('launches one sheet per recipient card', () => {
    const p = plan(mail({ to: ['mgr', 'dev1'] }), [], o)
    expect(p.launch.map((l) => l.to)).toEqual(['mgr', 'dev1'])
    expect(p.launch[0]).toMatchObject({ from: 'cos', mails: ['m1'], warn: false, thread: 't1' })
  })
  it('sends folded-away mail to the folded card', () => {
    expect(shown('deep')).toBe('mgr')
    const p = plan(mail({ to: ['deep', 'dev2'] }), [], o)
    expect(p.launch).toHaveLength(1)
    expect(p.launch[0]).toMatchObject({ to: 'mgr', mails: ['m1', 'm1'] })
  })
  it('lands mail within a folded card without flying', () => {
    const p = plan(mail({ from: 'deep', to: ['dev2'] }), [], o)
    expect(p.launch).toEqual([])
    expect(p.land).toEqual([{ to: 'mgr', mail: 'm1', warn: false }])
  })
  it('lands mail with no sender card', () => {
    expect(plan(mail({ from: 'stam' }), [], o).land).toHaveLength(1)
  })
  it('marks mail to the human and asks for the warning hue', () => {
    expect(plan(mail({ to: ['human'] }), [], o).launch[0].warn).toBe(true)
    expect(plan(mail({ ask: true }), [], o).launch[0].warn).toBe(true)
  })
  it('coalesces a burst to one card into one flight', () => {
    const air: Air[] = [{ key: 'f1', from: 'cos', to: 'mgr', mails: ['m0'], t0: 0 }]
    // The same pair joins however long the sheet has flown.
    expect(plan(mail({ id: 'm2' }), air, o).join).toEqual([{ key: 'f1', mail: 'm2', warn: false }])
    // Another sender joins only a sheet that has just left.
    expect(plan(mail({ id: 'm3', from: 'dev1' }), air, o).launch).toHaveLength(1)
    expect(plan(mail({ id: 'm3', from: 'dev1' }), air, { ...o, now: 300 }).join).toEqual([{ key: 'f1', mail: 'm3', warn: false }])
    // An ask that joins turns the sheet the warning hue.
    expect(plan(mail({ id: 'm4', ask: true }), air, o).join).toEqual([{ key: 'f1', mail: 'm4', warn: true }])
  })
  it('caps the sheets in the air and lands the rest', () => {
    const air: Air[] = Array.from({ length: 23 }, (_, i) => ({ key: 'f' + i, from: 'x', to: 'y' + i, mails: [], t0: 0 }))
    const p = plan(mail({ to: ['mgr', 'dev1', 'human'] }), air, o)
    expect(p.launch.map((l) => l.to)).toEqual(['mgr'])
    expect(p.land.map((l) => l.to)).toEqual(['dev1', 'human'])
  })
  it('lands everything under reduced motion', () => {
    const p = plan(mail({ to: ['mgr', 'human'] }), [], { ...o, still: true })
    expect(p.launch).toEqual([])
    expect(p.land).toEqual([{ to: 'mgr', mail: 'm1', warn: false }, { to: 'human', mail: 'm1', warn: true }])
  })
})

describe('stacks', () => {
  it('hold their count while sheets fly to them, but a read still shrinks them', () => {
    expect(stackCount(5, undefined)).toBe(5)
    expect(stackCount(5, 3)).toBe(3)
    expect(stackCount(2, 3)).toBe(2)
  })
})

describe('wires as flight paths', () => {
  const NODES: TreeIn[] = [{ id: 'human', parent: null }, { id: 'cos', parent: 'human' }, { id: 'a', parent: 'cos' }, { id: 'b', parent: 'cos' }, { id: 'a1', parent: 'a' }, { id: 'a2', parent: 'a' }]
  const at = (b: Bez, t: number) => bezAt(b, t)
  it('a curve rides from the parent\'s foot to the child\'s head', () => {
    const l = treeLayout(NODES, { w: 200, h: 100, gapX: 20, gapY: 50, indent: 20, rowGap: 10 })
    const w = l.wires.find((x) => x.id === 'a')!
    const p = l.pos.get('cos')!, c = l.pos.get('a')!
    // From the parent's foot, at the child's port across its middle (layout.ts), to the child's head.
    const start = at(w.bez, 0)
    expect(start.y).toBeCloseTo(p.y + 100, 6)
    expect(start.x).toBeGreaterThanOrEqual(p.x + 50)
    expect(start.x).toBeLessThanOrEqual(p.x + 150)
    close(at(w.bez, 1), { x: c.x + 100, y: c.y })
  })
  it('a rail rides from the parent\'s foot, past the siblings above, into the child', () => {
    const l = treeLayout(NODES, { w: 200, h: 100, gapX: 20, gapY: 50, indent: 20, rowGap: 10 })
    const w = l.wires.find((x) => x.id === 'a2')!
    const p = l.pos.get('a')!, c = l.pos.get('a2')!
    close(at(w.bez, 0), { x: p.x + 10, y: p.y + 100 })
    close(at(w.bez, 1), { x: c.x, y: c.y + 50 })
  })
})

describe('routes', () => {
  const pts = (r: ReturnType<typeof route>) => Array.from({ length: 401 }, (_, i) => routeAt(r, i / 400))
  it('walk a chain of segments by length', () => {
    const r = route([line({ x: 0, y: 0 }, { x: 10, y: 0 }), line({ x: 10, y: 0 }, { x: 10, y: 30 })])
    expect(r.len).toBeCloseTo(40)
    close(routeAt(r, 0.25), { x: 10, y: 0 })
    close(routeAt(r, 0.5), { x: 10, y: 10 })
    close(routeAt(r, 1), { x: 10, y: 30 })
  })
  it('round a polyline\'s corners and keep its ends', () => {
    const r = route(rails([{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 40, y: 50 }], 6))
    close(routeAt(r, 0), { x: 0, y: 0 })
    close(routeAt(r, 1), { x: 40, y: 50 })
    // The corner is cut, never overshot.
    for (const p of pts(r)) { expect(p.x).toBeGreaterThanOrEqual(-1e-9); expect(p.y).toBeLessThanOrEqual(50 + 1e-9) }
  })

  // cos over release, assistant and sv, its children, laid as the Tree lays them.
  const ol = treeLayout([{ id: 'human', parent: null }, { id: 'cos', parent: 'human' }, { id: 'release', parent: 'cos' }, { id: 'assistant', parent: 'cos' }, { id: 'sv', parent: 'cos' }], { w: 200, h: 60, gapX: 20, gapY: 50, indent: 20, rowGap: 10 })
  const D = { cardH: 60, landIn: 8, pad: 16, gap: 16, corner: 6, lift: 120, top: -16 }
  const card = (id: string) => ol.pos.get(id)!
  const wireOf = (id: string, down: boolean) => ({ bez: ol.wires.find((w) => w.id === id)!.bez, down, kind: 'curve' as const })

  it('start and end on the stack spots', () => {
    const r = flightRoute(card('cos'), card('sv'), wireOf('sv', true), D)
    close(routeAt(r, 0), stackSpot(card('cos'), D))
    close(routeAt(r, 1), stackSpot(card('sv'), D))
    const up = flightRoute(card('sv'), card('cos'), wireOf('sv', false), D)
    close(routeAt(up, 0), stackSpot(card('sv'), D))
    close(routeAt(up, 1), stackSpot(card('cos'), D))
  })
  it('in Stars ride the ray between the orbs\' stacks, both ways', () => {
    const l = starsLayout([{ id: 'h', parent: null }, { id: 'c', parent: 'h', cost: 9 }, { id: 'a', parent: 'c', cost: 1 }, { id: 'b', parent: 'a', cost: 4 }],
      { rMin: 12, rMax: 32, rHuman: 24, labelW: 104, labelH: 32, labelGap: 4, gap: 8, pad: 16 })
    const w = l.wires.find((x) => x.id === 'b')!
    const P = l.pos.get('a')!, C = l.pos.get('b')!
    const r = flightRoute(P, C, { bez: w.bez, down: true, kind: 'ray' }, { ...D, landIn: 0 })
    close(routeAt(r, 0), stackSpot(P, { landIn: 0 }))
    close(routeAt(r, 1), stackSpot(C, { landIn: 0 }))
    expect(pts(r).some((q) => Math.hypot(q.x - bezAt(w.bez, 0.5).x, q.y - bezAt(w.bez, 0.5).y) < 1)).toBe(true)
    const up = flightRoute(C, P, { bez: w.bez, down: false, kind: 'ray' }, { ...D, landIn: 0 })
    close(routeAt(up, 0), stackSpot(C, { landIn: 0 }))
    close(routeAt(up, 1), stackSpot(P, { landIn: 0 }))
  })
  it('on the desktop ride the wire between the stack spots', () => {
    const l = treeLayout([{ id: 'p', parent: null }, { id: 'a', parent: 'p' }, { id: 'b', parent: 'p' }, { id: 'a1', parent: 'a' }, { id: 'b1', parent: 'b' }], { w: 200, h: 100, gapX: 20, gapY: 50, indent: 20, rowGap: 10 })
    const w = l.wires.find((x) => x.id === 'a')!
    const r = flightRoute(l.pos.get('p')!, l.pos.get('a')!, { bez: w.bez, down: true, kind: 'curve' }, { ...D, cardH: 100, landIn: 0 })
    close(routeAt(r, 0), stackSpot(l.pos.get('p')!, { landIn: 0 }))
    close(routeAt(r, 1), stackSpot(l.pos.get('a')!, { landIn: 0 }))
    // It rides the wire, and never crosses a card's inside.
    const ps = pts(r)
    expect(ps.some((q) => Math.abs(q.x - bezAt(w.bez, 0.5).x) < 1 && Math.abs(q.y - bezAt(w.bez, 0.5).y) < 1)).toBe(true)
    const inside = (q: { x: number; y: number }) => [...l.pos.values()].some((c) => q.x > c.x + 8 && q.x < c.x + c.w - 8 && q.y > c.y + 8 && q.y < c.y + 100 - 8)
    expect(ps.filter(inside)).toEqual([])
    const up = flightRoute(l.pos.get('a')!, l.pos.get('p')!, { bez: w.bez, down: false, kind: 'curve' }, { ...D, cardH: 100, landIn: 0 })
    close(routeAt(up, 0), stackSpot(l.pos.get('a')!, { landIn: 0 }))
    close(routeAt(up, 1), stackSpot(l.pos.get('p')!, { landIn: 0 }))
  })
  it('fly a free arc between other cards, stack spot to stack spot', () => {
    const r = flightRoute(card('release'), card('assistant'), null, D)
    expect(r.segs).toHaveLength(1)
    close(routeAt(r, 0), stackSpot(card('release'), D))
    close(routeAt(r, 1), stackSpot(card('assistant'), D))
  })
})

describe('splitBez', () => {
  it('cuts out the stretch between two times', () => {
    const b: Bez = [1, 2, 5, -7, 9, 14, 20, 3]
    const s = splitBez(b, 0.2, 0.7)
    close(bezAt(s, 0), bezAt(b, 0.2))
    close(bezAt(s, 1), bezAt(b, 0.7))
    close(bezAt(s, 0.5), bezAt(b, 0.45))
    close(bezAt(splitBez(b, 0.3, 1), 1), bezAt(b, 1))
  })
})
