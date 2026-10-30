// The merge queue is read only while a view that lists it is on screen (S-4672): the ITSA poll skips
// GET /api/itsas/queue with no reader showing, and a reader that shows reads it at once. No network: api is mocked.
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => vi.fn())
vi.mock('./api', () => ({ api }))

import { getData, refreshItsas, setQueueReader, useQueueReader } from './store'
import { shownChanged, viewElement } from './shell/layout'
import type { ItsaQueueRow } from './types'

const queueRows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `q${i}` }) as unknown as ItsaQueueRow)
let queueCalls = 0
let queueAnswer: () => Promise<unknown>
beforeEach(() => {
  queueCalls = 0
  queueAnswer = () => Promise.resolve(queueRows(1))
  api.mockReset()
  api.mockImplementation((method: string, path: string) => {
    if (method === 'GET' && path === '/api/itsas') return Promise.resolve([])
    if (method === 'GET' && path === '/api/itsas/attention') return Promise.resolve([])
    if (method === 'GET' && path === '/api/itsas/queue') { queueCalls++; return queueAnswer() }
    return Promise.resolve({ statuses: [] })
  })
})
afterEach(() => { setQueueReader('work', false); setQueueReader('compliance', false) })

describe('the ITSA poll with no reader on screen', () => {
  it("doesn't read the queue", async () => {
    await refreshItsas()
    await refreshItsas()
    expect(queueCalls).toBe(0)
  })

  it('keeps the rows it had', async () => {
    await setQueueReader('work', true)
    expect(getData().queue).toEqual(queueRows(1))
    await setQueueReader('work', false)
    queueAnswer = () => Promise.resolve(queueRows(3))
    await refreshItsas()
    expect(queueCalls).toBe(1)
    expect(getData().queue).toEqual(queueRows(1))
  })
})

describe('a reader on screen', () => {
  it('reads the queue at once when it shows, then with each poll', async () => {
    await setQueueReader('work', true)
    expect(queueCalls).toBe(1)
    await refreshItsas()
    await refreshItsas()
    expect(queueCalls).toBe(3)
  })

  it('reads once for a second reader that shows while the first is on screen', async () => {
    await setQueueReader('work', true)
    expect(await setQueueReader('compliance', true)).toBeUndefined()
    expect(queueCalls).toBe(1)
  })

  it('stops reading when the last reader hides', async () => {
    await setQueueReader('work', true)
    await setQueueReader('compliance', true)
    await setQueueReader('work', false)
    await refreshItsas()
    expect(queueCalls).toBe(2)
    await setQueueReader('compliance', false)
    await refreshItsas()
    expect(queueCalls).toBe(2)
  })

  it('keeps the last rows when a daemon has no queue route', async () => {
    await setQueueReader('work', true)
    expect(getData().queue).toEqual(queueRows(1))
    queueAnswer = () => Promise.reject(new Error('no route'))
    await refreshItsas()
    expect(getData().queue).toEqual(queueRows(1))
  })
})

describe('a view mounted with a hidden element', () => {
  let main: HTMLElement
  let roots: Root[]
  beforeEach(() => {
    roots = []
    main = document.createElement('section')
    main.id = 'w-main'
    document.body.append(main)
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(() => {
    for (const r of roots) act(() => r.unmount())
    main.remove()
  })

  // A probe in the view's element: it reads the queue only while the element is shown in the main world.
  function mount(key: string, shown: boolean) {
    const el = viewElement(key)
    main.append(el)
    el.hidden = !shown
    shownChanged()
    const root = createRoot(el)
    roots.push(root)
    const Probe = () => { useQueueReader(key); return null }
    act(() => root.render(<Probe />))
    return el
  }
  const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

  it('reads the queue at once when shown, and stops when hidden', async () => {
    const el = mount('work', false)
    await flush()
    expect(queueCalls).toBe(0)
    await act(async () => { el.hidden = false; shownChanged() })
    await flush()
    expect(queueCalls).toBe(1)
    await act(async () => { el.hidden = true; shownChanged() })
    await flush()
    await refreshItsas()
    expect(queueCalls).toBe(1)
  })

  // Two readers on one view key: a reader that unmounts must not turn off the other's polling.
  it('keeps polling for the reader still on screen when another on the same key unmounts', async () => {
    const host = document.createElement('div')
    main.append(host)
    const root = createRoot(host)
    roots.push(root)
    const Probe = ({ name }: { name: string }) => { useQueueReader('compliance'); return <i data-name={name} /> }
    const shownRoot = document.createElement('div')
    main.append(shownRoot)
    const other = createRoot(shownRoot)
    roots.push(other)
    act(() => { root.render(<Probe name="a" />); other.render(<Probe name="b" />) })
    await flush()
    expect(queueCalls).toBe(1)
    act(() => root.unmount())
    roots.splice(roots.indexOf(root), 1)
    await refreshItsas()
    expect(queueCalls).toBe(2)
  })

  // StrictMode mounts, unmounts and mounts each effect: one registration must stay live afterward.
  it('keeps one live registration after a StrictMode mount, unmount and mount', async () => {
    const host = document.createElement('div')
    main.append(host)
    const root = createRoot(host)
    roots.push(root)
    // A key with no view element: the reader counts as shown.
    const Probe = () => { useQueueReader('strict'); return null }
    act(() => root.render(<StrictMode><Probe /></StrictMode>))
    await flush()
    // The reader is live after the double mount: the poll reads the queue.
    await refreshItsas()
    expect(queueCalls).toBeGreaterThan(0)
    // Unmounting leaves no registration behind: no reader is shown, so the poll stops reading.
    act(() => root.unmount())
    roots.splice(roots.indexOf(root), 1)
    await refreshItsas()
    const n = queueCalls
    await refreshItsas()
    expect(queueCalls).toBe(n)
  })
})
