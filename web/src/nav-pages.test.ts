// The pages the desktop nav bar's icons and the sidebar's tab headers open (S-1428): one opener, openWorld,
// and the Agents page is a world of its own like the Inbox and Work pages.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, emptyLayout, type Layout, type LayoutOp } from '../../src/layout-ops.ts'
import * as shell from './shell/layout'
// Loaded first: SidebarSettings reads SidebarPanes' tab registry as it loads, which only this order allows (a cycle through the registry).
import './views/SidebarSettings'

let daemon: Layout = emptyLayout()
let stream: ReadableStreamDefaultController<Uint8Array>
const enc = new TextEncoder()
const push = (l: Layout) => stream.enqueue(enc.encode(`event: layout\ndata: ${JSON.stringify(l)}\n\n`))
const tick = () => new Promise((r) => setTimeout(r, 10))

beforeAll(async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
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

// Each test starts with the sidebar's default layout and nothing open in main.
const reset = async () => {
  const { setSidebarPanes, defaultPanes } = await import('./sidebar-panes')
  setSidebarPanes(defaultPanes())
  shell.dropAgentWorld('w:agents')
  shell.showAgentWorld(null)
  await tick()
}

describe('the pages the nav bar and the sidebar open', () => {
  beforeEach(() => reset())
  it('openWorld agents opens the Agents page, as its own world', async () => {
    const { openWorld } = await import('./actions')
    openWorld('agents')
    await tick()
    expect(shell.currentWorld()).toBe('w:agents')
    expect(shell.leaves(shell.mainWorld().root).map((l) => l.tabs)).toEqual([['agents']])
  })
  it('the sidebar Agents tab header opens the Agents page', async () => {
    const { openTabPage } = await import('./SidebarPanes')
    expect(openTabPage('agents')).toBe(true)
    await tick()
    expect(shell.currentWorld()).toBe('w:agents')
  })
  it('the Issues tab header opens the Work page, as the human decided', async () => {
    const { openTabPage } = await import('./SidebarPanes')
    openTabPage('issues')
    await tick()
    expect(shell.currentWorld()).toBe('w:work')
  })
  it('opening a page that is already shown keeps the one page', async () => {
    const { openWorld } = await import('./actions')
    openWorld('agents')
    await tick()
    openWorld('agents')
    await tick()
    expect(shell.currentWorld()).toBe('w:agents')
    expect(shell.leaves(shell.mainWorld().root)).toHaveLength(1)
  })
  it('the Agents page is a view key the layout keeps across a reload', async () => {
    const { validKey } = await import('./views/registry')
    expect(validKey('agents')).toBe(true)
  })
  it('a tab without a page has none to open', async () => {
    const { openTabPage } = await import('./SidebarPanes')
    expect(openTabPage('history')).toBe(false)
    expect(shell.currentWorld()).toBeNull()
  })
})
