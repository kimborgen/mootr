// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DEFAULT_STATE, getUsageState, setUsageState } from '../state'
import { chartDays, OverviewCharts } from './OverviewCharts'

const paths: string[] = []
const signals: (AbortSignal | undefined)[] = []
let fail = false
vi.mock('../../api', () => ({
  api: vi.fn(async (_m: string, path: string, _b?: unknown, signal?: AbortSignal) => {
    paths.push(path)
    signals.push(signal)
    if (fail) throw new Error('HTTP 500')
    const days = Number(new URL('http://x' + path).searchParams.get('days'))
    return {
      days, group: 'tree', bucket: 'day', total: { cost_usd: 0 }, previous: { cost_usd: 0 },
      groups: [{ id: 'r1', name: 'root' }],
      rows: [{ t: '2026-10-14', cost_usd: 3, groups: { r1: { cost_usd: 3 } } }],
    }
  }),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let host: HTMLElement | undefined
beforeEach(() => { paths.length = 0; signals.length = 0; fail = false; setUsageState({ ...DEFAULT_STATE }) })
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = host = undefined })

async function mount() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(<OverviewCharts />) })
  return host
}

describe('OverviewCharts', () => {
  it('asks for the page period and sets the drill scope on a bar click', async () => {
    const h = await mount()
    expect(paths).toContain('/api/usage/series?days=6&group=tree')
    await act(async () => { (h.querySelector('.uc-bar') as HTMLButtonElement).click() })
    expect(getUsageState().scope).toEqual({ kind: 'tree', id: 'r1' })
  })

  it('follows the period control, drawing 30 days for all time', async () => {
    await mount()
    await act(async () => { setUsageState({ days: 0 }) })
    expect(paths.some((p) => p.startsWith('/api/usage/series?days=29&'))).toBe(true)
    expect(chartDays(0)).toBe(29) // all time draws 30 days, as the API counts them
    expect(chartDays(1)).toBe(1)
    expect(chartDays(7)).toBe(6)
  })

  it('draws the group-by choice', async () => {
    const h = await mount()
    await act(async () => { [...h.querySelectorAll<HTMLButtonElement>('.seg button')].find((b) => b.textContent === 'Model')!.click() })
    expect(paths.some((p) => p.includes('group=model'))).toBe(true)
  })

  it('makes one call per period, and aborts the one in flight when the period changes', async () => {
    await mount()
    expect(paths.filter((p) => p.includes('days=6'))).toHaveLength(1) // no second call for the previous period
    const first = signals[0]!
    await act(async () => { setUsageState({ days: 30 }) })
    expect(first.aborted).toBe(true)
  })

  it('shows an error with Retry when the fetch fails, and loads again on Retry', async () => {
    fail = true
    const h = await mount()
    expect(h.querySelector('[role=alert]')?.textContent).toContain('HTTP 500')
    expect(h.textContent).not.toContain('No spend in this period')
    fail = false
    await act(async () => { (h.querySelector('[role=alert] button') as HTMLButtonElement).click() })
    expect(h.querySelector('.uc-bar')).not.toBeNull()
  })
})
