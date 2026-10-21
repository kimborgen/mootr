// Mail opens where the setting says (settings.mailOpens, S-2310): the Inbox page, or the sidebar's Mail tab with a
// thread in main on its own. Closing the list keeps the thread beside it, and the page brings the list back.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, emptyLayout, type Layout, type LayoutOp } from '../../src/layout-ops.ts'
import * as shell from './shell/layout'
// Loaded first: SidebarSettings reads SidebarPanes' tab registry as it loads, which only this order allows (a cycle through the registry).
import './views/SidebarSettings'

let daemon: Layout = emptyLayout()
let stream: ReadableStreamDefaultController<Uint8Array>
let phone = false
const enc = new TextEncoder()
const push = (l: Layout) => stream.enqueue(enc.encode(`event: layout\ndata: ${JSON.stringify(l)}\n\n`))
const tick = () => new Promise((r) => setTimeout(r, 10))
const panes = () => shell.leaves(shell.mainWorld().root).map((l) => l.tabs)

beforeAll(async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: phone, addEventListener() {}, removeEventListener() {} }))
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
  shell.init({ valid: () => true, keep: () => true, keepWorld: () => true })
  await tick()
})
afterAll(() => { vi.unstubAllGlobals() })

// Each test starts with the Inbox page and the sidebar's default layout, nothing open in main.
const reset = async (mailOpens: 'inbox' | 'sidebar') => {
  const { setData } = await import('./store')
  const { setSidebarPanes, defaultPanes } = await import('./sidebar-panes')
  setData({ mailOpens })
  setSidebarPanes(defaultPanes())
  phone = false
  shell.dropAgentWorld('w:inbox')
  await tick()
  shell.showAgentWorld(null)
  await tick()
}

describe('Mail with the Inbox page setting', () => {
  beforeEach(() => reset('inbox'))
  it('the sidebar Mail tab opens the Inbox page', async () => {
    const { openTabPage } = await import('./SidebarPanes')
    openTabPage('mail')
    await tick()
    expect(shell.currentWorld()).toBe('w:inbox')
  })
  it('openWorld inbox, the route for #inbox, opens the Inbox page', async () => {
    const { openWorld } = await import('./actions')
    openWorld('inbox')
    await tick()
    expect(shell.currentWorld()).toBe('w:inbox')
  })
})

describe('Mail with the sidebar setting', () => {
  beforeEach(() => reset('sidebar'))
  for (const [name, open] of [
    ['the sidebar Mail tab', async () => (await import('./SidebarPanes')).openTabPage('mail')],
    ['openWorld inbox, the route for #inbox', async () => (await import('./actions')).openWorld('inbox')],
  ] as const) {
    it(`${name} shows the sidebar's Mail tab and opens the sidebar, not the page`, async () => {
      const { activate, currentPanes, setSidebarPanes } = await import('./sidebar-panes')
      setSidebarPanes(activate(currentPanes(), 1, 'history'))
      shell.toggleWorld('left', false)
      await open()
      await tick()
      expect(shell.currentWorld()).toBeNull()
      expect(currentPanes()[1].active).toBe('mail')
      expect(shell.worldOpen('left')).toBe(true)
    })
  }
  it('a thread opens in main on its own, as before the Inbox page', async () => {
    const { selectThread } = await import('./actions')
    selectThread('t1')
    await tick()
    expect(shell.currentWorld()).toBe('t:t1')
  })
  it('falls back to the Inbox page when the sidebar has no Mail tab', async () => {
    const { removeTab, currentPanes, setSidebarPanes } = await import('./sidebar-panes')
    const { openWorld } = await import('./actions')
    setSidebarPanes(removeTab(currentPanes(), 'mail'))
    openWorld('inbox')
    await tick()
    expect(shell.currentWorld()).toBe('w:inbox')
  })
  it('the phone keeps its Mail view, the page', async () => {
    const { openWorld } = await import('./actions')
    phone = true
    openWorld('inbox')
    await tick()
    expect(shell.currentWorld()).toBe('w:inbox')
    phone = false
  })
})

describe('closing the Inbox list', () => {
  beforeEach(() => reset('inbox'))
  it('keeps the thread open beside it, and the page brings the list back to its left', async () => {
    const { openWorld, openInboxThread } = await import('./actions')
    openWorld('inbox')
    await tick()
    openInboxThread('k1')
    await tick()
    expect(panes()).toEqual([['inbox'], ['thread:k1']])
    shell.close('inbox')
    await tick()
    expect(panes()).toEqual([['thread:k1']])
    openWorld('inbox')
    await tick()
    expect(panes()).toEqual([['inbox'], ['thread:k1']])
  })
  it('a thread opened after the list closed takes the thread pane, not a new one', async () => {
    const { openWorld, openInboxThread } = await import('./actions')
    openWorld('inbox')
    await tick()
    openInboxThread('k1')
    await tick()
    shell.close('inbox')
    await tick()
    openInboxThread('k2')
    await tick()
    expect(panes()).toEqual([['thread:k2']])
  })
})
