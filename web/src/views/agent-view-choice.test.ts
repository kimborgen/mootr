// An agent's two views (S-82): which one it opens in, and selecting it or switching
// swapping one for the other in place, over a stand-in daemon (fetch stubbed).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { apply, emptyLayout, leaves, type Layout, type LayoutOp } from '../../../src/layout-ops.ts'
import { chooseView, fallBackToTerminal, selectAgent, showView } from '../actions'
import * as shell from '../shell/layout'
import { getData, setData } from '../store'
import type { Agent } from '../types'
import { choiceOf, defaultView, keyFor, swapForDefault, switchable } from './agent-view-choice'

const caps = { can_stream: true, can_send: true, can_interrupt: true, can_approve: true }

describe('the default view', () => {
  it('is the agent’s own, then Settings’, then the terminal; never a view the agent lacks', () => {
    expect(defaultView({ view: caps, default_view: 'conversation' }, 'terminal')).toBe('conversation')
    expect(defaultView({ view: caps, default_view: 'terminal' }, 'conversation')).toBe('terminal')
    expect(defaultView({ view: caps, default_view: null }, 'conversation')).toBe('conversation')
    expect(defaultView({ view: caps }, undefined)).toBe('conversation')
    expect(defaultView({ view: caps, default_view: null }, null)).toBe('conversation')
    expect(defaultView({ view: null, default_view: 'conversation' }, 'conversation')).toBe('terminal')
    expect(defaultView(undefined, 'conversation')).toBe('terminal')
  })
  it('names keys both ways, and the switch shows only for an agent with a view', () => {
    expect(keyFor('a', 'terminal')).toBe('agent:a')
    expect(keyFor('a', 'conversation')).toBe('view:a')
    expect(choiceOf('view:a')).toEqual({ id: 'a', view: 'conversation' })
    expect(choiceOf('mail:a')).toBeNull()
    expect(switchable('agent:a', { view: caps })).toBe(true)
    expect(switchable('agent:a', { view: null })).toBe(false)
    expect(switchable('details:a', { view: caps })).toBe(false)
  })
  it('swaps on selection only when the other view shows alone', () => {
    expect(swapForDefault(['agent:a', 'mail:a'], 'a', 'conversation')).toEqual({ key: 'agent:a', with: 'view:a' })
    expect(swapForDefault(['view:a'], 'a', 'terminal')).toEqual({ key: 'view:a', with: 'agent:a' })
    expect(swapForDefault(['agent:a'], 'a', 'terminal')).toBeNull()
    expect(swapForDefault(['agent:a', 'view:a'], 'a', 'conversation')).toBeNull()
    expect(swapForDefault(['usage'], 'a', 'conversation')).toBeNull()
  })
})

// --- Over the shell ---
let daemon: Layout = emptyLayout()
let stream: ReadableStreamDefaultController<Uint8Array>
const puts: { path: string; body: unknown }[] = []
const enc = new TextEncoder()
const push = (l: Layout) => stream.enqueue(enc.encode(`event: layout\ndata: ${JSON.stringify(l)}\n\n`))
const tick = () => new Promise((r) => setTimeout(r, 10))
const agent = (id: string, view: Agent['view'], default_view: Agent['default_view'] = null) =>
  ({ id, name: id, view, default_view, machine: 'm', harness: 'opencode', lifecycle: 'active', created_at: '', updated_at: '' }) as unknown as Agent
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
    if (init?.method === 'PUT') { puts.push({ path, body: JSON.parse(String(init.body)) }); return new Response('{}') }
    // The daemon's list: the agents as the test set them, with any default the human picked.
    if (path.split('?')[0] === '/api/agents') return new Response(JSON.stringify(getData().agents))
    return new Response('[]')
  }))
  shell.init({ valid: () => true, keep: () => true, keepWorld: () => true })
  await tick()
})
afterAll(() => { vi.unstubAllGlobals() })

describe('selecting and switching', () => {
  it('opens a new agent in Settings’ default, and one without a view in its terminal', async () => {
    setData({ agents: [agent('oc', caps), agent('plain', null)], agentView: 'conversation' })
    selectAgent('oc')
    await tick()
    expect(tabs('oc')).toEqual([[['view:oc'], 'view:oc']])
    selectAgent('plain')
    await tick()
    expect(tabs('plain')).toEqual([[['agent:plain'], 'agent:plain']])
  })
  it('switches in place, and selecting again brings the default back', async () => {
    selectAgent('oc')
    shell.open('main', 'mail:oc')
    showView('oc', 'terminal')
    await tick()
    expect(tabs('oc')).toEqual([[['agent:oc', 'mail:oc'], 'agent:oc']])
    selectAgent('plain')
    selectAgent('oc')
    await tick()
    expect(tabs('oc')).toEqual([[['view:oc', 'mail:oc'], 'view:oc']])
  })
  it('follows the agent’s own default over Settings’', async () => {
    setData({ agents: [agent('oc', caps, 'terminal'), agent('plain', null)], agentView: 'conversation' })
    selectAgent('plain')
    selectAgent('oc')
    await tick()
    expect(tabs('oc')).toEqual([[['agent:oc', 'mail:oc'], 'agent:oc']])
  })
  it('leaves both views alone when the human put them side by side', async () => {
    shell.open('main', 'view:oc', { split: 'right' })
    setData({ agents: [agent('oc', caps, 'conversation'), agent('plain', null)] })
    selectAgent('plain')
    selectAgent('oc')
    await tick()
    expect(tabs('oc').map((t) => t[0])).toEqual([['agent:oc', 'mail:oc'], ['view:oc']])
  })
})

describe('the switch remembers, and a refused view falls back everywhere', () => {
  it('sets the agent’s own default to what the human picked, so reselecting opens it', async () => {
    setData({ agents: [agent('sw', caps), agent('plain', null)], agentView: 'terminal' })
    selectAgent('sw')
    await tick()
    expect(tabs('sw')).toEqual([[['agent:sw'], 'agent:sw']])
    chooseView('sw', 'conversation')
    await tick()
    expect(tabs('sw')).toEqual([[['view:sw'], 'view:sw']])
    expect(puts).toContainEqual({ path: '/api/agents/sw/default-view', body: { view: 'conversation' } })
    // The store holds the choice at once, before the next poll.
    selectAgent('plain')
    selectAgent('sw')
    await tick()
    expect(tabs('sw')).toEqual([[['view:sw'], 'view:sw']])
  })
  it('swaps a refused view in a world that isn’t on screen', async () => {
    setData({ agents: [agent('far', caps, 'conversation'), agent('plain', null)] })
    selectAgent('far')
    await tick()
    expect(tabs('far')).toEqual([[['view:far'], 'view:far']])
    selectAgent('plain')
    await tick()
    fallBackToTerminal('far')
    await tick()
    expect(tabs('far')).toEqual([[['agent:far'], 'agent:far']])
  })
})
