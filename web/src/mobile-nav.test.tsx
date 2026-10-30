// @vitest-environment jsdom
// The phone's bottom bar (S-3346): a world a fixed slot names is on in that slot, so the main slot
// never repeats it, and no two slots share a label in any world.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, emptyLayout, type Layout, type LayoutOp } from '../../src/layout-ops.ts'
import { MobileNav } from './App'
import * as shell from './shell/layout'
import { humanRowsOf } from './mail/thread-index'
import { setData } from './store'
import { setUi } from './ui/state'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let daemon: Layout = emptyLayout()
let stream: ReadableStreamDefaultController<Uint8Array>
const enc = new TextEncoder()
const push = (l: Layout) => stream.enqueue(enc.encode(`event: layout\ndata: ${JSON.stringify(l)}\n\n`))
const tick = () => new Promise((r) => setTimeout(r, 10))

let root: Root
let host: HTMLElement

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

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  // The bar reads the waiting list and the mail counts; none of them is in these tests.
  setData({ agents: [], itsas: [], humanRows: humanRowsOf() } as never)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  setUi({ topOpen: false })
  act(() => shell.phoneShow(null))
})

// The bar's labels in order, and the slots that are on.
const bar = () => {
  const btns = [...host.querySelectorAll<HTMLButtonElement>('#mobile-nav button')]
  return { labels: btns.map((b) => b.querySelector('.nl')?.textContent ?? ''), on: btns.filter((b) => b.classList.contains('on')).map((b) => b.dataset.nav) }
}
// Make a change to the shell or the assistant, then draw the bar again: it reads them outside a hook.
const change = (fn: () => void) => { act(fn); act(() => root.render(<MobileNav />)) }

// Each world a fixed slot names, and one world each that no fixed slot names.
const WORLDS = ['w:agents', 'w:inbox', 'w:work', 'w:config', 'w:usage', 'w:system', 'w:swipe', 'w:files', 'w:compliance', 'w:board:all']

describe('the phone tab bar', () => {
  it('on the Agents page, slot 1 is on and the main slot reads Main, not Agents again', () => {
    change(() => shell.showAgentWorld('w:agents'))
    expect(bar()).toEqual({ labels: ['Agents', 'Mail', 'Issues', 'Main', 'Work', 'Assistant'], on: ['left'] })
  })

  it('on the Work page and the Inbox page, the main slot keeps Main as before', () => {
    change(() => shell.showAgentWorld('w:work'))
    expect(bar()).toEqual({ labels: ['Agents', 'Mail', 'Issues', 'Main', 'Work', 'Assistant'], on: ['work'] })
    change(() => shell.showAgentWorld('w:inbox'))
    expect(bar()).toEqual({ labels: ['Agents', 'Mail', 'Issues', 'Main', 'Work', 'Assistant'], on: ['mail'] })
  })

  it('the Agents page gives way to another phone side, and to the assistant', () => {
    change(() => shell.showAgentWorld('w:agents'))
    change(() => shell.phoneShow('issues'))
    expect(bar().on).toEqual(['issues'])
    change(() => shell.phoneShow(null))
    change(() => setUi({ topOpen: true }))
    expect(bar().on).toEqual(['assistant'])
  })

  it('other worlds keep their own title in the main slot, with one slot on', () => {
    change(() => shell.showAgentWorld('w:config'))
    expect(bar()).toEqual({ labels: ['Agents', 'Mail', 'Issues', 'Settings', 'Work', 'Assistant'], on: ['main'] })
  })

  it('no world gives two slots the same label, and exactly one slot is on', () => {
    for (const w of WORLDS) {
      change(() => shell.showAgentWorld(w))
      for (const side of [null, 'left', 'issues'] as const) {
        change(() => shell.phoneShow(side))
        const { labels, on } = bar()
        expect(new Set(labels).size, `${w} with side ${side}: ${labels.join(', ')}`).toBe(labels.length)
        expect(on, `${w} with side ${side}`).toHaveLength(1)
      }
      change(() => shell.phoneShow(null))
    }
  })
})
