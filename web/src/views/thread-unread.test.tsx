// `u` on a thread that was already read (S-2246): the thread view that shows it doesn't read the mail again when the
// store reloads, and opening the thread again reads it.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { humanRowsOf } from '../mail/thread-index'
import * as store from '../store'
import { toggleInboxUnread } from '../actions'
import { ThreadView } from './ThreadView'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLElement
let root: Root
let posts: { path: string; body: any }[]
// The daemon's copy of the thread: the writes below change it, as the daemon does.
let server: { read_at: string | null }

const thread = () => [{
  id: 'm1', from_id: 'a1', from_name: 'lead', subject: 'Which one', body: 'Pick one.', created_at: '2026-10-13T10:00:00Z',
  recipients: [{ id: 'human', read_at: server.read_at }],
}]

beforeEach(() => {
  posts = []
  server = { read_at: '2026-10-13T10:01:00Z' }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } })
  vi.stubGlobal('requestAnimationFrame', (f: () => void) => setTimeout(f, 0))
  // A shown thread marks its mail read only while it is on screen; jsdom has no layout, so the view counts as shown.
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', { configurable: true, get() { return document.body } })
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('760px'), media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }))
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const ok = (d: unknown) => ({ ok: true, status: 200, json: async () => d, text: async () => JSON.stringify(d) })
    if (init?.method !== 'POST') return ok(String(path).startsWith('/api/threads/') ? thread() : String(path).includes('/thread-index?') ? { threads: [], next_cursor: null } : [])
    const body = JSON.parse(String(init.body ?? '{}'))
    posts.push({ path, body })
    if (path.endsWith('/unread')) server.read_at = null
    if (path === '/api/agents/human/read') server.read_at = '2026-10-13T10:05:00Z'
    return ok({ marked: body.ids ?? [] })
  }))
})
// A write's coalesced refresh lands SLOW_COALESCE ms later (S-4519): wait it out here, so it can't land in the next test.
afterEach(async () => { await act(() => store.refreshSlow()); act(() => root.unmount()); host.remove(); vi.unstubAllGlobals() })

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const reads = () => posts.filter((p) => p.path === '/api/agents/human/read')

describe('u on a thread that was already read', () => {
  it('the open thread view leaves the mail unread after the store reloads', async () => {
    store.setData({ humanRows: humanRowsOf([{ thread_id: 'u1', mails: [{ id: 'm1', from_id: 'a1', subject: 'Which one', created_at: '2026-10-13T10:00:00Z', recipients: [{ id: 'human', read_at: server.read_at }] }] }] as never), unread: 0 } as never)
    await act(async () => { root.render(<ThreadView tid="u1" viewKey="thread:u1" />) })
    await flush(); await flush()
    expect(reads()).toHaveLength(0)
    await toggleInboxUnread('u1')
    expect(posts.filter((p) => p.path === '/api/agents/human/threads/u1/unread')).toHaveLength(1)
    // The store reloads (a poll or another write): the view must not read the mail again.
    store.setData({ mailTick: store.getData().mailTick + 1 })
    await flush(); await flush()
    expect(reads()).toHaveLength(0)
    expect(server.read_at).toBeNull()
  })

  it('opening the thread again reads its unread mail', async () => {
    store.setData({ humanRows: humanRowsOf([{ thread_id: 'u2', mails: [{ id: 'm1', from_id: 'a1', subject: 'Which one', created_at: '2026-10-13T10:00:00Z', recipients: [{ id: 'human', read_at: server.read_at }] }] }] as never), unread: 0 } as never)
    await act(async () => { root.render(<ThreadView tid="u2" viewKey="thread:u2" />) })
    await flush(); await flush()
    await toggleInboxUnread('u2')
    store.setData({ mailTick: store.getData().mailTick + 1 })
    await flush(); await flush()
    expect(reads()).toHaveLength(0)
    // Mounting the view again is a new open: its unread mail is read.
    act(() => root.unmount())
    root = createRoot(host)
    await act(async () => { root.render(<ThreadView tid="u2" viewKey="thread:u2" />) })
    await flush(); await flush()
    expect(reads().map((p) => p.body)).toEqual([{ ids: ['m1'] }])
  })
})
