// @vitest-environment jsdom
// The backfill control keeps polling through a transient failed GET while running (S-252):
// the button stays disabled until the daemon says the run has stopped.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.fn()
vi.mock('../api', () => ({ api: (...a: unknown[]) => api(...a) }))

import { ClassifySince } from './ClassifySince'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const running = { running: true, labelled: 5, failed: 0, remaining: 10, stopped: null, capped: false, concurrency: 4, lastError: null }
const stopped = { ...running, running: false, remaining: 0, stopped: 'done' }

let host: HTMLDivElement
beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.appendChild(host)
})
afterEach(() => {
  vi.useRealTimers()
  host.remove()
  api.mockReset()
})

const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => { await vi.advanceTimersByTimeAsync(0) })
}

describe('ClassifySince polling', () => {
  it('keeps polling after one failed GET while running, then stops when the run does', async () => {
    // Calls in order: the mount's poll (running), the next one fails, the one after says stopped.
    const replies = [running, new Error('network down'), stopped]
    api.mockImplementation(async () => {
      const r = replies.shift() ?? stopped
      if (r instanceof Error) throw r
      return r
    })
    const root = createRoot(host)
    await act(async () => root.render(<ClassifySince />))
    await flush()
    expect(host.textContent).toContain('network down')
    expect(host.querySelector('button')?.disabled).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) }) // the retry
    await flush()
    expect(host.querySelector('button')?.disabled).toBe(false)
    expect(host.textContent).toContain('stopped: done')
    root.unmount()
  })
})
