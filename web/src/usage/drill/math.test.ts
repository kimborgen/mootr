import { describe, expect, it } from 'vitest'
import { itsaSpan, openFor, percentText, readTypical, readWindows, timesText, totalOf } from './math'
import type { Tot } from './types'

const tot = (c: number): Tot => ({ cost_usd: c, tokens_in: 0, tokens_out: 0, tokens_cache_read: 0, tokens_cache_write: 0 })
const typ = (median: number) => ({ estimate: true as const, config: 'claude · claude-opus-5-5', n: 4, median_cost_usd: median, median_weekly_percent: null })

describe('drill math', () => {
  it('reads an ITSA total and a plain one', () => {
    expect(totalOf({ own: tot(1), children: tot(2), total: tot(3) }).cost_usd).toBe(3)
    expect(totalOf(tot(5)).cost_usd).toBe(5)
  })
  it('marks a cost unusual only above 1.5 times the median', () => {
    expect(readTypical(typ(10), 15)?.unusual).toBe(false)
    expect(readTypical(typ(10), 15.01)?.unusual).toBe(true)
    expect(readTypical(typ(10), 47)?.multiple).toBeCloseTo(4.7)
    expect(readTypical(null, 5)).toBeNull()
    expect(readTypical(typ(0), 5)).toBeNull()
  })
  it('formats multiples and percents', () => {
    expect(timesText(4.66)).toBe('4.7×')
    expect(timesText(12.4)).toBe('12×')
    expect(percentText(null)).toBe('unknown')
    expect(percentText(0.04)).toBe('<0.1%')
    expect(percentText(4.93)).toBe('≈ 4.9%')
    expect(percentText(31.2)).toBe('≈ 31%')
  })
  it('leads with the largest weekly share', () => {
    const r = readWindows([
      { account: 'claude', window: 'five_hour', percent: 60, worth_usd: null },
      { account: 'codex', window: 'seven_day', percent: 1.2, worth_usd: 1 },
      { account: 'claude', window: 'seven_day', percent: 4.9, worth_usd: 1 },
    ])
    expect(r.lead).toEqual({ label: 'claude week', percent: 4.9, week: true })
    expect(r.rest.map((x) => x.label)).toEqual(['codex week', 'claude 5-hour'])
    expect(readWindows([]).lead).toBeNull()
  })
  it('counts how long an ITSA has been open', () => {
    const now = Date.parse('2026-10-14T12:00:00Z')
    expect(openFor('2026-10-14T04:00:00Z', null, now)).toBe('8 h')
    expect(openFor('2026-10-14T11:30:00Z', null, now)).toBe('30 min')
    expect(openFor('2026-10-10T12:00:00Z', '2026-10-13T12:00:00Z', now)).toBe('3 d')
  })
  it('spans an ITSA from when it opened, hourly under 48 hours', () => {
    const now = Date.parse('2026-10-14T12:00:00Z')
    expect(itsaSpan('2026-10-14T04:00:00Z', now)).toEqual({ since: '2026-10-14T04:00:00.000Z', bucket: 'hour' })
    expect(itsaSpan('2026-10-10T04:00:00Z', now)?.bucket).toBe('day')
    expect(itsaSpan(undefined, now)).toBeUndefined()
    expect(itsaSpan('2026-10-15T04:00:00Z', now)).toBeUndefined()
  })
})
