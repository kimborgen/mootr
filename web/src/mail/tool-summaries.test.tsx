// @vitest-environment jsdom
// Tool-call summaries in the conversation (S-1481, ./tool-summaries.ts): only groups on screen
// are asked for, the latest group first and each group's header call ahead of its other calls;
// a call waits up to the hold drawn invisible, then shows raw and fades to a late summary; a
// summary inside the hold shows at once; with the step off nothing waits and stored summaries still
// show; a stale summary shows until its new one lands (S-1843); and in the
// own view a summary landing redraws neither another turn nor its own turn's text.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setData } from '../store'
import type { Agent } from '../types'
import type { ViewMessage, ViewState } from '../views/ownview-model'
import { OwnView } from '../views/OwnView'
import { ToolGroup, type ToolCallItem } from './ToolGroup'
import { rearmToolSummaries, resetToolSummaries } from './tool-summaries'

// Counts how often each text is drawn, to prove a summary leaves the turns alone.
const drawn = vi.hoisted(() => new Map<string, number>())
vi.mock('./Rendered', async (orig) => {
  const m = await orig<typeof import('./Rendered')>()
  return { ...m, Rendered: (p: Parameters<typeof m.Rendered>[0]) => { drawn.set(p.text, (drawn.get(p.text) ?? 0) + 1); return m.Rendered(p) } }
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// An IntersectionObserver whose elements show when the test says so. Like the real one, it
// reports an element's state as soon as it is observed (again).
let observed: Element[] = []
let shownEls = new Set<Element>()
let fire: (els: Element[], on: boolean) => void = () => {}
class FakeIO {
  private cb: IntersectionObserverCallback
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb
    fire = (els, on) => { for (const el of els) if (on) shownEls.add(el); else shownEls.delete(el); this.report(els) }
  }
  private report(els: Element[]) { this.cb(els.map((target) => ({ target, isIntersecting: shownEls.has(target) }) as IntersectionObserverEntry), this as unknown as IntersectionObserver) }
  observe(el: Element) { observed.push(el); if (shownEls.has(el)) queueMicrotask(() => this.report([el])) }
  unobserve(el: Element) { observed = observed.filter((x) => x !== el) }
  disconnect() { observed = [] }
}

type Body = { agent: string; calls: { id: string; name: string }[]; wait: number }
let asked: Body[]
// What the daemon answers each tool-summaries request: a promise the test can hold.
let answer: (b: Body) => Promise<unknown>
const SUM = (id: string) => ({ tool: `tool ${id}`, doing: `doing ${id}` })
const all = (b: Body) => Promise.resolve({ enabled: true, pending: [], summaries: Object.fromEntries(b.calls.map((c) => [c.id, SUM(c.id)])) })

let root: Root
let host: HTMLElement
let push: (ev: unknown) => void = () => {}
function stubFetch(view?: ViewState) {
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/tool-summaries') {
      const b = JSON.parse(init!.body as string) as Body
      asked.push(b)
      return new Response(JSON.stringify(await answer(b)), { status: 200 })
    }
    if (view && path === `/api/agents/${view.agent}/view`) {
      const body = new ReadableStream<Uint8Array>({ start(c) { const enc = new TextEncoder(); push = (ev) => c.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`)); push({ type: 'state', state: view }) } })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response('{}', { status: 200 })
  }))
}
const tick = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const group = (g: string, n: number): ToolCallItem[] => Array.from({ length: n }, (_, i) => ({ id: `${g}-${i}`, name: 'Bash', input: { command: `step ${g}${i}` }, result: 'ok', status: 'done' }))

beforeEach(() => {
  vi.useFakeTimers()
  resetToolSummaries()
  observed = []
  shownEls = new Set()
  asked = []
  answer = all
  drawn.clear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  vi.stubGlobal('IntersectionObserver', FakeIO)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  stubFetch()
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers() })

const what = (sel: string) => host.querySelector(`${sel} > summary .ov-what`)!

describe('tool-call summaries', () => {
  it('asks only for groups on screen: the latest group first, each header call ahead of the rest', async () => {
    await act(async () => { root.render(<>{['g1', 'g2', 'g3'].map((g) => <ToolGroup key={g} tools={group(g, 3)} agent="ag" />)}</>) })
    const [g1, , g3] = observed
    await act(async () => { fire([g1, g3], true) })
    await tick(10)
    expect(asked.map((b) => b.calls.map((c) => c.id))).toEqual([['g3-2', 'g1-2'], ['g3-1', 'g3-0', 'g1-1', 'g1-0']])
    expect(asked[0].agent).toBe('ag')
    // g2 never showed: nothing of it was asked for, and it shows raw once the step is known on.
    expect(asked.flatMap((b) => b.calls.map((c) => c.id)).some((id) => id.startsWith('g2'))).toBe(false)
    expect(host.querySelectorAll('.ov-what-sum').length).toBe(2 + 6)
  })

  it('holds a call drawn invisible, shows it raw after the hold, then fades to a late summary', async () => {
    let release!: () => void
    answer = (b) => new Promise((r) => { release = () => r(all(b)) })
    await act(async () => { root.render(<ToolGroup tools={group('h', 1)} agent="ag" />) })
    await act(async () => { fire(observed, true) })
    await tick(10)
    expect(what('.ov-tools').classList.contains('held')).toBe(true)
    await tick(1000)
    expect(what('.ov-tools').classList.contains('held')).toBe(false)
    expect(what('.ov-tools').textContent).toContain('step h0')
    await act(async () => { release() })
    await tick(10)
    expect(what('.ov-tools').classList.contains('fade')).toBe(true)
    expect(what('.ov-tools').querySelector('.ov-what-sum')!.textContent).toBe('tool h-0doing h-0')
    expect(what('.ov-tools').querySelector('.ov-what-raw')!.getAttribute('aria-hidden')).toBe('true')
  })

  it('shows a summary that lands inside the hold at once, with no fade', async () => {
    await act(async () => { root.render(<ToolGroup tools={group('q', 2)} agent="ag" />) })
    await act(async () => { fire(observed, true) })
    await tick(10)
    expect(what('.ov-tools').className).toBe('ov-what')
    expect(what('.ov-tools').textContent).toBe('tool q-1doing q-1')
    // Open, the call's raw name and input come first.
    expect(host.querySelector('.ov-tools-rows .ov-tool-raw')!.textContent).toBe('Bashstep q0')
  })

  it('with the step off shows a stored summary and calls without one raw, nothing waits', async () => {
    answer = () => Promise.resolve({ enabled: false, pending: [], summaries: { 'o-0': SUM('o-0') } })
    await act(async () => { root.render(<ToolGroup tools={group('o', 1)} agent="ag" />) })
    await act(async () => { fire(observed, true) })
    await tick(10)
    expect(asked.length).toBe(1)
    expect(host.querySelector('.ov-what.held')).toBeNull()
    expect(what('.ov-tools').querySelector('.ov-what-sum')!.textContent).toBe('tool o-0doing o-0')
  })

  it('a stale summary shows until the new one lands, and is asked again until then', async () => {
    const old = { tool: 'old tool', doing: 'old doing' }
    const fresh = { tool: 'new tool', doing: 'new doing' }
    answer = (b) => Promise.resolve(asked.length === 1
      ? { enabled: true, summaries: { 'v-0': old }, pending: b.calls.map((c) => c.id) }
      : { enabled: true, summaries: { 'v-0': fresh }, pending: [] })
    await act(async () => { root.render(<ToolGroup tools={group('v', 1)} agent="ag" />) })
    await act(async () => { fire(observed, true) })
    await tick(10)
    expect(what('.ov-tools').querySelector('.ov-what-sum')!.textContent).toBe('old toolold doing')
    expect(asked.length).toBe(1)
    await tick(2000)
    expect(asked.length).toBe(2)
    expect(what('.ov-tools').querySelector('.ov-what-sum')!.textContent).toBe('new toolnew doing')
    await tick(2000)
    expect(asked.length).toBe(2)
  })

  it('learns the step is off from the daemon and shows everything raw', async () => {
    answer = () => Promise.resolve({ enabled: false, summaries: {}, pending: [] })
    await act(async () => { root.render(<ToolGroup tools={group('d', 2)} agent="ag" />) })
    await act(async () => { fire(observed, true) })
    await tick(10)
    // The latest call is asked; the off reply stops the rest of the group.
    expect(asked.length).toBe(1)
    expect(host.querySelector('.ov-what.held')).toBeNull()
    expect(what('.ov-tools').textContent).toBe('Bashstep d1')
  })

  it('after an off reply, calls that scroll into view are not asked, until the step is re-armed', async () => {
    answer = () => Promise.resolve({ enabled: false, summaries: {}, pending: [] })
    await act(async () => { root.render(<ToolGroup tools={group('f', 1)} agent="ag" />) })
    await act(async () => { fire(observed, true) })
    await tick(10)
    expect(asked.length).toBe(1)
    // More groups scroll into view with the step still off: no request is made.
    await act(async () => { root.render(<>{['f', 'g1', 'g2'].map((g) => <ToolGroup key={g} tools={group(g, 1)} agent="ag" />)}</>) })
    await act(async () => { fire(observed, true) })
    await tick(10)
    expect(asked.length).toBe(1)
    // A settings change re-arms the step: the calls on screen, f-0 among them (settled while off), are asked again.
    answer = all
    await act(async () => { rearmToolSummaries() })
    await tick(10)
    expect(asked.flatMap((b) => b.calls.map((c) => c.id))).toEqual(expect.arrayContaining(['f-0', 'g1-0', 'g2-0']))
    expect(what('.ov-tools').querySelector('.ov-what-sum')).not.toBeNull()
  })

  it('a streamed call never leaves the header empty: the previous line stays until the new one fades in', async () => {
    const one = group('s', 1)
    await act(async () => { root.render(<ToolGroup tools={one} agent="ag" />) })
    await act(async () => { fire(observed, true) })
    await tick(10)
    expect(what('.ov-tools').textContent).toBe('tool s-0doing s-0')
    // A second call streams in; its summary is held at the daemon.
    let release!: () => void
    answer = (b) => new Promise((r) => { release = () => r(all(b)) })
    const two = [...one, { id: 's-1', name: 'Bash', input: { command: 'step s1' }, result: 'ok', status: 'done' as const }]
    await act(async () => { root.render(<ToolGroup tools={two} agent="ag" />) })
    for (const ms of [0, 10, 500]) {
      await tick(ms)
      expect(host.querySelector('.ov-tools > summary .ov-what.held')).toBeNull()
      expect(what('.ov-tools').textContent).toBe('tool s-0doing s-0')
    }
    // The hold ends: the new call's raw line fades in, with nothing of the old call's raw line in it.
    await tick(600)
    expect(what('.ov-tools').classList.contains('enter')).toBe(true)
    expect(what('.ov-tools').textContent).toBe('Bashstep s1')
    await act(async () => { release() })
    await tick(10)
    expect(what('.ov-tools').querySelector('.ov-what-sum')!.textContent).toBe('tool s-1doing s-1')
  })

  it('a waiting retry does not delay a group that just showed', async () => {
    answer = (b) => Promise.resolve({ enabled: true, summaries: {}, pending: b.calls.map((c) => c.id) })
    await act(async () => { root.render(<>{['r1', 'r2'].map((g) => <ToolGroup key={g} tools={group(g, 1)} agent="ag" />)}</>) })
    await act(async () => { fire([observed[0]], true) })
    await tick(10)
    expect(asked.length).toBe(1)
    // A retry is now due in 2 s; the second group shows and is asked at once.
    answer = all
    await act(async () => { fire([observed[1]], true) })
    await tick(10)
    expect(asked.flatMap((b) => b.calls.map((c) => c.id))).toContain('r2-0')
  })

  it('a failed request is asked again, and after three failures the call shows raw', async () => {
    let fails = 0
    answer = () => { fails++; return Promise.reject(new Error('down')) }
    vi.stubGlobal('fetch', vi.fn(async (_path: string, init?: RequestInit) => {
      asked.push(JSON.parse(init!.body as string))
      try { return new Response(JSON.stringify(await answer(asked.at(-1)!)), { status: 200 }) } catch { return new Response('{"error":"down"}', { status: 502 }) }
    }))
    await act(async () => { root.render(<ToolGroup tools={group('e', 1)} agent="ag" />) })
    await act(async () => { fire(observed, true) })
    await tick(10)
    expect(fails).toBe(1)
    await tick(2000)
    expect(fails).toBe(2)
    await tick(2000)
    expect(fails).toBe(3)
    await tick(5000)
    expect(fails).toBe(3)
    expect(what('.ov-tools').textContent).toBe('Bashstep e0')
  })

  it('a call whose input may still be streaming (pending) is not asked for until it runs', async () => {
    const t = (status: 'pending' | 'running'): ToolCallItem[] => [{ id: 'p-0', name: 'Bash', input: { command: 'part' }, status }]
    await act(async () => { root.render(<ToolGroup tools={t('pending')} agent="ag" />) })
    await act(async () => { fire(observed, true) })
    await tick(10)
    expect(asked).toEqual([])
    await act(async () => { root.render(<ToolGroup tools={t('running')} agent="ag" />) })
    await tick(10)
    expect(asked.map((b) => b.calls.map((c) => c.id))).toEqual([['p-0']])
  })

  it('without an agent (another view) draws raw, unwatched', async () => {
    await act(async () => { root.render(<ToolGroup tools={group('n', 2)} />) })
    expect(observed).toEqual([])
    expect(what('.ov-tools').textContent).toBe('Bashstep n1')
  })
})

describe('in the own view', () => {
  const AGENT: Agent = { id: 'oc', name: 'fixture-oc', harness: 'opencode', machine: 'alpha', lifecycle: 'active', activity: 'idle' } as Agent
  const msg = (id: string, at: number, over: Partial<ViewMessage> = {}): ViewMessage => ({ id, role: 'assistant', at, parts: [{ type: 'text', text: id }], ...over })
  const state: ViewState = {
    agent: 'oc', harness: 'opencode', capabilities: { can_stream: true, can_send: true, can_interrupt: true, can_approve: true }, running: false, permissions: [], older: null,
    messages: [
      msg('u1', 1, { role: 'user', parts: [{ type: 'text', text: 'first question' }] }),
      msg('a1', 2, { parts: [{ type: 'text', text: 'first answer' }, { type: 'tool', id: 'c1', name: 'Read', input: { file_path: '/a.ts' }, output: 'x', status: 'done' }] }),
      msg('u2', 3, { role: 'user', parts: [{ type: 'text', text: 'second question' }] }),
      msg('a2', 4, { parts: [{ type: 'text', text: 'second answer' }, { type: 'tool', id: 'c2', name: 'Bash', input: { command: 'ls' }, output: 'y', status: 'done' }] }),
    ],
  }

  it("a summary landing redraws only its own call, not another turn nor its own turn's text", async () => {
    setData({ agents: [AGENT], machine: 'alpha' })
    // The first turn's call answers at once; the second's is held until the test lets it land.
    let release!: () => void
    answer = (b) => b.calls.some((c) => c.id === 'c2') ? new Promise((r) => { release = () => r(all(b)) }) : all(b)
    stubFetch(state)
    await act(async () => { root.render(<OwnView id="oc" />) })
    await tick(20)
    expect(host.textContent).toContain('second answer')
    await act(async () => { fire(observed, true) })
    await tick(10)
    await tick(1000)
    const before = new Map(drawn)
    expect(before.get('first answer')).toBeGreaterThan(0)
    await act(async () => { release() })
    await tick(10)
    expect(host.querySelector('[data-id="a2"] .ov-what-sum')!.textContent).toBe('tool c2doing c2')
    for (const t of ['first question', 'first answer', 'second question', 'second answer']) expect(drawn.get(t), t).toBe(before.get(t))
  })
})
