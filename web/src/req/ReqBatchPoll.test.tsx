// @vitest-environment jsdom
// S-4699: on the phone no sidebar ReqSide is mounted, so a shown ReqBatch alone must load the requirements.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReqBatch } from './ReqBatch'
import { getReq, resetReq } from './store'

const hoisted = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../api', () => ({ api: (...args: unknown[]) => hoisted.get(...args) }))
vi.mock('./parts', () => ({ openReq: vi.fn() }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const it1 = { id: 'a1', kind: 'requirement-approval', closed_at: null, updated_at: 'u1' }
const flagReads = () => hoisted.get.mock.calls.filter(([, path]) => path === '/api/req-enabled').length

let root: Root
let host: HTMLElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  resetReq()
  hoisted.get = vi.fn((_m: string, path: string) => Promise.resolve(path === '/api/req-enabled' ? { enabled: true } : path === '/api/requirements?verdicts=latest' ? [] : { itsa: 'S-1', items: [] }))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

describe('ReqBatch alone (phone)', () => {
  it('loads the requirements when mounted and shown, with no sidebar', async () => {
    await act(async () => root.render(<ReqBatch it={it1} />))
    await flush()
    expect(flagReads()).toBe(1)
    expect(getReq().enabled).toBe(true)
  })

  it('fetches nothing once unmounted, and nothing before it was mounted', async () => {
    vi.useFakeTimers()
    try {
      expect(flagReads()).toBe(0)
      await act(async () => root.render(<ReqBatch it={it1} />))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(flagReads()).toBe(1)
      act(() => root.unmount())
      root = createRoot(host)
      await vi.advanceTimersByTimeAsync(24_000)
      expect(flagReads()).toBe(1)
    } finally { vi.useRealTimers() }
  })
})
