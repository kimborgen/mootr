// The Work page's grouping: roots with something under them are groups, their descendants
// rows in tree order with their depth, lone roots one trailing group, and ancestors the
// filter or the open-only view would hide kept as context rows.
import { describe, expect, it } from 'vitest'
import type { Itsa } from '../types'
import type { CellContext } from './columns'
import type { SortFilterCol } from './sortfilter'
import { agentIdsOf, FLAT, foldRows, groupByAgent, groupFlat, groupFor, groupWork, pruneFolded, since, STANDALONE, UNOWNED, type AgentNode, type GroupOptions } from './model'

let n = 0
const mk = (key: string, parent: string | null, status = 'todo', more: Partial<Itsa> = {}): Itsa => ({
  id: key, key, parent_id: parent, kind: null, title: 'Title ' + key, summary: null, body: null, status, owner: null, thread_id: null,
  created_by: 'human', created_at: new Date(1_700_000_000_000 + n++ * 1000).toISOString(), updated_at: '2026-10-12T00:00:00Z', closed_at: null, ...more,
})
const closed = (x: Itsa) => x.status === 'done'
const opts = (o: Partial<GroupOptions> = {}): GroupOptions => ({ show: 'open', text: '', closed, ...o })
const shape = (gs: ReturnType<typeof groupWork>) => gs.map((g) => [g.id, g.rows.map((r) => `${r.it.key}@${r.depth}${r.context ? '~' : ''}`)])

const tree = [
  mk('A', null, 'in_progress'),
  mk('A1', 'A'),
  mk('A1a', 'A1', 'in_review', { summary: 'needle in here' }),
  mk('A2', 'A', 'done'),
  mk('B', null, 'done'),
  mk('B1', 'B', 'done'),
  mk('C', null),
  mk('D', null, 'done'),
  mk('E', 'gone'),
]

describe('groupWork', () => {
  it('groups open work by root, descendants in tree order with their depth', () => {
    expect(shape(groupWork(tree, opts()))).toEqual([
      ['A', ['A1@0', 'A1a@1']],
      [STANDALONE, ['C@0', 'E@0']],
    ])
  })

  it('shows closed ones too when asked for all', () => {
    expect(shape(groupWork(tree, opts({ show: 'all' })))).toEqual([
      ['A', ['A1@0', 'A1a@1', 'A2@0']],
      ['B', ['B1@0']],
      [STANDALONE, ['C@0', 'D@0', 'E@0']],
    ])
  })

  it('keeps a hidden ancestor as context for a row under it', () => {
    const xs = [mk('P', null), mk('Q', 'P', 'done'), mk('R', 'Q')]
    expect(shape(groupWork(xs, opts()))).toEqual([['P', ['Q@0~', 'R@1']]])
  })

  it('filters by key, title, or summary, case aside, keeping the path to a match', () => {
    expect(shape(groupWork(tree, opts({ text: 'NEEDLE' })))).toEqual([['A', ['A1@0~', 'A1a@1']]])
    expect(shape(groupWork(tree, opts({ text: 'c' })))).toEqual([[STANDALONE, ['C@0']]])
    expect(groupWork(tree, opts({ text: 'nothing like it' }))).toEqual([])
  })

  it('survives a parent cycle', () => {
    const xs = [mk('R0', null), mk('X', 'Y'), mk('Y', 'X')]
    expect(shape(groupWork(xs, opts()))).toEqual([[STANDALONE, ['R0@0']]])
  })
})

describe('groupByAgent', () => {
  // The agent tree: r has children r0 (older) and r1, r1 has r1a; s is a second root; t's
  // parent is one the store doesn't know, so t is a root too.
  const agents: AgentNode[] = [
    { id: 'r', name: 'Root', harness: 'claude-code', parents: [], created_at: '2026-10-01T00:00:00Z' },
    { id: 'r1', name: 'Mid', harness: 'codex', parents: ['r'], created_at: '2026-10-03T00:00:00Z' },
    { id: 'r1a', name: 'Leaf', harness: 'opencode', parent_id: 'r1', created_at: '2026-10-04T00:00:00Z' },
    { id: 'r0', name: 'Older', harness: 'claude-code', parents: ['r'], created_at: '2026-10-02T00:00:00Z' },
    { id: 's', name: 'Other', harness: 'claude-code', parents: ['gone'], created_at: '2026-10-05T00:00:00Z' },
    { id: 't', name: 'Empty', harness: 'claude-code', parents: ['r'], created_at: '2026-10-06T00:00:00Z' },
  ]
  const owned = [
    mk('x1', null, 'todo', { owner: 'r1a' }),
    mk('x2', null, 'todo', { owner: 'r' }),
    mk('x3', null, 'done', { owner: 's' }),
    mk('x4', null, 'todo', { owner: 'ghost' }),
    mk('x5', null, 'todo', { owner: null }),
    mk('x6', null, 'todo', { owner: 's' }),
    mk('x7', null, 'todo', { owner: 'r0' }),
  ]

  it('groups by root agent: agents in tree order, each one\'s rows at its depth, then Unowned', () => {
    expect(shape(groupByAgent(owned, agents, opts()))).toEqual([
      ['r', ['x2@0', 'x7@1', 'x1@2']],
      ['s', ['x6@0']],
      [UNOWNED, ['x4@0', 'x5@0']],
    ])
  })

  it('heads each group with its root agent\'s name and harness', () => {
    const gs = groupByAgent(owned, agents, opts())
    expect(gs[0].agent).toEqual({ id: 'r', name: 'Root', harness: 'claude-code' })
    expect(gs[2].agent).toBeNull()
  })

  it('shows closed work too when asked for all, and skips an agent tree with nothing in it', () => {
    expect(shape(groupByAgent(owned, agents, opts({ show: 'all' })))).toEqual([
      ['r', ['x2@0', 'x7@1', 'x1@2']],
      ['s', ['x3@0', 'x6@0']],
      [UNOWNED, ['x4@0', 'x5@0']],
    ])
  })

  it('filters like the issue grouping does', () => {
    expect(shape(groupByAgent(owned, agents, opts({ text: 'x6' })))).toEqual([['s', ['x6@0']]])
  })

  it('lists an ITSA once per agent tree: at its owner when the owner is in that tree, else under a participant there', () => {
    // r1a (the owner) and r0 (a participant) are both in r's tree, so the row sits at the owner, not at r0.
    const xs = [mk('p1', null, 'todo', { owner: 'r1a', participants: ['human', 'r0', 'r1a', 's'] })]
    const gs = groupByAgent(xs, agents, opts())
    expect(shape(gs)).toEqual([
      ['r', ['p1@2']],
      ['s', ['p1@0']],
    ])
    expect(gs[0].rows[0].role).toBe('owner')
    expect(gs[1].rows[0].role).toBe('participant')
  })

  it('lists an ITSA once when its participant is the owner\'s parent', () => {
    const xs = [mk('p4', null, 'todo', { owner: 'r1a', participants: ['r'] })]
    expect(shape(groupByAgent(xs, agents, opts()))).toEqual([['r', ['p4@2']]])
  })

  it('counts an agent that is both owner and participant once, and never lists the human', () => {
    const xs = [mk('p2', null, 'todo', { owner: 's', participants: ['s', 'human', 'human'] })]
    expect(shape(groupByAgent(xs, agents, opts()))).toEqual([['s', ['p2@0']]])
  })

  it('keeps an ITSA with no known owner under Unowned, and under each known participant', () => {
    // t sits under r in the agent tree, so its participant row is at r's depth 1.
    const xs = [mk('p3', null, 'todo', { owner: 'ghost', participants: ['t'] })]
    expect(shape(groupByAgent(xs, agents, opts()))).toEqual([
      ['r', ['p3@1']],
      [UNOWNED, ['p3@0']],
    ])
  })

  it('survives a parent cycle', () => {
    const cyc: AgentNode[] = [{ id: 'a', name: 'A', harness: 'codex', parents: ['b'] }, { id: 'b', name: 'B', harness: 'codex', parents: ['a'] }]
    expect(groupByAgent([mk('y', null, 'todo', { owner: 'b' })], cyc, opts())).toEqual([])
  })
})

describe('groupFlat', () => {
  const xs = [
    mk('F1', null, 'todo', { updated_at: '2026-10-01T00:00:00Z' }),
    mk('F2', null, 'todo', { updated_at: '2026-10-10T00:00:00Z' }),
    mk('F3', 'F2', 'done', { updated_at: '2026-10-12T00:00:00Z' }),
    mk('F4', 'F3', 'todo', { updated_at: '2026-10-11T00:00:00Z' }),
  ]

  it('is one headless group of every open ITSA at depth 0, newest update first, with no context rows', () => {
    expect(shape(groupFlat(xs, opts()))).toEqual([[FLAT, ['F4@0', 'F2@0', 'F1@0']]])
  })

  it('lists closed work too when asked for all', () => {
    expect(shape(groupFlat(xs, opts({ show: 'all' })))[0][1]).toEqual(['F3@0', 'F4@0', 'F2@0', 'F1@0'])
  })

  it('is empty when nothing is wanted', () => {
    expect(groupFlat(xs.filter((x) => x.status === 'done'), opts())).toEqual([])
  })

  it('is picked by groupFor for the flat mode', () => {
    expect(groupFor('flat', xs, [], opts())).toEqual(groupFlat(xs, opts()))
    expect(groupFor('issues', xs, [], opts())).toEqual(groupWork(xs, opts()))
  })
})

describe('agentIdsOf', () => {
  it('names the owner first, then other participants, never the human', () => {
    expect(agentIdsOf({ owner: 'a1', participants: ['human', 'a2', 'a1'] })).toEqual(['a1', 'a2'])
    expect(agentIdsOf({ owner: 'human', participants: undefined })).toEqual([])
  })
})

describe('since', () => {
  const t = Date.parse('2026-10-12T12:00:00Z')
  it('says how long ago, short', () => {
    expect([30, 240, 7200, 86400 * 3, 86400 * 30].map((s) => since(new Date(t - s * 1000).toISOString(), t))).toEqual(['now', '4m', '2h', '3d', '4w'])
  })
})

// Sort and filter (S-1507): per-column values read through `cols`, applied at each level of the tree.
describe('sort and filter', () => {
  const cx = { now: 0, extras: {} } as unknown as CellContext
  const colList: SortFilterCol[] = [
    { id: 'title', sortValue: ({ it }) => it.title, filter: { kind: 'text', valueOf: ({ it }) => it.title } },
    { id: 'status', sortValue: ({ it }) => it.status, filter: { kind: 'values', valueOf: ({ it }) => it.status } },
    { id: 'rank', sortValue: ({ it }) => it.rank ?? null, filter: { kind: 'range', valueOf: ({ it }) => it.rank ?? null } },
  ]
  const cols = (id: string) => colList.find((c) => c.id === id)
  const so = (o: Partial<GroupOptions>) => opts({ cols, cx, ...o })
  const titled = (key: string, parent: string | null, title: string, more: Partial<Itsa> = {}) => mk(key, parent, 'todo', { title, ...more })
  const xs = [
    titled('P', null, 'Root'),
    titled('P1', 'P', 'Charlie', { rank: 2 }), titled('P2', 'P', 'Alpha', { rank: 1 }), titled('P3', 'P', 'Bravo'),
    titled('P2a', 'P2', 'Zed', { rank: 5 }), titled('P2b', 'P2', 'Yak', { rank: 4 }),
    titled('S1', null, 'Zulu'), titled('S2', null, 'Echo'),
  ]

  it('does nothing without sort or filters, or without a column lookup', () => {
    expect(groupWork(xs, so({}))).toEqual(groupWork(xs, opts()))
    expect(groupWork(xs, opts({ sort: [{ col: 'title', dir: 'asc' }], filters: { title: { kind: 'text', q: 'zzz' } } }))).toEqual(groupWork(xs, opts()))
  })

  it('sorts siblings at every level of the issue tree and keeps its shape', () => {
    expect(shape(groupWork(xs, so({ sort: [{ col: 'title', dir: 'asc' }] })))).toEqual([
      ['P', ['P2@0', 'P2b@1', 'P2a@1', 'P3@0', 'P1@0']],
      [STANDALONE, ['S2@0', 'S1@0']],
    ])
    expect(shape(groupWork(xs, so({ sort: [{ col: 'title', dir: 'desc' }] })))[0][1]).toEqual(['P1@0', 'P3@0', 'P2@0', 'P2a@1', 'P2b@1'])
  })

  it('orders the groups by their roots, and keeps blanks last either way', () => {
    const roots = [titled('R1', null, 'b', { rank: 2 }), titled('R2', null, 'a', { rank: null }), titled('R3', null, 'c', { rank: 1 }), titled('R1k', 'R1', 'k'), titled('R2k', 'R2', 'k'), titled('R3k', 'R3', 'k')]
    for (const [dir, want] of [['asc', ['R3', 'R1', 'R2']], ['desc', ['R1', 'R3', 'R2']]] as const) {
      expect(groupWork(roots, so({ sort: [{ col: 'rank', dir }] })).map((g) => g.id)).toEqual(want)
    }
  })

  it('filters with the show and text checks ANDed, keeping the path to a match as context', () => {
    expect(shape(groupWork(xs, so({ filters: { title: { kind: 'text', q: 'yak' } } })))).toEqual([['P', ['P2@0~', 'P2b@1']]])
    expect(shape(groupWork(xs, so({ text: 'a', filters: { title: { kind: 'text', q: 'z' } } })))).toEqual([['P', ['P2@0~', 'P2a@1']]])
    expect(groupWork(xs, so({ filters: { rank: { kind: 'range', min: 99 } } }))).toEqual([])
    expect(shape(groupWork(xs, so({ filters: { rank: { kind: 'range', min: 4 }, title: { kind: 'text', q: 'z' } } })))).toEqual([['P', ['P2@0~', 'P2a@1']]])
  })

  it('ignores a filter on a column that is gone or cannot apply it', () => {
    expect(groupWork(xs, so({ filters: { gone: { kind: 'has', has: true }, title: { kind: 'check', value: true } } }))).toEqual(groupWork(xs, opts()))
  })

  const agents: AgentNode[] = [
    { id: 'r', name: 'Root', harness: 'claude-code', parents: [], created_at: '2026-10-01T00:00:00Z' },
    { id: 'c', name: 'Kid', harness: 'codex', parents: ['r'], created_at: '2026-10-02T00:00:00Z' },
  ]
  const owned = [
    titled('o1', null, 'Mango', { owner: 'r' }), titled('o2', null, 'Apple', { owner: 'r' }), titled('o3', null, 'Pear', { owner: 'c' }),
    titled('o4', null, 'Kiwi', { owner: 'c' }), titled('u1', null, 'Fig'), titled('u2', null, 'Date'),
  ]

  it('sorts each agent\'s ITSAs and the Unowned ones, with the agents in tree order', () => {
    expect(shape(groupByAgent(owned, agents, so({ sort: [{ col: 'title', dir: 'asc' }] })))).toEqual([
      ['r', ['o2@0', 'o1@0', 'o4@1', 'o3@1']],
      [UNOWNED, ['u2@0', 'u1@0']],
    ])
  })

  it('filters the agent grouping', () => {
    expect(shape(groupByAgent(owned, agents, so({ filters: { title: { kind: 'text', q: 'i' } } })))).toEqual([['r', ['o4@1']], [UNOWNED, ['u1@0']]])
  })

  it('flat: one sorted list, newest update first without a sort and as the tie-break', () => {
    const flat = [
      titled('F1', null, 'b', { updated_at: '2026-10-01T00:00:00Z' }), titled('F2', null, 'a', { updated_at: '2026-10-02T00:00:00Z' }),
      titled('F3', null, 'b', { updated_at: '2026-10-03T00:00:00Z' }), titled('F4', null, 'c', { updated_at: '2026-10-04T00:00:00Z', status: 'done' }),
    ]
    expect(shape(groupFlat(flat, so({})))[0][1]).toEqual(['F3@0', 'F2@0', 'F1@0'])
    expect(shape(groupFlat(flat, so({ sort: [{ col: 'title', dir: 'asc' }] })))[0][1]).toEqual(['F2@0', 'F3@0', 'F1@0'])
    expect(shape(groupFlat(flat, so({ show: 'all', filters: { status: { kind: 'values', values: ['done'] } } })))[0][1]).toEqual(['F4@0'])
    expect(groupFor('flat', flat, [], so({ sort: [{ col: 'title', dir: 'desc' }] }))).toEqual(groupFlat(flat, so({ sort: [{ col: 'title', dir: 'desc' }] })))
  })

  it('handles a few hundred ITSAs: every one once, sorted within its level, filtered exactly', () => {
    const big: Itsa[] = []
    for (let r = 0; r < 12; r++) {
      big.push(titled(`R${r}`, null, `root ${r}`))
      for (let c = 0; c < 6; c++) {
        big.push(titled(`R${r}c${c}`, `R${r}`, `child ${(c * 7) % 6}`, { rank: c }))
        for (let g = 0; g < 4; g++) big.push(titled(`R${r}c${c}g${g}`, `R${r}c${c}`, `leaf ${(g * 3) % 4}`, { rank: g }))
      }
    }
    expect(big.length).toBe(12 * (1 + 6 * 5))
    const t0 = Date.now()
    const gs = groupWork(big, so({ sort: [{ col: 'title', dir: 'asc' }] }))
    expect(Date.now() - t0).toBeLessThan(2000)
    const rows = gs.flatMap((g) => g.rows)
    expect(new Set(rows.map((r) => r.it.key)).size).toBe(big.length - 12)
    for (const g of gs) {
      const kids = g.rows.filter((r) => r.depth === 0).map((r) => r.it.title)
      expect(kids).toEqual([...kids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })))
    }
    const hit = groupWork(big, so({ filters: { rank: { kind: 'range', min: 3, max: 3 } } }))
    const keep = hit.flatMap((g) => g.rows.filter((r) => !r.context)).map((r) => r.it.key)
    expect(keep.length).toBe(big.filter((x) => x.rank === 3 && x.parent_id).length)
    expect(groupFlat(big, so({ filters: { title: { kind: 'text', q: 'LEAF 2' } } }))[0].rows.length).toBe(12 * 6)
  })
})

describe('pruneFolded', () => {
  const folded = { 'column:agents:a1': true, 'column:agents:gone': true, 'column:agents:': true, 'column:status:todo': true, r1: true, 'agents:gone': true }
  it('drops the column:agents folds of agents that are gone and keeps the rest', () => {
    expect(pruneFolded(folded, new Set(['a1']))).toEqual({ 'column:agents:a1': true, 'column:agents:': true, 'column:status:todo': true, r1: true, 'agents:gone': true })
  })
  it('returns the same object when nothing is gone', () => {
    const f = { 'column:agents:a1': true }
    expect(pruneFolded(f, new Set(['a1']))).toBe(f)
  })
})

describe('foldRows', () => {
  const row = (id: string, depth: number) => ({ it: { id } as never, depth, context: false })
  const rows = [row('a', 0), row('a1', 1), row('a1x', 2), row('a2', 1), row('b', 0), row('c', 0), row('c1', 1)]
  it('counts the deeper rows after each row, and shows everything when nothing is folded', () => {
    const f = foldRows(rows, () => false)
    expect(f.rows.map((r) => r.it.id)).toEqual(['a', 'a1', 'a1x', 'a2', 'b', 'c', 'c1'])
    expect([...f.kids]).toEqual([['a', 3], ['a1', 1], ['c', 1]])
  })
  it('hides the subrows of a folded row up to the next row at its depth, and nested folds hide with it', () => {
    expect(foldRows(rows, (r) => r.it.id === 'a1').rows.map((r) => r.it.id)).toEqual(['a', 'a1', 'a2', 'b', 'c', 'c1'])
    expect(foldRows(rows, (r) => r.it.id === 'a' || r.it.id === 'a1').rows.map((r) => r.it.id)).toEqual(['a', 'b', 'c', 'c1'])
    expect(foldRows(rows, (r) => r.it.id === 'b').rows).toHaveLength(7)
  })
})
