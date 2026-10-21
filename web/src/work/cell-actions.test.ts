// What a cell's menu offers and what each entry does to the layout (S-1518).
import { describe, expect, it } from 'vitest'
import type { Itsa } from '../types'
import { cellActions, type CellAction, type CellEntry } from './cell-actions'
import { WORK_COLUMNS, type CellContext } from './columns'
import type { WorkRow } from './model'
import { BLANK } from './sortfilter'
import { defaultLayout, type Layout } from './views'

const col = (id: string) => WORK_COLUMNS.find((c) => c.id === id)!
const row = (more: Record<string, unknown> = {}): WorkRow => ({ it: { id: 'i', key: 'S-12', title: 'A title', summary: null, status: 'in_review', owner: null, participants: [], updated_at: '2026-10-12T09:00:00Z', ...more } as unknown as Itsa, depth: 0, context: false })
const cx = (more: Record<string, unknown> = {}) => ({ now: Date.parse('2026-10-17T00:00:00Z'), extras: { costs: null, activity: null, watch: {}, fields: null, fieldsFailed: false, fieldsStart: 0, ...more } }) as unknown as CellContext
const base: Layout = defaultLayout(WORK_COLUMNS.map((c) => c.id))
const opts = (...v: string[]) => v.map((value) => ({ value, label: value, n: 1 }))
const acts = (es: CellEntry[]) => es.filter((e): e is CellAction => e !== 'sep')
const labels = (es: CellEntry[]) => acts(es).map((e) => e.label)
const run = (es: CellEntry[], label: string, l: Layout = base) => acts(es).find((e) => e.label === label)!.apply(l)

describe('entries follow the column\'s filter kinds', () => {
  it('values: only this / exclude this, then a sort', () => {
    const es = cellActions(col('status'), row(), cx(), base, opts('todo', 'in_review'))
    expect(labels(es)).toEqual(['Filter to this value', 'Exclude this value', 'Sort by this column, ascending', 'Sort by this column, descending'])
  })
  it('has: has / has not', () => {
    const es = cellActions(col('branch'), row(), cx(), base, [])
    expect(labels(es).slice(0, 2)).toEqual(['Has', 'Has not'])
    expect(run(es, 'Has not').filters).toEqual({ branch: { kind: 'has', has: false } })
  })
  it('range and date: at least / at most', () => {
    expect(labels(cellActions(col('cost'), row(), cx({ costs: { issues: [{ key: 'S-12', total: { cost_usd: 2 }, cost: { mode: 'api', own: { api: 2 }, total: { api: 2 } } }] } }), base, []))).toContain('At most this')
    const es = cellActions(col('updated'), row(), cx(), base, [])
    expect(labels(es).slice(0, 2)).toEqual(['At least this', 'At most this'])
    expect(acts(es)[0].hint).toBe('2026-10-12')
  })
  it('a column of two kinds lists both, apart', () => {
    const es = cellActions(col('github'), row(), cx(), base, opts('open'))
    expect(es.filter((e) => e === 'sep').length).toBe(2)
    expect(labels(es)).toContain('Has not')
  })
  it('a column that sorts and filters nothing offers nothing; a source not loaded offers no filter', () => {
    expect(cellActions({ id: 'x' }, row(), cx(), base, [])).toEqual([])
    expect(labels(cellActions(col('cost'), row(), cx(), base, []))).toEqual(['Sort by this column, ascending', 'Sort by this column, descending'])
  })
})

describe('what an entry does', () => {
  it('filter to this value replaces the filter on the column; an empty cell is blank', () => {
    const es = cellActions(col('health'), row({ health: null }), cx(), base, opts('on_track'))
    expect(acts(es)[0].hint).toBe('(Blank)')
    const l = run(es, 'Filter to this value', { ...base, filters: { health: { kind: 'values', values: ['on_track', 'at_risk'] } } })
    expect(l.filters).toEqual({ health: { kind: 'values', values: [BLANK] } })
  })
  it('exclude adds the value to a standing not rule, or takes it off an include list', () => {
    const es = cellActions(col('status'), row({ status: 'todo' }), cx(), base, opts('todo', 'done', 'in_review'))
    expect(run(es, 'Exclude this value').filters).toEqual({ status: { kind: 'values', not: ['todo'] } })
    const had = { ...base, filters: { status: { kind: 'values' as const, values: ['todo', 'done'] } } }
    expect(run(es, 'Exclude this value', had).filters).toEqual({ status: { kind: 'values', values: ['done'] } })
    // A second exclusion adds to the rule, and the same value twice adds it once.
    const done = cellActions(col('status'), row({ status: 'done' }), cx(), base, opts('todo', 'done'))
    const twice = run(done, 'Exclude this value', run(es, 'Exclude this value'))
    expect(twice.filters).toEqual({ status: { kind: 'values', not: ['todo', 'done'] } })
    expect(run(es, 'Exclude this value', twice).filters).toEqual({ status: { kind: 'values', not: ['todo', 'done'] } })
    // A stored pair (never made by the menu) collapses: the value leaves the list, and the rule's values with it.
    const both = { ...base, filters: { status: { kind: 'values' as const, values: ['todo', 'done', 'x'], not: ['x'] } } }
    expect(run(es, 'Exclude this value', both).filters).toEqual({ status: { kind: 'values', values: ['done'] } })
  })
  it('a row with several values offers each', () => {
    const es = cellActions(col('agents'), row({ owner: 'a1', participants: ['a2'] }), cx(), base, opts('a1', 'a2'))
    expect(acts(es).filter((e) => e.label === 'Exclude this value').map((e) => e.hint)).toEqual(['a1', 'a2'])
  })
  it('at least / at most keep the other bound while it fits, and drop it when it would cross', () => {
    const c = { ...col('time'), filter: { kind: 'range' as const, valueOf: () => 50 } }
    const rs = cellActions(c, row(), cx(), base, [])
    const f = (min?: number, max?: number) => ({ ...base, filters: { time: { kind: 'range' as const, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) } } })
    expect(run(rs, 'At least this', f(undefined, 80)).filters!.time).toEqual({ kind: 'range', min: 50, max: 80 })
    expect(run(rs, 'At least this', f(undefined, 20)).filters!.time).toEqual({ kind: 'range', min: 50 })
    expect(run(rs, 'At most this', f(10)).filters!.time).toEqual({ kind: 'range', min: 10, max: 50 })
    expect(run(rs, 'At most this', f(70)).filters!.time).toEqual({ kind: 'range', max: 50 })
  })
  it('a date sets a day bound and drops a preset', () => {
    const es = cellActions(col('updated'), row(), cx(), base, [])
    const had = { ...base, filters: { updated: { kind: 'date' as const, preset: '7d' as const, to: '2026-10-20' } } }
    expect(run(es, 'At least this', had).filters!.updated).toEqual({ kind: 'date', from: '2026-10-12', to: '2026-10-20' })
    expect(run(es, 'At most this', had).filters!.updated).toEqual({ kind: 'date', to: '2026-10-12' })
    const early = { ...base, filters: { updated: { kind: 'date' as const, to: '2026-10-01' } } }
    expect(run(es, 'At least this', early).filters!.updated).toEqual({ kind: 'date', from: '2026-10-12' })
    const late = { ...base, filters: { updated: { kind: 'date' as const, from: '2026-10-20' } } }
    expect(run(es, 'At most this', late).filters!.updated).toEqual({ kind: 'date', to: '2026-10-12' })
  })
  it('sort replaces the other keys', () => {
    const es = cellActions(col('status'), row(), cx(), { ...base, sort: [{ col: 'work', dir: 'asc' }] }, opts('todo'))
    expect(run(es, 'Sort by this column, descending', { ...base, sort: [{ col: 'work', dir: 'asc' }] }).sort).toEqual([{ col: 'status', dir: 'desc' }])
  })
})
