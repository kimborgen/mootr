import { describe, expect, it } from 'vitest'
import { axisLabel, bucketLabel, colorVar, labelEvery, niceTicks, previousColumns, rankGroups, slotOf, stackAll, stackColumn, type Series } from './math'

const g = (id: string, name = id) => ({ id, name })
const row = (t: string, vals: Record<string, number>) => ({
  t,
  cost_usd: Object.values(vals).reduce((a, b) => a + b, 0),
  groups: Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, { cost_usd: v }])),
})
const series = (rows: ReturnType<typeof row>[], groups = [g('a'), g('b'), g('other', 'Other')], bucket: 'day' | 'hour' = 'day'): Series => ({
  days: 7, group: 'tree', bucket, groups, rows, total: { cost_usd: 0 }, previous: { cost_usd: 0 },
})

describe('stacking', () => {
  it('stacks in legend order and drops zero segments', () => {
    const c = stackColumn(row('2026-10-12', { a: 2, b: 0, other: 1 }), [g('a'), g('b'), g('other')])
    expect(c.segments).toEqual([{ id: 'a', value: 2, y0: 0, y1: 2 }, { id: 'other', value: 1, y0: 2, y1: 3 }])
    expect(c.total).toBe(3)
  })
  it('gives an empty column for an empty row, never NaN', () => {
    const c = stackColumn({ t: 'x', cost_usd: 0, groups: {} }, [g('a')])
    expect(c.segments).toEqual([])
    expect(c.total).toBe(0)
  })
  it('ignores negative values', () => {
    expect(stackColumn(row('x', { a: -1, b: 2 }), [g('a'), g('b')]).total).toBe(2)
  })
  it('stacks every row', () => {
    expect(stackAll(series([row('a', { a: 1 }), row('b', { b: 1 })]))).toHaveLength(2)
  })
})

describe('niceTicks', () => {
  it('gives three clean ticks that cover the maximum', () => {
    for (const max of [0.004, 0.7, 1, 3.2, 47, 118, 999, 12345]) {
      const { ticks, top } = niceTicks(max)
      expect(ticks).toHaveLength(3)
      expect(top).toBeGreaterThanOrEqual(max)
      expect(ticks[2]).toBe(top)
      expect(ticks[1] - ticks[0]).toBeCloseTo(ticks[0])
    }
  })
  it('picks the step from 1, 2, 2.5, 5', () => {
    expect(niceTicks(30).ticks).toEqual([10, 20, 30])
    expect(niceTicks(45).ticks).toEqual([20, 40, 60])
    expect(niceTicks(7).ticks).toEqual([2.5, 5, 7.5])
  })
  it('handles empty input', () => {
    expect(niceTicks(0).top).toBe(1.5)
    expect(niceTicks(NaN).ticks).toHaveLength(3)
  })
})

describe('rankGroups', () => {
  it('sorts by value with Other last and computes shares', () => {
    const s = series([row('1', { a: 1, b: 3, other: 6 }), row('2', { a: 0, b: 0, other: 0 })])
    const r = rankGroups(s)
    expect(r.map((x) => x.id)).toEqual(['b', 'a', 'other'])
    expect(r.map((x) => x.share)).toEqual([0.3, 0.1, 0.6])
  })
  it('leaves out groups with no spend in the period', () => {
    const r = rankGroups(series([row('1', { a: 0, b: 2, other: 0 })]))
    expect(r.map((x) => x.id)).toEqual(['b'])
    expect(r[0].share).toBe(1)
  })
  it('is empty for no spend or no rows', () => {
    expect(rankGroups(series([row('1', { a: 0 })]))).toEqual([])
    expect(rankGroups(series([]))).toEqual([])
  })
})

describe('previousColumns', () => {
  const cur = (days: number, bucket: 'day' | 'hour' = 'day') => ({ ...series([row('2026-10-12', { a: 1 }), row('2026-10-13', { a: 1 }), row('2026-10-14', { a: 1 })], undefined, bucket), days })
  it('matches previous days by date, an empty column where a day has no row', () => {
    const c = { ...cur(2), previous_rows: [row('2026-10-09', { a: 6, other: 2 }), row('2026-10-11', { a: 7 })] }
    const p = previousColumns(c)
    expect(p.map((x) => x.t)).toEqual(['2026-10-09', '2026-10-10', '2026-10-11'])
    expect(p[0].segments).toEqual([{ id: 'a', value: 6, y0: 0, y1: 6 }, { id: 'other', value: 2, y0: 6, y1: 8 }])
    expect(p[1].total).toBe(0)
    expect(p[2].total).toBe(7)
  })
  it('draws none for periods over 14 days, hourly series, or no previous rows', () => {
    const pr = [row('2026-10-09', { a: 1 })]
    const long = series(Array.from({ length: 15 }, (_, i) => row(`2026-10-${String(i + 1).padStart(2, '0')}`, { a: 1 })))
    expect(previousColumns({ ...long, previous_rows: pr })).toEqual([])
    expect(previousColumns({ ...cur(1, 'hour'), previous_rows: pr })).toEqual([])
    expect(previousColumns(cur(2))).toEqual([])
  })
})

describe('colours', () => {
  it('keeps a group on its slot whatever its rank', () => {
    const m = new Map<string, number>()
    expect(slotOf(m, 'tree', 'x')).toBe(1)
    expect(slotOf(m, 'tree', 'y')).toBe(2)
    expect(slotOf(m, 'tree', 'x')).toBe(1)
    expect(slotOf(m, 'itsa', 'x')).toBe(1)
  })
  it('makes Other neutral and harnesses take their hue', () => {
    const m = new Map<string, number>()
    expect(colorVar(m, 'tree', { id: 'other' })).toBe('var(--text-muted)')
    expect(colorVar(m, 'harness', { id: 'codex' })).toBe('var(--h-codex)')
    expect(colorVar(m, 'tree', { id: 'q' })).toBe('var(--series-1)')
  })
  it('stays within six slots for many groups', () => {
    const m = new Map<string, number>()
    for (let i = 0; i < 20; i++) expect(slotOf(m, 'tree', 'g' + i)).toBeLessThanOrEqual(6)
  })
})

describe('labels', () => {
  it('shortens axis labels', () => {
    expect(axisLabel('2026-10-12', 'day', false)).toBe('12')
    expect(axisLabel('2026-10-12', 'day', true)).toBe('Oct 12')
    expect(axisLabel('2026-11-01', 'day', false)).toBe('Nov 1')
    expect(axisLabel('2026-11-01', 'day', true, false)).toBe('1')
    expect(axisLabel('2026-10-05T14:00:00.000Z', 'hour', false)).toBe('14')
  })
  it('formats buckets', () => {
    expect(bucketLabel('2026-10-05', 'day')).toBe('Oct 5')
    expect(bucketLabel('2026-10-05T14:00:00.000Z', 'hour')).toBe('14:00')
  })
  it('thins labels as columns crowd', () => {
    expect(labelEvery(7, 600)).toBe(1)
    expect(labelEvery(31, 320)).toBe(2)
    expect(labelEvery(15, 340)).toBe(1)
    expect(labelEvery(60, 320)).toBe(4)
  })
})
