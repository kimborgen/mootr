// @vitest-environment jsdom
// S-4609: the requirements poll fetches nothing while the tab is hidden or the section is off screen, and runs
// one round when either comes back, at once when the section is shown.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { holdReq, resetReq, watchReq } from './store'

const hoisted = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../api', () => ({ api: (...args: unknown[]) => hoisted.get(...args) }))

const setHidden = (hidden: boolean) => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  document.dispatchEvent(new Event('visibilitychange'))
}
const flagReads = () => hoisted.get.mock.calls.filter(([, path]) => path === '/api/req-enabled').length

// A stand-in for the section: `offsetParent` is null while it or an ancestor is hidden, as in a browser.
let section: { offsetParent: object | null }
let resized: () => void
const disconnect = vi.fn()
let stop: (() => void) | undefined
const show = () => { section.offsetParent = {} }
const start = () => { stop = watchReq(() => section as unknown as HTMLElement) }

beforeEach(() => {
  vi.useFakeTimers()
  resetReq()
  hoisted.get = vi.fn(() => Promise.resolve({ enabled: false }))
  setHidden(false)
  section = { offsetParent: null }
  disconnect.mockClear()
  vi.stubGlobal('ResizeObserver', class {
    constructor(cb: () => void) { resized = cb }
    observe() {}
    disconnect() { disconnect() }
  })
})
afterEach(() => {
  stop?.()
  stop = undefined
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('watchReq', () => {
  it('does not fetch while the tab is hidden', async () => {
    show()
    setHidden(true)
    start()
    await vi.advanceTimersByTimeAsync(24_000)
    expect(flagReads()).toBe(0)
  })

  it('does not fetch while the section is not shown', async () => {
    start()
    await vi.advanceTimersByTimeAsync(24_000)
    expect(flagReads()).toBe(0)
  })

  it('runs one round when the section is shown again, without waiting for a tick', async () => {
    start()
    await vi.advanceTimersByTimeAsync(4_000)
    show()
    resized()
    await vi.advanceTimersByTimeAsync(0)
    expect(flagReads()).toBe(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(flagReads()).toBe(1)
  })

  it('runs one round when the tab becomes visible again', async () => {
    show()
    setHidden(true)
    start()
    await vi.advanceTimersByTimeAsync(8_000)
    expect(flagReads()).toBe(0)
    setHidden(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(flagReads()).toBe(1)
  })

  it('polls every 8 s while shown', async () => {
    show()
    start()
    await vi.advanceTimersByTimeAsync(0)
    expect(flagReads()).toBe(1)
    await vi.advanceTimersByTimeAsync(24_000)
    expect(flagReads()).toBe(4)
  })

  it('stops polling and disconnects the observer when stopped', async () => {
    show()
    start()
    await vi.advanceTimersByTimeAsync(0)
    stop?.()
    stop = undefined
    expect(disconnect).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(24_000)
    expect(flagReads()).toBe(1)
  })
})

// S-4699: a reader that is not the sidebar (ReqBatch on the phone) holds the same poll.
describe('holdReq', () => {
  it('fetches nothing while no reader is held', async () => {
    await vi.advanceTimersByTimeAsync(24_000)
    expect(flagReads()).toBe(0)
  })

  it('reads at once when the first reader holds, then every 8 s, with one poll for two readers', async () => {
    const a = holdReq()
    const b = holdReq()
    await vi.advanceTimersByTimeAsync(0)
    expect(flagReads()).toBe(1)
    await vi.advanceTimersByTimeAsync(24_000)
    expect(flagReads()).toBe(4)
    a()
    await vi.advanceTimersByTimeAsync(8_000)
    expect(flagReads()).toBe(5)
    b()
    await vi.advanceTimersByTimeAsync(24_000)
    expect(flagReads()).toBe(5)
  })

  it('makes no read when held in a hidden tab, and reads when the tab is visible', async () => {
    setHidden(true)
    const release = holdReq()
    await vi.advanceTimersByTimeAsync(24_000)
    expect(flagReads()).toBe(0)
    setHidden(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(flagReads()).toBe(1)
    release()
  })

  it('holds while only the reader is mounted, without a sidebar section', async () => {
    const release = holdReq()
    await vi.advanceTimersByTimeAsync(0)
    expect(hoisted.get).toHaveBeenCalledWith('GET', '/api/req-enabled')
    release()
  })
})
