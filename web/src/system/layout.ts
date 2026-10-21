// The system view's layouts (S-458), pure so they test without a browser: the desktop's org tree
// and the phone's tall columns, each a position per card and a wire per child. The desktop
// tree is tidy top-down, except that a node whose children are all leaves stacks them in a
// column under it, like an org chart, so forty agents fit one screen. d3-hierarchy builds and
// walks the tree; the placement is our own, since that leaf column isn't one of d3's layouts.
import { stratify, type HierarchyNode } from 'd3-hierarchy'
import type { Bez } from './flights'

// One card: its id and its parent's (null for the root). Children keep the order given. `cost`,
// its spend in dollars, sizes its orb in Stars mode (stars.ts).
export interface TreeIn { id: string; parent: string | null; cost?: number }
export interface Dims {
  // A card's width and height.
  w: number
  h: number
  // Between sibling subtrees, and between a row of cards and the row of children under it.
  gapX: number
  gapY: number
  // A stacked column's indent from its parent's left edge, and the gap between its cards.
  indent: number
  rowGap: number
}
export interface Pos { x: number; y: number; w: number; depth: number }
// A wire from a parent to one child, keyed by the child: a curve from the parent's foot to the
// child's head, or a rail down the column's left with an elbow into the child. `bez` is the path
// a mail sheet rides between the two (S-459): the curve itself, or a cubic that hugs the rail
// from the parent's foot, since the drawn rail starts at the sibling above. A spoke is the Cards
// mode's wire (orbits.ts, S-460), from centre to centre; a ray the Stars mode's (stars.ts, S-539),
// from orb edge to orb edge.
export interface Wire { id: string; from: string; kind: 'curve' | 'rail' | 'spoke' | 'ray'; d: string; bez: Bez }
// `hub`: a radial mode's centre, which mail between teams swings through, and `orbits` the faint
// guides drawn round it, by their semi-axes (orbits.ts). `stacksOut`: mail stacks sit out past
// each card's corner, at screen size (Cards, where cards are drawn small). `cols`: how many columns
// the phone's Cards laid the cards in (S-784): 1 for the one column, more when the subtrees packed.
export interface Laid { pos: Map<string, Pos>; wires: Wire[]; width: number; height: number; hub?: { x: number; y: number }; orbits?: { rx: number; ry: number }[]; stacksOut?: boolean; cols?: number }

type N = HierarchyNode<TreeIn> & { w?: number; h?: number; col?: boolean }

// The nodes as a d3 hierarchy, with a folded node's children left out. A node whose parent is
// missing hangs from the root, so one bad parent id never drops a subtree.
export function build(nodes: TreeIn[], folded: ReadonlySet<string> = new Set()): N {
  const ids = new Set(nodes.map((n) => n.id))
  const root = nodes.find((n) => n.parent === null)
  if (!root) throw new Error('the tree needs a root')
  const fixed = nodes.map((n) => (n === root || (n.parent && ids.has(n.parent)) ? n : { ...n, parent: root.id }))
  const h = stratify<TreeIn>().id((d) => d.id).parentId((d) => d.parent)(fixed) as N
  h.each((n) => { if (folded.has(n.id!) && n.children) { (n as N & { _kids?: N[] })._kids = n.children; n.children = undefined } })
  return h
}

const kids = (n: N) => (n.children ?? []) as N[]

// The desktop tree.
export function treeLayout(nodes: TreeIn[], dims: Dims, folded: ReadonlySet<string> = new Set()): Laid {
  const { w: CW, h: CH, gapX, gapY, indent, rowGap } = dims
  const root = build(nodes, folded)
  // Sizes, children first: a leaf is one card; a column is the parent over its stacked leaves;
  // a row is the parent over its children's subtrees side by side.
  root.eachAfter((n: N) => {
    const ks = kids(n)
    if (!ks.length) { n.w = CW; n.h = CH; return }
    n.col = ks.every((k) => !k.children)
    if (n.col) { n.w = indent + CW; n.h = CH + ks.length * (CH + rowGap); return }
    n.w = Math.max(CW, ks.reduce((s, k) => s + k.w!, 0) + gapX * (ks.length - 1))
    n.h = CH + gapY + Math.max(...ks.map((k) => k.h!))
  })
  const pos = new Map<string, Pos>()
  const wires: Wire[] = []
  const place = (n: N, x: number, y: number) => {
    const ks = kids(n)
    if (!ks.length) { pos.set(n.id!, { x, y, w: CW, depth: n.depth }); return }
    if (n.col) {
      pos.set(n.id!, { x, y, w: CW, depth: n.depth })
      ks.forEach((k, i) => place(k, x + indent, y + CH + rowGap + i * (CH + rowGap)))
      return
    }
    const span = ks.reduce((s, k) => s + k.w!, 0) + gapX * (ks.length - 1)
    let cx = x + (n.w! - span) / 2
    for (const k of ks) { place(k, cx, y + CH + gapY); cx += k.w! + gapX }
    // The parent centres over its first and last child cards, not over their whole subtrees.
    const l = pos.get(ks[0].id!)!.x
    const r = pos.get(ks[ks.length - 1].id!)!.x + CW
    pos.set(n.id!, { x: (l + r) / 2 - CW / 2, y, w: CW, depth: n.depth })
  }
  place(root, 0, 0)
  // Everything starts at x 0: the leftmost card may sit right of the root's box.
  const minX = Math.min(...[...pos.values()].map((p) => p.x))
  if (minX !== 0) for (const p of pos.values()) p.x -= minX
  root.each((n: N) => {
    const ks = kids(n)
    const p = pos.get(n.id!)!
    ks.forEach((k, i) => {
      const c = pos.get(k.id!)!
      if (n.col) {
        // Each child's rail runs from the elbow above it (or the parent's foot), so no stretch
        // of rail is drawn twice.
        const from = i === 0 ? p.y + CH : pos.get(ks[i - 1].id!)!.y + CH / 2
        const x = p.x + indent / 2, y = c.y + CH / 2
        wires.push({ id: k.id!, from: n.id!, kind: 'rail', d: rail(x, from, c.x, y), bez: [x, p.y + CH, x, y, x, y, c.x, y] })
      } else {
        // The curves leave the parent's foot spread across its middle, in the children's order, so
        // a wide row fans out from the card instead of knotting at one point (S-462).
        const port = ks.length > 1 ? (i / (ks.length - 1) - 0.5) * CW * PORTS : 0
        const x1 = p.x + CW / 2 + port, y1 = p.y + CH, x2 = c.x + CW / 2, m = (y1 + c.y) / 2
        wires.push({ id: k.id!, from: n.id!, kind: 'curve', d: curve(x1, y1, x2, c.y), bez: [x1, y1, x1, m, x2, m, x2, c.y] })
      }
    })
  })
  return { pos, wires, width: Math.max(...[...pos.values()].map((p) => p.x + p.w)), height: root.h! }
}

// How much of a parent's width its curves leave across: its middle half.
const PORTS = 0.5
// A rounded elbow's radius: small enough for the phone's 12 px indent.
const R = 4
export const curve = (x1: number, y1: number, x2: number, y2: number) => {
  const m = (y1 + y2) / 2
  return `M${r1(x1)} ${r1(y1)}C${r1(x1)} ${r1(m)} ${r1(x2)} ${r1(m)} ${r1(x2)} ${r1(y2)}`
}
export const rail = (x: number, y1: number, x2: number, y2: number) => `M${r1(x)} ${r1(y1)}${elbow(x, y1, x2, y2)}`
// A rail from where the pen is, down at x to y2 and across to x2: the rail's stretch without its M.
const elbow = (x: number, y1: number, x2: number, y2: number) => {
  const r = Math.min(R, Math.max(0, (x2 - x) / 2), Math.max(0, (y2 - y1) / 2))
  return `V${r1(y2 - r)}Q${r1(x)} ${r1(y2)} ${r1(x + r)} ${r1(y2)}H${r1(x2)}`
}
const r1 = (v: number) => Math.round(v * 10) / 10
// Cards on a phone (S-705): every card a full card in one column, depth-first, each level stepping in
// by `indent`, so a tall narrow screen shows them at full size and the rest is a pan down. Each
// child hangs off its parent's trunk by a rail, as in the Tree's stacked column. The cards keep the
// Tree's size, so the width is a card and the deepest step in.
export function columnLayout(nodes: TreeIn[], dims: Pick<Dims, 'w' | 'h' | 'indent' | 'rowGap'>, folded: ReadonlySet<string> = new Set()): Laid {
  const { w: CW, h: CH, indent, rowGap } = dims
  const root = build(nodes, folded)
  const pos = new Map<string, Pos>()
  const wires: Wire[] = []
  let y = 0
  root.eachBefore((n: N) => {
    pos.set(n.id!, { x: n.depth * indent, y, w: CW, depth: n.depth })
    y += CH + rowGap
  })
  root.each((n: N) => {
    const p = pos.get(n.id!)!
    let from = p.y + CH
    for (const k of kids(n)) {
      const c = pos.get(k.id!)!
      const x = p.x + indent / 2, cy = c.y + CH / 2
      wires.push({ id: k.id!, from: n.id!, kind: 'rail', d: rail(x, from, c.x, cy), bez: [x, p.y + CH, x, cy, x, cy, c.x, cy] })
      from = cy
    }
  })
  return { pos, wires, width: Math.max(...[...pos.values()].map((q) => q.x + q.w)), height: y - rowGap, stacksOut: true, cols: 1 }
}

// The width the phone's one column would take: a card plus the deepest step in, no wires.
export function columnWidth(nodes: TreeIn[], dims: Pick<Dims, 'w' | 'indent'>, folded: ReadonlySet<string> = new Set()): number {
  const root = build(nodes, folded)
  let d = 0
  root.each((n) => { if (n.depth > d) d = n.depth })
  return dims.w + d * dims.indent
}

// Cards zoomed out on a phone (S-784). Zoomed far out, the one column leaves most of a narrow pane
// empty, so the top-level subtrees lie side by side as columns that pack into the pane's own shape:
// every whole subtree keeps its tree lines inside its own column, and the human and the chief of
// staff stay a spine above them, wired down to each column's root. The cards keep the Tree's size,
// so a column's width is a card plus its deepest step in. `cols` fixes the number of columns (the
// two-column option at Fit); 0 picks the number whose arrangement best matches `aspect`, the pane's
// width over its height.
export interface PackDims { w: number; h: number; indent: number; rowGap: number; gapX: number; gapY: number }
// One subtree laid out as its own column, and one rail per child for the wires built once it lands.
interface PackSub { top: N; list: N[]; w: number; h: number; x: Map<string, Pos>; edges: PackEdge[] }
interface PackEdge { id: string; from: string; ax: number; start: number; foot: number; cx: number; cy: number }

// The subtrees split into `n` columns, each new one to the shortest, so the columns balance; the
// column of each subtree, and the arrangement's size, with `gapX` between columns and `rowGap`
// between the subtrees stacked in one.
export function packColumns(subs: readonly { w: number; h: number }[], n: number, gapX: number, rowGap: number): { groups: number[][]; w: number; h: number } {
  const groups: number[][] = Array.from({ length: n }, () => [])
  const hs = new Array(n).fill(0)
  const room = (j: number) => hs[j] + (groups[j].length ? rowGap : 0)
  subs.forEach((s, i) => {
    let c = i < n ? i : 0
    for (let j = 1; j < n; j++) if (room(j) < room(c)) c = j
    groups[c].push(i)
    hs[c] = room(c) + s.h
  })
  const w = groups.reduce((s, ids, c) => s + (c ? gapX : 0) + Math.max(0, ...ids.map((i) => subs[i].w)), 0)
  return { groups, w, h: hs.length ? Math.max(...hs) : 0 }
}

// The column count whose arrangement comes closest in shape to a pane of `aspect` (its width over
// its height): the one whose packed width over height is nearest it, log-scaled so both ways count.
export function bestColumns(subs: readonly { w: number; h: number }[], aspect: number, gapX: number, rowGap: number): number {
  let best = 1, score = Infinity
  for (let n = 1; n <= subs.length; n++) {
    const { w, h } = packColumns(subs, n, gapX, rowGap)
    const s = Math.abs(Math.log((w / Math.max(1, h)) / Math.max(1e-3, aspect)))
    if (s < score - 1e-6) { score = s; best = n }
  }
  return best
}

export function packLayout(nodes: TreeIn[], dims: PackDims, folded: ReadonlySet<string> = new Set(), cols = 0, aspect = 1): Laid {
  const { w: CW, h: CH, indent, rowGap, gapX, gapY } = dims
  const root = build(nodes, folded)
  // The spine runs down from the root while each node has exactly one child; the columns are the
  // children of the node where it first branches (the human over the chief of staff, or the root).
  let branch = root
  while (kids(branch).length === 1) branch = kids(branch)[0]
  const spine: N[] = []
  for (let n: N = root; ; n = kids(n)[0]) { spine.push(n); if (n === branch) break }
  // Each subtree as its own column, depth first, a level stepping in, as columnLayout.
  const colOf = (top: N): PackSub => {
    const list: N[] = []
    top.eachBefore((n) => list.push(n))
    const rel = (n: N) => n.depth - top.depth
    const x = new Map<string, Pos>()
    list.forEach((n, i) => x.set(n.id!, { x: rel(n) * indent, y: i * (CH + rowGap), w: CW, depth: n.depth }))
    const edges: PackEdge[] = []
    for (const n of list) {
      const p = x.get(n.id!)!
      // As in columnLayout, each rail starts at the elbow above it, so no stretch is drawn twice;
      // `foot` is the parent's own foot, where the bez (a mail sheet's path) leaves it.
      let from = p.y + CH
      for (const k of kids(n)) {
        const c = x.get(k.id!)!
        edges.push({ id: k.id!, from: n.id!, ax: p.x + indent / 2, start: from, foot: p.y + CH, cx: c.x, cy: c.y + CH / 2 })
        from = c.y + CH / 2
      }
    }
    return { top, list, w: CW + Math.max(...list.map(rel)) * indent, h: list.length * CH + (list.length - 1) * rowGap, x, edges }
  }
  const subs = kids(branch).map(colOf)
  const n = subs.length ? (cols > 0 ? Math.min(cols, subs.length) : bestColumns(subs, aspect, gapX, rowGap)) : 1
  const packed = subs.length ? packColumns(subs, n, gapX, rowGap) : { groups: [] as number[][], w: 0, h: 0 }
  const pos = new Map<string, Pos>()
  const wires: Wire[] = []
  // The spine stands above the columns, centred over them, one wire down each step.
  const spineBottom = spine.length * CH + (spine.length - 1) * rowGap
  const top = spineBottom + (subs.length ? gapY : 0)
  // A stacked root's rail runs in the gutter half a gap left of its column, so the first column
  // shifts right by that half gap, and only when it holds a stacked root, so no other layout moves.
  const lead = packed.groups[0]?.length > 1 ? gapX / 2 : 0
  const sx = lead + Math.max(0, (packed.w - CW) / 2)
  spine.forEach((sp, i) => {
    pos.set(sp.id!, { x: sx, y: i * (CH + rowGap), w: CW, depth: sp.depth })
    if (i) {
      const p = pos.get(spine[i - 1].id!)!
      const x1 = sx + CW / 2, y1 = p.y + CH, y2 = p.y + CH + rowGap, m = (y1 + y2) / 2
      wires.push({ id: sp.id!, from: spine[i - 1].id!, kind: 'curve', d: curve(x1, y1, x1, y2), bez: [x1, y1, x1, m, x1, m, x1, y2] })
    }
  })
  // The chief of staff's wire to a root stacked below another subtree in its column can't be a curve:
  // it would pass behind the cards above. It runs down its column's left rail instead, with an elbow
  // into the root. The column's first stacked root takes a lane: a curve from the foot to the top of
  // its gutter, then down the rail. The rest hang off the rail where the wire above them left. `rails`
  // holds, per stacked root, its rail's x, where its rail starts, and whether it takes a lane.
  const rails = new Map<string, { x: number; from: number; lane: boolean }>()
  let cx = lead
  packed.groups.forEach((ids) => {
    let cy = top
    let prev = 0
    ids.forEach((i, j) => {
      const s = subs[i]
      for (const nd of s.list) { const p = s.x.get(nd.id!)!; pos.set(nd.id!, { x: cx + p.x, y: cy + p.y, w: CW, depth: nd.depth }) }
      for (const e of s.edges) {
        const ax = cx + e.ax, st = cy + e.start, foot = cy + e.foot, e2x = cx + e.cx, e2y = cy + e.cy
        wires.push({ id: e.id, from: e.from, kind: 'rail', d: rail(ax, st, e2x, e2y), bez: [ax, foot, ax, e2y, ax, e2y, e2x, e2y] })
      }
      if (j) rails.set(s.top.id!, { x: cx - gapX / 2, from: prev, lane: j === 1 })
      prev = cy + CH / 2
      cy += s.h + rowGap
    })
    cx += Math.max(0, ...ids.map((i) => subs[i].w)) + gapX
  })
  // The chief of staff's wires that leave its foot, fanned across it in the order they meet the
  // columns' top edge: a curve meets it at its root's centre, a lane at its gutter's rail. Every such
  // wire is the same S-curve from the foot to that point on the edge, so with the ports in the same
  // order no two cross: two curves that share their ends' heights never cross if their ends keep
  // their order. A lane's rail then runs down its gutter below the edge, where no chief wire is, so
  // its curve needs no height of its own. (The old lanes ran level across under the curves, and no
  // height cleared both neighbours.)
  const bp = pos.get(branch.id!)!
  const mid = bp.x + CW / 2
  const roots = subs.map((s) => ({ id: s.top.id!, p: pos.get(s.top.id!)! })).sort((a, b) => a.p.x - b.p.x)
  const laned = roots.filter((r) => rails.get(r.id)?.lane)
  const curves = roots.filter((r) => !rails.has(r.id))
  const meet = (r: { id: string; p: Pos }) => rails.get(r.id)?.lane ? rails.get(r.id)!.x : r.p.x + CW / 2
  const fan = [...laned, ...curves].sort((a, b) => meet(a) - meet(b))
  const port = (i: number) => mid + (fan.length > 1 ? (i / (fan.length - 1) - 0.5) * CW * PORTS : 0)
  const y1 = bp.y + CH
  fan.forEach((r, i) => {
    const x1 = port(i), y2 = top, side = rails.get(r.id)
    if (side?.lane) {
      // Down its rail from the edge, then across into the root: the rail's own bez, from the edge.
      const x = side.x, cy = r.p.y + CH / 2
      wires.push({ id: r.id, from: branch.id!, kind: 'rail', d: curve(x1, y1, x, y2) + elbow(x, y2, r.p.x, cy), bez: [x, y2, x, cy, x, cy, r.p.x, cy] })
    } else {
      const x2 = r.p.x + CW / 2, m = (y1 + y2) / 2
      wires.push({ id: r.id, from: branch.id!, kind: 'curve', d: curve(x1, y1, x2, y2), bez: [x1, y1, x1, m, x2, m, x2, y2] })
    }
  })
  // The stacked roots below a column's first hang off its rail, each from the elbow above it.
  for (const r of roots) {
    const side = rails.get(r.id)
    if (!side || side.lane) continue
    const cy = r.p.y + CH / 2
    wires.push({ id: r.id, from: branch.id!, kind: 'rail', d: rail(side.x, side.from, r.p.x, cy), bez: [side.x, side.from, side.x, cy, side.x, cy, r.p.x, cy] })
  }
  return { pos, wires, width: Math.max(packed.w + lead, sx + CW), height: top + packed.h, stacksOut: true, cols: subs.length ? n : 1 }
}

// Every descendant of a node in the full tree, folded or not.
export function descendants(nodes: TreeIn[], id: string): string[] {
  const by = new Map<string, string[]>()
  for (const n of nodes) if (n.parent) by.set(n.parent, [...(by.get(n.parent) ?? []), n.id])
  const out: string[] = []
  const walk = (x: string) => { for (const k of by.get(x) ?? []) { out.push(k); walk(k) } }
  walk(id)
  return out
}
