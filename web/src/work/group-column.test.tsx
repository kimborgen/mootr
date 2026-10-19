// Grouping by a column (S-1520): one group per value in the column's order, rows sorted by the
// view's sort inside, (Blank) last, a multi-agent row in each agent's group, filters and search
// still applied, empty groups not made. Uses the real built-in columns.
import { describe, expect, it } from 'vitest'
import { setData } from '../store'
import type { Itsa } from '../types'
import { WORK_COLUMNS, type CellContext } from './columns'
import { fieldColumn } from './field-columns'
import { groupable, groupByColumn, groupFor, type GroupOptions } from './model'
import { BLANK } from './sortfilter'

const mk = (key: string, status: string, more: Partial<Itsa> = {}): Itsa => ({
  id: key, key, parent_id: null, kind: null, title: 'Title ' + key, summary: null, body: null, status, owner: null, participants: [], thread_id: null,
  created_by: 'human', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-12T00:00:00Z', closed_at: null, ...more,
}) as Itsa
const cx = { now: Date.parse('2026-10-17T00:00:00Z'), extras: { costs: null, activity: null, watch: {}, fields: null, fieldsFailed: false, fieldsStart: 0 } } as unknown as CellContext
const cols = (id: string) => WORK_COLUMNS.find((c) => c.id === id)
const opts = (o: Partial<GroupOptions> = {}): GroupOptions => ({ show: 'open', text: '', closed: (x) => x.status === 'done', cols, cx, ...o })
const shape = (gs: ReturnType<typeof groupByColumn>) => gs.map((g) => [g.column!.label, g.rows.map((r) => r.it.key)])

setData({ itsaStatuses: [
  { name: 'todo', category: 'ready', human: false }, { name: 'in_progress', category: 'active', human: false },
  { name: 'in_review', category: 'review', human: false }, { name: 'backlog', category: 'backlog', human: false },
  { name: 'done', category: 'closed', human: false },
] } as never)

describe('groupable', () => {
  it('is any column with a values or check filter', () => {
    expect(WORK_COLUMNS.filter(groupable).map((c) => c.id)).toEqual(['status', 'agents', 'github', 'health', 'review', 'tests'])
    expect(groupable(undefined)).toBe(false)
  })
})

describe('groupByColumn', () => {
  const all = [mk('A', 'in_review'), mk('B', 'backlog'), mk('C', 'todo'), mk('D', 'in_progress'), mk('E', 'todo'), mk('F', 'done')]

  it('orders status groups by category, then status, and drops closed ones when only open shows', () => {
    const gs = groupByColumn(all, cols('status')!, opts())
    expect(gs.map((g) => g.column!.value)).toEqual(['backlog', 'todo', 'in_progress', 'in_review'])
    expect(gs.map((g) => g.id)).toEqual(['status:backlog', 'status:todo', 'status:in_progress', 'status:in_review'])
    expect(gs.find((g) => g.column!.value === 'todo')!.rows.map((r) => r.it.key)).toEqual(['C', 'E'])
    expect(gs.every((g) => g.rows.every((r) => r.depth === 0 && !r.context))).toBe(true)
  })

  it('includes closed statuses when all show, closed last', () => {
    expect(groupByColumn(all, cols('status')!, opts({ show: 'all' })).map((g) => g.column!.value).at(-1)).toBe('done')
  })

  it('sorts rows inside a group by the view sort, newest update first without one', () => {
    const xs = [mk('A', 'todo', { updated_at: '2026-10-01T00:00:00Z' }), mk('B', 'todo', { updated_at: '2026-10-03T00:00:00Z' }), mk('C', 'todo', { updated_at: '2026-10-02T00:00:00Z' })]
    expect(shape(groupByColumn(xs, cols('status')!, opts()))).toEqual([['todo', ['B', 'C', 'A']]])
    expect(shape(groupByColumn(xs, cols('status')!, opts({ sort: [{ col: 'updated', dir: 'asc' }] })))).toEqual([['todo', ['A', 'C', 'B']]])
  })

  it('puts rows with no value in a (Blank) group, last', () => {
    const xs = [mk('A', 'todo'), mk('B', 'todo', { health: 'at_risk' }), mk('C', 'todo', { health: 'on_track' })]
    const gs = groupByColumn(xs, cols('health')!, opts())
    expect(gs.map((g) => g.column!.label)).toEqual(['On track', 'At risk', '(Blank)'])
    expect(gs.at(-1)!.column!.value).toBe(BLANK)
    expect(gs.at(-1)!.rows.map((r) => r.it.key)).toEqual(['A'])
  })

  it('lists a row with several agents under each of them', () => {
    const xs = [mk('A', 'todo', { owner: 'a1', participants: ['a2', 'human'] }), mk('B', 'todo', { owner: 'a2' }), mk('C', 'todo')]
    const gs = groupByColumn(xs, cols('agents')!, opts())
    expect(gs.map((g) => [g.column!.value, g.rows.map((r) => r.it.key)])).toEqual([['a1', ['A']], ['a2', ['A', 'B']], [BLANK, ['C']]])
  })

  it('orders the agents groups by name, not by id', () => {
    setData({ agents: [{ id: 'b1', name: 'zed' }, { id: 'b2', name: 'amy' }] } as never)
    try {
      const xs = [mk('A', 'todo', { owner: 'b1' }), mk('B', 'todo', { owner: 'b2' })]
      expect(groupByColumn(xs, cols('agents')!, opts()).map((g) => g.column!.label)).toEqual(['amy', 'zed'])
    } finally { setData({ agents: [] } as never) }
  })

  it('applies the filters and the search; a group they leave empty is not made', () => {
    const status = { status: { kind: 'values' as const, values: ['todo', 'in_progress'] } }
    expect(groupByColumn(all, cols('status')!, opts({ filters: status })).map((g) => g.column!.value)).toEqual(['todo', 'in_progress'])
    expect(shape(groupByColumn(all, cols('status')!, opts({ text: 'title e' })))).toEqual([['todo', ['E']]])
    expect(groupByColumn(all, cols('status')!, opts({ text: 'nothing like it' }))).toEqual([])
  })

  it('groups by a choice field in the field\'s option order, and a check field into Yes and No', () => {
    const choice = fieldColumn({ id: 'f1', key: 'prio', label: 'Priority', type: 'choice', options: [{ value: 'hi', label: 'High' }, { value: 'lo', label: 'Low' }] } as never)
    const check = fieldColumn({ id: 'f2', key: 'ok', label: 'Ok', type: 'check' } as never)
    const xs = [mk('A', 'todo', { fields: { prio: 'lo', ok: true } }), mk('B', 'todo', { fields: { prio: 'hi' } }), mk('C', 'todo')]
    expect(groupable(choice) && groupable(check)).toBe(true)
    expect(shape(groupByColumn(xs, choice, opts({ cols: (id) => (id === choice.id ? choice : undefined) })))).toEqual([['High', ['B']], ['Low', ['A']], ['(Blank)', ['C']]])
    expect(shape(groupByColumn(xs, check, opts({ cols: (id) => (id === check.id ? check : undefined) })))).toEqual([['Yes', ['A']], ['No', ['B', 'C']]])
  })
})

describe('groupFor with the column mode', () => {
  const xs = [mk('A', 'todo'), mk('B', 'todo', { parent_id: 'A' })]
  it('groups by the named column', () => {
    expect(groupFor('column', xs, [], opts({ groupBy: 'status' })).map((g) => g.id)).toEqual(['status:todo'])
  })
  it('falls back to the issue tree for a missing or ungroupable column, so no row hides', () => {
    for (const groupBy of [undefined, 'gone', 'cost']) expect(groupFor('column', xs, [], opts({ groupBy })).map((g) => g.id)).toEqual(['A'])
  })
})
