// @vitest-environment jsdom
// The card layout poll (S-4610): every mounted card shares one poll, so each tick reads the settings once,
// whatever the number of cards, and the poll stops with the last card.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCardLayout } from './card-layout'

const api = vi.hoisted(() => vi.fn())
const sendAsHuman = vi.hoisted(() => vi.fn())
vi.mock('./api', () => ({ api, sendAsHuman }))

// The settings file as the daemon has it: GET reads it.
let settings: Record<string, unknown> = {}
const gets = () => api.mock.calls.filter(([method, path]) => method === 'GET' && path === '/api/config/settings').length

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  settings = {}
  api.mockReset()
  sendAsHuman.mockReset()
  // jsdom reports the page as hidden, and the poll skips a hidden page: this test's page is visible.
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  api.mockImplementation((method: string, path: string) => {
    if (method === 'GET' && path === '/api/config/settings') return Promise.resolve({ text: JSON.stringify(settings) })
    return Promise.reject(new Error(`unexpected ${method} ${path}`))
  })
})

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

// Mounts `n` cards that each read the issue layout; `titles[i]` is the title lines card i last drew.
async function mount(n: number) {
  const titles: (number | undefined)[] = Array(n).fill(undefined)
  function Card({ i }: { i: number }) {
    titles[i] = useCardLayout('issue').titleLines
    return null
  }
  const roots: Root[] = []
  for (let i = 0; i < n; i++) {
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => { root.render(createElement(Card, { i })) })
    roots.push(root)
  }
  const unmount = async () => { for (const r of roots) await act(async () => { r.unmount() }) }
  return { titles, unmount }
}

const tick = (ms = 5000) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

describe('the shared card layout poll', () => {
  it('makes one GET per interval for three mounted cards', async () => {
    const { unmount } = await mount(3)
    const before = gets()
    await tick()
    expect(gets() - before).toBe(1)
    await tick()
    expect(gets() - before).toBe(2)
    await unmount()
  })

  it('stops once the last card unmounts', async () => {
    const { unmount } = await mount(3)
    await unmount()
    const before = gets()
    await tick(20000)
    expect(gets()).toBe(before)
  })

  it('still reaches every card when the record changes', async () => {
    const { titles, unmount } = await mount(3)
    expect(titles).toEqual([3, 3, 3])
    settings = { cardLayouts: { issue: { slots: { TOP: [], META: [], BADGES: [], FOOT: [] }, titleLines: 1, seen: [], chosen: true } } }
    await tick()
    expect(titles).toEqual([1, 1, 1])
    await unmount()
  })
})
