// A view's refetch on each tick follows what the real shell shows: MainWorld and ViewPortals
// rendered as the app renders them, over a stand-in daemon. A world switch and the phone's
// focused pane each park the other views, which then reload once when they show again.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, emptyLayout, type Layout, type LayoutOp } from '../../../src/layout-ops.ts'
import { ViewPortals } from '../views/registry'
import * as store from '../store'
import { MainWorld } from './MainWorld'
import * as shell from './layout'

let daemon: Layout = emptyLayout()
let stream: ReadableStreamDefaultController<Uint8Array>
let phone = false
const enc = new TextEncoder()
const push = (l: Layout) => stream.enqueue(enc.encode(`event: layout\ndata: ${JSON.stringify(l)}\n\n`))
const change = (ops: LayoutOp[]) => {
  daemon = { ...ops.reduce((l, op) => apply(l, op), daemon), version: daemon.version + 1 }
  return daemon
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 10)) })
const tick = () => act(async () => { store.setData({ mailTick: store.getData().mailTick + 1 }) })

// Every GET of a mail list, by its owner, counted.
let loads: Record<string, number>
const loadsOf = (owner: string) => loads[owner] ?? 0

let host: HTMLElement
let root: Root
beforeAll(async () => {
  vi.stubGlobal('matchMedia', () => ({ get matches() { return phone }, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } })
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/layout/stream') return new Response(new ReadableStream<Uint8Array>({ start: (c) => { stream = c; push(daemon) } }))
    if (path === '/api/layout/ops' && init?.method === 'POST') {
      const ops = JSON.parse(String(init.body)).ops as LayoutOp[]
      const l = change(ops)
      queueMicrotask(() => push(l))
      return new Response(JSON.stringify(l))
    }
    const m = /^\/api\/agents\/([^/]+)\/threads/.exec(path)
    if (m) { loads[m[1]] = loadsOf(m[1]) + 1; return new Response('[]') }
    return new Response(init?.method === 'POST' ? '{}' : '[]')
  }))
  shell.init({ valid: () => true, keep: () => true, keepWorld: () => true })
  await flush()
})
afterAll(() => { vi.unstubAllGlobals() })

beforeEach(() => {
  loads = {}
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(<><MainWorld /><ViewPortals /></>))
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('a world switch', () => {
  it('parks the main world\'s views, which reload once when their world shows again', async () => {
    phone = false
    shell.open('main', 'mail:a1')
    await flush()
    const n = loadsOf('a1')
    await tick()
    await flush()
    expect(loadsOf('a1')).toBe(n + 1)

    // Another agent's world takes the screen: a1's mail is parked, not shown.
    shell.showAgentWorld('w1')
    await flush()
    const parked = loadsOf('a1')
    await tick()
    await tick()
    await flush()
    expect(loadsOf('a1')).toBe(parked)

    // Back to the home world: a1's mail shows, and reloads once for the ticks it missed.
    shell.showAgentWorld(null)
    await flush()
    expect(loadsOf('a1')).toBe(parked + 1)
    await tick()
    await flush()
    expect(loadsOf('a1')).toBe(parked + 2)
  })
})

describe('the phone\'s focused pane', () => {
  it('parks the pane that isn\'t focused, which reloads once when it is focused again', async () => {
    shell.showAgentWorld(null)
    shell.open('main', 'mail:b1')
    shell.open('main', 'mail:b2', { split: 'right' })
    await flush()
    const first = shell.leaves(shell.mainWorld().root)[0].id
    const second = shell.leaves(shell.mainWorld().root)[1].id
    phone = true
    shell.setFocus('main', first)
    await flush()
    const b2 = loadsOf('b2')
    await tick()
    await flush()
    // Only the focused pane (b1) is on screen, so b2 loads nothing on a tick.
    expect(loadsOf('b2')).toBe(b2)
    const b1 = loadsOf('b1')

    shell.setFocus('main', second)
    await flush()
    expect(loadsOf('b2')).toBe(b2 + 1)
    expect(loadsOf('b1')).toBe(b1)
    phone = false
  })
})
