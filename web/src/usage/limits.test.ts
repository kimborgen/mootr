import { describe, expect, it } from 'vitest'
import { forecast, paceLines, paidKnown, tone } from './Limits'
import { finishedIn, median, trend } from './Tiles'
import type { Series } from './charts/math'
import type { Issues, IssueRow, WindowShares } from './types'

const shares = (p: Partial<WindowShares['projection']>) => ({ projection: { estimate: true, used_percentage: 62, percent_per_hour: 9, reaches_100_at: null, resets_at: null, ...p } }) as WindowShares
const NOW = Date.parse('2026-10-14T12:00:00Z')

describe('forecast', () => {
  it('reaches 100% before the reset: warning with the instant', () => {
    const f = forecast({ used_percentage: 62, resets_at: NOW / 1000 + 7200 }, shares({ reaches_100_at: '2026-10-14T15:40:00Z' }), false, NOW)
    expect(f.atReset).toBe(100)
    expect(tone(f)).toBe('warn')
  })
  it('projects the percent at reset from the rate', () => {
    const f = forecast({ used_percentage: 12, resets_at: NOW / 1000 + 4 * 3600 }, shares({ percent_per_hour: 2, resets_at: new Date(NOW + 4 * 3600_000).toISOString() }), false, NOW)
    expect(f.atReset).toBeCloseTo(20)
    expect(tone(f)).toBe('')
  })
  it('a stale reading forecasts nothing, and 100% used is over', () => {
    expect(forecast({ used_percentage: 50 }, shares({ reaches_100_at: '2026-10-14T15:40:00Z' }), true, NOW).atReset).toBeNull()
    expect(tone(forecast({ used_percentage: 100 }, undefined, false, NOW))).toBe('over')
  })
})

describe('paceLines', () => {
  const pace = (percent_per_hour: number, at_reset: number | null, reaches_100_at: string | null = null) => ({ estimate: true as const, percent_per_hour, covered_hours: 30, at_reset, reaches_100_at })
  it('lists the 7-day then the 24h pace, and leaves out a null one', () => {
    const both = paceLines(shares({ pace_7d: pace(0.3, 72), pace_24h: pace(1.6, 100, '2026-10-14T15:40:00Z') }), false)
    expect(both.map((l) => [l.key, l.atReset, l.hitAt])).toEqual([['pace_7d', 72, null], ['pace_24h', 100, '2026-10-14T15:40:00Z']])
    expect(paceLines(shares({ pace_7d: null, pace_24h: pace(1, 40) }), false).map((l) => l.key)).toEqual(['pace_24h'])
    expect(paceLines(shares({}), false)).toEqual([])
  })
  it('a stale reading has no paces', () => {
    expect(paceLines(shares({ pace_24h: pace(1, 40) }), true)).toEqual([])
  })
})

describe('tiles', () => {
  const series = (cur: number, prev: number, days = 6, group = 'tree') => ({ days, group, total: { cost_usd: cur }, previous: { cost_usd: prev } }) as unknown as Series
  it('trend is the change against the previous period, and none without one', () => {
    expect(trend(series(118, 100), 7)).toEqual({ pct: 18, up: true })
    expect(trend(series(50, 100), 7)).toEqual({ pct: 50, up: false })
    expect(trend(series(5, 0), 7)).toBeNull()
    expect(trend(null, 7)).toBeNull()
    expect(trend(series(5, 5, 1), 1)).toBeNull()
    // an ITSA series is built from samples and has no previous period: never a trend
    expect(trend(series(12, 0, 6, 'itsa'), 7)).toBeNull()
    expect(trend(series(12, 10, 6, 'itsa'), 7)).toBeNull()
    // the series is asked for the period as the API counts it: 7 days is days=6
    expect(trend(series(118, 100, 7), 7)).toBeNull()
  })
  it('median of costs', () => {
    expect(median([])).toBeNull()
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(2.5)
  })
  it('counts closed issues finished within the period', () => {
    const row = (key: string, closed_at: string | null, status = 'done') => ({ key, kind: 'issue', status, closed_at }) as IssueRow
    const d = { issues: [row('S-1', '2026-10-14T01:00:00Z'), row('S-2', '2026-10-10T01:00:00Z'), row('S-3', '2026-09-01T00:00:00Z'), row('S-4', null, 'todo')] } as Issues
    expect(finishedIn(d, 1, NOW).map((r) => r.key)).toEqual(['S-1'])
    expect(finishedIn(d, 7, NOW).map((r) => r.key)).toEqual(['S-1', 'S-2'])
    expect(finishedIn(d, 0, NOW)).toHaveLength(3)
  })
})

describe('paidKnown', () => {
  it('counts only a known source, and hides a 0 estimate on an account with windows', () => {
    expect(paidKnown({ usd: 0, source: 'unknown' }, true)).toBeNull()
    expect(paidKnown({ usd: null, source: 'exact' }, false)).toBeNull()
    expect(paidKnown({ usd: 0, source: 'estimate' }, true)).toBeNull()
    expect(paidKnown({ usd: 0, source: 'exact' }, false)).toBe(0)
    expect(paidKnown({ usd: 3.8, source: 'exact' }, false)).toBe(3.8)
    expect(paidKnown({ usd: 2, source: 'estimate' }, true)).toBe(2)
  })
})
