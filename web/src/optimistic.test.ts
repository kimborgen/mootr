import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { optimistic } from './optimistic'
import { getData, getPolled, setData, type Data } from './store'

const toast = vi.hoisted(() => vi.fn())
vi.mock('./ui/menu', () => ({ toast }))

// The change under test: the unread count goes to `n`, and a poll agrees once it reads `n`.
const unreadIs = (n: number) => ({
  apply: (d: Data): Data => ({ ...d, unread: n }),
  settled: (p: Data) => p.unread === n,
  failed: "Couldn't change",
})

// A request the test answers by hand.
function request() {
  let ok = () => {}
  let no = (_: Error) => {}
  const p = new Promise<void>((a, b) => { ok = a; no = b })
  return { p, ok, no: (msg: string) => no(new Error(msg)) }
}

beforeEach(() => {
  vi.useFakeTimers()
  toast.mockClear()
  setData({ unread: 0 })
})
// A change still held for a poll drops with its hold, so no overlay leaks into the next test.
afterEach(() => { vi.advanceTimersByTime(10000); vi.useRealTimers() })

describe('optimistic', () => {
  it('shows the change at once, before the request answers', async () => {
    const r = request()
    const done = optimistic({ ...unreadIs(3), send: () => r.p })
    expect(getData().unread).toBe(3)
    expect(getPolled().unread).toBe(0)
    r.ok()
    await expect(done).resolves.toBe(true)
  })

  it('keeps the change until a poll agrees with it, then shows the polled data', async () => {
    const r = request()
    const done = optimistic({ ...unreadIs(3), send: () => r.p })
    r.ok()
    await done
    expect(getData().unread).toBe(3)
    setData({ unread: 3 })
    expect(getData().unread).toBe(3)
    // The overlay is gone: a later poll with other data shows as it is.
    setData({ unread: 7 })
    expect(getData().unread).toBe(7)
  })

  it('keeps the change through a poll that arrives during the request', async () => {
    const r = request()
    const done = optimistic({ ...unreadIs(3), send: () => r.p })
    setData({ unread: 0, machine: 'alpha' })
    expect(getData().unread).toBe(3)
    expect(getData().machine).toBe('alpha')
    r.ok()
    await done
    setData({ unread: 0 })
    expect(getData().unread).toBe(3)
  })

  it('drops the change after the hold when no poll agrees', async () => {
    const r = request()
    const done = optimistic({ ...unreadIs(3), send: () => r.p })
    r.ok()
    await done
    vi.advanceTimersByTime(8000)
    expect(getData().unread).toBe(0)
  })

  it('rolls back and toasts the error when the request fails', async () => {
    const r = request()
    const done = optimistic({ ...unreadIs(3), send: () => r.p })
    expect(getData().unread).toBe(3)
    r.no('the daemon refused it')
    await expect(done).resolves.toBe(false)
    expect(getData().unread).toBe(0)
    expect(toast).toHaveBeenCalledWith("Couldn't change: the daemon refused it", true)
  })

  it('tells the caller once when the change goes: settled, timed out, or failed (S-4617)', async () => {
    const gone = vi.fn()
    const settled = request()
    void optimistic({ ...unreadIs(3), send: () => settled.p, done: () => gone('settled') })
    settled.ok()
    await settled.p
    await Promise.resolve()
    expect(gone).not.toHaveBeenCalled()
    setData({ unread: 3 })
    setData({ unread: 3 })
    expect(gone.mock.calls).toEqual([['settled']])
    const held = request()
    void optimistic({ ...unreadIs(5), send: () => held.p, done: () => gone('held') })
    held.ok()
    await held.p
    await Promise.resolve()
    vi.advanceTimersByTime(8000)
    const failed = request()
    const no = optimistic({ ...unreadIs(6), send: () => failed.p, done: () => gone('failed') })
    failed.no('refused')
    await no
    expect(gone.mock.calls).toEqual([['settled'], ['held'], ['failed']])
  })
})
