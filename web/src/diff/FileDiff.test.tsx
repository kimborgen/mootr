// @vitest-environment jsdom
// S-1916: a drawn file tears its editor down once it leaves the far margin, and draws again, without a refetch, when it comes back.
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileDiff, FAR_MARGIN } from './FileDiff'
import type { DiffFileItem } from './diffModel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const destroy = vi.hoisted(() => vi.fn())
const created = vi.hoisted(() => vi.fn())
vi.mock('./mergeEditor', () => ({
  createDiffEditor: async (el: HTMLElement) => {
    created()
    const pre = document.createElement('div')
    pre.className = 'fake-editor'
    pre.textContent = 'text'
    pre.tabIndex = 0
    el.append(pre)
    return { views: { path: 'a.ts', mode: 'split', head: {}, base: {} }, reveal: () => {}, destroy: () => { destroy(); pre.remove() } }
  },
}))

// An observer the test drives by rootMargin: `fire(margin, intersecting)`.
interface Obs { cb: IntersectionObserverCallback; margin: string; live: boolean }
let observers: Obs[] = []
const fire = (margin: string, isIntersecting: boolean) => {
  for (const o of observers.filter((x) => x.live && x.margin === margin)) act(() => o.cb([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver))
}
const FAR = `${FAR_MARGIN}px 0px`, NEAR = '800px 0px'

const refs = { repo: 'stam2', pr: 7, head: 'a'.repeat(40), base: 'b'.repeat(40) }
const f: DiffFileItem = { path: 'a.ts', status: 'modified', additions: 2, deletions: 1, binary: false, class: null, headBlob: 'h', baseBlob: 'b' }

let root: Root | undefined
let host: HTMLDivElement
let fetched = 0
const onEditor = vi.fn()
beforeEach(() => {
  observers = []
  fetched = 0
  destroy.mockClear(); created.mockClear(); onEditor.mockClear()
  vi.stubGlobal('IntersectionObserver', class {
    o: Obs
    constructor(cb: IntersectionObserverCallback, opts: IntersectionObserverInit) { this.o = { cb, margin: opts.rootMargin ?? '', live: true }; observers.push(this.o) }
    observe() {} unobserve() {} takeRecords() { return [] }
    disconnect() { this.o.live = false }
  })
  vi.stubGlobal('fetch', vi.fn(async () => { fetched++; return new Response('x\n', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } }) }))
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals() })

const mount = async (extra: Partial<React.ComponentProps<typeof FileDiff>> = {}) => {
  act(() => root!.render(<FileDiff file={f} refs={refs} mode="split" wrap={false} viewed={false} onViewed={() => {}} onHide={() => {}} onEditor={onEditor} {...extra} />))
  fire(NEAR, true)
  await vi.waitFor(() => expect(host.querySelector('.fake-editor')).not.toBeNull(), { timeout: 5000 })
}
const section = () => host.querySelector<HTMLElement>('section')!

describe('far teardown', () => {
  it('destroys the editor when the file leaves the far margin, and redraws without a second fetch', async () => {
    await mount()
    const first = fetched
    expect(first).toBe(2)
    fire(FAR, false)
    await vi.waitFor(() => expect(host.querySelector('.fake-editor')).toBeNull())
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(onEditor).toHaveBeenLastCalledWith(null, 'a.ts')
    fire(NEAR, true)
    await vi.waitFor(() => expect(host.querySelector('.fake-editor')).not.toBeNull())
    expect(created).toHaveBeenCalledTimes(2)
    expect(fetched).toBe(first)
    expect(onEditor.mock.calls.filter((c) => c[0]).length).toBe(2)
  })

  it('keeps an editor that is still inside the far margin', async () => {
    await mount()
    fire(FAR, true)
    expect(destroy).not.toHaveBeenCalled()
  })

  it('pins the height while torn down and clears the pin once redrawn', async () => {
    await mount()
    Object.defineProperty(section(), 'offsetHeight', { configurable: true, value: 640 })
    fire(FAR, false)
    await vi.waitFor(() => expect(host.querySelector('.fake-editor')).toBeNull())
    expect(section().style.minHeight).toBe('640px')
    fire(NEAR, true)
    await vi.waitFor(() => expect(host.querySelector('.fake-editor')).not.toBeNull())
    expect(section().style.minHeight).toBe('')
  })

  it('does not tear down a file that holds focus, until it loses it', async () => {
    await mount()
    act(() => host.querySelector<HTMLElement>('.fake-editor')!.focus())
    fire(FAR, false)
    expect(destroy).not.toHaveBeenCalled()
    act(() => { host.querySelector<HTMLElement>('.fake-editor')!.blur() })
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledTimes(1))
  })

  it('does not tear down while a selection sits in the file, until it is cleared', async () => {
    await mount()
    document.getSelection()!.selectAllChildren(host.querySelector('.fake-editor')!)
    fire(FAR, false)
    expect(destroy).not.toHaveBeenCalled()
    document.getSelection()!.removeAllRanges()
    act(() => { document.dispatchEvent(new Event('selectionchange')) })
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledTimes(1))
  })

  it('holds a file jumped to from far away until the far observer has seen it in range', async () => {
    await mount({ target: { line: 1, side: 'head', n: 1 }, onTarget: () => {} })
    fire(FAR, false)
    expect(destroy).not.toHaveBeenCalled()
    fire(FAR, true)
    fire(FAR, false)
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledTimes(1))
  })

  it('drops the pinned height when the torn-down file closes', async () => {
    await mount()
    Object.defineProperty(section(), 'offsetHeight', { configurable: true, value: 640 })
    fire(FAR, false)
    await vi.waitFor(() => expect(section().style.minHeight).toBe('640px'))
    act(() => root!.render(<FileDiff file={f} refs={refs} mode="split" wrap={false} viewed onViewed={() => {}} onHide={() => {}} onEditor={onEditor} />))
    expect(section().style.minHeight).toBe('')
  })
})
