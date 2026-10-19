// Rapid-fire's Load older threads (S-1121): loaded cards keep the scroll where you were, and a
// load that adds no card leaves no anchor for the next send, which lands at the bottom.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const pages = vi.hoisted(() => ({ count: 60 }))
vi.mock('../api', async (orig) => ({
  ...(await orig<typeof import('../api')>()),
  api: vi.fn(async (_m: string, path: string) => {
    if (!path.includes('with=dev') || path.includes('archived=1') || path.includes('deferred=1')) return []
    return Array.from({ length: pages.count }, (_, i) => ({ thread_id: 'd' + i, mails: [{ id: 'm' + i, thread_id: 'd' + i, from_id: 'human', from_name: 'human', subject: 's' + i, body: 'b', created_at: new Date(Date.UTC(2026, 9, 15, 0, i)).toISOString(), recipients: [{ id: 'dev', read_at: null }] }] }))
  }),
}))
import { getData, setData } from '../store'
import { RapidView } from './RapidView'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLElement
let root: Root
const tops = new WeakMap<Element, number>()
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)) })

beforeEach(() => {
  pages.count = 60
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  // jsdom has no layout: a card is 100 px tall, and scrollTop is a plain value.
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return this.querySelectorAll('.rf-list > li').length * 100 } })
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', { configurable: true, get() { return tops.get(this) ?? 0 }, set(v: number) { tops.set(this, v) } })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } })
  setData({ humanThreads: [], humanArchived: [], humanDeferred: [], rapidWith: {} })
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals() })

const scroller = () => host.querySelector<HTMLElement>('.rf-scroll')!
const older = () => host.querySelector<HTMLButtonElement>('.rf-older')

describe('RapidView Load older threads', () => {
  it('keeps the cards you were reading in place when older ones load above', async () => {
    await act(async () => { root.render(<RapidView id="dev" />) })
    await flush()
    expect(scroller().scrollTop).toBe(6000)
    scroller().scrollTop = 0
    pages.count = 110
    await act(async () => { older()!.click() })
    await flush()
    expect(host.querySelectorAll('.rf-list > li')).toHaveLength(110)
    expect(scroller().scrollTop).toBe(5000)
    expect(older()).toBeNull()
  })

  it('a load that adds no card leaves no anchor: the next send scrolls to the bottom', async () => {
    await act(async () => { root.render(<RapidView id="dev" />) })
    await flush()
    scroller().scrollTop = 300
    await act(async () => { older()!.click() })
    await flush()
    expect(host.querySelectorAll('.rf-list > li')).toHaveLength(60)
    const sent = { thread_id: 'new', mails: [{ id: 'mn', thread_id: 'new', from_id: 'human', from_name: 'human', subject: 'new', body: 'b', created_at: '2026-10-15T09:00:00.000Z', recipients: [{ id: 'dev', read_at: null }] }] }
    await act(async () => { setData({ humanThreads: [...getData().humanThreads, sent] }) })
    expect(host.querySelectorAll('.rf-list > li')).toHaveLength(61)
    expect(scroller().scrollTop).toBe(6100)
  })
})
