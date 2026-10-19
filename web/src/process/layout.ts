// Auto-layout for the process view. Pure: it takes a Process and the geometry, runs Dagre, and
// returns placed nodes and lane bands. The view reads the geometry from tokens (process.css) and
// passes it in, so no size is written here.
//
// Dagre lays a directed graph out along one axis (left-to-right or top-to-bottom). Swimlanes are
// orthogonal to that axis, so after Dagre runs, each lane is placed in its own band: a lane's
// nodes keep their Dagre coordinate on the flow axis and are shifted onto the lane's band on the
// other axis. That gives clean bands without Dagre needing to know about them.
import dagre from '@dagrejs/dagre'
import type { NodeKind, Process } from './types'

export type Direction = 'LR' | 'TB'

export interface Box { w: number; h: number }
export interface Metrics {
  boxes: Record<NodeKind, Box>
  lanePad: number
  laneGap: number
  margin: number
  nodesep: number
  ranksep: number
  // The phone column (layoutColumn): the row heights, the gap between rows, and the step between
  // the side edges' loops in the right gutter. Optional: a layout that never runs a column omits them.
  rowH?: number
  rowHStart?: number
  rowGap?: number
  edgeStep?: number
}

export interface Placed { id: string; x: number; y: number; w: number; h: number }
export interface LaneBand { id: string; label: string; x: number; y: number; w: number; h: number }
export interface LayoutResult { nodes: Placed[]; lanes: LaneBand[]; width: number; height: number }

export interface LayoutNode { id: string; kind: NodeKind; lane: string; w: number; h: number }
export interface LayoutEdge { from: string; to: string }
export interface LayoutInput { nodes: LayoutNode[]; edges: LayoutEdge[] }

// The Lane's display name: its label, else its type, else the key it is stored under.
export function laneLabel(lane: string, p: Process): string {
  const l = p.lanes[lane]
  return l?.label ?? l?.type ?? lane
}

// What Dagre is given: every node with its box, and every edge whose ends both exist.
export function layoutInput(p: Process, m: Metrics): LayoutInput {
  const ids = Object.keys(p.nodes)
  const nodes = ids.map((id): LayoutNode => {
    const kind = p.nodes[id].kind
    const b = m.boxes[kind] ?? m.boxes.agent
    return { id, kind, lane: p.nodes[id].lane, w: b.w, h: b.h }
  })
  const edges = p.edges.filter((e) => p.nodes[e.from] && p.nodes[e.to]).map((e): LayoutEdge => ({ from: e.from, to: e.to }))
  return { nodes, edges }
}

// The lanes in band order: those the process declares first, then any a node names but the process
// does not declare. Only lanes that hold a node get a band.
export function laneOrder(p: Process): string[] {
  const seen: string[] = Object.keys(p.lanes)
  for (const id of Object.keys(p.nodes)) { const l = p.nodes[id].lane; if (!seen.includes(l)) seen.push(l) }
  return seen.filter((l) => Object.keys(p.nodes).some((id) => p.nodes[id].lane === l))
}

export function layoutProcess(p: Process, dir: Direction, m: Metrics): LayoutResult {
  const input = layoutInput(p, m)
  const g = new dagre.graphlib.Graph()
  g.setGraph({
    rankdir: dir,
    nodesep: dir === 'LR' ? m.nodesep : m.nodesep * 0.75,
    ranksep: dir === 'LR' ? m.ranksep : m.ranksep * 0.8,
    marginx: m.margin,
    marginy: m.margin,
  })
  g.setDefaultEdgeLabel(() => ({}))
  for (const n of input.nodes) g.setNode(n.id, { width: n.w, height: n.h })
  for (const e of input.edges) g.setEdge(e.from, e.to)
  dagre.layout(g)

  const raw = new Map<string, { x: number; y: number; w: number; h: number }>()
  for (const n of input.nodes) {
    const r = g.node(n.id) as { x: number; y: number; width: number; height: number }
    raw.set(n.id, { x: r.x, y: r.y, w: r.width, h: r.height })
  }

  const nodes: Placed[] = []
  const lanes: LaneBand[] = []
  if (dir === 'LR') {
    let top = m.margin
    for (const lane of laneOrder(p)) {
      const group = input.nodes.filter((n) => n.lane === lane)
      const minY = Math.min(...group.map((n) => raw.get(n.id)!.y - raw.get(n.id)!.h / 2))
      const maxY = Math.max(...group.map((n) => raw.get(n.id)!.y + raw.get(n.id)!.h / 2))
      const bandH = maxY - minY + m.lanePad * 2
      for (const n of group) {
        const r = raw.get(n.id)!
        nodes.push({ id: n.id, x: r.x - r.w / 2, y: top + m.lanePad + (r.y - r.h / 2 - minY), w: r.w, h: r.h })
      }
      lanes.push({ id: lane, label: laneLabel(lane, p), x: m.margin / 2, y: top, w: 0, h: bandH })
      top += bandH + m.laneGap
    }
  } else {
    let left = m.margin
    for (const lane of laneOrder(p)) {
      const group = input.nodes.filter((n) => n.lane === lane)
      const minX = Math.min(...group.map((n) => raw.get(n.id)!.x - raw.get(n.id)!.w / 2))
      const maxX = Math.max(...group.map((n) => raw.get(n.id)!.x + raw.get(n.id)!.w / 2))
      const bandW = maxX - minX + m.lanePad * 2
      for (const n of group) {
        const r = raw.get(n.id)!
        nodes.push({ id: n.id, x: left + m.lanePad + (r.x - r.w / 2 - minX), y: r.y - r.h / 2, w: r.w, h: r.h })
      }
      lanes.push({ id: lane, label: laneLabel(lane, p), x: left, y: m.margin / 2, w: bandW, h: 0 })
      left += bandW + m.laneGap
    }
  }

  const width = Math.max(...nodes.map((n) => n.x + n.w), 0) + m.margin
  const height = Math.max(...nodes.map((n) => n.y + n.h), 0) + m.margin
  for (const b of lanes) { if (dir === 'LR') b.w = width - m.margin; else b.h = height - m.margin }
  return { nodes, lanes, width, height }
}

// ---- The phone column --------------------------------------------------------------------
// Under 600 px the flow is one vertical column: every node a full-width row, in flow order, with
// its lane named on the node instead of drawn as a band. An edge between neighbouring rows runs
// straight down; any other edge loops through a gutter on the right.

export interface ColumnResult { nodes: Placed[]; order: string[]; gutter: number; width: number; height: number }

export interface EdgeRoute { side: boolean; k: number }

// Which edges loop through the gutter, and each loop's lane in it (k, narrowest span first so the
// nested loops don't cross). Aligned with the edges given.
export function routeEdges(order: string[], edges: LayoutEdge[]): EdgeRoute[] {
  const at = new Map(order.map((id, i) => [id, i]))
  const routes: EdgeRoute[] = edges.map((e) => ({ side: at.get(e.to)! !== at.get(e.from)! + 1, k: 0 }))
  const span = (i: number) => Math.abs(at.get(edges[i].to)! - at.get(edges[i].from)!)
  routes.map((r, i) => (r.side ? i : -1)).filter((i) => i >= 0).sort((a, b) => span(a) - span(b) || a - b).forEach((i, k) => { routes[i].k = k })
  return routes
}

// The column: Dagre decides the flow order (rank, then position within it); the rows are then
// stacked at that order and sized so the column and its gutter fill `paneW`.
export function layoutColumn(p: Process, m: Metrics, paneW: number): ColumnResult {
  const input = layoutInput(p, m)
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB' })
  g.setDefaultEdgeLabel(() => ({}))
  for (const n of input.nodes) g.setNode(n.id, { width: n.w, height: n.h })
  for (const e of input.edges) g.setEdge(e.from, e.to)
  dagre.layout(g)
  const pos = (id: string) => g.node(id) as { x: number; y: number }
  const order = input.nodes.map((n) => n.id).sort((a, b) => pos(a).y - pos(b).y || pos(a).x - pos(b).x)
  const rowH = m.rowH ?? m.boxes.agent.h
  const rowHStart = m.rowHStart ?? m.boxes.start.h
  const gap = m.rowGap ?? m.nodesep
  const step = m.edgeStep ?? m.laneGap
  const side = routeEdges(order, input.edges).filter((r) => r.side).length
  const gutter = side ? step * (side + 2) : 0
  const x = m.margin / 2
  const colW = Math.max(paneW - x * 2 - gutter, 0)
  let y = m.margin
  const nodes: Placed[] = order.map((id) => {
    const h = p.nodes[id].kind === 'start' ? rowHStart : rowH
    const placed = { id, x, y, w: colW, h }
    y += h + gap
    return placed
  })
  return { nodes, order, gutter, width: x * 2 + colW + gutter, height: y - gap + m.margin }
}
