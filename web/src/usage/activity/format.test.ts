import { describe, expect, it } from 'vitest'
import { categoryRows, clockRows, configParts, costIn, frictionNote, hours, leadText, longestNote, rangeMark, share, sortTrees, spreadIn, topCategory, treeParts, youNote, CATEGORY_COLORS, MORE_COLOR, UNCLASSIFIED_COLOR } from './format'
import { CONFIGS, SUMMARY, TREES } from './summaryFixture'

describe('activity format (S-1011)', () => {
  it('reads agent-hours in a short unit', () => {
    expect([hours(30), hours(720), hours(4.5 * 3600), hours(196 * 3600), hours(1030 * 3600), hours(null)]).toEqual(['30\u00a0s', '12\u00a0min', '4.5\u00a0h', '196\u00a0h', '1,030\u00a0h', '—'])
    expect([share(196, 1030), share(1, 1000), share(0, 0)]).toEqual(['19%', '<1%', '—'])
  })
  it('lists the clock groups in reading order, summing to the total', () => {
    const rows = clockRows(SUMMARY)
    expect(rows.map((r) => r.key)).toEqual(['working', 'others', 'you', 'friction', 'idle'])
    expect(rows.reduce((n, r) => n + r.seconds, 0)).toBe(SUMMARY.clock.total_s)
    expect(rows.find((r) => r.key === 'you')?.color).toBe('var(--status-warning-fg)')
  })
  it('shows the five largest categories in series colours (never --series-2), the rest as N more', () => {
    const rows = categoryRows(SUMMARY, 'time', 'api')
    expect(rows.map((r) => r.label)).toEqual(['Verifying', 'Communicating', 'Tracking', 'Integrating', 'Understanding', '3 more'])
    expect(rows.map((r) => r.color)).toEqual([...CATEGORY_COLORS, MORE_COLOR])
    expect(rows.some((r) => r.color.includes('series-2'))).toBe(false)
    expect(Math.round(rows[5].value! / 3600 * 10) / 10).toBe(54.6)
    // By cost, in the chosen measure, the order follows the cost.
    expect(categoryRows(SUMMARY, 'cost', 'api')[0]).toMatchObject({ label: 'Communicating', value: 800 })
    expect(categoryRows(SUMMARY, 'cost', 'week')[0].value).toBe(40)
  })
  it('Unclassified never takes a top slot: real categories, then N more, then Unclassified muted last', () => {
    const unc = { key: 'unclassified', label: 'Unclassified', seconds: 400 * 3600, cost_usd: 5000, modes: null, estimated: true, leaves: {} }
    const d = { ...SUMMARY, working_by_category: [unc, ...SUMMARY.working_by_category] }
    const rows = categoryRows(d, 'time', 'api')
    expect(rows.map((r) => r.label)).toEqual(['Verifying', 'Communicating', 'Tracking', 'Integrating', 'Understanding', '3 more', 'Unclassified'])
    expect(rows.at(-1)).toMatchObject({ color: UNCLASSIFIED_COLOR, muted: true })
    // By cost too, and the top category names a real one.
    const cost = categoryRows(d, 'cost', 'api')
    expect(cost[0].label).toBe('Communicating')
    expect(cost.at(-1)?.label).toBe('Unclassified')
    expect(topCategory(cost)?.label).toBe('Communicating')
    // At zero it has no row.
    expect(categoryRows({ ...SUMMARY, working_by_category: [{ ...unc, seconds: 0, cost_usd: 0 }, ...SUMMARY.working_by_category] }, 'time', 'api').some((r) => r.key === 'unclassified')).toBe(false)
  })
  it('a mode that cannot be computed stays null, never a guess', () => {
    expect(costIn({ cost_usd: 5, modes: { api: 5, paid_usd: 0, five_hour: null, seven_day: null, subscription: null } }, 'real')).toBeNull()
    expect(costIn({ cost_usd: 5 }, 'api')).toBe(5)
    const d = { ...SUMMARY, working_by_category: SUMMARY.working_by_category.map((c) => ({ ...c, modes: { ...c.modes!, subscription: null } })) }
    expect(categoryRows(d, 'cost', 'real').every((r) => r.value == null)).toBe(true)
  })
  it('writes the tile and bottleneck notes', () => {
    expect(frictionNote(SUMMARY.tiles.friction.parts)).toBe('incl. cost pauses 52\u00a0h, polling 35\u00a0h')
    expect(frictionNote({})).toBe('none in this window')
    expect(youNote(SUMMARY.tiles.you)).toBe('replies 36\u00a0h · new prompts 43\u00a0h')
    expect(youNote({ ...SUMMARY.tiles.you, permission_s: 600 })).toBe('replies 36\u00a0h · new prompts 43\u00a0h · permissions 10\u00a0min')
    const [, cost, , tests] = SUMMARY.bottlenecks
    expect(longestNote(cost)).toBe('one 30\u00a0h pause')
    expect(longestNote(tests)).toBeNull()
    expect(longestNote({ ...tests, longest: { ...tests.longest!, seconds: 40 * 3600 } })).toBe('one 40\u00a0h run')
  })
  it('reads a config group\'s cost spread in the measure, and places its range mark (S-1012)', () => {
    const opus = CONFIGS.by_model[0]
    expect(spreadIn(opus, 'api')).toEqual({ median: 0.69, p75: 1.4 })
    expect(spreadIn(opus, 'week').median).toBeCloseTo(0.0345)
    expect(spreadIn(opus, 'week').p75).toBeCloseTo(0.07)
    // Real $ is each issue's subscription + paid, a spread of its own.
    expect(spreadIn(opus, 'real').median).toBeCloseTo(0.276)
    expect(spreadIn({ ...opus, cost_modes: undefined }, 'api')).toEqual({ median: 0.69, p75: 1.4 })
    expect(spreadIn({ ...opus, cost_modes: undefined }, 'real')).toEqual({ median: null, p75: null })
    expect(rangeMark({ median: 1, p75: 2 }, 4)).toEqual({ dot: 25, tick: 50 })
    expect(rangeMark({ median: 1, p75: null }, 2)).toEqual({ dot: 50, tick: 50 })
    expect(rangeMark({ median: null, p75: null }, 2)).toBeNull()
    expect(configParts('claude · claude-opus-5-5')).toEqual({ harness: 'claude', model: 'Opus 5.5' })
    expect(configParts('opencode · openrouter/deepseek/deepseek-v4.1-flash').model).toBe('DeepSeek v4.1 flash')
    expect([leadText(3.4 * 3600), leadText(60 * 3600), leadText(null)]).toEqual(['3.4\u00a0h', '2.5\u00a0d', '—'])
  })
  it('sorts trees by cost, working or friction; a tree\'s bar is its clock groups in order (S-1012)', () => {
    expect(sortTrees(TREES, 'cost', 'api').slice(0, 3).map((t) => t.name)).toEqual(['cos', 'release', 'intake'])
    expect(sortTrees(TREES, 'working', 'api').slice(0, 2).map((t) => t.name)).toEqual(['cos', 'release'])
    expect(sortTrees(TREES, 'friction', 'api')[1].name).toBe('release')
    expect(treeParts(TREES[0]).map((p) => [p.key, p.seconds / 3600])).toEqual([['working', 141], ['others', 520], ['you', 40], ['friction', 60], ['idle', 30]])
  })
})
