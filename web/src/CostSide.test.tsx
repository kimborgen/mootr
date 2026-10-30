// The sidebar Cost pane reads GET /api/usage?days=1 only while it shows (S-4671): hidden, it reads nothing; shown,
// it reads on show and on its five-minute refresh; hidden again, the refresh stops. No network: fetch is stubbed.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CostSide } from './CostSide'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let usageReads = 0
let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  usageReads = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/api/usage?days=1')) usageReads++
    return { ok: true, status: 200, json: async () => ({ accounts: [] }) } as unknown as Response
  }))
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const show = (shown: boolean) => act(async () => { root.render(<CostSide shown={shown} />) })

describe('the Cost pane', () => {
  it('reads nothing while it is hidden', async () => {
    await show(false)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(usageReads).toBe(0)
  })

  it('reads once on show, refreshes every five minutes only while shown, and stops when hidden', async () => {
    await show(true)
    expect(usageReads).toBe(1)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(usageReads).toBe(2)
    await show(false)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(usageReads).toBe(2)
    await show(true)
    expect(usageReads).toBe(3)
  })
})
