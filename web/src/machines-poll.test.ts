// The machines poll (S-4671): every 5 s while a reader shows the machines, otherwise about once a minute, which
// keeps setKnownOrigins current. No network: fetch is stubbed and time is fake.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { holdMachines, poll, pollMachines, useMachinesShown } from './store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let reads = 0
beforeEach(() => {
  vi.useFakeTimers()
  reads = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/api/machines')) reads++
    return { ok: true, status: 200, json: async () => [] } as unknown as Response
  }))
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('the machines poll', () => {
  it('reads about once a minute while no reader shows the machines', async () => {
    const stop = poll(pollMachines, 5000)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(reads).toBeGreaterThan(0)
    expect(reads).toBeLessThanOrEqual(5)
    stop()
  })

  it('reads every 5 s while a reader shows them, reading at once when it starts', async () => {
    const stop = poll(pollMachines, 5000)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    const before = reads
    const release = holdMachines()
    expect(reads).toBe(before + 1)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(reads).toBe(before + 1 + 4)
    release()
    stop()
  })

  it('goes back to the slow keep when the last reader leaves', async () => {
    const stop = poll(pollMachines, 5000)
    const release = holdMachines()
    await vi.advanceTimersByTimeAsync(20_000)
    release()
    const after = reads
    await vi.advanceTimersByTimeAsync(20_000)
    expect(reads - after).toBeLessThanOrEqual(1)
    stop()
  })
})

// A component that holds the poll while `shown`, as the sidebar pane, the phone list and the views do.
function Probe({ shown }: { shown: boolean }) {
  useMachinesShown(shown)
  return null
}

describe('useMachinesShown', () => {
  it('holds the poll while shown, follows shown on and off, and releases it on unmount', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const render = (shown: boolean) => act(async () => { root.render(createElement(Probe, { shown })) })
    const stop = poll(pollMachines, 5000)

    await render(false)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    const hidden = reads
    await render(true)
    expect(reads).toBe(hidden + 1)
    await render(true)
    expect(reads).toBe(hidden + 1)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(reads).toBe(hidden + 1 + 4)

    await render(false)
    const off = reads
    await render(true)
    expect(reads).toBe(off + 1)

    await act(async () => root.unmount())
    host.remove()
    const unmounted = reads
    await vi.advanceTimersByTimeAsync(20_000)
    expect(reads - unmounted).toBeLessThanOrEqual(1)
    stop()
  })

  it('leaves the counter at zero, so a later hold still runs fast', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const stop = poll(pollMachines, 5000)
    await act(async () => { root.render(createElement(Probe, { shown: true })) })
    await act(async () => root.unmount())
    host.remove()

    const before = reads
    const release = holdMachines()
    expect(reads).toBe(before + 1)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(reads).toBe(before + 1 + 4)
    release()
    stop()
  })
})
