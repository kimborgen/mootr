// The sidebar's model codes: one short code per model, built by one rule, so the tree can
// draw them in a fixed-width slot. The model list is the registry's (`bin/stam registry`).
import { describe, expect, it } from 'vitest'
import { costCell, costShort, costTitle, modelCode, threadTitle, treeAgents } from './format'
import type { Agent } from './types'

// Every model in registry/defaults.json, with the code the rule gives it.
const REGISTRY: [string, string][] = [
  ['claude-opus-5-5', 'O5.5'],
  ['claude-sonnet-5-5', 'S5.5'],
  ['claude-haiku-5-5', 'H5.5'],
  ['claude-fable-5-1', 'F5.1'],
  ['openrouter/~deepseek/deepseek-v4-flash-latest', 'D4F'],
  ['openrouter/deepseek/deepseek-v4.1-flash', 'D4.1F'],
  ['gpt-6.1-sol', '6.1S'],
  ['gpt-6-astra', '6A'],
  ['gpt-6-luna', '6L'],
  ['openrouter/~openai/gpt-luna-latest', 'L'],
]

describe('modelCode', () => {
  it('codes every model in the registry', () => {
    for (const [id, code] of REGISTRY) expect(modelCode(id), id).toBe(code)
  })

  it('keeps every code within one fixed width', () => {
    for (const [id, code] of REGISTRY) expect(code.length, id).toBeLessThanOrEqual(5)
  })

  it('reads the family, model, version, and variant letters', () => {
    expect(modelCode('claude-opus-5-5')).toBe('O5.5')      // O opus, 5.5
    expect(modelCode('claude-fable-5-1')).toBe('F5.1')     // F fable, 5.1
    expect(modelCode('gpt-6.1-sol')).toBe('6.1S')          // 6.1, S sol
    expect(modelCode('openrouter/deepseek/deepseek-v4.1-flash')).toBe('D4.1F') // D family, 4.1, F flash
  })

  it('falls back to the same rule for a model it does not know', () => {
    expect(modelCode('mistral-large-3')).toBe('M3')        // M family, version 3
    expect(modelCode('llama-3-70b')).toBe('L3')
    expect(modelCode('qwen2.5-coder')).toBe('Q2.5')
  })

  it('shows a dash when no model is set', () => {
    expect(modelCode(null)).toBe('–')
    expect(modelCode(undefined)).toBe('–')
    expect(modelCode('')).toBe('–')
  })
})

describe('treeAgents', () => {
  // Only the fields the tree reads: a lifecycle and the parents.
  const agent = (id: string, lifecycle: string, parents: string[] = []) => ({ id, lifecycle, parents }) as unknown as Agent
  const ids = (as: Agent[]) => as.map((a) => a.id).sort()

  it('keeps a shut-down agent that has a non-archived child, and that child', () => {
    const all = [agent('cos', 'active'), agent('steps', 'shut_down', ['cos']), agent('tool', 'paused', ['steps'])]
    expect(ids(treeAgents(all))).toEqual(['cos', 'steps', 'tool'])
  })

  it('keeps a shut-down child under a dimmed parent, while it has no children of its own', () => {
    const all = [agent('cos', 'active'), agent('steps', 'shut_down', ['cos']), agent('leaf', 'shut_down', ['steps'])]
    expect(ids(treeAgents(all))).toEqual(['cos', 'leaf', 'steps'])
  })

  it('leaves a shut-down agent with no children, and archived children, out of the tree', () => {
    const all = [agent('cos', 'active'), agent('done', 'shut_down', ['cos']), agent('steps', 'shut_down', ['cos']), agent('old', 'archived', ['steps'])]
    expect(ids(treeAgents(all))).toEqual(['cos'])
  })

  it('leaves a shut-down child of a live parent out of the tree (it is listed under Stopped)', () => {
    const all = [agent('cos', 'active'), agent('done', 'shut_down', ['cos'])]
    expect(ids(treeAgents(all))).toEqual(['cos'])
  })
})

describe('threadTitle', () => {
  it('is the newest message title, skipping messages without one (S-297)', () => {
    expect(threadTitle([{ title: 'Deploy done' }, { title: 'Token lifetime' }, { title: null }, {}])).toBe('Token lifetime')
    expect(threadTitle([{ title: null }, {}])).toBeNull()
    expect(threadTitle([])).toBeNull()
  })
})

describe('sidebar cost numbers (S-318)', () => {
  const modes = (api: number | null, pct: number | null, paid = 0) => ({ api, five_hour: pct, seven_day: pct, subscription: api, paid_usd: paid })
  it('formats dollars and percents in each mode', () => {
    expect(costShort(1.234, 'api')).toBe('$1.2')
    expect(costShort(14.4, 'subscription')).toBe('$14')
    expect(costShort(9.97, 'api')).toBe('$10')
    expect(costShort(0.04, 'api')).toBe('<$0.1')
    expect(costShort(0, 'api')).toBe('$0')
    expect(costShort(3.4, 'five_hour')).toBe('3%')
    expect(costShort(0.4, 'seven_day')).toBe('<1%')
    expect(costShort(0, 'five_hour')).toBe('0%')
  })
  it('shows a dash for null', () => {
    expect(costShort(null, 'api')).toBe('–')
    expect(costShort(undefined, 'five_hour')).toBe('–')
    expect(costCell(modes(null, null), 'five_hour')).toBe('–')
  })
  it('leaves real paid spend out of the number (the tooltip has it)', () => {
    expect(costCell(modes(1.2, 3, 0.4), 'api')).toBe('$1.2')
    expect(costCell(modes(null, 3, 0.4), 'five_hour')).toBe('3%')
  })
  it('titles say what each number is, and only a parent gets a tree part', () => {
    const cost = { mode: 'api' as const, own: modes(1.2, 0), tree: modes(14, 0) }
    expect(costTitle(cost, true)).toBe('own: $1.20 API-equivalent · tree: $14.00 API-equivalent')
    expect(costTitle(cost, false)).toBe('own: $1.20 API-equivalent')
    const pct = { mode: 'five_hour' as const, own: modes(0, 0.4, 0.5), tree: modes(0, 3.2) }
    expect(costTitle(pct, false)).toBe('own: <1% of the 5h window + $0.50 paid')
    expect(costTitle({ ...pct, mode: 'api' }, true)).toBe('own: $0.00 API-equivalent + $0.50 paid · tree: $0.00 API-equivalent')
  })
})
