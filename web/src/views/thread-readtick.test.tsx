// The tick of a thread view's own read (S-4519): the view reloads on it like any other tick. The coalesced round that
// brought the read can bring a mail too, one sent while the stream was down included, and be the last tick for a
// while (review of #1408).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const stream = vi.hoisted(() => ({ listeners: [] as ((c: boolean) => void)[] }))
vi.mock('../live', async (orig) => ({
  ...(await orig<typeof import('../live')>()),
  liveConnected: () => true,
  onLiveConnection: (cb: (c: boolean) => void) => { stream.listeners.push(cb); return () => {} },
}))

import { humanRowsOf } from '../mail/thread-index'
import * as store from '../store'
import { shownChanged, viewElement, viewHandle } from '../shell/layout'
import { ThreadView } from './ThreadView'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLElement
let root: Root
let fetches: number
// Each read request's ids, in order, and how many requests have finished.
let readIds: string[][]
let readsDone: number
// The daemon's copy of the thread.
let server: { id: string; body: string; read_at: string | null }[]
// Hold the next read's response until the test releases it (a delayed response).
let holdNext: boolean
let releaseRead: (() => void) | null

const thread = () => server.map((m, i) => ({
  id: m.id, thread_id: 't1', from_id: 'a1', from_name: 'lead', subject: 'Which one', body: m.body, created_at: `2026-10-29T10:0${i}:00Z`,
  recipients: [{ id: 'human', read_at: m.read_at }],
}))

beforeEach(() => {
  fetches = 0
  readIds = []
  readsDone = 0
  server = [{ id: 'm1', body: 'First.', read_at: null }]
  holdNext = false
  releaseRead = null
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } })
  vi.stubGlobal('requestAnimationFrame', (f: () => void) => setTimeout(f, 0))
  // A browser gives no offsetParent to an element that is hidden or parked out of the page, so the view reads nothing there.
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', { configurable: true, get() { return this.closest('[hidden], #view-store') ? null : document.body } })
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('760px'), media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }))
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const ok = (d: unknown) => ({ ok: true, status: 200, json: async () => d, text: async () => JSON.stringify(d) })
    if (init?.method === 'POST') {
      if (path === '/api/agents/human/read') {
        const { ids } = JSON.parse(String(init.body)) as { ids: string[] }
        readIds.push(ids)
        if (holdNext) { holdNext = false; await new Promise<void>((r) => { releaseRead = r }) }
        for (const m of server) if (ids.includes(m.id)) m.read_at = '2026-10-29T10:09:00Z'
        readsDone++
      }
      return ok({})
    }
    if (String(path) === '/api/threads/t1') { fetches++; return ok(thread()) }
    if (String(path).includes('/thread-index?')) return ok({ threads: [], next_cursor: null })
    return ok([])
  }))
  store.setData({ humanRows: humanRowsOf([{ thread_id: 't1', mails: thread() }]) } as never)
})
afterEach(async () => {
  releaseRead?.()
  await act(() => store.refreshSlow())
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, store.SLOW_COALESCE + 50)) })

describe('the tick of a thread view\'s own read', () => {
  it('reloads on it, and reads nothing twice', async () => {
    await act(async () => { root.render(<ThreadView tid="t1" viewKey="thread:t1" />) })
    await flush(); await flush()
    expect(fetches).toBe(1)
    expect(readIds).toEqual([['m1']])
    await settle(); await flush()
    expect(fetches).toBe(2)
    expect(readIds).toEqual([['m1']])
  })

  it('loads a mail sent during a stream gap while the read\'s round was pending', async () => {
    await act(async () => { root.render(<ThreadView tid="t1" viewKey="thread:t1" />) })
    await flush(); await flush()
    expect(fetches).toBe(1)
    // The stream breaks, a mail lands in the thread, and the stream comes back: no mail.sent reaches the page.
    act(() => { for (const cb of stream.listeners) cb(false) })
    server.push({ id: 'm2', body: 'Sent in the gap.', read_at: null })
    act(() => { for (const cb of stream.listeners) cb(true) })
    await settle(); await flush()
    expect(host.textContent).toContain('Sent in the gap.')
  })

  it('loads a mail that arrived before the read\'s coalesced round landed', async () => {
    await act(async () => { root.render(<ThreadView tid="t1" viewKey="thread:t1" />) })
    await flush(); await flush()
    expect(fetches).toBe(1)
    // A second mail lands in the thread while the read's refresh waits for its round.
    server.push({ id: 'm2', body: 'Second, after the read.', read_at: null })
    act(() => store.applyLiveEvent('mail.sent', { id: 'm2', from: 'a1', to: ['human'], thread: 't1' }))
    await settle(); await flush()
    expect(fetches).toBe(2)
    expect(host.textContent).toContain('Second, after the read.')
  })

  // The regression of ownRead (S-4519 review): the first read's response is delayed, a mail lands and a tick comes while
  // it is in flight. That tick must still reload the thread, and the mail's own read goes out on its own.
  it('reloads on a tick that comes while the read is in flight, and reads each mail once when both land', async () => {
    holdNext = true
    await act(async () => { root.render(<ThreadView tid="t1" viewKey="thread:t1" />) })
    await flush(); await flush()
    expect(readIds).toEqual([['m1']])
    const before = fetches
    server.push({ id: 'm2', body: 'Arrived during the held read.', read_at: null })
    act(() => { store.setData({ mailTick: store.getData().mailTick + 1 }) })
    await flush(); await flush()
    expect(fetches).toBe(before + 1)
    expect(host.textContent).toContain('Arrived during the held read.')
    // The mail that arrived is read by its own request, which is not held.
    expect(readIds).toEqual([['m1'], ['m2']])
    expect(readsDone).toBe(1)
    act(() => releaseRead?.())
    await settle(); await flush()
    expect(readsDone).toBe(2)
    expect(server.map((m) => m.read_at)).toEqual(['2026-10-29T10:09:00Z', '2026-10-29T10:09:00Z'])
    expect(readIds).toEqual([['m1'], ['m2']])
    expect(host.textContent).toContain('Arrived during the held read.')
  })
})

// A thread view hidden in the main world (S-4608): it doesn't refetch on ticks, and reloads once when it shows again.
describe('a thread view hidden in the main world', () => {
  it('loads once on show, for the mail that came while it was hidden', async () => {
    const main = document.createElement('section')
    main.id = 'w-main'
    document.body.append(main)
    const el = viewElement('thread:hidden')
    main.append(el)
    el.hidden = true
    shownChanged()
    const hiddenRoot = createRoot(el)
    try {
      await act(async () => { hiddenRoot.render(<ThreadView tid="t1" viewKey="thread:hidden" />) })
      await flush(); await flush()
      // The mount load happens even while hidden, and reads nothing: the view is not on screen.
      expect(fetches).toBe(1)
      expect(readIds).toEqual([])
      expect(server.map((m) => m.read_at)).toEqual([null])
      server.push({ id: 'm2', body: 'Came while hidden.', read_at: null })
      act(() => { store.setData({ mailTick: store.getData().mailTick + 1 }) })
      act(() => { store.setData({ mailTick: store.getData().mailTick + 1 }) })
      await flush(); await flush()
      expect(fetches).toBe(1)
      expect(readIds).toEqual([])
      expect(el.textContent).not.toContain('Came while hidden.')
      // Shown again: one reload for the ticks it missed, the mail shows, and both unread mails are read, each id once.
      await act(async () => {
        el.hidden = false
        shownChanged()
        viewHandle('thread:hidden')?.show?.()
      })
      await flush(); await flush()
      expect(fetches).toBe(2)
      expect(el.textContent).toContain('Came while hidden.')
      expect(readIds).toEqual([['m1', 'm2']])
      expect(readsDone).toBe(1)
      // The read's own refresh is a tick too (#1408), so the view reloads once more; the read itself is not repeated.
      await settle(); await flush()
      expect(readIds).toEqual([['m1', 'm2']])
      expect(readsDone).toBe(1)
      expect(server.map((m) => m.read_at)).toEqual(['2026-10-29T10:09:00Z', '2026-10-29T10:09:00Z'])
      // Shown now: the next tick reloads again.
      const settled = fetches
      act(() => { store.setData({ mailTick: store.getData().mailTick + 1 }) })
      await flush(); await flush()
      expect(fetches).toBe(settled + 1)
    } finally {
      act(() => hiddenRoot.unmount())
      main.remove()
    }
  })
})
