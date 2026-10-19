// The text search across every column (S-1519): a row is found by any column's text, case aside,
// a match keeps its ancestors, and the per-ITSA string is built once until the ITSA or the extras change.
import { describe, expect, it } from 'vitest'
import type { Itsa } from '../types'
import type { CellContext } from './columns'
import { groupWork, type GroupOptions } from './model'
import { searchString } from './search'
import { WORK_COLUMNS } from './columns'
import { setData } from '../store'
import type { Agent } from '../types'
import type { SortFilterCol } from './sortfilter'

const mk = (key: string, parent: string | null, more: Partial<Itsa> = {}): Itsa => ({
  id: key, key, parent_id: parent, kind: null, title: 'Title ' + key, summary: null, body: null, status: 'todo', owner: null, thread_id: null,
  created_by: 'human', created_at: '2026-10-12T00:00:00Z', updated_at: '2026-10-12T00:00:00Z', closed_at: null, ...more,
})
const extras = () => ({ costs: null, activity: null, watch: {}, fields: null, fieldsFailed: false, fieldsStart: 0 }) as CellContext['extras']
const cx = (e = extras()): CellContext => ({ now: 0, extras: e })

let reads = 0
// Stand-ins for the agents and branch columns: the text comes from the ITSA's owner and title.
const cols: SortFilterCol[] = [
  { id: 'work', text: ({ it }) => `${it.key} ${it.title}` },
  { id: 'agents', text: ({ it }) => { reads++; return it.owner ? `Agent-${it.owner}` : '' } },
  { id: 'nofield' },
]
const opts = (o: Partial<GroupOptions> = {}): GroupOptions => ({ show: 'all', text: '', closed: () => false, searchCols: cols, cx: cx(), ...o })
const keys = (gs: ReturnType<typeof groupWork>) => gs.flatMap((g) => g.rows.map((r) => `${r.it.key}${r.context ? '~' : ''}`))

describe('search across columns', () => {
  const xs = [mk('A', null), mk('A1', 'A', { owner: 'Zebra' }), mk('B', null)]

  it('finds a row by a column other than key, title and summary, case aside', () => {
    expect(keys(groupWork(xs, opts({ text: 'ZEBRA' })))).toEqual(['A1'])
  })

  it('keeps the ancestors of a match as context and drops what does not match', () => {
    const got = groupWork(xs, opts({ text: 'agent-zebra' }))
    expect(got.map((g) => g.id)).toEqual(['A'])
    expect(keys(got)).toEqual(['A1'])
  })

  it('finds nothing when no column has the text', () => {
    expect(groupWork(xs, opts({ text: 'nowhere' }))).toEqual([])
  })

  it('reads only the key, title and summary without columns', () => {
    expect(groupWork(xs, opts({ text: 'zebra', searchCols: undefined }))).toEqual([])
  })

  it('builds a row\'s string once, until the ITSA, the extras or the columns change', () => {
    const it = mk('M', null, { owner: 'Mo' })
    const c = cx()
    reads = 0
    searchString(cols, it, c)
    searchString(cols, it, c)
    expect(reads).toBe(1)
    searchString(cols, { ...it, owner: 'Ned' }, c)
    expect(reads).toBe(2)
    expect(searchString(cols, it, cx())).toContain('agent-mo')
    expect(reads).toBe(3)
    searchString([...cols], it, c)
    expect(reads).toBe(4)
  })

  it('shows the new text after an update replaces the ITSA', () => {
    const c = cx()
    expect(searchString(cols, mk('M', null, { owner: 'Mo' }), c)).toContain('agent-mo')
    expect(searchString(cols, mk('M', null, { owner: 'Ned' }), c)).not.toContain('agent-mo')
  })

  it('rebuilds after the store\'s agents list is replaced, so a rename or a late list is found', () => {
    const it = mk('N', null, { owner: 'a1' })
    const c = cx()
    const agentsCol = [WORK_COLUMNS.find((x) => x.id === 'agents')!]
    setData({ agents: [] })
    expect(searchString(agentsCol, it, c)).toContain('a1')
    setData({ agents: [{ id: 'a1', name: 'Zebra' } as Agent] })
    expect(searchString(agentsCol, it, c)).toContain('zebra')
    setData({ agents: [{ id: 'a1', name: 'Yak' } as Agent] })
    expect(searchString(agentsCol, it, c)).toContain('yak')
    expect(searchString(agentsCol, it, c)).not.toContain('zebra')
  })

  it('does not search the updated column\'s raw ISO time', () => {
    const it = mk('U', null, { updated_at: '2026-10-12T00:00:00Z' })
    expect(searchString(WORK_COLUMNS.filter((x) => x.id === 'updated'), it, cx())).toBe('')
  })
})
