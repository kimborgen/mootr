import { describe, expect, it } from 'vitest'
import { bezAt, flightRoute, routeAt, type Bez } from './flights'
import { agentBadgeRows, agentCardHeight, agentFootRows, bestColumns, columnLayout, columnWidth, descendants, nestedRows, packLayout, treeLayout, type TreeIn, type Wire } from './layout'
import { defaultCardLayout } from '../card-layout'

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
  // The straight stretches of a path: each M, V, H, Q or C (its end) from where the pen was; a cubic
  // is sampled into short stretches.
  const stretches = (d: string) => {
    const out: number[][] = []
    let x = 0, y = 0
    for (const [, c, args] of d.matchAll(/([MVHCQ])([^MVHCQ]*)/g)) {
      const v = args.trim().split(/[\s,]+/).map(Number)
      if (c === 'C') {
        let p = { x, y }
        for (let i = 1; i <= 16; i++) { const q = bezAt([x, y, ...v] as Bez, i / 16); out.push([p.x, p.y, q.x, q.y]); p = q }
        x = p.x; y = p.y
        continue
      }
      const [nx, ny] = c === 'V' ? [x, v[0]] : c === 'H' ? [v[0], y] : [v[v.length - 2], v[v.length - 1]]
      if (c !== 'M') out.push([x, y, nx, ny])
      x = nx; y = ny
    }
    return out
  }
  // A wire's drawn segments: a rail's stretches, a curve's sampled.
  const segs = (w: Wire): number[][] => w.kind === 'curve'
    ? Array.from({ length: 40 }, (_, i) => { const a = bezAt(w.bez, i / 40), b = bezAt(w.bez, (i + 1) / 40); return [a.x, a.y, b.x, b.y] })
    : stretches(w.d)
  // Whether two segments cross, or lie along one another (a stretch drawn twice); an end touching the
  // other doesn't count.
  const crosses = ([ax, ay, bx, by]: number[], [cx, cy, dx, dy]: number[]) => {
    const side = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px))
    const s1 = side(ax, ay, bx, by, cx, cy), s2 = side(ax, ay, bx, by, dx, dy)
    const s3 = side(cx, cy, dx, dy, ax, ay), s4 = side(cx, cy, dx, dy, bx, by)
    if (s1 === 0 && s2 === 0) {
      // Collinear: they overlap when their spans do, along x or along y.
      const span = (p: number, q: number, r: number, s: number) => Math.min(Math.max(p, q), Math.max(r, s)) - Math.max(Math.min(p, q), Math.min(r, s))
      return span(ax, bx, cx, dx) > 1e-6 || span(ay, by, cy, dy) > 1e-6
    }
    return s1 * s2 < 0 && s3 * s4 < 0
  }

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

  it('runs the chief of staff\'s wire to a stacked root down the left rail, clear of the cards above', () => {
    // One column: the subtrees stack, so the two below the first take a rail, not a curve.
    const one = packLayout(NODES, P, new Set(), 1, 1)
    const cards = [...one.pos.values()]
    const rails = one.wires.filter((w) => w.from === 'cos' && w.kind === 'rail')
    expect(rails.map((w) => w.id).sort()).toEqual(['lead', 'mgr'])
    // A stretch crosses a card when it runs through the card's inside.
    const crosses = ([x1, y1, x2, y2]: number[], p: { x: number; y: number }) =>
      Math.min(x1, x2) < p.x + DIMS.w - 0.01 && Math.max(x1, x2) > p.x + 0.01 &&
      Math.min(y1, y2) < p.y + DIMS.h - 0.01 && Math.max(y1, y2) > p.y + 0.01
    for (const w of rails) {
      for (const s of stretches(w.d)) {
        expect(s[0]).toBeGreaterThanOrEqual(0)
        for (const p of cards) expect(crosses(s, p)).toBe(false)
      }
    }
    // The stacked root's rail drops left of its own column, down to the root's level.
    for (const w of rails) {
      const drops = stretches(w.d).filter((s) => s[0] === s[2] && Math.max(s[1], s[3]) > at(w.id).y)
      expect(drops.length).toBeGreaterThan(0)
      for (const s of drops) expect(s[0]).toBeLessThan(at(w.id).x)
    }
  })

  it('never crosses two of the chief of staff\'s wires, at one, two or three columns', () => {
    for (const n of [1, 2, 3]) {
      const ws = packLayout(NODES, P, new Set(), n, 1).wires.filter((w) => w.from === 'cos')
      const ss = ws.map(segs)
      for (let a = 0; a < ws.length; a++) for (let b = a + 1; b < ws.length; b++)
        for (const s of ss[a]) for (const t of ss[b]) expect(crosses(s, t)).toBe(false)
    }
  })

  it('never crosses the chief of staff\'s wires with five subtrees, where a middle column stacks', () => {
    const leaves: TreeIn[] = [{ id: 'human', parent: null }, { id: 'cos', parent: 'human' }, ...['A', 'B', 'C', 'D', 'E'].map((id) => ({ id, parent: 'cos' }))]
    for (const n of [3, 4]) {
      const lay = packLayout(leaves, P, new Set(), n, 1)
      const ws = lay.wires.filter((w) => w.from === 'cos')
      // Some root sits below another in its column, so a rail is in play.
      expect(ws.some((w) => w.kind === 'rail')).toBe(true)
      const ss = ws.map(segs)
      for (let a = 0; a < ws.length; a++) for (let b = a + 1; b < ws.length; b++)
        for (const s of ss[a]) for (const t of ss[b]) expect([n, ws[a].id, ws[b].id, crosses(s, t)]).toEqual([n, ws[a].id, ws[b].id, false])
    }
  })

  // Whether a stretch runs through a card's inside.
  const through = ([x1, y1, x2, y2]: number[], p: { x: number; y: number }) =>
    Math.min(x1, x2) < p.x + DIMS.w - 0.01 && Math.max(x1, x2) > p.x + 0.01 &&
    Math.min(y1, y2) < p.y + DIMS.h - 0.01 && Math.max(y1, y2) > p.y + 0.01
  // The chief of staff's wires of a packing: none crosses or overlaps another, none runs through a
  // card, and every mail route to a child misses every card.
  const checkChief = (lay: ReturnType<typeof packLayout>, ctx: string) => {
    const ws = lay.wires.filter((w) => w.from === 'cos')
    const cards = [...lay.pos.values()]
    const ss = ws.map(segs)
    const bad: string[] = []
    for (let a = 0; a < ws.length; a++) {
      for (const s of ss[a]) for (const p of cards) if (through(s, p)) bad.push(`${ws[a].id} runs through a card`)
      for (let b = a + 1; b < ws.length; b++)
        for (const s of ss[a]) for (const t of ss[b]) if (crosses(s, t)) bad.push(`${ws[a].id} crosses ${ws[b].id}`)
    }
    const D = { cardH: DIMS.h, landIn: 0, pad: 16, gap: 16, corner: 6, lift: 120, top: -16 }
    // A route lands in its child's stack, at the child's own edge, so only the other cards count.
    for (const w of ws) {
      const r = flightRoute(lay.pos.get('cos')!, lay.pos.get(w.id)!, { bez: w.bez, down: true, kind: w.kind }, D)
      const others = [...lay.pos].filter(([id]) => id !== 'cos' && id !== w.id).map(([, p]) => p)
      for (let i = 0; i <= 200; i++) {
        const q = routeAt(r, i / 200)
        if (others.some((p) => q.x > p.x + 1 && q.x < p.x + DIMS.w - 1 && q.y > p.y + 1 && q.y < p.y + DIMS.h - 1)) bad.push(`${w.id}'s mail runs through a card`)
      }
    }
    expect([ctx, bad.slice(0, 3)]).toEqual([ctx, []])
  }
  // A seeded generator, so the random packings repeat.
  const rng = (seed: number) => () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 2 ** 32 }
  // The chief of staff under `subs` top-level subtrees, each a leaf or a small tree, so some stack.
  const randomTree = (rand: () => number, subs: number): TreeIn[] => {
    const out: TreeIn[] = [{ id: 'human', parent: null }, { id: 'cos', parent: 'human' }]
    let k = 0
    const grow = (parent: string, depth: number) => {
      const n = 1 + Math.floor(rand() * 4)
      for (let i = 0; i < n; i++) {
        const id = `n${k++}`
        out.push({ id, parent })
        if (depth < 2 && rand() < 0.5) grow(id, depth + 1)
      }
    }
    for (let s = 0; s < subs; s++) {
      const id = `t${s}`
      out.push({ id, parent: 'cos' })
      if (rand() < 0.8) grow(id, 1)
    }
    return out
  }

  it('keeps every chief wire clear for random packings at one to six columns', () => {
    const rand = rng(7)
    for (let trial = 0; trial < 40; trial++) {
      const nodes = randomTree(rand, 1 + Math.floor(rand() * 7))
      for (let n = 1; n <= 6; n++) checkChief(packLayout(nodes, P, new Set(), n, 1), `trial ${trial}, ${n} columns`)
    }
  })

  it('keeps the chief of staff\'s wires clear in the repro: A over B and E, C and D, E\'s lane clear of both curves', () => {
    // A is a manager over two leaves, B to E are leaves: the packing is [[A], [B, E], [C], [D]].
    const nodes: TreeIn[] = [
      { id: 'human', parent: null }, { id: 'cos', parent: 'human' },
      { id: 'A', parent: 'cos' }, { id: 'a1', parent: 'A' }, { id: 'a2', parent: 'A' },
      { id: 'B', parent: 'cos' }, { id: 'C', parent: 'cos' }, { id: 'D', parent: 'cos' }, { id: 'E', parent: 'cos' },
    ]
    const lay = packLayout(nodes, P, new Set(), 4, 1)
    expect(lay.pos.get('E')!.x).toBe(lay.pos.get('B')!.x)
    expect(lay.pos.get('E')!.y).toBeGreaterThan(lay.pos.get('B')!.y)
    expect(lay.wires.find((w) => w.id === 'E')!.kind).toBe('rail')
    checkChief(lay, 'repro')
  })

  it('lets a mail sheet ride a stacked root\'s rail and miss every card', () => {
    const one = packLayout(NODES, P, new Set(), 1, 1)
    const D = { cardH: DIMS.h, landIn: 0, pad: 16, gap: 16, corner: 6, lift: 120, top: -16 }
    for (const w of one.wires.filter((x) => x.from === 'cos' && x.kind === 'rail')) {
      const r = flightRoute(one.pos.get('cos')!, one.pos.get(w.id)!, { bez: w.bez, down: true, kind: 'rail' }, D)
      for (let i = 0; i <= 400; i++) {
        const q = routeAt(r, i / 400)
        for (const p of one.pos.values()) {
          expect(q.x > p.x + 1 && q.x < p.x + DIMS.w - 1 && q.y > p.y + 1 && q.y < p.y + DIMS.h - 1).toBe(false)
        }
      }
    }
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

describe('agent card height (S-1438 PR 4)', () => {
  it('is today\'s card with the default layout: one nested row, so the base height, and it moves a row per nested row', () => {
    const rows = nestedRows(defaultCardLayout('issue'), defaultCardLayout('agent'))
    expect(rows).toBe(1)
    expect(agentCardHeight(96, 16, rows)).toBe(96)
    expect(agentCardHeight(96, 16, 2)).toBe(112)
    expect(agentCardHeight(96, 16, 0)).toBe(80)
  })

  it('is 96 px for the default agent layout, read through its own rows (PR 8)', () => {
    const agent = defaultCardLayout('agent')
    expect(agentCardHeight(96, 16, nestedRows(defaultCardLayout('issue'), agent), agentBadgeRows(agent), agentFootRows(agent))).toBe(96)
  })

  it('shrinks by one row for an empty BADGES, and for an empty FOOT, with no row left drawn (PR 8; the PR 4 code gives 96 for both)', () => {
    expect(agentCardHeight(96, 16, 1, 0, 1)).toBe(80)
    expect(agentCardHeight(96, 16, 1, 1, 0)).toBe(80)
    expect(agentCardHeight(96, 16, 0, 0, 0)).toBe(48)
    const agent = { ...defaultCardLayout('agent'), slots: { ...defaultCardLayout('agent').slots, BADGES: [], FOOT: [] } }
    expect(agentBadgeRows(agent)).toBe(0)
    expect(agentFootRows(agent)).toBe(0)
    expect(agentCardHeight(96, 16, 1, agentBadgeRows(agent), agentFootRows(agent))).toBe(64)
  })

  it('counts the nested rows: the issue layout\'s BADGES and FOOT add one each, and an ISSUE slot left out adds none', () => {
    const agent = defaultCardLayout('agent')
    const issue = { ...defaultCardLayout('issue'), slots: { TOP: [], META: [], BADGES: ['status'], FOOT: ['updated'] } }
    expect(nestedRows(issue, agent)).toBe(3)
    expect(nestedRows(issue, { ...agent, slots: { ...agent.slots, ISSUE: [] } })).toBe(0)
  })

  it('draws no row for an owner alone, or for a BADGES item the agent card already draws (it draws once, on the agent card)', () => {
    const agent = { ...defaultCardLayout('agent'), slots: { ...defaultCardLayout('agent').slots, BADGES: ['health', 'field:stage'] } }
    const owner = { ...defaultCardLayout('issue'), slots: { TOP: [], META: [], BADGES: ['owner'], FOOT: ['owner'] } }
    expect(nestedRows(owner, agent)).toBe(1)
    const shared = { ...defaultCardLayout('issue'), slots: { TOP: [], META: [], BADGES: ['field:stage'], FOOT: [] } }
    expect(nestedRows(shared, agent)).toBe(1)
    expect(nestedRows({ ...shared, slots: { ...shared.slots, BADGES: ['field:stage', 'field:other'] } }, agent)).toBe(2)
  })
})
