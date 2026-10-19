// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { BudgetSplit, budgetState } from './Limits'
import type { Account, Budget, Reserve } from './types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const budget = (usd: number, spent: number | null, per = 'day'): Budget => ({ usd, per, spent, remaining: spent == null ? null : usd - spent })
const unk = { usd: null, source: 'unknown' as const }
const acct = (account: string, b: Budget | null, paid: Account['paid']['month'] = unk): Account => ({ account, match: { harness: 'opencode' }, windows: {}, updated_at: null, age_ms: null, stale: false, paid: { today: unk, week: unk, month: paid }, balance: null, budget: b, shares: null })

describe('budgetState', () => {
  it('is low from 80% and spent at 100%, and none without a spent figure', () => {
    expect(budgetState(budget(10, 7.9)).state).toBe('ok')
    expect(budgetState(budget(10, 8)).state).toBe('low')
    expect(budgetState(budget(10, 12))).toEqual({ pct: 100, state: 'spent' })
    expect(budgetState(budget(10, null))).toEqual({ pct: null, state: 'ok' })
    expect(budgetState(null).state).toBe('ok')
  })
})

describe('BudgetSplit', () => {
  let root: Root | undefined
  let host: HTMLElement | undefined
  afterEach(() => { act(() => root?.unmount()); host?.remove() })
  const render = (accounts: Account[], reserve?: Reserve | null) => {
    host = document.createElement('div'); document.body.append(host)
    root = createRoot(host)
    act(() => root!.render(<BudgetSplit accounts={accounts} reserve={reserve} />))
    return host
  }
  it('shows Agents and System side by side with spent, remaining and period, each in its own state', () => {
    const h = render([acct('openrouter', budget(20, 17, 'week')), acct('openrouter-system', budget(3, 3))])
    const [a, s] = [...h.querySelectorAll('.lim-split-card')]
    expect(a.textContent).toContain('Agents')
    expect(a.textContent).toContain('$17')
    expect(a.textContent).toContain('$3.00 left')
    expect(a.textContent).toContain('/week')
    expect(a.classList.contains('low')).toBe(true)
    expect(a.querySelector('.badge.warn')?.textContent).toBe('low')
    expect(s.textContent).toContain('System')
    expect(s.classList.contains('spent')).toBe(true)
    expect(s.querySelector('.lim-meter.over')).not.toBeNull()
  })
  it('falls back to the known paid spend this month when the budget has no spent figure', () => {
    const h = render([acct('openrouter', { usd: 10, per: 'month', spent: null, remaining: null }, { usd: 9, source: 'exact' })])
    const a = h.querySelector('.lim-split-card')!
    expect(a.textContent).toContain('$9')
    expect(a.textContent).toContain('$1.00 left')
    expect(a.classList.contains('low')).toBe(true)
  })
  it('prompts for a system budget when the system account is not configured', () => {
    const h = render([acct('openrouter', budget(20, 2))])
    const s = h.querySelectorAll('.lim-split-card')[1]
    expect(s.textContent).toContain('No system budget')
    expect(s.querySelector('button')?.textContent).toBe('Set in Settings')
  })
  it('shows the system reserve and the credit left on the System card, not low while the credit is above it', () => {
    const h = render([acct('openrouter', budget(20, 2)), acct('openrouter-system', budget(3, 1))], { reserve: 1, remaining: 12.5 })
    const line = h.querySelectorAll('.lim-split-card')[1].querySelector('.lim-reserve')!
    expect(line.textContent).toBe('Reserve $1.00 · credit left $12.50')
    expect(line.classList.contains('low')).toBe(false)
    expect(h.querySelectorAll('.lim-split-card')[0].querySelector('.lim-reserve')).toBeNull()
  })
  it('marks the reserve line low when the credit left is within the reserve', () => {
    const h = render([acct('openrouter', budget(20, 2)), acct('openrouter-system', budget(3, 1))], { reserve: 1, remaining: 0.8 })
    const line = h.querySelectorAll('.lim-split-card')[1].querySelector('.lim-reserve')!
    expect(line.textContent).toBe('Reserve $1.00 · credit left $0.80')
    expect(line.classList.contains('low')).toBe(true)
    expect(line.classList.contains('lim-warn')).toBe(true)
  })
  it('reads the credit left as unknown when the reading is stale', () => {
    const h = render([acct('openrouter-system', budget(3, 1))], { reserve: 1, remaining: null })
    const line = h.querySelector('.lim-reserve')!
    expect(line.textContent).toBe('Reserve $1.00 · credit left unknown')
    expect(line.classList.contains('low')).toBe(false)
  })
  it('renders nothing when neither OpenRouter account exists', () => {
    expect(render([acct('claude-max', null)]).querySelector('.lim-split')).toBeNull()
  })
})
