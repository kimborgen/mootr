import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => vi.fn())
const sendAsHuman = vi.hoisted(() => vi.fn())
vi.mock('./api', () => ({ api, sendAsHuman }))

type Gate = typeof import('./motion-gate')
let g: Gate
let settings: Record<string, unknown>

function reduced(on: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: on && q.includes('reduce') }))
}
// A fake IntersectionObserver the test drives.
let ioCallback: (e: { target: Element; isIntersecting: boolean }[]) => void
const observed = vi.fn()
const unobserved = vi.fn()
class FakeIO {
  constructor(cb: typeof ioCallback) { ioCallback = cb }
  observe(el: Element) { observed(el) }
  unobserve(el: Element) { unobserved(el) }
}
const rectAt = (el: Element, top: number) => vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ top, bottom: top + 20, left: 0, right: 100, width: 100, height: 20, x: 0, y: top, toJSON() {} } as DOMRect)

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  localStorage.clear()
  settings = {}
  api.mockReset()
  sendAsHuman.mockReset()
  api.mockImplementation((method: string, _path: string, body?: { patch: Record<string, Record<string, unknown>> }) => {
    if (method === 'GET') return Promise.resolve({ text: JSON.stringify(settings) })
    for (const [k, v] of Object.entries(body!.patch)) {
      const cur = (settings[k] ?? {}) as Record<string, unknown>
      for (const [id, x] of Object.entries(v)) { if (x === null) delete cur[id]; else cur[id] = x }
      settings[k] = cur
    }
    return Promise.resolve({ text: JSON.stringify(settings) })
  })
  reduced(false)
  observed.mockReset()
  unobserved.mockReset()
  vi.stubGlobal('IntersectionObserver', FakeIO)
  g = await import('./motion-gate')
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('motion gate toggles', () => {
  it('allows every kind by default', () => {
    for (const k of g.MOTION_KINDS) expect(g.canAnimate(k.id)).toBe(true)
  })
  it('blocks everything when the master is off', () => {
    g.setMotionPrefs({ all: false })
    for (const k of g.MOTION_KINDS) expect(g.canAnimate(k.id)).toBe(false)
  })
  it('blocks only the kind that is off', () => {
    g.setMotionPrefs({ spend: false })
    expect(g.canAnimate('spend')).toBe(false)
    expect(g.canAnimate('mail')).toBe(true)
  })
  it('blocks all kinds under prefers-reduced-motion', () => {
    reduced(true)
    expect(g.canAnimate('mail')).toBe(false)
  })
  it('notifies subscribers when the reduced-motion setting changes', () => {
    let change: () => void = () => {}
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: (_: string, f: () => void) => { change = f } }))
    g.canAnimate('mail')
    const cb = vi.fn()
    g.subscribeMotion(cb)
    change()
    expect(cb).toHaveBeenCalledTimes(1)
  })
  it('lists each kind once', () => {
    const ids = g.MOTION_KINDS.map((k) => k.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).not.toContain(g.MASTER)
  })
})

describe('motion gate on an element', () => {
  it('blocks while the element is off screen, allows when it returns', () => {
    const el = document.createElement('div')
    document.body.append(el)
    g.watchVisible(el)
    ioCallback([{ target: el, isIntersecting: false }])
    expect(g.canAnimate('mail', el)).toBe(false)
    ioCallback([{ target: el, isIntersecting: true }])
    expect(g.canAnimate('mail', el)).toBe(true)
  })
  it('blocks while the scroll container scrolls and for 150 ms after', () => {
    const box = document.createElement('div')
    const el = document.createElement('div')
    box.append(el)
    document.body.append(box)
    expect(g.canAnimate('mail', el)).toBe(true)
    box.dispatchEvent(new Event('scroll'))
    expect(g.canAnimate('mail', el)).toBe(false)
    vi.advanceTimersByTime(149)
    expect(g.canAnimate('mail', el)).toBe(false)
    vi.advanceTimersByTime(2)
    expect(g.canAnimate('mail', el)).toBe(true)
  })
  it('notifies when a second container starts while the first is still in its window', () => {
    const a = document.createElement('div')
    const b = document.createElement('div')
    document.body.append(a, b)
    g.startMotionGate()
    const cb = vi.fn()
    g.subscribeMotion(cb)
    a.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(50)
    b.dispatchEvent(new Event('scroll'))
    expect(cb).toHaveBeenCalledTimes(2)
    expect(g.canAnimate('mail', b)).toBe(false)
  })
  it('measures an element the observer has not reported on yet', () => {
    const el = document.createElement('div')
    document.body.append(el)
    rectAt(el, 5000)
    expect(g.canAnimate('mail', el)).toBe(false)
    rectAt(el, 10)
    expect(g.canAnimate('mail', el)).toBe(true)
  })
  it('measures an unobserved element against its scroll container', () => {
    const box = document.createElement('div')
    box.style.overflowY = 'auto'
    const el = document.createElement('div')
    box.append(el)
    document.body.append(box)
    rectAt(box, 0)
    rectAt(el, 300)
    expect(g.canAnimate('mail', el)).toBe(false)
  })
  it('keeps observing an element until the last watcher stops', () => {
    const el = document.createElement('div')
    document.body.append(el)
    const a = g.watchVisible(el)
    const b = g.watchVisible(el)
    expect(observed).toHaveBeenCalledTimes(1)
    a()
    a()
    expect(unobserved).not.toHaveBeenCalled()
    b()
    expect(unobserved).toHaveBeenCalledTimes(1)
  })
  it('ignores a scroll in an unrelated container', () => {
    const a = document.createElement('div')
    const b = document.createElement('div')
    document.body.append(a, b)
    g.startMotionGate()
    a.dispatchEvent(new Event('scroll'))
    expect(g.canAnimate('mail', b)).toBe(true)
  })
  it('notifies subscribers when scrolling starts and when it ends', () => {
    const el = document.createElement('div')
    document.body.append(el)
    g.startMotionGate()
    const cb = vi.fn()
    g.subscribeMotion(cb)
    el.dispatchEvent(new Event('scroll'))
    expect(cb).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(151)
    expect(cb).toHaveBeenCalledTimes(2)
  })
})

describe('motion settings round trip', () => {
  it('saves a toggle to the settings record and reads it back on another page', async () => {
    await g.loadMotion()
    g.setMotion('spend', false)
    g.setMotion('all', false)
    await vi.advanceTimersByTimeAsync(600)
    expect(settings.motion).toEqual({ spend: false, all: false })
    vi.resetModules()
    const other: Gate = await import('./motion-gate')
    await other.loadMotion()
    expect(other.motionOn('spend')).toBe(false)
    expect(other.motionOn('all')).toBe(false)
    expect(other.motionOn('mail')).toBe(true)
  })
})
