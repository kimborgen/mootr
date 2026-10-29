// A new agent opens in its default view straight from the spawn (S-173): the POST /api/agents
// response carries the agent's view capabilities, as the list does, so the default applies
// without waiting for the next refresh. Over the shell, with fetch stubbed as in agent-view-choice.test.ts.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { apply, emptyLayout, leaves, type Layout, type LayoutOp } from '../../../src/layout-ops.ts'
import { spawn } from '../spawn'
import * as shell from '../shell/layout'
import { getData, setData } from '../store'
import type { Agent } from '../types'

const caps = { can_stream: true, can_send: true, can_interrupt: true, can_approve: true }

let daemon: Layout = emptyLayout()
let stream: ReadableStreamDefaultController<Uint8Array>
const enc = new TextEncoder()
const push = (l: Layout) => stream.enqueue(enc.encode(`event: layout\ndata: ${JSON.stringify(l)}\n\n`))
const tick = () => new Promise((r) => setTimeout(r, 10))
// What the daemon answers a spawn with: the new agent, with the view its harness has.
let spawned: unknown = {}
const tabs = (world: string) => leaves(daemon.agentWorlds[world].root).map((l) => [l.tabs, l.active])

beforeAll(async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/layout/stream') return new Response(new ReadableStream<Uint8Array>({ start: (c) => { stream = c; push(daemon) } }))
    if (path === '/api/layout/ops' && init?.method === 'POST') {
      const ops = JSON.parse(String(init.body)).ops as LayoutOp[]
      daemon = { ...ops.reduce((l, op) => apply(l, op), daemon), version: daemon.version + 1 }
      const l = daemon
      queueMicrotask(() => push(l))
      return new Response(JSON.stringify(l))
    }
    if (path === '/api/agents' && init?.method === 'POST') return new Response(JSON.stringify(spawned))
    if (path.split('?')[0] === '/api/agents') return new Response(JSON.stringify(getData().agents))
    return new Response('{}')
  }))
  shell.init({ valid: () => true, keep: () => true, keepWorld: () => true })
  await tick()
})
afterAll(() => { vi.unstubAllGlobals() })

const made = (id: string, view: Agent['view']) =>
  ({ id, name: id, view, default_view: null, machine: 'm', harness: 'opencode', model: null, cwd: '/tmp', parent_id: null, lifecycle: 'active', created_at: '', updated_at: '' }) as unknown as Agent

describe('a spawned agent', () => {
  it('opens in the default view, not the terminal, when the spawn response has its view', async () => {
    setData({ agents: [], agentView: 'conversation' })
    spawned = made('new1', caps)
    await spawn({ name: 'new1', harness: 'opencode', cwd: '/tmp' } as never)
    await tick()
    expect(tabs('new1')).toEqual([[['view:new1'], 'view:new1']])
  })
  it('opens in the terminal when Settings says so', async () => {
    setData({ agents: [], agentView: 'terminal' })
    spawned = made('new2', caps)
    await spawn({ name: 'new2', harness: 'opencode', cwd: '/tmp' } as never)
    await tick()
    expect(tabs('new2')).toEqual([[['agent:new2'], 'agent:new2']])
  })
  it('opens in the terminal when the agent has no view', async () => {
    setData({ agents: [], agentView: 'conversation' })
    spawned = made('new3', null)
    await spawn({ name: 'new3', harness: 'opencode', cwd: '/tmp' } as never)
    await tick()
    expect(tabs('new3')).toEqual([[['agent:new3'], 'agent:new3']])
  })
})
