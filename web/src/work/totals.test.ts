// The Work totals footer (S-1521): what the shown rows add up to.
import { describe, expect, it } from 'vitest'
import type { Field } from '../itsa/fields'
import type { CostMode, Itsa, ItsaCategory } from '../types'
import { groupFlat, groupFor, groupWork, type GroupOptions, type WorkGroup } from './model'
import { totalCell, totalLine, workTotals } from './totals'

const CAT: Record<string, ItsaCategory> = { todo: 'ready', in_progress: 'active', in_review: 'review', done: 'closed' }
const category = (s: string) => CAT[s] ?? 'backlog'
const mk = (key: string, parent: string | null, status = 'todo', fields?: Record<string, unknown>): Itsa => ({
  id: key, key, parent_id: parent, kind: null, title: 'T' + key, summary: null, body: null, status, owner: null, thread_id: null,
  created_by: 'human', created_at: '', updated_at: '2026-10-12T00:00:00Z', closed_at: null, fields,
} as Itsa)
const est = { id: 'est', key: 'est', label: 'Est', type: 'number' } as Field
const area = { id: 'area', key: 'area', label: 'Area', type: 'text' } as Field
const split = (working_s: number) => ({ working_s, waiting_s: 0, working_by_kind: {}, waiting_by_top: {}, waiting_by_kind: {}, cost_usd: 0 })
// One issue's cost in every unit; only the api and five_hour parts are filled, the rest null.
const units = (mode: CostMode, own: number, total: number) => {
  const part = (v: number) => ({ api: mode === 'api' ? v : null, five_hour: mode === 'five_hour' ? v : null, seven_day: null, subscription: null, paid_usd: 0 })
  return { mode, own: part(own), total: part(total) }
}
const extras = {
  costs: { note: '', issues: [{ key: 'A', own: { cost_usd: 1.5 }, total: { cost_usd: 4 }, weekly_percent: null, cost: units('api', 1.5, 4) }, { key: 'A1', own: { cost_usd: 2.5 }, total: { cost_usd: 2.5 }, weekly_percent: null, cost: units('api', 2.5, 2.5) }] },
  activity: { note: '', since: '', rows: [{ key: 'A', category: '', created_at: '', closed_at: null, lead_s: null, review_rounds: 0, own: split(60), total: split(360), agents: [] }, { key: 'A1', category: '', created_at: '', closed_at: null, lead_s: null, review_rounds: 0, own: split(300), total: split(300), agents: [] }] },
}
const opts = (o: Partial<GroupOptions> = {}): GroupOptions => ({ show: 'open', text: '', closed: (x) => x.status === 'done', ...o })
const none = { costs: null, activity: null }

describe('workTotals', () => {
  const all = [mk('A', null, 'in_progress', { est: 2 }), mk('A1', 'A', 'in_review', { est: '3.5' }), mk('A2', 'A', 'todo'), mk('B', null, 'done', { est: 9 })]

  it('counts rows by status category and sums cost, working time and number fields', () => {
    const t = workTotals(groupFlat(all, opts()), extras, [est], category)
    expect(t.count).toBe(3)
    expect(t.byCategory).toEqual([{ category: 'ready', n: 1 }, { category: 'active', n: 1 }, { category: 'review', n: 1 }])
    expect(t.cost).toBe(4)
    expect(t.workingS).toBe(360)
    expect(t.numbers).toEqual({ 'field:est': 5.5 })
  })

  it('leaves context rows out', () => {
    // Q is closed and hidden, so it stays as context for R.
    const gs = groupWork([mk('P', null), mk('Q', 'P', 'done', { est: 8 }), mk('R', 'Q', 'todo', { est: 1 })], opts())
    expect(gs[0].rows.map((r) => r.context)).toEqual([true, false])
    const t = workTotals(gs, extras, [est], category)
    expect(t.count).toBe(1)
    expect(t.byCategory).toEqual([{ category: 'ready', n: 1 }])
    expect(t.numbers).toEqual({ 'field:est': 1 })
  })

  it('leaves out rows the filters drop', () => {
    const gs = groupFor('flat', all, [], opts({ show: 'all', filters: { status: { kind: 'values', values: ['todo'] } }, cols: (id) => id === 'status' ? { id, filter: { kind: 'values', valueOf: ({ it }) => it.status } } : undefined }))
    const t = workTotals(gs, extras, [est], category)
    expect(t.count).toBe(1)
    expect(t.cost).toBe(0)
    expect(t.numbers).toEqual({})
  })

  it('counts a row listed in several groups once', () => {
    const row = { it: all[0], depth: 0, context: false }
    const gs: WorkGroup[] = [{ id: 'x', root: null, rows: [row] }, { id: 'y', root: null, rows: [row] }]
    const t = workTotals(gs, extras, [est], category)
    expect(t.count).toBe(1)
    expect(t.cost).toBe(1.5)
    expect(t.numbers['field:est']).toBe(2)
  })

  it('sums only number fields and skips empty or non-numeric values', () => {
    const xs = [mk('C', null, 'todo', { est: 1, area: '7' }), mk('D', null, 'todo', { est: '' }), mk('E', null, 'todo', { est: 'abc' })]
    expect(workTotals(groupWork(xs, opts()), none, [est, area], category).numbers).toEqual({ 'field:est': 1 })
  })

  it('uses own cost and time, so a parent and its child shown together do not count twice', () => {
    const t = workTotals(groupFlat([mk('A', null, 'in_progress'), mk('A1', 'A')], opts()), extras, [], category)
    expect(t.cost).toBe(4)
    expect(t.workingS).toBe(360)
  })

  it('marks a footer sum that left out a row with no figure in the unit', () => {
    const partial = { costs: { note: '', issues: [{ key: 'A', own: { cost_usd: 1 }, total: { cost_usd: 1 }, weekly_percent: null, cost: units('api', 1.5, 1.5) }, { key: 'A1', own: { cost_usd: 1 }, total: { cost_usd: 1 }, weekly_percent: null, cost: { mode: 'api' as const, own: { api: null, five_hour: null, seven_day: null, subscription: null, paid_usd: 0 }, total: { api: null, five_hour: null, seven_day: null, subscription: null, paid_usd: 0 } } }] }, activity: null }
    const t = workTotals(groupFlat([mk('A', null, 'in_progress'), mk('A1', 'A')], opts()), partial, [], category)
    expect(totalCell('cost', t)).toBe('$1.5+')
  })

  it('sums the own cost in the Settings unit, not dollars', () => {
    const pct = { costs: { note: '', issues: [{ key: 'A', own: { cost_usd: 1 }, total: { cost_usd: 1 }, weekly_percent: null, cost: units('five_hour', 3.2, 3.2) }, { key: 'A1', own: { cost_usd: 1 }, total: { cost_usd: 1 }, weekly_percent: null, cost: units('five_hour', 1.4, 1.4) }] }, activity: null }
    const t = workTotals(groupFlat([mk('A', null, 'in_progress'), mk('A1', 'A')], opts()), pct, [], category)
    expect(t.costMode).toBe('five_hour')
    expect(totalCell('cost', t)).toBe('5%')
  })
})

describe('totalCell and totalLine', () => {
  const t = workTotals(groupFlat([mk('A', null, 'in_progress', { est: 2 }), mk('A1', 'A', 'in_review')], opts()), extras, [est], category)

  it('writes each column and leaves the rest blank', () => {
    expect(totalCell('work', t)).toBe('2 issues')
    expect(totalCell('status', t)).toBe('1 active · 1 review')
    expect(totalCell('cost', t)).toBe('$4.0')
    expect(totalCell('time', t)).toBe('6m')
    expect(totalCell('field:est', t)).toBe('2')
    expect(totalCell('updated', t)).toBe('')
    expect(totalCell('field:other', t)).toBe('')
  })

  it('leaves cost and time blank when nothing is known', () => {
    const e = workTotals(groupWork([mk('A', null)], opts()), none, [], category)
    expect(totalCell('cost', e)).toBe('')
    expect(totalCell('time', e)).toBe('')
    expect(totalCell('work', e)).toBe('1 issue')
    expect(totalLine(e)).toBe('1 issue · 1 ready')
  })

  it('joins the phone line', () => {
    expect(totalLine(t)).toBe('2 issues · 1 active · 1 review · $4.0 · 6m working')
  })
})
