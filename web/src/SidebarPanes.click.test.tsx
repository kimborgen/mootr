// @vitest-environment jsdom
// A click on a sidebar tab header shows the tab in its pane and opens the tab's page (S-1428): Mail opens the
// Inbox page, and the pane keeps showing Mail. A tab with no page only shows.
import { act, createRef, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, emptyLayout, type Layout, type LayoutOp } from '../../src/layout-ops.ts'
import './shell/layout'
// Loaded first: SidebarSettings reads SidebarPanes' tab registry as it loads, which only this order allows (a cycle through the registry).
import './views/SidebarSettings'

vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
// The Tree reads the Work fields from the API: an empty list, as the daemon answers with none.
vi.mock('./api', () => ({ api: vi.fn(async () => []), hash: new URLSearchParams() }))

let daemon: Layout = emptyLayout()
let stream: ReadableStreamDefaultController<Uint8Array>
const enc = new TextEncoder()
const push = (l: Layout) => stream.enqueue(enc.encode(`event: layout\ndata: ${JSON.stringify(l)}\n\n`))
const tick = () => new Promise((r) => setTimeout(r, 10))

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/layout/stream') return new Response(new ReadableStream<Uint8Array>({ start: (c) => { stream = c; push(daemon) } }))
    if (path === '/api/layout/ops' && init?.method === 'POST') {
      const ops = JSON.parse(String(init.body)).ops as LayoutOp[]
      daemon = { ...ops.reduce((l, op) => apply(l, op), daemon), version: daemon.version + 1 }
      queueMicrotask(() => push(daemon))
      return new Response(JSON.stringify(daemon))
    }
    return new Response('{}', { status: 404 })
  }))
  const shell = await import('./shell/layout')
  shell.init({ valid: () => true, keep: () => true, keepWorld: () => true })
  await tick()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(() => { vi.unstubAllGlobals() })

// Each test's tree is unmounted and removed, so a later test's ids are the only ones in the document.
const roots: Root[] = []
const mount = async (node: ReactNode) => {
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  roots.push(root)
  await act(async () => { root.render(node) })
  return el
}
afterEach(async () => {
  for (const r of roots.splice(0)) await act(async () => { r.unmount() })
  document.body.innerHTML = ''
})

describe('the sidebar tab headers', () => {
  beforeEach(async () => {
    const shell = await import('./shell/layout')
    const { defaultPanes, setSidebarPanes } = await import('./sidebar-panes')
    setSidebarPanes(defaultPanes())
    shell.showAgentWorld(null)
    await tick()
  })

  it('a click on Mail shows the tab and opens the Inbox page', async () => {
    const shell = await import('./shell/layout')
    const { SidebarPanes } = await import('./SidebarPanes')
    const el = await mount(<SidebarPanes left={createRef()} />)
    await act(async () => { el.querySelector<HTMLButtonElement>('#pane-tab-mail')!.click(); await tick() })
    expect(shell.currentWorld()).toBe('w:inbox')
    expect(el.querySelector('#pane-tab-mail')!.getAttribute('aria-selected')).toBe('true')
  })

  it('a click on a tab with no page only shows it', async () => {
    const shell = await import('./shell/layout')
    const { SidebarPanes } = await import('./SidebarPanes')
    const el = await mount(<SidebarPanes left={createRef()} />)
    await act(async () => { el.querySelector<HTMLButtonElement>('#pane-tab-machines')!.click(); await tick() })
    expect(shell.currentWorld()).toBeNull()
    expect(el.querySelector('#pane-tab-machines')!.getAttribute('aria-selected')).toBe('true')
  })
})

// The separator between panes (S-3810). jsdom has no layout, so the panes' heights (300, 200, 100) and their
// minimum height (60) are stubbed, and the pointer is a MouseEvent of the pointer types.
describe('the pane separators', () => {
  const HEIGHTS = [300, 200, 100]
  const patches = async () => {
    await new Promise((r) => setTimeout(r, 650))
    const { api } = await import('./api')
    return vi.mocked(api).mock.calls.filter((c) => c[0] === 'PATCH')
  }
  const fire = (el: Element, type: string, y = 0) => act(async () => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientY: y })) })
  let sep: HTMLElement
  let el: HTMLElement
  let store: typeof import('./sidebar-panes')

  beforeEach(async () => {
    store = await import('./sidebar-panes')
    const { api } = await import('./api')
    const rect = Element.prototype.getBoundingClientRect
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const i = this.classList.contains('side-pane') ? Number((this as HTMLElement).dataset.pane) : -1
      return i < 0 ? rect.call(this) : { x: 0, y: 0, left: 0, right: 0, top: 0, bottom: HEIGHTS[i], width: 0, height: HEIGHTS[i], toJSON() {} }
    })
    const style = window.getComputedStyle
    vi.spyOn(window, 'getComputedStyle').mockImplementation(((e: Element, pseudo?: string | null) => (e.classList?.contains('side-pane') ? { minHeight: '60px' } : style(e, pseudo))) as typeof window.getComputedStyle)
    HTMLElement.prototype.setPointerCapture = vi.fn()
    store.setSidebarPanes(store.defaultPanes())
    store.setSidebarSizes(null)
    await new Promise((r) => setTimeout(r, 650))
    vi.mocked(api).mockClear()
    const { SidebarPanes } = await import('./SidebarPanes')
    el = await mount(<SidebarPanes left={createRef()} />)
    sep = el.querySelector<HTMLElement>('.sep[data-sep="0"]')!
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('moves the panes while dragging and saves exactly once, on release', async () => {
    await fire(sep, 'pointerdown', 300)
    await fire(sep, 'pointermove', 250)
    await fire(sep, 'pointermove', 200)
    expect(store.currentSizes()).toBeUndefined()
    expect(el.querySelector<HTMLElement>('[data-pane="0"]')!.style.flex).toBe('2 1 0%')
    await fire(sep, 'pointerup', 200)
    expect(store.currentSizes()?.map((v) => Math.round(v * 100) / 100)).toEqual([2, 3, 1])
    const sent = await patches()
    expect(sent).toHaveLength(1)
    expect((sent[0][2] as { patch: { sidebarPanes: { main: { sizes: number[] } } } }).patch.sidebarPanes.main.sizes).toHaveLength(3)
  })
  it('saves nothing for a press with no movement', async () => {
    await fire(sep, 'pointerdown', 300)
    await fire(sep, 'pointerup', 300)
    expect(store.currentSizes()).toBeUndefined()
    expect(await patches()).toHaveLength(0)
  })
  it('does not nudge the panes when the gutter is pressed off the pane edge', async () => {
    await fire(sep, 'pointerdown', 303)
    await fire(sep, 'pointermove', 304)
    await fire(sep, 'pointerup', 304)
    expect(Math.abs(store.currentSizes()![0] - 3)).toBeLessThan(0.02)
  })
  it('puts the panes back and saves nothing when the pointer is cancelled', async () => {
    await fire(sep, 'pointerdown', 300)
    await fire(sep, 'pointermove', 200)
    await fire(sep, 'pointercancel', 200)
    expect(el.querySelector<HTMLElement>('[data-pane="0"]')!.style.flex).toBe('3 1 0%')
    expect(store.currentSizes()).toBeUndefined()
    expect(await patches()).toHaveLength(0)
  })
  it('steps with the arrow keys and keeps aria-valuenow, with the real limits, up to date', async () => {
    expect(sep.getAttribute('aria-valuenow')).toBe('60')
    expect(sep.getAttribute('aria-valuemin')).toBe('12')
    expect(sep.getAttribute('aria-valuemax')).toBe('88')
    await act(async () => { sep.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
    expect(store.currentSizes()).toBeDefined()
    expect(el.querySelector('.sep[data-sep="0"]')!.getAttribute('aria-valuenow')).toBe('65')
  })
  it('resets to the default on a double-click', async () => {
    await act(async () => { store.setSidebarSizes([1, 4, 1]) })
    await act(async () => { sep.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
    expect(store.currentSizes()).toBeUndefined()
  })
})
