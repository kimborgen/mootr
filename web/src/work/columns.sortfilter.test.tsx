// What each built-in column and each field type gives to sort, filter and search (S-1507).
import { describe, expect, it } from 'vitest'
import type { Field } from '../itsa/fields'
import { setData } from '../store'
import type { Itsa } from '../types'
import { WORK_COLUMNS, type CellContext } from './columns'
import { fieldColumn } from './field-columns'
import type { WorkRow } from './model'
import { BLANK, kindsOf, type FilterKind } from './sortfilter'

const col = (id: string) => WORK_COLUMNS.find((c) => c.id === id)!
const row = (more: Record<string, unknown> = {}): WorkRow => ({ it: { id: 'i', key: 'S-12', title: 'A title', summary: 'sum', status: 'todo', owner: null, participants: [], updated_at: '2026-10-12T00:00:00Z', ...more } as unknown as Itsa, depth: 0, context: false })
const extras = (more: Record<string, unknown> = {}) => ({ costs: null, activity: null, watch: {}, fields: null, fieldsFailed: false, fieldsStart: 0, ...more })
const cx = (more: Record<string, unknown> = {}) => ({ now: Date.parse('2026-10-17T00:00:00Z'), extras: extras(more) }) as unknown as CellContext
const read = (id: string, r: WorkRow, kind: FilterKind, c = cx()) => col(id).filter!.valueOf(r, c, kind)
const link = (n: number, system: string, url: string, external_id?: string, meta?: unknown) => ({ n, system, url, external_id: external_id ?? null, meta })

describe('unknown values sort after known ones, before blanks', () => {
  it('an unknown health or review value', () => {
    const h = (health: string | null) => col('health').sortValue!(row({ health }), cx())
    expect(h('on_track')! < h('made_up')!).toBe(true)
    expect(h('made_up')).not.toBeNull()
    expect(h(null)).toBeNull()
    const sv = (verdict: string) => col('review').sortValue!(row({ links: [link(1, 'branch', '', 'b', { review: { verdict } })] }), cx())
    expect(sv('comment')! < sv('weird')!).toBe(true)
  })
  it('a status of an unknown category', () => {
    setData({ itsaStatuses: [{ name: 'todo', category: 'ready', human: false }, { name: 'odd', category: 'mystery', human: false }] } as never)
    const v = (status: string) => col('status').sortValue!(row({ status }), cx()) as string
    expect(v('todo').localeCompare(v('odd'), undefined, { numeric: true })).toBeLessThan(0)
  })
})

describe('built-in columns', () => {
  it('every column but none sorts, filters, and has text, as designed', () => {
    const kinds = Object.fromEntries(WORK_COLUMNS.map((c) => [c.id, kindsOf(c)]))
    expect(kinds).toEqual({
      work: ['text'], status: ['values'], agents: ['values'], branch: ['has', 'text'], github: ['values', 'has'], test: ['has', 'text'], linear: ['has', 'text'], link: ['has', 'text'],
      time: ['range'], cost: ['range'], window: ['range'], health: ['values'], review: ['values'], tests: ['values'], updated: ['date'],
    })
    for (const c of WORK_COLUMNS) expect([c.id, typeof c.sortValue, typeof c.text]).toEqual([c.id, 'function', 'function'])
  })

  it('work: text over key, title, summary; sorts by key number, then title', () => {
    expect(col('work').text!(row(), cx())).toBe('S-12 A title sum')
    expect(read('work', row(), 'text')).toBe('S-12 A title sum')
    const v = (key: string, title: string) => col('work').sortValue!(row({ key, title }), cx()) as string
    expect([v('S-9', 'b'), v('S-10', 'a'), v('S-10', 'b')].sort()).toEqual([v('S-9', 'b'), v('S-10', 'a'), v('S-10', 'b')])
  })

  it('status: values by status name; sorts by category order, then status', () => {
    expect(read('status', row({ status: 'in_review' }), 'values')).toBe('in_review')
    setData({ itsaStatuses: [{ name: 'todo', category: 'ready', human: false }, { name: 'in_progress', category: 'active', human: false }, { name: 'done', category: 'closed', human: false }] })
    const v = (status: string) => col('status').sortValue!(row({ status }), cx()) as string
    expect(v('todo') < v('in_progress')).toBe(true)
    expect(col('status').filter!.values!([row(), row(), row({ status: 'done' })], cx())).toEqual([{ value: 'todo', label: 'todo', n: 2 }, { value: 'done', label: 'done', n: 1 }])
  })

  it('agents: ids with none as blank; sorts by the first agent\'s name', () => {
    expect(read('agents', row({ owner: 'a1', participants: ['human', 'a2'] }), 'values')).toEqual(['a1', 'a2'])
    expect(col('agents').filter!.values!([row(), row({ owner: 'a1' })], cx())).toEqual([{ value: 'a1', label: 'a1', n: 1 }, { value: BLANK, label: '(Blank)', n: 1 }])
    expect(col('agents').sortValue!(row(), cx())).toBeNull()
  })

  it('link columns: has, and text on the labels', () => {
    const r = row({ links: [link(1, 'branch', '', 'stam/foo'), link(2, 'github', 'https://github.com/o/r/pull/7'), link(3, 'link', 'https://example.com/x')] })
    expect([read('branch', r, 'has'), read('branch', r, 'text'), read('test', r, 'has'), read('link', r, 'text')]).toEqual([true, 'stam/foo', false, 'example.com'])
    expect(col('branch').sortValue!(row(), cx())).toBeNull()
  })

  it('github: PR states from the watch plus has', () => {
    const r = row({ links: [link(1, 'github', 'https://github.com/o/r/pull/7'), link(2, 'github', 'https://github.com/o/r/pull/8')] })
    const c = cx({ watch: { 'github:o/r#7': { state: 'open', draft: true }, 'github:o/r#8': { state: 'merged' } } })
    expect(read('github', r, 'values', c)).toEqual(['draft', 'merged'])
    expect(read('github', r, 'has')).toBe(true)
    expect(read('github', row(), 'values', c)).toEqual([])
    expect(read('github', r, 'values')).toBeUndefined() // the watch hasn't loaded
    expect(read('github', row(), 'values')).toEqual([])
    // A commit link has no PR state to load: with the watch loaded, it has no state, so a state filter hides it.
    const commit = row({ links: [link(3, 'github', 'https://github.com/o/r/commit/abc')] })
    expect(read('github', commit, 'values', c)).toEqual([])
    expect(read('github', commit, 'values')).toEqual([])
    expect(col('github').filter!.values!([r], c).map((v) => [v.value, v.n])).toEqual([['open', 0], ['draft', 1], ['merged', 1], ['closed', 0]])
  })

  it('time, cost and window: ranges that are blank without a figure', () => {
    const c = cx({
      activity: { rows: [{ key: 'S-12', total: { working_s: 90, waiting_s: 10 } }] },
      costs: { note: '', issues: [{ key: 'S-12', own: { cost_usd: 1 }, total: { cost_usd: 2.5 }, weekly_percent: 4.4 }] },
    })
    expect([read('time', row(), 'range', c), read('cost', row(), 'range', c), read('window', row(), 'range', c)]).toEqual([90, 2.5, 4.4])
    // Loaded but without a figure is blank; not loaded (null report) is undefined, which a filter ignores.
    const loaded = cx({ costs: { note: '', issues: [] }, activity: { rows: [] } })
    expect([read('time', row(), 'range', loaded), read('cost', row(), 'range', loaded), read('window', row(), 'range', loaded)]).toEqual([null, null, null])
    expect([read('time', row(), 'range'), read('cost', row(), 'range'), read('window', row(), 'range')]).toEqual([undefined, undefined, undefined])
    expect(col('cost').sortValue!(row(), c)).toBe(2.5)
    expect(col('cost').text!(row(), c)).toBe('$2.50')
  })

  it('health, review, tests: values, blank when unrecorded', () => {
    const b = (meta: unknown) => row({ links: [link(1, 'branch', '', 'b', meta)] })
    expect([read('health', row({ health: 'at_risk' }), 'values'), read('health', row(), 'values')]).toEqual(['at_risk', BLANK])
    expect([read('review', b({ review: { verdict: 'approve' } }), 'values'), read('review', row(), 'values')]).toEqual(['approve', BLANK])
    expect([read('tests', b({ tests: { passed: 3, failed: 1 } }), 'values'), read('tests', b({ tests: { passed: 3, failed: 0 } }), 'values'), read('tests', row(), 'values')]).toEqual(['failed', 'passed', BLANK])
    expect(col('review').filter!.values!([b({ review: { verdict: 'approve' } })], cx()).map((v) => v.label)).toEqual(['approved', 'changes requested', 'commented'])
    expect(col('health').sortValue!(row({ health: 'off_track' }), cx())).toBe(0)
  })

  it('updated: the ISO time for date filtering and sorting', () => {
    expect(read('updated', row(), 'date')).toBe('2026-10-12T00:00:00Z')
    expect(col('updated').sortValue!(row(), cx())).toBe('2026-10-12T00:00:00Z')
  })
})

describe('field columns by type', () => {
  let n = 0
  const field = (over: Partial<Field>): Field => ({ id: `f${n++}`, key: 'k', label: 'K', type: 'text', options: null, description: null, hint: null, width: 'm', align: 'start', card: 'meta', position: 0, ...over })
  const of = (f: Field, v: unknown, kind: FilterKind) => fieldColumn(f).filter!.valueOf(row({ fields: { [f.key]: v } }), cx(), kind)
  const sortOf = (f: Field, v: unknown) => fieldColumn(f).sortValue!(row({ fields: { [f.key]: v } }), cx())

  it('choice: values in option order, text is the label, sorts by option order', () => {
    const f = field({ type: 'choice', options: [{ value: 'hi', label: 'High', tone: null }, { value: 'lo', label: 'Low', tone: null }] })
    const rows = [row({ fields: { k: 'lo' } }), row({ fields: {} }), row({ fields: { k: 'zz' } })]
    expect(fieldColumn(f).filter!.values!(rows, cx())).toEqual([{ value: 'hi', label: 'High', n: 0 }, { value: 'lo', label: 'Low', n: 1 }, { value: 'zz', label: 'zz', n: 1 }, { value: BLANK, label: '(Blank)', n: 1 }])
    expect([of(f, 'lo', 'values'), of(f, undefined, 'values')]).toEqual(['lo', BLANK])
    expect(fieldColumn(f).text!(rows[0], cx())).toBe('Low')
    expect((sortOf(f, 'hi') as string) < (sortOf(f, 'lo') as string)).toBe(true)
    expect(sortOf(f, undefined)).toBeNull()
  })

  it('text, number, date, check', () => {
    expect([of(field({ type: 'text' }), 'Hello', 'text'), sortOf(field({ type: 'text' }), 'Hello'), sortOf(field({ type: 'text' }), '')]).toEqual(['Hello', 'hello', null])
    const num = field({ type: 'number' })
    expect([of(num, 7, 'range'), of(num, undefined, 'range'), sortOf(num, 3), sortOf(num, '')]).toEqual([7, null, 3, null])
    const date = field({ type: 'date' })
    expect([of(date, '2026-10-01', 'date'), of(date, undefined, 'date'), sortOf(date, '2026-10-01')]).toEqual(['2026-10-01', null, '2026-10-01'])
    const chk = field({ type: 'check' })
    expect([of(chk, true, 'check'), of(chk, false, 'check'), of(chk, undefined, 'check')]).toEqual([true, false, false])
    expect(kindsOf(fieldColumn(chk))).toEqual(['check'])
  })

  it('link: has, and text on the host', () => {
    const f = field({ type: 'link' })
    expect([of(f, 'https://www.example.com/a', 'has'), of(f, undefined, 'has'), of(f, 'https://www.example.com/a', 'text'), kindsOf(fieldColumn(f))]).toEqual([true, false, 'example.com', ['has', 'text']])
  })
})
