// Sort and filter, pure: each filter kind against its values (blank included), the sort order with
// ties and blanks, and the checks on stored sort and filters.
import { describe, expect, it } from 'vitest'
import type { Itsa } from '../types'
import type { CellContext } from './columns'
import { BLANK, type ColFilter, cleanFilter, cleanFilters, cleanSort, countValues, dayOf, keeps, matchFilter, sorted, type SortFilterCol } from './sortfilter'
import type { WorkRow } from './model'

const cx = { now: Date.parse('2026-10-17T12:00:00Z'), extras: {} } as unknown as CellContext
const row = (key: string, extra: Record<string, unknown> = {}): WorkRow => ({ it: { id: key, key, title: key, ...extra } as unknown as Itsa, depth: 0, context: false })

describe('matchFilter', () => {
  it('values: OR within, blank is the empty string', () => {
    const f: ColFilter = { kind: 'values', values: ['a', BLANK] }
    expect([matchFilter(f, 'a'), matchFilter(f, 'b'), matchFilter(f, ''), matchFilter(f, null), matchFilter(f, [])]).toEqual([true, false, true, true, true])
    expect(matchFilter(f, ['b', 'a'])).toBe(true)
    expect(matchFilter({ kind: 'values', values: ['a'] }, null)).toBe(false)
    expect(matchFilter({ kind: 'values', values: [] }, 'a')).toBe(false)
  })

  it('text: contains, case aside; no text keeps all', () => {
    expect([matchFilter({ kind: 'text', q: 'FOO' }, 'a foo b'), matchFilter({ kind: 'text', q: 'x' }, 'a foo'), matchFilter({ kind: 'text', q: 'x' }, null), matchFilter({ kind: 'text', q: ' ' }, null)]).toEqual([true, false, false, true])
  })

  it('range: min and max inclusive; a blank value fails a bounded range', () => {
    const f: ColFilter = { kind: 'range', min: 2, max: 5 }
    expect([1, 2, 5, 6].map((v) => matchFilter(f, v))).toEqual([false, true, true, false])
    expect(matchFilter(f, null)).toBe(false)
    expect(matchFilter({ kind: 'range', min: 3 }, 99)).toBe(true)
    expect(matchFilter({ kind: 'range', max: 3 }, 99)).toBe(false)
    expect(matchFilter({ kind: 'range' }, null)).toBe(true)
  })

  it('date: presets against now, a from and to by local day, blank fails', () => {
    const at = (h: number) => new Date(cx.now - h * 3_600_000).toISOString()
    expect(matchFilter({ kind: 'date', preset: 'hour' }, at(0.5), cx.now)).toBe(true)
    expect(matchFilter({ kind: 'date', preset: 'hour' }, at(2), cx.now)).toBe(false)
    expect(matchFilter({ kind: 'date', preset: '7d' }, at(24 * 6), cx.now)).toBe(true)
    expect(matchFilter({ kind: 'date', preset: '7d' }, at(24 * 8), cx.now)).toBe(false)
    expect([at(24 * 3), at(24)].map((v) => matchFilter({ kind: 'date', preset: 'older2d' }, v, cx.now))).toEqual([true, false])
    expect([at(24 * 8), at(24 * 3)].map((v) => matchFilter({ kind: 'date', preset: 'older7d' }, v, cx.now))).toEqual([true, false])
    expect(matchFilter({ kind: 'date', preset: 'today' }, new Date(cx.now).toISOString(), cx.now)).toBe(true)
    expect(matchFilter({ kind: 'date', preset: 'today' }, at(24 * 3), cx.now)).toBe(false)
    const range: ColFilter = { kind: 'date', from: '2026-10-10', to: '2026-10-12' }
    expect(['2026-10-09', '2026-10-10', '2026-10-12', '2026-10-13'].map((v) => matchFilter(range, v))).toEqual([false, true, true, false])
    expect(matchFilter(range, null)).toBe(false)
    expect(matchFilter({ kind: 'date' }, null)).toBe(true)
  })

  it('has and check', () => {
    expect([matchFilter({ kind: 'has', has: true }, 'x'), matchFilter({ kind: 'has', has: true }, ''), matchFilter({ kind: 'has', has: false }, null), matchFilter({ kind: 'has', has: true }, true), matchFilter({ kind: 'has', has: true }, ['a']), matchFilter({ kind: 'has', has: false }, [])]).toEqual([true, false, true, true, true, true])
    expect([matchFilter({ kind: 'check', value: true }, true), matchFilter({ kind: 'check', value: true }, false), matchFilter({ kind: 'check', value: false }, undefined)]).toEqual([true, false, true])
  })

  it('dayOf reads a bare day as it is', () => {
    expect(dayOf('2026-10-12')).toBe('2026-10-12')
    expect(dayOf('nonsense T')).toBe('')
  })
})

describe('keeps', () => {
  const col: SortFilterCol = { id: 'c', filter: { kind: ['has', 'text'], valueOf: (r, _c, k) => (k === 'has' ? !!r.it.title : r.it.title) } }
  it('applies the filter to the column\'s value of its kind', () => {
    expect(keeps(col, { kind: 'text', q: 'ab' }, row('abc'), cx)).toBe(true)
    expect(keeps(col, { kind: 'text', q: 'zz' }, row('abc'), cx)).toBe(false)
  })
  it('keeps every row when the column or the kind is unknown', () => {
    expect(keeps(undefined, { kind: 'text', q: 'zz' }, row('abc'), cx)).toBe(true)
    expect(keeps(col, { kind: 'range', min: 1 }, row('abc'), cx)).toBe(true)
    expect(keeps({ id: 'n' }, { kind: 'text', q: 'zz' }, row('abc'), cx)).toBe(true)
  })
  it('keeps every row while the value is undefined (source not loaded), but not when it is null (blank)', () => {
    const r: SortFilterCol = { id: 'r', filter: { kind: 'range', valueOf: (x) => (x.it.title === 'unloaded' ? undefined : null) } }
    expect(keeps(r, { kind: 'range', min: 1 }, row('unloaded'), cx)).toBe(true)
    expect(keeps(r, { kind: 'range', min: 1 }, row('blank'), cx)).toBe(false)
  })
})

describe('sorted', () => {
  const by = (v: (r: WorkRow) => string | number | null): SortFilterCol => ({ id: 'c', sortValue: v })
  const cols = { n: by((r) => (r.it as unknown as { n: number | null }).n), s: by((r) => (r.it as unknown as { s: string }).s) }
  const mk = (key: string, n: number | null, s = '') => row(key, { n, s })
  const order = (rows: WorkRow[], keys: { col: string; dir: 'asc' | 'desc' }[]) => sorted(rows, keys, (id) => cols[id as 'n' | 's'], cx, (r) => r).map((r) => r.it.key)

  it('orders numbers as numbers and text with digit runs as numbers', () => {
    const rows = [mk('a', 10, 'item 10'), mk('b', 9, 'item 9'), mk('c', 100, 'item 100')]
    expect(order(rows, [{ col: 'n', dir: 'asc' }])).toEqual(['b', 'a', 'c'])
    expect(order(rows, [{ col: 's', dir: 'asc' }])).toEqual(['b', 'a', 'c'])
    expect(order(rows, [{ col: 'n', dir: 'desc' }])).toEqual(['c', 'a', 'b'])
  })

  it('sorts blanks last in both directions', () => {
    const rows = [mk('a', null), mk('b', 2), mk('c', 1), mk('d', null, 'x')]
    expect(order(rows, [{ col: 'n', dir: 'asc' }])).toEqual(['c', 'b', 'a', 'd'])
    expect(order(rows, [{ col: 'n', dir: 'desc' }])).toEqual(['b', 'c', 'a', 'd'])
  })

  it('breaks ties with the next key, then keeps the given order', () => {
    const rows = [mk('a', 1, 'b'), mk('b', 1, 'a'), mk('c', 1, 'a'), mk('d', 0, 'z')]
    expect(order(rows, [{ col: 'n', dir: 'asc' }, { col: 's', dir: 'desc' }])).toEqual(['d', 'a', 'b', 'c'])
    expect(order(rows, [{ col: 'n', dir: 'asc' }])).toEqual(['d', 'a', 'b', 'c'])
  })

  it('leaves the order alone without keys, or for a column with no sort value', () => {
    const rows = [mk('b', 2), mk('a', 1)]
    expect(order(rows, [])).toEqual(['b', 'a'])
    expect(sorted(rows, [{ col: 'gone', dir: 'asc' }], () => undefined, cx, (r) => r)).toBe(rows)
  })
})

describe('countValues', () => {
  it('counts distinct values, listed ones first even at 0, and blank last as (Blank)', () => {
    const rows = [row('a', { v: ['x', 'y'] }), row('b', { v: [] }), row('c', { v: ['y'] })]
    const read = (r: WorkRow) => (r.it as unknown as { v: string[] }).v
    expect(countValues(rows, read, (v) => v.toUpperCase(), ['z', 'y'])).toEqual([
      { value: 'z', label: 'Z', n: 0 }, { value: 'y', label: 'Y', n: 2 }, { value: 'x', label: 'X', n: 1 }, { value: BLANK, label: '(Blank)', n: 1 },
    ])
  })
})

describe('stored sort and filters', () => {
  it('keeps well-formed sort keys once each, dropping the rest and unknown columns', () => {
    const raw = [{ col: 'a', dir: 'asc' }, { col: 'a', dir: 'desc' }, { col: 'b', dir: 'up' }, { col: 3, dir: 'asc' }, null, { col: 'gone', dir: 'asc' }, { col: 'c', dir: 'desc' }]
    expect(cleanSort(raw)).toEqual([{ col: 'a', dir: 'asc' }, { col: 'gone', dir: 'asc' }, { col: 'c', dir: 'desc' }])
    expect(cleanSort(raw, ['a', 'c'])).toEqual([{ col: 'a', dir: 'asc' }, { col: 'c', dir: 'desc' }])
    expect([cleanSort('x'), cleanSort(undefined), cleanSort({})]).toEqual([[], [], []])
  })

  it('keeps each filter kind when well-formed and drops a malformed one', () => {
    expect([
      cleanFilter({ kind: 'values', values: ['a', 'a', ''] }), cleanFilter({ kind: 'text', q: 'x' }), cleanFilter({ kind: 'range', min: 1, max: 2, junk: 1 }),
      cleanFilter({ kind: 'date', preset: '7d', from: '2026-10-01' }), cleanFilter({ kind: 'has', has: false }), cleanFilter({ kind: 'check', value: true }),
    ]).toEqual([
      { kind: 'values', values: ['a', ''] }, { kind: 'text', q: 'x' }, { kind: 'range', min: 1, max: 2 },
      { kind: 'date', preset: '7d', from: '2026-10-01' }, { kind: 'has', has: false }, { kind: 'check', value: true },
    ])
    for (const bad of [null, 'x', {}, { kind: 'nope' }, { kind: 'values', values: [1] }, { kind: 'values' }, { kind: 'text', q: 1 }, { kind: 'range', min: 'a' }, { kind: 'range', max: NaN },
      { kind: 'date', preset: 'year' }, { kind: 'date', from: 'yesterday' }, { kind: 'has', has: 'yes' }, { kind: 'check' }]) {
      expect(cleanFilter(bad)).toBeNull()
    }
  })

  it('keeps the good filters of a record, for known columns', () => {
    const raw = { a: { kind: 'has', has: true }, b: { kind: 'bad' }, gone: { kind: 'has', has: true } }
    expect(cleanFilters(raw)).toEqual({ a: { kind: 'has', has: true }, gone: { kind: 'has', has: true } })
    expect(cleanFilters(raw, ['a', 'b'])).toEqual({ a: { kind: 'has', has: true } })
    expect([cleanFilters([]), cleanFilters(null), cleanFilters('x')]).toEqual([{}, {}, {}])
  })
})
