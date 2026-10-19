// @vitest-environment jsdom
// The Usage page's Measure control and its number formats (S-663): one money rule, one percent
// rule, and the switch that changes a row's number in place.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { measureText, measureValue, money, pct, toMeasure } from './measure'
import { DEFAULT_STATE, setUsageState } from './state'
import { TreesTab } from './Trees'
import type { Modes, TreeNode } from './types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('money', () => {
  it('uses two decimals under $10 and none from $10 up, never three', () => {
    expect(money(14)).toBe('$14')
    expect(money(9)).toBe('$9.00')
    expect(money(0.5)).toBe('$0.50')
    expect(money(0)).toBe('$0.00')
    expect(money(0.125)).toBe('$0.13')
    // The comparison is on the rounded cents, so $9.999 is $10, not $10.00.
    expect(money(9.999)).toBe('$10')
  })
})

describe('pct', () => {
  it('has one rule: <0.1% below a tenth, one decimal under 10, none from 10 up', () => {
    expect(pct(0)).toBe('0.0%')
    expect(pct(0.04)).toBe('<0.1%')
    expect(pct(4.93)).toBe('4.9%')
    expect(pct(31.2)).toBe('31%')
  })
})

describe('measureValue', () => {
  const modes: Modes = { api: 4, five_hour: 1.2, seven_day: 3.4, subscription: 2.5, paid_usd: 0.25 }
  it('picks the API dollars, the 7-day share or the subscription plus paid', () => {
    expect(measureValue(modes, 'api')).toBe(4)
    expect(measureValue(modes, 'week')).toBe(3.4)
    expect(measureValue(modes, 'real')).toBe(2.75)
  })
  it('is null, never 0, when the measure has no value', () => {
    const none: Modes = { api: 0, five_hour: null, seven_day: null, subscription: null, paid_usd: 0 }
    expect(measureValue(none, 'week')).toBeNull()
    expect(measureValue(none, 'real')).toBeNull()
    expect(measureValue(undefined, 'api')).toBeNull()
    expect(measureText(null, 'real')).toBe('—')
    expect(measureText(2.75, 'real')).toBe('$2.75')
  })
})

describe('toMeasure', () => {
  it("maps the Settings cost unit onto the page's three measures", () => {
    expect(toMeasure('seven_day')).toBe('week')
    expect(toMeasure('subscription')).toBe('real')
    expect(toMeasure('api')).toBe('api')
    expect(toMeasure('five_hour')).toBe('api')
    expect(toMeasure(undefined)).toBe('api')
  })
})

const node = (modes: Modes): TreeNode => ({ id: 'a1', name: 'lead', cost_usd: 44.2, tokens: 0, modes, shares: {}, children: [] })

let root: Root | undefined
let host: HTMLElement | undefined
beforeEach(() => setUsageState({ ...DEFAULT_STATE }))
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = host = undefined })

describe('the Measure switch', () => {
  it('changes every number in place', async () => {
    const modes: Modes = { api: 44.2, five_hour: 1.2, seven_day: 3.4, subscription: 3, paid_usd: 0.25 }
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root!.render(<TreesTab nodes={[node(modes)]} />) })
    const text = () => host!.querySelector('.tree-totals')!.textContent ?? ''
    expect(text()).toContain('$44')
    await act(async () => { setUsageState({ measure: 'week' }) })
    expect(text()).toContain('3.4%')
    await act(async () => { setUsageState({ measure: 'real' }) })
    expect(text()).toContain('$3.25')
  })
  it('shows a dash, never $0.00, for a row with no value in the chosen measure', async () => {
    const modes: Modes = { api: 0, five_hour: null, seven_day: null, subscription: null, paid_usd: 0 }
    setUsageState({ measure: 'real' })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root!.render(<TreesTab nodes={[node(modes)]} />) })
    const text = () => host!.querySelector('.tree-totals')!.textContent ?? ''
    expect(text()).toContain('—')
    expect(text()).not.toContain('$0.00')
  })
})
