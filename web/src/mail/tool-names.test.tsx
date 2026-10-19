// @vitest-environment jsdom
// Tool names in the conversation (S-1933, ./tool-names.ts): a tool shows as its label with the MCP
// server in front. Seeded built-ins show at once and are never asked for; any other tool on screen is
// asked for once, shown prettified until its label lands; a tool in flight, or one the daemon is still
// naming, isn't asked again by a flush that follows at once, only by the retry timer; with the step
// off, or the daemon unable to name, nothing more is asked and the prettified name stays.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setData } from '../store'
import type { Agent } from '../types'
import { ToolGroup, type ToolCallItem } from './ToolGroup'
import { resetToolNames, rearmToolNames } from './tool-names'
import { resetToolSummaries, seedEnabled } from './tool-summaries'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let observed: Element[] = []
let shownEls = new Set<Element>()
let fire: (els: Element[], on: boolean) => void = () => {}
class FakeIO {
  private cb: IntersectionObserverCallback
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb
    fire = (els, on) => { for (const el of els) if (on) shownEls.add(el); else shownEls.delete(el); this.cb(els.map((target) => ({ target, isIntersecting: shownEls.has(target) }) as IntersectionObserverEntry), this as unknown as IntersectionObserver) }
  }
  observe(el: Element) { observed.push(el) }
  unobserve(el: Element) { observed = observed.filter((x) => x !== el) }
  disconnect() { observed = [] }
}

type Body = { agent: string; names: string[]; wait: number }
let asked: Body[]
let answer: (b: Body) => Promise<unknown>
const labelled = (b: Body) => Promise.resolve({ enabled: true, pending: [], labels: Object.fromEntries(b.names.map((n) => [n, `Label of ${n.split('__').at(-1)}`])) })

let root: Root
let host: HTMLElement
const tick = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const call = (id: string, name: string): ToolCallItem => ({ id, name, input: { x: id }, result: 'ok', status: 'done' })
const title = () => [...host.querySelectorAll('.ov-tools > summary .ov-what-raw b')].map((b) => b.textContent)
const show = async (tools: ToolCallItem[], agent = 'ag') => {
  await act(async () => { root.render(<ToolGroup tools={tools} agent={agent} />) })
  await act(async () => { fire(observed, true) })
  await tick(10)
}

beforeEach(() => {
  vi.useFakeTimers()
  resetToolNames()
  resetToolSummaries()
  // The per-call summary step is off, as by default: the daemon says so and nothing waits.
  seedEnabled(false)
  observed = []
  shownEls = new Set()
  asked = []
  answer = labelled
  setData({ agents: [{ id: 'ag', harness: 'claude' } as Agent] })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  vi.stubGlobal('IntersectionObserver', FakeIO)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/tool-names') {
      const b = JSON.parse(init!.body as string) as Body
      asked.push(b)
      return new Response(JSON.stringify(await answer(b)), { status: 200 })
    }
    return new Response(JSON.stringify({ enabled: false, summaries: {}, pending: [] }), { status: 200 })
  }))
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('tool names', () => {
  it('shows a seeded built-in at once and never asks for it', async () => {
    await show([call('a', 'WebSearch')])
    expect(title()).toEqual(['Web search'])
    expect(asked).toEqual([])
  })

  it('shows another tool prettified with its server, then its label when it lands', async () => {
    let release!: () => void
    answer = (b) => new Promise((r) => { release = () => r(labelled(b)) })
    await show([call('a', 'mcp__stam__send_mail')])
    expect(title()).toEqual(['stam · Send mail'])
    expect(asked.map((b) => b.names)).toEqual([['mcp__stam__send_mail']])
    await act(async () => { release() })
    await tick(10)
    expect(title()).toEqual(['stam · Label of send_mail'])
    // Open rows read it too; the raw name is the hover title.
    expect(host.querySelector('.ov-tools-rows b')!.getAttribute('title')).toBe('mcp__stam__send_mail')
  })

  it('asks only for tools on screen, once, however often they show', async () => {
    await show([call('a', 'mcp__stam__send_mail')])
    await act(async () => { fire(observed, false) })
    await act(async () => { fire(observed, true) })
    await tick(10)
    expect(asked.length).toBe(1)
    await act(async () => { root.render(<ToolGroup tools={[call('a', 'mcp__stam__send_mail'), call('b', 'mcp__stam__send_mail')]} agent="ag" />) })
    await act(async () => { fire(observed, true) })
    await tick(10)
    expect(asked.length).toBe(1)
  })

  it('does not ask while the first request is in flight; a new tool goes alone', async () => {
    let release!: () => void
    answer = (b) => new Promise((r) => { release = () => r(labelled(b)) })
    await show([call('a', 'mcp__a__one')])
    await act(async () => { root.render(<ToolGroup tools={[call('a', 'mcp__a__one'), call('b', 'mcp__a__two')]} agent="ag" />) })
    await act(async () => { fire(observed, true) })
    await tick(10)
    expect(asked.map((b) => b.names)).toEqual([['mcp__a__one'], ['mcp__a__two']])
    await act(async () => { release() })
  })

  it('a tool the daemon is still naming is asked again only on the retry timer', async () => {
    let n = 0
    answer = (b) => Promise.resolve(n++ === 0 ? { enabled: true, labels: {}, pending: b.names } : labelled(b))
    await show([call('a', 'mcp__a__one')])
    expect(asked.length).toBe(1)
    // An immediate re-flush sends nothing: the tool is pending.
    await act(async () => { fire(observed, false) })
    await act(async () => { fire(observed, true) })
    await tick(1000)
    expect(asked.length).toBe(1)
    await tick(1500)
    expect(asked.length).toBe(2)
    expect(title()).toEqual(['a · Label of one'])
  })

  it('with the step off nothing more is asked, and the prettified name stays', async () => {
    answer = () => Promise.resolve({ enabled: false, labels: {}, pending: [] })
    await show([call('a', 'mcp__a__one')])
    expect(asked.length).toBe(1)
    await act(async () => { root.render(<ToolGroup tools={[call('a', 'mcp__a__one'), call('b', 'mcp__a__two_words')]} agent="ag" />) })
    await act(async () => { fire(observed, true) })
    await tick(10000)
    expect(asked.length).toBe(1)
    expect(title()).toEqual(['a · Two words'])
    // Turned back on (a settings save), the tools are asked for again.
    answer = labelled
    await act(async () => { rearmToolNames() })
    await tick(10)
    expect(asked.length).toBe(2)
    expect(title()).toEqual(['a · Label of two_words'])
  })

  it('a tool the daemon could not name stays prettified and is not asked again', async () => {
    answer = () => Promise.resolve({ enabled: true, labels: {}, pending: [] })
    await show([call('a', 'mcp__a__one_tool')])
    await act(async () => { fire(observed, false) })
    await act(async () => { fire(observed, true) })
    await tick(10000)
    expect(asked.length).toBe(1)
    expect(title()).toEqual(['a · One tool'])
  })

  it('asks no more than a batch at a time, in one request per agent', async () => {
    const tools = Array.from({ length: 45 }, (_, i) => call(`t${i}`, `mcp__a__tool${i}`))
    await show(tools)
    expect(asked.map((b) => b.names.length)).toEqual([40, 5])
  })

  it('each response holds its own tools for the full retry delay, not the first timer', async () => {
    const seen = new Map<string, number>()
    // Every tool is still being named on its first ask, named on its second.
    answer = (b) => {
      const named = b.names.filter((n) => seen.get(n))
      const still = b.names.filter((n) => !seen.get(n))
      for (const n of b.names) seen.set(n, (seen.get(n) ?? 0) + 1)
      return Promise.resolve({ enabled: true, labels: Object.fromEntries(named.map((n) => [n, `Label of ${n}`])), pending: still })
    }
    await show([call('a', 'mcp__a__one')])
    expect(asked.map((b) => b.names)).toEqual([['mcp__a__one']])
    await tick(1900)
    // A second tool comes into view 1.9 s after the first; the first is still held.
    await act(async () => { root.render(<ToolGroup tools={[call('a', 'mcp__a__one'), call('b', 'mcp__a__two')]} agent="ag" />) })
    await act(async () => { fire(observed, false) })
    await act(async () => { fire(observed, true) })
    await tick(10)
    expect(asked.map((b) => b.names)).toEqual([['mcp__a__one'], ['mcp__a__two']])
    // The first tool's timer ends at 2 s: it goes again, the second (0.2 s into its own delay) doesn't.
    await tick(200)
    expect(asked.map((b) => b.names)).toEqual([['mcp__a__one'], ['mcp__a__two'], ['mcp__a__one']])
    // The second goes only after its own full delay.
    await tick(1500)
    expect(asked.length).toBe(3)
    await tick(400)
    expect(asked.map((b) => b.names)).toEqual([['mcp__a__one'], ['mcp__a__two'], ['mcp__a__one'], ['mcp__a__two']])
  })

  it('reserves every name before the first batch is sent: none is asked twice', async () => {
    const tools = Array.from({ length: 45 }, (_, i) => call(`t${i}`, `mcp__a__tool${i}`))
    let release!: () => void
    let first = true
    answer = (b) => {
      if (!first) return labelled(b)
      first = false
      return new Promise((r) => { release = () => r(labelled(b)) })
    }
    await show(tools)
    expect(asked.map((b) => b.names.length)).toEqual([40])
    // A visibility event while the first batch is held must not send the last five.
    await act(async () => { fire(observed, false) })
    await act(async () => { fire(observed, true) })
    await tick(10)
    expect(asked.length).toBe(1)
    await act(async () => { release() })
    await tick(10)
    const names = asked.flatMap((b) => b.names)
    expect(asked.map((b) => b.names.length)).toEqual([40, 5])
    expect(new Set(names).size).toBe(45)
    expect(names.length).toBe(45)
  })
})
