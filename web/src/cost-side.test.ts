import { describe, expect, it } from 'vitest'
import { costEntries, costEntry } from './cost-side'
import { ACCOUNT_CLAUDE, ACCOUNT_CODEX, ACCOUNT_OPENCODE, ACCOUNT_OR_AGENTS, ACCOUNT_OR_AGENTS_SPENT } from './usage/story-data'
import type { Account } from './usage/types'

const unknown = { usd: null, source: 'unknown' as const }
const bare: Account = { ...ACCOUNT_CLAUDE, shares: null, paid: { today: unknown, week: unknown, month: unknown } }

describe('cost entries', () => {
  it('a subscription shows its 5-hour then 7-day windows and no cost it lacks', () => {
    const e = costEntry({ ...bare, windows: { seven_day: { used_percentage: 40 }, five_hour: { used_percentage: 10 } } })
    expect(e.subscription).toBe(true)
    expect(e.windows.map((w) => w.key)).toEqual(['five_hour', 'seven_day'])
    expect(e.worth).toBeNull()
    expect(e.paid).toBeNull()
    expect(e.budget).toBeNull()
    expect(e.level).toBe('')
  })
  it('shows the API-equivalent from the window shares and the forecast tone', () => {
    const e = costEntry(ACCOUNT_CLAUDE)
    expect(e.worth).toBe(32.6)
    expect(e.windows[0].tone).toBe('warn')
    expect(e.level).toBe('warn')
  })
  it('a window at 100% is over', () => {
    expect(costEntry(ACCOUNT_CODEX).level).toBe('over')
  })
  it('shows paid spend on a subscription only when it is non-zero', () => {
    const zero = { usd: 0, source: 'estimate' as const }
    expect(costEntry({ ...bare, paid: { today: zero, week: zero, month: zero } }).paid).toBeNull()
    expect(costEntry({ ...bare, paid: { today: zero, week: zero, month: { usd: 12, source: 'exact' } } }).paid).toBe(12)
  })
  it('an API-only account has no windows, its paid spend, and a budget bar', () => {
    const e = costEntry(ACCOUNT_OPENCODE)
    expect(e.subscription).toBe(false)
    expect(e.windows).toEqual([])
    expect(e.paid).toBe(46.8)
    expect(e.paidEstimate).toBe(true)
    expect(e.budget).toMatchObject({ spent: 46.8, usd: 50, per: 'month', state: 'low' })
    expect(e.level).toBe('warn')
  })
  it('a spent budget is over', () => {
    const e = costEntry(ACCOUNT_OR_AGENTS_SPENT)
    expect(e.budget?.state).toBe('spent')
    expect(e.level).toBe('over')
  })
  it('a stale reading forecasts nothing', () => {
    const e = costEntry({ ...ACCOUNT_CLAUDE, stale: true })
    expect(e.stale).toBe(true)
    expect(e.windows.every((w) => w.atReset == null && w.hitAt == null)).toBe(true)
  })
  it('leaves out an account with nothing to show', () => {
    const empty: Account = { ...bare, account: 'fixture-empty', windows: {} }
    expect(costEntries([empty, ACCOUNT_OR_AGENTS, ACCOUNT_CLAUDE]).map((e) => e.name)).toEqual(['openrouter', 'fixture-claude-max'])
    expect(costEntries(undefined)).toEqual([])
  })
})
