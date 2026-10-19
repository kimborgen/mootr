// The shell over a stand-in daemon (fetch stubbed): the human's own navigation stays on this
// device and never sends a current op; a current op from elsewhere (an agent) moves this
// device too, out from under a phone's overlay.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { apply, emptyLayout, type Layout, type LayoutOp } from '../../../src/layout-ops.ts'
import * as shell from './layout'

let daemon: Layout = emptyLayout()
let stream: ReadableStreamDefaultController<Uint8Array>
const posted: LayoutOp[][] = []
let phone = false
const enc = new TextEncoder()
const push = (l: Layout) => stream.enqueue(enc.encode(`event: layout\ndata: ${JSON.stringify(l)}\n\n`))
const change = (ops: LayoutOp[]) => {
  daemon = { ...ops.reduce((l, op) => apply(l, op), daemon), version: daemon.version + 1 }
  return daemon
}
const tick = () => new Promise((r) => setTimeout(r, 10))

beforeAll(async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: phone, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/layout/stream') return new Response(new ReadableStream<Uint8Array>({ start: (c) => { stream = c; push(daemon) } }))
    if (path === '/api/layout/ops' && init?.method === 'POST') {
      const ops = JSON.parse(String(init.body)).ops as LayoutOp[]
      posted.push(ops)
      const l = change(ops)
      queueMicrotask(() => push(l))
      return new Response(JSON.stringify(l))
    }
    return new Response('{}', { status: 404 })
  }))
  shell.init({ valid: () => true, keep: () => true, keepWorld: () => true })
  await tick()
})
afterAll(() => { vi.unstubAllGlobals() })

describe('which world a device shows', () => {
  it('changes on this device alone when the human navigates: no current op is sent', async () => {
    shell.showAgentWorld('a1')
    await tick()
    expect(shell.currentWorld()).toBe('a1')
    expect(posted.flat().some((op) => op.op === 'current')).toBe(false)
    expect(daemon.current).toBeNull()
    // The world is kept on the daemon, so its views stay alive after the human moves on.
    expect(daemon.agentWorlds.a1).toBeDefined()
    shell.open('main', 'usage')
    await tick()
    expect(daemon.agentWorlds.a1.root.split ? null : daemon.agentWorlds.a1.root.tabs).toEqual(['agent:a1', 'usage'])
  })

  it('follows a current op from elsewhere, closing the phone\'s overlay', async () => {
    phone = true
    shell.phoneShow('left')
    expect(shell.phoneShows()).toBe('left')
    push(change([{ op: 'current', world: 'b2' }, { op: 'open', world: 'main', key: 'usage', split: 'right' }]))
    await tick()
    expect(shell.currentWorld()).toBe('b2')
    expect(shell.phoneShows()).toBeNull()
    expect(shell.tabsIn()).toEqual(['agent:b2', 'usage'])
    phone = false
  })

  it('sends a split\'s new sizes even before the daemon has the split', async () => {
    shell.showAgentWorld('r1')
    await tick()
    shell.open('main', 'usage', { split: 'right' })
    // The drag ends before the split's own change has come back from the daemon.
    const root = shell.mainWorld().root
    if (!root.split) throw new Error('no split')
    root.sizes = [3, 1]
    shell.resized(root)
    await tick()
    const r = daemon.agentWorlds.r1.root
    expect(r.split && r.id === root.id && r.sizes).toEqual([3, 1])
  })

  it('stays put when another change arrives that leaves the current world alone', async () => {
    shell.showAgentWorld('a1')
    await tick()
    push(change([{ op: 'open', world: 'b2', key: 'config' }]))
    await tick()
    expect(shell.currentWorld()).toBe('a1')
  })
})
