// The pure parts of the process view: the count badge's formatting and the layout's input
// building and placement. No React, no Dagre inside a component.
import { describe, expect, it } from 'vitest'
import { badgeFor, countBadge, nodeBadge } from './badge'
import { layoutInput, laneLabel, laneOrder, layoutColumn, layoutProcess, routeEdges, type Metrics, type Placed } from './layout'
import { DEV_CHANGE } from './fixture'
import type { Process } from './types'

const M: Metrics = {
  boxes: {
    start: { w: 240, h: 120 }, end: { w: 144, h: 80 }, wait: { w: 144, h: 80 },
    agent: { w: 192, h: 64 }, human: { w: 192, h: 64 }, script: { w: 192, h: 64 },
    exclusive: { w: 72, h: 72 }, parallel: { w: 72, h: 72 },
  },
  lanePad: 16, laneGap: 12, margin: 24, nodesep: 32, ranksep: 72,
}

const overlaps = (a: Placed, b: Placed) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

describe('count badge', () => {
  it('shows the count, muted when it is zero', () => {
    expect(countBadge(3)).toEqual({ text: '3', muted: false })
    expect(countBadge(0)).toEqual({ text: '0', muted: true })
    expect(countBadge(undefined)).toEqual({ text: '0', muted: true })
  })

  it('gives no badge to a node without statuses, whatever the count', () => {
    expect(nodeBadge({ kind: 'exclusive', lane: 'reviewer' }, 4)).toBeNull()
    expect(nodeBadge({ kind: 'agent', lane: 'developer', statuses: ['in_progress'] }, 4)).toEqual({ text: '4', muted: false })
  })

  it('reads the count from a process counts map by node id', () => {
    expect(badgeFor('code', DEV_CHANGE.nodes.code, DEV_CHANGE.counts)).toEqual({ text: '10', muted: false })
    expect(badgeFor('request', DEV_CHANGE.nodes.request, DEV_CHANGE.counts)).toBeNull()
    expect(badgeFor('code', DEV_CHANGE.nodes.code, undefined)).toEqual({ text: '0', muted: true })
  })
})

describe('layout input', () => {
  it('gives Dagre every node with its kind box and every edge between known nodes', () => {
    const input = layoutInput(DEV_CHANGE, M)
    expect(input.nodes.map((n) => n.id).sort()).toEqual(Object.keys(DEV_CHANGE.nodes).sort())
    expect(input.nodes.find((n) => n.id === 'code')).toMatchObject({ kind: 'agent', w: 192, h: 64, lane: 'developer' })
    expect(input.nodes.find((n) => n.id === 'request')).toMatchObject({ kind: 'start', w: 240, h: 120 })
    expect(input.edges).toHaveLength(DEV_CHANGE.edges.length)
  })

  it('drops an edge whose end is not a node', () => {
    const p: Process = {
      id: 'x', title: 'X', lanes: { a: { type: 'a' } },
      nodes: { one: { kind: 'start', lane: 'a' } }, edges: [{ from: 'one', to: 'ghost' }],
    }
    expect(layoutInput(p, M).edges).toEqual([])
  })

  it('names lanes by label, else type, and keeps an undeclared lane', () => {
    expect(laneLabel('cos', DEV_CHANGE)).toBe('Chief of staff')
    expect(laneLabel('human', DEV_CHANGE)).toBe('human')
    const p: Process = { id: 'x', title: 'X', lanes: {}, nodes: { n: { kind: 'agent', lane: 'stray' } }, edges: [] }
    expect(laneOrder(p)).toEqual(['stray'])
    expect(laneLabel('stray', p)).toBe('stray')
  })
})

describe('layout placement', () => {
  const chain = ['request', 'code', 'review', 'verdict', 'approve', 'merge', 'deploy', 'done']

  it('left to right: bands stack down the page and the flow moves right', () => {
    const l = layoutProcess(DEV_CHANGE, 'LR', M)
    const pos = new Map(l.nodes.map((n) => [n.id, n]))
    for (let i = 1; i < chain.length; i++) expect(pos.get(chain[i])!.x, chain[i]).toBeGreaterThan(pos.get(chain[i - 1])!.x)
    // A lane band is a full-width row, below the one before it.
    expect(l.lanes.map((b) => b.id)).toEqual(laneOrder(DEV_CHANGE))
    for (let i = 1; i < l.lanes.length; i++) expect(l.lanes[i].y).toBeGreaterThan(l.lanes[i - 1].y)
    for (const b of l.lanes) expect(b.w).toBe(l.width - M.margin)
  })

  it('top to bottom: bands sit side by side and the flow moves down', () => {
    const l = layoutProcess(DEV_CHANGE, 'TB', M)
    const pos = new Map(l.nodes.map((n) => [n.id, n]))
    for (let i = 1; i < chain.length; i++) expect(pos.get(chain[i])!.y, chain[i]).toBeGreaterThan(pos.get(chain[i - 1])!.y)
    for (let i = 1; i < l.lanes.length; i++) expect(l.lanes[i].x).toBeGreaterThan(l.lanes[i - 1].x)
    for (const b of l.lanes) expect(b.h).toBe(l.height - M.margin)
  })

  it('places every node inside the diagram and no two nodes overlap', () => {
    for (const dir of ['LR', 'TB'] as const) {
      const l = layoutProcess(DEV_CHANGE, dir, M)
      expect(l.nodes).toHaveLength(Object.keys(DEV_CHANGE.nodes).length)
      for (const n of l.nodes) {
        expect(n.x, `${dir} ${n.id} x`).toBeGreaterThanOrEqual(0)
        expect(n.y, `${dir} ${n.id} y`).toBeGreaterThanOrEqual(0)
        expect(n.x + n.w, `${dir} ${n.id} right`).toBeLessThanOrEqual(l.width)
        expect(n.y + n.h, `${dir} ${n.id} bottom`).toBeLessThanOrEqual(l.height)
      }
      for (let i = 0; i < l.nodes.length; i++) for (let j = i + 1; j < l.nodes.length; j++) {
        expect(overlaps(l.nodes[i], l.nodes[j]), `${dir} ${l.nodes[i].id} vs ${l.nodes[j].id}`).toBe(false)
      }
    }
  })

  it('puts every node in its lane\'s band', () => {
    const l = layoutProcess(DEV_CHANGE, 'LR', M)
    const band = new Map(l.lanes.map((b) => [b.id, b]))
    for (const n of l.nodes) {
      const lane = DEV_CHANGE.nodes[n.id].lane
      const b = band.get(lane)!
      expect(n.y, n.id).toBeGreaterThanOrEqual(b.y)
      expect(n.y + n.h, n.id).toBeLessThanOrEqual(b.y + b.h + 0.001)
    }
  })
})

describe('the phone column', () => {
  const CM: Metrics = { ...M, rowH: 64, rowHStart: 96, rowGap: 24, edgeStep: 8 }

  it('stacks every node in one column of rows, in flow order, that fills the pane', () => {
    const c = layoutColumn(DEV_CHANGE, CM, 360)
    expect(c.nodes).toHaveLength(Object.keys(DEV_CHANGE.nodes).length)
    expect(new Set(c.nodes.map((n) => n.x)).size).toBe(1)
    expect(new Set(c.nodes.map((n) => n.w)).size).toBe(1)
    expect(c.width).toBe(360)
    expect(c.nodes[0].x + c.nodes[0].w + c.gutter).toBeLessThanOrEqual(360)
    const at = (id: string) => c.order.indexOf(id)
    expect(at('request')).toBe(0)
    for (const [a, b] of [['request', 'code'], ['code', 'review'], ['review', 'verdict'], ['merge', 'deploy'], ['deploy', 'done']]) {
      if (DEV_CHANGE.nodes[a] && DEV_CHANGE.nodes[b]) expect(at(b), `${a} before ${b}`).toBeGreaterThan(at(a))
    }
    for (let i = 1; i < c.nodes.length; i++) expect(c.nodes[i].y).toBeGreaterThanOrEqual(c.nodes[i - 1].y + c.nodes[i - 1].h)
  })

  it('sends a non-neighbour edge through the gutter, narrowest loop innermost', () => {
    const order = ['a', 'b', 'c', 'd']
    const r = routeEdges(order, [{ from: 'a', to: 'b' }, { from: 'a', to: 'd' }, { from: 'c', to: 'a' }, { from: 'b', to: 'c' }])
    expect(r.map((x) => x.side)).toEqual([false, true, true, false])
    expect(r[2].k).toBeLessThan(r[1].k)
  })
})
