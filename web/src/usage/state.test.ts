import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiDays, DEFAULT_STATE, decodeUsage, encodeUsage, getUsageState, onUsageChange, parseUsageHash, setUsageState, usageHash } from './state'
import { modelName } from './shared'
import { decodeFilter, DEFAULT_FILTER, filterParam, keepsType, toggleType } from './agentFilter'

afterEach(() => setUsageState({ ...DEFAULT_STATE }))

describe('apiDays', () => {
  it('asks for N-1 days for a period of N calendar days, Today as 1, all time as a year', () => {
    expect([1, 7, 30, 0].map((p) => apiDays(p as 1 | 7 | 30 | 0))).toEqual([1, 6, 29, 365])
  })
})

describe('usage state', () => {
  it('merges a change, notifies once, and ignores a change to nothing', () => {
    const on = vi.fn()
    const off = onUsageChange(on)
    setUsageState({ tab: 'models', days: 30 })
    setUsageState({ tab: 'models' })
    expect(getUsageState()).toEqual({ ...DEFAULT_STATE, tab: 'models', days: 30 })
    expect(on).toHaveBeenCalledTimes(1)
    off()
  })
  it('round-trips through a history entry, scope included', () => {
    const s = { tab: 'agents', days: 1, measure: 'api', scope: { kind: 'tree', id: 'a1' }, agents: ['manager', 'untyped'], mode: 'cost' } as const
    expect(decodeUsage(encodeUsage(s))).toEqual(s)
  })
  it('reads anything unreadable as the default, a bad field at a time', () => {
    expect(decodeUsage('not json')).toEqual(DEFAULT_STATE)
    expect(decodeUsage(JSON.stringify({ tab: 'nope', days: 30, scope: { kind: 'x', id: 'y' } }))).toEqual({ ...DEFAULT_STATE, days: 30 })
  })
})

describe('usage deep link', () => {
  it('writes the state to a hash and reads it back, scope included', () => {
    const s = { tab: 'models', days: 0, measure: 'api', scope: { kind: 'tree', id: 'a:1' }, agents: DEFAULT_STATE.agents, mode: 'time' } as const
    expect(usageHash(s)).toBe('#view=usage&tab=models&period=all&scope=tree%3Aa%3A1')
    expect(parseUsageHash(new URLSearchParams(usageHash(s).slice(1)))).toEqual({ tab: 'models', days: 0, scope: { kind: 'tree', id: 'a:1' } })
  })
  it('writes the agent types to the hash only when some are chosen, and reads them back', () => {
    const two = { ...DEFAULT_STATE, agents: ['developer', 'reviewer-opus'] } as const
    expect(usageHash(two)).toBe('#view=usage&tab=overview&period=7d&types=developer%2Creviewer-opus')
    expect(parseUsageHash(new URLSearchParams(usageHash(two).slice(1))).agents).toEqual(['developer', 'reviewer-opus'])
  })
  it('writes the mode to the hash only when it is Cost', () => {
    const cost = { ...DEFAULT_STATE, tab: 'activity', mode: 'cost' } as const
    expect(usageHash(cost)).toBe('#view=usage&tab=activity&period=7d&mode=cost')
    expect(parseUsageHash(new URLSearchParams(usageHash(cost).slice(1))).mode).toBe('cost')
    expect(parseUsageHash(new URLSearchParams('view=usage&tab=activity&mode=nope')).mode).toBeUndefined()
    expect(usageHash({ ...cost, mode: 'time' })).not.toContain('mode')
  })
  it('keeps an older link\'s preset or classes as tokens the daemon resolves', () => {
    const agents = (q: string) => parseUsageHash(new URLSearchParams(q)).agents
    expect(agents('view=usage&tab=activity&agents=managers')).toEqual(['managers'])
    expect(agents('view=usage&tab=activity&agents=work')).toEqual(['work'])
    expect(agents('view=usage&tab=activity&agents=non-managers')).toEqual(['non-managers'])
    expect(agents('view=usage&tab=activity&agents=developers')).toEqual(['developers'])
    expect(agents('view=usage&tab=activity&agents=custom&classes=manager,other')).toEqual(['+manager', '+other'])
    expect(agents('view=usage&tab=activity&agents=all')).toBeUndefined()
    expect(agents('view=usage&tab=activity&agents=custom')).toBeUndefined()
  })
  it('ignores what it does not know', () => {
    expect(parseUsageHash(new URLSearchParams('view=usage&tab=nope&period=9d&scope=x:1&agents=everyone'))).toEqual({})
  })
})

describe('agent filter', () => {
  it('sends the types sorted as agents=, and nothing for all', () => {
    expect(filterParam([])).toBe('')
    expect(filterParam(['manager', 'developer'])).toBe('developer,manager')
  })
  it('keeps a row without a type, and filters one with', () => {
    expect(keepsType([], 'chief-of-staff')).toBe(true)
    expect(keepsType(['developer'], undefined)).toBe(true)
    expect(keepsType(['developer'], 'manager')).toBe(false)
    expect(keepsType(['developer', 'manager'], 'manager')).toBe(true)
  })
  it('toggles a type in and out; none left counts all', () => {
    expect(toggleType([], 'manager')).toEqual(['manager'])
    expect(toggleType(['manager'], 'developer')).toEqual(['developer', 'manager'])
    expect(toggleType(['manager'], 'manager')).toEqual([])
  })
  it('reads a stored filter, and an older one as its types', () => {
    expect(decodeFilter(['zz zz', 'manager', 'manager', 3])).toEqual(['manager'])
    expect(decodeFilter({ preset: 'developers', classes: ['cos'] })).toEqual(['developers'])
    expect(decodeFilter({ preset: 'work', classes: [] })).toEqual(['work'])
    expect(decodeFilter({ preset: 'non-managers', classes: [] })).toEqual(['non-managers'])
    expect(decodeFilter({ preset: 'custom', classes: ['manager', 'cos'] })).toEqual(['+manager', '+cos'])
    expect(decodeFilter({ preset: 'all', classes: ['cos'] })).toEqual([])
    expect(decodeFilter(['work'])).toEqual(['work'])
    expect(decodeFilter(null)).toEqual(DEFAULT_FILTER)
  })
  it('moves the state, and a change to the same types notifies nobody', () => {
    const on = vi.fn()
    const off = onUsageChange(on)
    setUsageState({ agents: ['manager'] })
    setUsageState({ agents: ['manager'] })
    expect(on).toHaveBeenCalledTimes(1)
    expect(getUsageState().agents).toEqual(['manager'])
    off()
  })
})

describe('modelName', () => {
  it('names models the way the sidebar does', () => {
    expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelName('openrouter/deepseek/deepseek-v4.1-flash')).toBe('DeepSeek v4.1 flash')
    expect(modelName('gpt-6.1-sol')).toBe('gpt-6.1-sol')
    expect(modelName(null)).toBe('unknown model')
  })
})
