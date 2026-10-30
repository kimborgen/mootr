// The UI's polls run one round at a time and rest while the tab is hidden (S-4517); a read the daemon never
// answers is given up, so the poll waiting on it runs again. No network: fetch is stubbed and time is fake.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, READ_TIMEOUT } from './api'
import { getData, poll, refreshSlowNow, setData } from './store'
import type { Ask } from './types'

let hidden = false
beforeEach(() => {
  vi.useFakeTimers()
  hidden = false
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

const setHidden = (h: boolean) => { hidden = h; document.dispatchEvent(new Event('visibilitychange')) }

describe('a poll', () => {
  it('skips a tick while its last round is still in flight', async () => {
    let calls = 0
    let finish = () => {}
    const stop = poll(() => { calls++; return new Promise<void>((r) => { finish = r }) }, 2000)
    await vi.advanceTimersByTimeAsync(2000)
    expect(calls).toBe(1)
    // The daemon is slow: three more ticks pass with the first round unanswered.
    await vi.advanceTimersByTimeAsync(6000)
    expect(calls).toBe(1)
    finish()
    await vi.advanceTimersByTimeAsync(2000)
    expect(calls).toBe(2)
    stop()
  })

  it('runs again after a round that failed', async () => {
    let calls = 0
    const stop = poll(async () => { calls++; throw new Error('down') }, 2000)
    await vi.advanceTimersByTimeAsync(4000)
    expect(calls).toBe(2)
    stop()
  })

  it('rests while the tab is hidden, and runs one round at once when it shows', async () => {
    let calls = 0
    const stop = poll(async () => { calls++ }, 2000)
    setHidden(true)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls).toBe(0)
    setHidden(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(calls).toBe(2)
    stop()
  })

  it('stops with its stop, showing the tab included', async () => {
    let calls = 0
    const stop = poll(async () => { calls++ }, 2000)
    stop()
    setHidden(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls).toBe(0)
  })
})

// A fetch that answers only when its signal aborts, as a hung daemon does.
const hung = vi.fn((_: string, init: RequestInit) => new Promise<Response>((_r, reject) => {
  init.signal?.addEventListener('abort', () => reject(init.signal!.reason ?? new DOMException('aborted', 'AbortError')))
}))

describe('a read', () => {
  it('is given up after READ_TIMEOUT as a retryable 504', async () => {
    vi.stubGlobal('fetch', hung)
    const p = api('GET', '/api/agents').catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT)
    const e = await p
    expect(e).toBeInstanceOf(ApiError)
    expect((e as ApiError).status).toBe(504)
  })

  it('aborted by its caller rejects with the caller\'s reason, not a timeout', async () => {
    vi.stubGlobal('fetch', hung)
    const ctl = new AbortController()
    const p = api('GET', '/api/usage/series', undefined, ctl.signal).catch((e: unknown) => e)
    ctl.abort(new Error('closed'))
    expect(((await p) as Error).message).toBe('closed')
  })

  it('answered in time clears its timer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => [1] }) as unknown as Response))
    expect(await api('GET', '/api/agents')).toEqual([1])
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('a write', () => {
  it('has no timeout: one that landed late would be sent twice', async () => {
    vi.stubGlobal('fetch', hung)
    let settled = false
    void api('POST', '/api/mail', {}).finally(() => { settled = true }).catch(() => {})
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT * 4)
    expect(settled).toBe(false)
    expect(hung.mock.calls.at(-1)?.[1].signal).toBeUndefined()
  })
})

// The mailbox round as the 8 s poll runs it (review of #1404).
describe('the mailbox poll', () => {
  const path = (input: string | URL | Request) => (typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url).split('?')[0]
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response
  // Every other read answers empty; the thread index as a page.
  const empty = (input: string) => ok(path(input) === '/api/agents/human/thread-index' ? { threads: [], next_cursor: null } : [])

  it('keeps the asks shown when their read times out', async () => {
    const ask = { mail_id: 'm1' } as unknown as Ask
    setData({ asks: [ask] })
    vi.stubGlobal('fetch', vi.fn((input: string, init: RequestInit) => (path(input) === '/api/asks' ? hung(input, init) : Promise.resolve(empty(input)))))
    const round = refreshSlowNow()
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT)
    await round
    expect(getData().asks).toEqual([ask])
  })

  it('empties the asks on a daemon without the route', async () => {
    setData({ asks: [{ mail_id: 'm1' } as unknown as Ask] })
    vi.stubGlobal('fetch', vi.fn(async (input: string) => (path(input) === '/api/asks' ? ({ ok: false, status: 404, json: async () => ({ error: 'no route' }) }) as unknown as Response : empty(input))))
    await refreshSlowNow()
    expect(getData().asks).toEqual([])
  })

  it('stays in flight until every read settles, when one failed fast', async () => {
    let rings = 0
    let release = () => {}
    vi.stubGlobal('fetch', vi.fn((input: string) => {
      const p = path(input)
      if (p === '/api/rings') { rings++; return Promise.reject(new TypeError('network')) }
      if (p === '/api/mail/decisions') return new Promise<Response>((r) => { release = () => r(ok([])) })
      return Promise.resolve(empty(input))
    }))
    const stop = poll(refreshSlowNow, 8000)
    await vi.advanceTimersByTimeAsync(8000)
    expect(rings).toBe(1)
    // The rings read failed at once; the decisions read is still out, so the next ticks skip.
    await vi.advanceTimersByTimeAsync(16_000)
    expect(rings).toBe(1)
    release()
    await vi.advanceTimersByTimeAsync(8000)
    expect(rings).toBe(2)
    stop()
  })
})
