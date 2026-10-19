import { describe, expect, it } from 'vitest'
import { bestColumns, columnLayout, columnWidth, descendants, packLayout, treeLayout, type TreeIn } from './layout'

const DIMS = { w: 200, h: 100, gapX: 20, gapY: 50, indent: 20, rowGap: 10 }
// human > cos > (release, mgr > (dev1, dev2, review), lead > (sub > (x)))
const NODES: TreeIn[] = [
  { id: 'human', parent: null },
  { id: 'cos', parent: 'human' },
  { id: 'release', parent: 'cos' },
  { id: 'mgr', parent: 'cos' },
  { id: 'dev1', parent: 'mgr' },
  { id: 'dev2', parent: 'mgr' },
  { id: 'review', parent: 'mgr' },
  { id: 'lead', parent: 'cos' },
  { id: 'sub', parent: 'lead' },
  { id: 'x', parent: 'sub' },
]

describe('treeLayout', () => {
  const l = treeLayout(NODES, DIMS)
  const at = (id: string) => l.pos.get(id)!

  it('places every node, the human on top', () => {
    expect(l.pos.size).toBe(NODES.length)
    expect(at('human').y).toBe(0)
    expect(at('cos').y).toBe(DIMS.h + DIMS.gapY)
  })

  it('stacks a node whose children are all leaves in a column under it', () => {
    const m = at('mgr')
    expect(at('dev1')).toMatchObject({ x: m.x + DIMS.indent, y: m.y + DIMS.h + DIMS.rowGap })
    expect(at('dev2').y).toBe(at('dev1').y + DIMS.h + DIMS.rowGap)
    expect(at('review').x).toBe(at('dev1').x)
  })

  it('lays out other children side by side, the parent centred over them', () => {
    const row = ['release', 'mgr', 'lead'].map(at)
    expect(new Set(row.map((p) => p.y)).size).toBe(1)
    expect(row[0].x).toBeLessThan(row[1].x)
    expect(row[1].x).toBeLessThan(row[2].x)
    const c = at('cos')
    expect(c.x + DIMS.w / 2).toBeCloseTo((row[0].x + row[2].x + DIMS.w) / 2)
  })

  it('never overlaps two cards', () => {
    const ps = [...l.pos.values()]
    for (const a of ps) for (const b of ps) {
      if (a === b) continue
      const apart = a.x + DIMS.w <= b.x || b.x + DIMS.w <= a.x || a.y + DIMS.h <= b.y || b.y + DIMS.h <= a.y
      expect(apart).toBe(true)
    }
  })

  it('starts at x 0 and reports a size that holds every card', () => {
    const ps = [...l.pos.values()]
    expect(Math.min(...ps.map((p) => p.x))).toBe(0)
    for (const p of ps) { expect(p.x + DIMS.w).toBeLessThanOrEqual(l.width); expect(p.y + DIMS.h).toBeLessThanOrEqual(l.height) }
  })

  it('draws one wire per child: rails into a column, curves elsewhere', () => {
    expect(l.wires.map((w) => w.id).sort()).toEqual(NODES.filter((n) => n.parent).map((n) => n.id).sort())
    expect(l.wires.find((w) => w.id === 'dev2')).toMatchObject({ from: 'mgr', kind: 'rail' })
    expect(l.wires.find((w) => w.id === 'mgr')).toMatchObject({ from: 'cos', kind: 'curve' })
    // A curve runs from the parent's foot to the child's head.
    const c = at('cos'), m = at('mgr')
    expect(l.wires.find((w) => w.id === 'mgr')!.d).toMatch(new RegExp(`^M${c.x + DIMS.w / 2} ${c.y + DIMS.h}C.* ${m.x + DIMS.w / 2} ${m.y}$`))
  })

  it('spreads a row of curves across the parent\'s middle, in the children\'s order', () => {
    const c = at('cos')
    const start = (id: string) => Number(/^M([\d.]+) /.exec(l.wires.find((w) => w.id === id)!.d)![1])
    // release, mgr, lead: left of the middle, the middle, right of it, across half the card.
    expect(start('release')).toBeCloseTo(c.x + DIMS.w / 4, 1)
    expect(start('mgr')).toBeCloseTo(c.x + DIMS.w / 2, 1)
    expect(start('lead')).toBeCloseTo(c.x + (DIMS.w * 3) / 4, 1)
  })

  it('leaves a folded subtree out', () => {
    const f = treeLayout(NODES, DIMS, new Set(['mgr']))
    expect(f.pos.has('mgr')).toBe(true)
    for (const id of ['dev1', 'dev2', 'review']) expect(f.pos.has(id)).toBe(false)
    expect(f.wires.some((w) => w.from === 'mgr')).toBe(false)
  })

  it('hangs a node with an unknown parent from the root', () => {
    const f = treeLayout([...NODES, { id: 'orphan', parent: 'gone' }], DIMS)
    expect(f.wires.find((w) => w.id === 'orphan')?.from).toBe('human')
  })
})

it('descendants lists a whole subtree', () => {
  expect(descendants(NODES, 'lead')).toEqual(['sub', 'x'])
  expect(descendants(NODES, 'x')).toEqual([])
})

// Cards zoomed out on a phone (S-784): the top-level subtrees side by side in columns.
describe('packLayout', () => {
  const P = { ...DIMS, gapX: 20, gapY: 50 }
  const l = packLayout(NODES, P, new Set(), 0, 360 / 640)
  const at = (id: string) => l.pos.get(id)!
  // The top-level subtrees: what each column holds.
  const SUBS = [['release'], ['mgr', 'dev1', 'dev2', 'review'], ['lead', 'sub', 'x']]

  it('places every agent, and draws a wire per child', () => {
    expect([...l.pos.keys()].sort()).toEqual(NODES.map((n) => n.id).sort())
    expect(l.wires.map((w) => w.id).sort()).toEqual(NODES.filter((n) => n.parent).map((n) => n.id).sort())
  })

  it('never overlaps two cards', () => {
    const ps = [...l.pos.values()]
    for (const a of ps) for (const b of ps) {
      if (a === b) continue
      const apart = a.x + DIMS.w <= b.x || b.x + DIMS.w <= a.x || a.y + DIMS.h <= b.y || b.y + DIMS.h <= a.y
      expect(apart).toBe(true)
    }
  })

  it('gives every subtree its own column, its tree lines inside it', () => {
    const cs = SUBS.map((ids) => ({
      ids,
      x0: Math.min(...ids.map((id) => at(id).x)), x1: Math.max(...ids.map((id) => at(id).x + DIMS.w)),
      y0: Math.min(...ids.map((id) => at(id).y)), y1: Math.max(...ids.map((id) => at(id).y + DIMS.h)),
    }))
    // Two subtrees either stand side by side in different columns, or stack in the same one.
    for (const a of cs) for (const b of cs) if (a !== b) {
      const side = a.x1 <= b.x0 + 0.01 || b.x1 <= a.x0 + 0.01
      const stacked = a.y1 <= b.y0 + 0.01 || b.y1 <= a.y0 + 0.01
      expect(side || stacked).toBe(true)
    }
    // The subtrees fill exactly the columns the layout reports.
    expect(new Set(cs.map((c) => c.x0)).size).toBe(l.cols)
    // Every card of a subtree stays in its column.
    for (const c of cs) for (const id of c.ids) { expect(at(id).x).toBeGreaterThanOrEqual(c.x0 - 0.01); expect(at(id).x + DIMS.w).toBeLessThanOrEqual(c.x1 + 0.01) }
    // Every wire inside a subtree keeps to that column; the spine's and the chief of staff's fans
    // are the only ones that leave one.
    for (const w of l.wires) {
      const c = cs.find((x) => x.ids.includes(w.from))
      if (!c) continue
      expect(c.ids).toContain(w.id)
      for (const i of [0, 2, 4, 6]) { expect(w.bez[i]).toBeGreaterThanOrEqual(c.x0 - 0.01); expect(w.bez[i]).toBeLessThanOrEqual(c.x1 + 0.01) }
    }
    // The chief of staff's fan reaches every column's root.
    expect(l.wires.filter((w) => w.from === 'cos').map((w) => w.id).sort()).toEqual(['lead', 'mgr', 'release'])
  })

  it('keeps the human and the chief of staff a spine above the columns', () => {
    expect(at('human').y).toBe(0)
    expect(at('cos').y).toBe(DIMS.h + DIMS.rowGap)
    expect(at('human').x).toBe(at('cos').x)
    for (const id of ['release', 'mgr', 'lead']) expect(at(id).y).toBeGreaterThan(at('cos').y + DIMS.h)
  })

  it('packs into the width, in the shape that matches the pane', () => {
    // A wide pane wants more columns than a tall one.
    const squares = Array.from({ length: 9 }, () => ({ w: 100, h: 100 }))
    expect(bestColumns(squares, 2.5, 20, 10)).toBeGreaterThan(bestColumns(squares, 0.4, 20, 10))
    // Every card lies inside the size the layout reports.
    for (const p of l.pos.values()) { expect(p.x + p.w).toBeLessThanOrEqual(l.width); expect(p.y + DIMS.h).toBeLessThanOrEqual(l.height) }
    expect(l.cols).toBeGreaterThanOrEqual(1)
  })

  it('honours a fixed column count (the two-column option at Fit)', () => {
    expect(packLayout(NODES, P, new Set(), 2, 1).cols).toBe(2)
    expect(columnLayout(NODES, DIMS).cols).toBe(1)
  })

  it('leaves a folded manager\'s team out', () => {
    const f = packLayout(NODES, P, new Set(['mgr']))
    expect(f.pos.has('mgr')).toBe(true)
    for (const id of ['dev1', 'dev2', 'review']) expect(f.pos.has(id)).toBe(false)
    expect(f.wires.some((w) => w.from === 'mgr')).toBe(false)
  })

  it('reports the one column\'s width as a card plus the deepest step in', () => {
    expect(columnWidth(NODES, DIMS)).toBe(DIMS.w + 4 * DIMS.indent)
  })
})

describe('columnLayout (Cards on a phone)', () => {
  const l = columnLayout(NODES, DIMS)
  const at = (id: string) => l.pos.get(id)!

  it('lays every card out full size in one column, depth-first, a level stepping in', () => {
    expect(l.pos.size).toBe(NODES.length)
    expect([...l.pos.keys()]).toEqual(['human', 'cos', 'release', 'mgr', 'dev1', 'dev2', 'review', 'lead', 'sub', 'x'])
    for (const [i, id] of [...l.pos.keys()].entries()) {
      expect(at(id).w).toBe(DIMS.w)
      expect(at(id).y).toBe(i * (DIMS.h + DIMS.rowGap))
    }
    expect(at('human').x).toBe(0)
    expect(at('dev1').x).toBe(3 * DIMS.indent)
    expect(at('x').x).toBe(4 * DIMS.indent)
  })

  it('is a card wide, plus the deepest step in, and as tall as its rows', () => {
    expect(l.width).toBe(DIMS.w + 4 * DIMS.indent)
    expect(l.height).toBe(NODES.length * DIMS.h + (NODES.length - 1) * DIMS.rowGap)
  })

  it('draws a rail per child, and no card overlaps another', () => {
    expect(l.wires.map((w) => w.id).sort()).toEqual(NODES.filter((n) => n.parent).map((n) => n.id).sort())
    expect(l.wires.every((w) => w.kind === 'rail')).toBe(true)
    const ys = [...l.pos.values()].map((p) => p.y).sort((a, b) => a - b)
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(DIMS.h)
  })

  it('leaves a folded manager\'s team out', () => {
    expect(columnLayout(NODES, DIMS, new Set(['mgr'])).pos.has('dev1')).toBe(false)
  })
})
