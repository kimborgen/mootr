// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const apiMock = vi.fn()
vi.mock('../../api', () => ({ api: (...a: unknown[]) => apiMock(...a), ApiError: class extends Error { status: number; constructor(m: string, s: number) { super(m); this.status = s } } }))
import { ApiError } from '../../api'
import { ScopedView } from './Drill'
import { getUsageState, setUsageState } from '../state'
import type { ScopeAnswer } from './types'

let root: Root | undefined
let host: HTMLElement | undefined
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = host = undefined; apiMock.mockReset(); setUsageState({ scope: null }) })
beforeEach(() => { setUsageState({ scope: null }) })

const t = (cost: number, i = 0, o = 0) => ({ cost_usd: cost, tokens_in: i, tokens_out: o, tokens_cache_read: 0, tokens_cache_write: 0 })
const ANSWER: ScopeAnswer = {
  days: 6, bucket: 'day',
  scope: { kind: 'itsa', id: 'i1', key: 'S-656', name: 'S-656 Redesign the Usage page' },
  totals: { own: t(20), children: t(30), total: t(50) },
  windows: [{ account: 'claude', window: 'seven_day', percent: 4.9, worth_usd: 100 }],
  timeseries: { group: 'agent', groups: [{ id: 'a1', name: 'usage-redesign' }, { id: 'a2', name: 'review-usage' }], rows: [
    { t: '2026-10-13', cost_usd: 5, groups: { a1: { cost_usd: 3 }, a2: { cost_usd: 2 } } },
    { t: '2026-10-14', cost_usd: 4, groups: { a1: { cost_usd: 4 } } },
  ] },
  by_agent: [
    { id: 'a1', name: 'usage-redesign', role: 'manager', harness: 'claude', model: 'claude-opus-5-5', ...t(30, 1200000, 41000) },
    { id: 'a2', name: 'review-usage', role: 'reviewer', harness: 'codex', model: 'gpt-6.1-sol', ...t(20, 200000, 9000) },
  ],
  by_model: [{ harness: 'claude', model: 'claude-opus-5-5', ...t(30) }, { harness: 'codex', model: 'gpt-6.1-sol', ...t(20) }],
  itsas: [{ key: 'S-660', title: 'Limits band', status: 'done', owner: 'dev-usage-band', cost_usd: 19.4 }],
  typical: { estimate: true, config: 'claude · claude-opus-5-5', n: 4, median_cost_usd: 10, median_weekly_percent: null },
}

async function mount(): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(<ScopedView scope={{ kind: 'itsa', id: 'S-656' }} />) })
  return host
}

describe('ScopedView', () => {
  it('asks the scope endpoint and draws tiles, chart, models and both tables', async () => {
    apiMock.mockResolvedValue(ANSWER)
    const h = await mount()
    expect(apiMock.mock.calls[0][1]).toBe('/api/usage/scope?days=6&itsa=S-656')
    const tiles = h.querySelector('.ud-tiles')!.textContent!
    expect(tiles).toContain('$50')
    expect(tiles).toContain('own $20 · children $30')
    expect(tiles).toContain('5.0×')
    expect(tiles).toContain('1 child ITSA')
    expect(h.querySelectorAll('.uc-col')).toHaveLength(2)
    expect(h.querySelectorAll('.uc-bar')).toHaveLength(2)
    expect(h.querySelectorAll('.ud-agents tr.click')).toHaveLength(2)
    expect(h.querySelector('.ud-children')!.textContent).toContain('Limits band')
  })

  it('shows the multiple in warning ink only above 1.5 times the median', async () => {
    apiMock.mockResolvedValue({ ...ANSWER, typical: { ...ANSWER.typical!, median_cost_usd: 40 } })
    const h = await mount()
    expect(h.querySelector('.mb-metric.warning')).toBeNull()
    expect(h.querySelector('.ud-tiles')!.textContent).toContain('in line with the median')
  })

  it('drills into an agent on a row click and goes up from a crumb', async () => {
    apiMock.mockResolvedValue(ANSWER)
    const h = await mount()
    act(() => { (h.querySelector('.ud-agents tr.click') as HTMLElement).click() })
    expect(getUsageState().scope).toEqual({ kind: 'agent', id: 'a1' })
    act(() => { (h.querySelector('.ud-crumb') as HTMLElement).click() })
    expect(getUsageState().scope).toBeNull()
  })

  it('opens the Activity tab on the same scope (S-1012)', async () => {
    apiMock.mockResolvedValue(ANSWER)
    const h = await mount()
    const link = h.querySelector('.ud-activity') as HTMLElement
    expect(link.textContent).toBe('Activity for this issue')
    act(() => { link.click() })
    expect(getUsageState()).toMatchObject({ tab: 'activity', scope: { kind: 'itsa', id: 'S-656' } })
    setUsageState({ tab: 'overview' })
  })

  it('sorts the agents table by a column', async () => {
    apiMock.mockResolvedValue(ANSWER)
    const h = await mount()
    const names = () => [...h.querySelectorAll('.ud-agents tbody tr.click td:first-child')].map((x) => x.textContent)
    expect(names()[0]).toContain('usage-redesign')
    const out = [...h.querySelectorAll('.ud-agents th .sort')].find((b) => b.textContent!.startsWith('Out'))!
    act(() => { (out as HTMLElement).click() })
    act(() => { (out as HTMLElement).click() })
    expect(names()[0]).toContain('review-usage')
  })

  it('gives each section an empty state', async () => {
    apiMock.mockResolvedValue({ ...ANSWER, by_agent: [], by_model: [], itsas: [], typical: null, windows: [], timeseries: { group: 'agent', groups: [], rows: [] } })
    const h = await mount()
    const text = h.textContent!
    for (const s of ['No spend in this period', 'No model spend', 'No agent spend', 'No child ITSAs', 'no closed issues', 'no subscription use']) expect(text).toContain(s)
  })

  it('says a 404 is not found, with no Retry', async () => {
    apiMock.mockRejectedValue(new ApiError('no ITSA X-1', 404))
    const h = await mount()
    expect(h.textContent).toContain('Not found')
    expect(h.querySelector('button.btn')).toBeNull()
  })

  it('says a 403 is not visible, and offers Retry on other errors', async () => {
    apiMock.mockRejectedValue(new ApiError('an agent reads the cost of the ITSAs it belongs to only', 403))
    let h = await mount()
    expect(h.textContent).toContain('Not visible to you')
    expect(h.querySelector('button.btn')).toBeNull()
    act(() => root!.unmount()); h.remove()
    apiMock.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(ANSWER)
    h = await mount()
    expect(h.textContent).toContain('boom')
    await act(async () => { (h.querySelector('button.btn') as HTMLElement).click() })
    expect(h.querySelector('.ud-tiles')).not.toBeNull()
  })
})
