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
