// The one-time move of this browser's earlier layout (stam/shell3) to an empty daemon: it
// counts as done only once the daemon took it (or refused it, its layout no longer empty);
// a failure leaves it to try again.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { emptyLayout, type Layout } from '../../../src/layout-ops.ts'
import * as shell from './layout'

const old = { v: 6, open: { left: true, bottom: true }, size: { left: 300, right: 360, bottom: 200 }, current: 'a1', agentWorlds: { a1: { root: { id: 'x', tabs: ['agent:a1'], active: 'agent:a1' }, focused: 'x' } }, worlds: {} }
let daemon: Layout = emptyLayout()
let puts = 0
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  localStorage.setItem('stam/shell3', JSON.stringify(old))
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/layout/stream') {
      return new Response(new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new TextEncoder().encode(`event: layout\ndata: ${JSON.stringify(daemon)}\n\n`)) }))
    }
    if (path === '/api/layout' && init?.method === 'PUT') {
      // The first try fails on the daemon's side; the second goes through.
      if (++puts === 1) return new Response('{"error":"busy"}', { status: 503 })
      daemon = { ...JSON.parse(String(init.body)).layout, version: 1 }
      return new Response(JSON.stringify(daemon))
    }
    return new Response('{}', { status: 404 })
  }))
  shell.init({ valid: () => true, keep: () => true, keepWorld: () => true })
})
afterAll(() => { vi.unstubAllGlobals(); localStorage.clear() })

describe('moving the earlier layout to the daemon', () => {
  it('isn\'t marked done while the PUT fails, and is after it goes through', async () => {
    await tick(50)
    expect(puts).toBe(1)
    expect(localStorage.getItem('stam/shell3-moved')).toBeNull()
    expect(shell.tabsIn()).toEqual(['agent:a1'])
    await tick(1200)
    expect(puts).toBe(2)
    expect(localStorage.getItem('stam/shell3-moved')).toBe('true')
    expect(daemon.agentWorlds.a1).toBeDefined()
  })
})
