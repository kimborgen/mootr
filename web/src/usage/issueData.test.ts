import { describe, expect, it } from 'vitest'
import { closedInPeriod, periodStart } from './issueData'
import type { IssueRow } from './types'

// A fixed instant late on October 14 in UTC, which is already October 15 east of it.
const NOW = new Date('2026-10-14T23:30:00Z')
const row = (closed_at: string | null, status = 'done') => ({ key: 'S-1', title: 't', kind: 'issue', status, closed_at } as IssueRow)

describe('periodStart', () => {
  it('starts a period of N days at UTC midnight, N calendar days ending today', () => {
    expect(new Date(periodStart(1, NOW)).toISOString()).toBe('2026-10-14T00:00:00.000Z')
    expect(new Date(periodStart(7, NOW)).toISOString()).toBe('2026-10-08T00:00:00.000Z')
    expect(new Date(periodStart(30, NOW)).toISOString()).toBe('2026-09-15T00:00:00.000Z')
  })
  it('reaches back a year plus a day for all time', () => {
    expect(new Date(periodStart(0, NOW)).toISOString()).toBe('2025-10-14T00:00:00.000Z')
  })
})

describe('closedInPeriod', () => {
  it('counts a closed issue from the first day of the period on', () => {
    expect(closedInPeriod(row('2026-10-08T00:00:00Z'), 7, NOW)).toBe(true)
    expect(closedInPeriod(row('2026-10-07T23:59:59Z'), 7, NOW)).toBe(false)
  })
  it('leaves out an open issue and one with no close time', () => {
    expect(closedInPeriod(row('2026-10-12T00:00:00Z', 'in_progress'), 7, NOW)).toBe(false)
    expect(closedInPeriod(row(null), 7, NOW)).toBe(false)
  })
})
