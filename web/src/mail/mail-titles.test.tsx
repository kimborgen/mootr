// @vitest-environment jsdom
// Mail titles shown again (S-1843, ./mail-titles.ts): a mail on screen is asked for once, the daemon's
// pending mails are asked again on a retry until they land, and the list refreshes when one has landed.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRef } from 'react'
import { rearmMailTitles, resetMailTitles, useWatchMailTitle } from './mail-titles'

const refreshSlow = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../store', () => ({ refreshSlow }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// An IntersectionObserver whose elements show when the test says so.
let shownEls = new Set<Element>()
let fire: (els: Element[], on: boolean) => void = () => {}
class FakeIO {
  private cb: IntersectionObserverCallback
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb
    fire = (els, on) => {
      for (const el of els) if (on) shownEls.add(el); else shownEls.delete(el)
      this.cb(els.map((target) => ({ target, isIntersecting: shownEls.has(target) }) as IntersectionObserverEntry), this as unknown as IntersectionObserver)
    }
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

type Body = { ids: string[] }
type Answer = { enabled: boolean; pending: string[] }
let asked: Body[]
let answer: (b: Body) => Answer | Promise<Answer>

const tick = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

// A card for one mail: the hook watches its element.
function Card({ id }: { id: string }) {
  const el = useRef<HTMLDivElement>(null)
  useWatchMailTitle(id, el)
  return <div ref={el} data-id={id} />
}

let root: Root
let host: HTMLElement

beforeEach(() => {
  vi.useFakeTimers()
  asked = []
  answer = () => ({ enabled: true, pending: [] })
  vi.stubGlobal('IntersectionObserver', FakeIO)
  vi.stubGlobal('fetch', vi.fn(async (_path: string, init?: RequestInit) => {
    const b = JSON.parse(init!.body as string) as Body
    asked.push(b)
    return new Response(JSON.stringify(await answer(b)), { status: 200 })
  }))
  shownEls = new Set()
  refreshSlow.mockClear()
  resetMailTitles()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('mail titles shown again', () => {
  it('asks once for a mail on screen, and not again when it is current', async () => {
    await act(async () => { root.render(<Card id="m1" />) })
    await act(async () => { fire([host.querySelector('[data-id="m1"]')!], true) })
    await tick(10)
    expect(asked).toEqual([{ ids: ['m1'] }])
    await act(async () => { fire([host.querySelector('[data-id="m1"]')!], false) })
    await act(async () => { fire([host.querySelector('[data-id="m1"]')!], true) })
    await tick(10)
    expect(asked.length).toBe(1)
  })

  it('asks again while the daemon has a mail pending, then refreshes the list once it lands', async () => {
    answer = (b) => (asked.length === 1 ? { enabled: true, pending: b.ids } : { enabled: true, pending: [] })
    await act(async () => { root.render(<Card id="p1" />) })
    await act(async () => { fire([host.querySelector('[data-id="p1"]')!], true) })
    await tick(10)
    expect(asked).toEqual([{ ids: ['p1'] }])
    expect(refreshSlow).not.toHaveBeenCalled()
    await tick(3000)
    expect(asked).toEqual([{ ids: ['p1'] }, { ids: ['p1'] }])
    expect(refreshSlow).toHaveBeenCalledTimes(1)
    await tick(6000)
    expect(asked.length).toBe(2)
  })

  it('a settings save asks a mail on screen again, and one that left the screen is not retried', async () => {
    answer = () => ({ enabled: true, pending: [] })
    await act(async () => { root.render(<Card id="r1" />) })
    await act(async () => { fire([host.querySelector('[data-id="r1"]')!], true) })
    await tick(10)
    expect(asked.length).toBe(1)
    await act(async () => { rearmMailTitles() })
    await tick(10)
    expect(asked).toEqual([{ ids: ['r1'] }, { ids: ['r1'] }])
  })

  it('a mail still being made that leaves the screen is not retried', async () => {
    answer = (b) => ({ enabled: true, pending: b.ids })
    await act(async () => { root.render(<Card id="x1" />) })
    await act(async () => { fire([host.querySelector('[data-id="x1"]')!], true) })
    await tick(10)
    expect(asked.length).toBe(1)
    await act(async () => { fire([host.querySelector('[data-id="x1"]')!], false) })
    await tick(3000)
    expect(asked.length).toBe(1)
  })

  it('with the step off the daemon names nothing pending, and nothing is refreshed', async () => {
    answer = () => ({ enabled: false, pending: [] })
    await act(async () => { root.render(<Card id="o1" />) })
    await act(async () => { fire([host.querySelector('[data-id="o1"]')!], true) })
    await tick(10)
    expect(asked.length).toBe(1)
    expect(refreshSlow).not.toHaveBeenCalled()
  })

  it('a shown mail past the first batch of 40 is asked for on the next request', async () => {
    const ids = Array.from({ length: 41 }, (_, i) => `b${i}`)
    answer = () => ({ enabled: true, pending: [] })
    await act(async () => { root.render(<>{ids.map((id) => <Card key={id} id={id} />)}</>) })
    await act(async () => { fire(ids.map((id) => host.querySelector(`[data-id="${id}"]`)!), true) })
    await tick(10)
    expect(asked.map((b) => b.ids.length)).toEqual([40, 1])
    expect(asked[1].ids).toEqual(['b40'])
  })

  it('two overlapping flushes make one request at a time: the second waits for the first', async () => {
    let release!: () => void
    answer = (b) => new Promise<Answer>((r) => { release = () => r({ enabled: true, pending: [] }); void b })
    await act(async () => { root.render(<><Card id="o1" /><Card id="o2" /></>) })
    await act(async () => { fire([host.querySelector('[data-id="o1"]')!], true) })
    await tick(10)
    expect(asked).toEqual([{ ids: ['o1'] }])
    // o2 shows while o1's request is in flight: nothing new goes out until it has answered.
    await act(async () => { fire([host.querySelector('[data-id="o2"]')!], true) })
    await tick(10)
    expect(asked.length).toBe(1)
    await act(async () => { release() })
    await tick(10)
    expect(asked).toEqual([{ ids: ['o1'] }, { ids: ['o2'] }])
  })

  it('a settings save during a request asks the shown mail again once that request has answered', async () => {
    let release!: () => void
    answer = () => new Promise<Answer>((r) => { release = () => r({ enabled: true, pending: [] }) })
    await act(async () => { root.render(<Card id="s1" />) })
    await act(async () => { fire([host.querySelector('[data-id="s1"]')!], true) })
    await tick(10)
    expect(asked.length).toBe(1)
    await act(async () => { rearmMailTitles() })
    await tick(10)
    expect(asked.length).toBe(1)
    await act(async () => { release() })
    await tick(10)
    expect(asked).toEqual([{ ids: ['s1'] }, { ids: ['s1'] }])
  })

  it('pending mails are sent again only on the retry timer, never in an immediate re-flush', async () => {
    vi.useFakeTimers()
    const ids = Array.from({ length: 41 }, (_, i) => `c${i}`)
    // Every mail stays pending: the first request holds the first 40, and the 41st is asked on its own.
    answer = (b) => ({ enabled: true, pending: b.ids })
    await act(async () => { root.render(<>{ids.map((id) => <Card key={id} id={id} />)}</>) })
    await act(async () => { fire(ids.map((id) => host.querySelector(`[data-id="${id}"]`)!), true) })
    await tick(10)
    expect(asked.map((b) => b.ids.length)).toEqual([40, 1])
    expect(asked[1].ids).toEqual(['c40'])
    // Nothing more goes out before the 3 s retry timer.
    await tick(2900)
    expect(asked.length).toBe(2)
    await tick(200)
    expect(asked.length).toBe(3)
    expect(asked[2].ids.length).toBe(40)
  })
})
