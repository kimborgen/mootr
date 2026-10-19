// The web store's live stream (S-457): the SSE parser, the events applied to the store, the
// reconnect backoff, and the fallback polls slowing while the stream is connected. The
// daemon's stream is S-456; its shapes are fixed in src/events.ts. No network: fetch is
// stubbed and time is fake.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLive, parseLiveEvents } from './live'
import { applyLiveEvent, getData, onMailEvent, onUsageChanged, refreshAgents, refreshItsas, setData, startPolls, type MailEvent } from './store'
import type { Agent, Itsa, ItsaStatus } from './types'

// A Response whose body is these chunks, then closes.
function bodyOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close() } })
}
// A Response whose body stays open until the test errors it.
function held(): { body: ReadableStream<Uint8Array>; fail: (e: Error) => void } {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(c) { ctrl = c } })
  return { body, fail: (e) => ctrl.error(e) }
}
const jsonRes = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response
// A fetch that answers the daemon's poll routes with empty lists.
function stubPolls(count: (path: string) => void) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const path = url.split('?')[0]
    count(path)
    return jsonRes(path.endsWith('/statuses') ? { statuses: [] } : [])
  })
}
const agent = (patch: Partial<Agent>): Agent => ({ id: 'a1', name: 'alice', harness: 'claude', lifecycle: 'idle', machine: 'm', cwd: '/', created_at: '', updated_at: '', ...patch })
const itsa = (patch: Partial<Itsa>): Itsa => ({ id: 'i1', key: 'S-1', parent_id: null, kind: 'issue', title: 't', summary: null, body: null, status: 'todo', owner: null, thread_id: null, created_by: 'h', created_at: '', updated_at: '', closed_at: null, ...patch })

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('the stream parser', () => {
  it('reads events across split chunks, comments, and multi-line data', () => {
    const first = ': connected\n\nevent: agent.changed\ndata: {"id":"a1",\n'
    const a = parseLiveEvents(first)
    expect(a.events).toEqual([])
    expect(a.rest).toBe('event: agent.changed\ndata: {"id":"a1",\n')

    // The rest of the data, then a comment and another event; the comment is dropped.
    const second = a.rest + 'data: "state":"working"}\n\n: ping\n\nevent: usage.changed\ndata: {}\n\n'
    const b = parseLiveEvents(second)
    expect(b.events).toEqual([
      { type: 'agent.changed', data: { id: 'a1', state: 'working' } },
      { type: 'usage.changed', data: {} },
    ])
    expect(b.rest).toBe('')
  })

  it('drops a comment-only block and a block with broken JSON', () => {
    expect(parseLiveEvents(': ping\n\n').events).toEqual([])
    expect(parseLiveEvents('event: x\ndata: not json\n\n').events).toEqual([])
  })

  it('keeps what a short chunk can\'t complete', () => {
    const { events, rest } = parseLiveEvents('event: mail.read\ndata: {"id":"m1"}')
    expect(events).toEqual([])
    expect(rest).toBe('event: mail.read\ndata: {"id":"m1"}')
  })

  it('normalises CRLF and lone-CR line endings', () => {
    expect(parseLiveEvents('event: mail.read\r\ndata: {"id":"m1"}\r\n\r\n').events).toEqual([{ type: 'mail.read', data: { id: 'm1' } }])
    expect(parseLiveEvents('event: usage.changed\rdata: {}\r\r').events).toEqual([{ type: 'usage.changed', data: {} }])
  })
})

describe('live events applied to the store', () => {
  it('merges agent.changed into the agent, leaving fields it doesn\'t carry', () => {
    setData({ agents: [agent({ name: 'alice', activity: null, cost_usd: 0, unread: 0 })] })
    applyLiveEvent('agent.changed', { id: 'a1', state: 'working', activity: 'thinking', context_tokens: 1200, cost_usd: 1.5, unread: 3 })
    const a = getData().agents[0]
    expect(a.lifecycle).toBe('working')
    expect(a.activity).toBe('thinking')
    expect(a.context_tokens).toBe(1200)
    expect(a.cost_usd).toBe(1.5)
    expect(a.unread).toBe(3)
    expect(a.name).toBe('alice')
  })

  it('only sets data when agent.changed changes something', () => {
    setData({ agents: [agent({ lifecycle: 'working', activity: 'thinking', cost_usd: 1.5, context_tokens: 1200, unread: 3 })] })
    const before = getData()
    applyLiveEvent('agent.changed', { id: 'a1', state: 'working', activity: 'thinking', context_tokens: 1200, cost_usd: 1.5, unread: 3 })
    expect(getData()).toBe(before)
    // An agent the store doesn't know changes nothing either.
    applyLiveEvent('agent.changed', { id: 'ghost', state: 'working' })
    expect(getData()).toBe(before)
  })

  it('refreshes the agents when one spawns or archives', async () => {
    const paths: string[] = []
    vi.stubGlobal('fetch', stubPolls((p) => paths.push(p)))
    applyLiveEvent('agent.spawned', { id: 'a2', name: 'bob', parent_id: 'a1' })
    await Promise.resolve()
    await Promise.resolve()
    expect(paths).toContain('/api/agents')
    // A spawn's ITSA reaches its card without waiting for the ITSA poll (S-462).
    expect(paths).toContain('/api/itsas')
    paths.length = 0
    applyLiveEvent('agent.archived', { id: 'a2' })
    await Promise.resolve()
    await Promise.resolve()
    expect(paths).toContain('/api/agents')
    expect(paths).not.toContain('/api/itsas')
  })

  it('merges itsa.changed, and refreshes an unknown ITSA', async () => {
    setData({ itsas: [itsa({ status: 'todo', owner: null, fields: {} })] })
    applyLiveEvent('itsa.changed', { id: 'i1', key: 'S-1', status: 'in_progress', owner: 'a1', fields: { prio: 'high' } })
    const s = getData().itsas[0]
    expect(s.status).toBe('in_progress')
    expect(s.owner).toBe('a1')
    expect(s.fields).toEqual({ prio: 'high' })

    const paths: string[] = []
    vi.stubGlobal('fetch', stubPolls((p) => paths.push(p)))
    applyLiveEvent('itsa.changed', { id: 'ghost', status: 'todo' })
    await Promise.resolve()
    await Promise.resolve()
    expect(paths).toContain('/api/itsas')
  })

  it('notifies mail and usage subscribers, and stops when unsubscribed', () => {
    const mails: MailEvent[] = []
    const uses = vi.fn()
    const off = onMailEvent((e) => mails.push(e))
    const offUse = onUsageChanged(uses)
    applyLiveEvent('mail.sent', { id: 'm1', from: 'a1', to: ['a2'], thread: 't1', itsa: null, ask: false, subject: 'hi', at: 'T' })
    applyLiveEvent('mail.read', { id: 'm1', by: 'a2', at: 'T2' })
    applyLiveEvent('usage.changed', {})
    expect(mails).toEqual([
      { type: 'sent', id: 'm1', from: 'a1', to: ['a2'], thread: 't1', itsa: null, ask: false, subject: 'hi', at: 'T' },
      { type: 'read', id: 'm1', by: 'a2', at: 'T2' },
    ])
    expect(uses).toHaveBeenCalledTimes(1)
    off(); offUse()
    applyLiveEvent('mail.sent', { id: 'm2', from: 'a1', to: [], at: 'T3' })
    expect(mails).toHaveLength(2)
  })

  it('keeps an agent change that lands while a poll is in flight', async () => {
    setData({ agents: [agent({ lifecycle: 'idle', activity: null })] })
    let release!: (agents: Agent[]) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((res) => { release = (agents) => res(jsonRes(agents)) })) as unknown as typeof fetch)
    const polling = refreshAgents()
    // The event lands after the poll started; the poll then returns the older snapshot.
    applyLiveEvent('agent.changed', { id: 'a1', state: 'working', activity: 'thinking' })
    expect(getData().agents[0].lifecycle).toBe('working')
    release([agent({ lifecycle: 'idle', activity: null })])
    await polling
    expect(getData().agents[0].lifecycle).toBe('working')
    expect(getData().agents[0].activity).toBe('thinking')
  })

  it('keeps an ITSA change that lands while a poll is in flight', async () => {
    setData({ itsas: [itsa({ status: 'todo', owner: null })] })
    let release!: (itsas: Itsa[]) => void
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.split('?')[0] === '/api/itsas') return new Promise<Response>((res) => { release = (itsas) => res(jsonRes(itsas)) })
      return Promise.resolve(jsonRes([]))
    }) as unknown as typeof fetch)
    const polling = refreshItsas()
    applyLiveEvent('itsa.changed', { id: 'i1', status: 'in_progress', owner: 'a1' })
    expect(getData().itsas[0].status).toBe('in_progress')
    release([itsa({ status: 'todo', owner: null })])
    await polling
    expect(getData().itsas[0].status).toBe('in_progress')
    expect(getData().itsas[0].owner).toBe('a1')
  })

  it('fetches the ITSAs once more after a burst of spawns, never out of order (S-462)', async () => {
    // Statuses already known, so a refresh fetches the list, attention and queue only.
    setData({ itsas: [], itsaStatuses: [{ name: 'todo', category: 'ready', human: false }] as ItsaStatus[] })
    const held: ((itsas: Itsa[]) => void)[] = []
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.split('?')[0] === '/api/itsas') return new Promise<Response>((res) => { held.push((itsas) => res(jsonRes(itsas))) })
      return Promise.resolve(jsonRes([]))
    }) as unknown as typeof fetch)
    const first = refreshItsas()
    const rest = [refreshItsas(), refreshItsas(), refreshItsas()]
    // Three more asked while one runs: they share the one after it.
    expect(held.length).toBe(1)
    expect(new Set(rest).size).toBe(1)
    held[0]([itsa({ status: 'todo' })])
    await first
    await vi.waitFor(() => expect(held.length).toBe(2))
    held[1]([itsa({ status: 'in_progress' })])
    await rest[0]
    expect(held.length).toBe(2)
    expect(getData().itsas[0].status).toBe('in_progress')
  })
})

describe('the reconnect backoff', () => {
  beforeEach(() => { vi.useFakeTimers() })

  it('waits 1 s, doubling to 30 s, for each failed attempt', async () => {
    vi.setSystemTime(0)
    const calls: number[] = []
    const live = createLive({ fetch: vi.fn(async () => { calls.push(Date.now()); throw new Error('down') }) as unknown as typeof fetch })
    live.start()
    // 0, 1 s, 3 s, 7 s, 15 s, 31 s, 61 s … (each wait doubles, capped at 30 s).
    const schedule = [0, 1000, 3000, 7000, 15_000, 31_000, 61_000]
    for (const at of schedule) {
      await vi.advanceTimersByTimeAsync(at - (calls.at(-1) ?? 0))
      expect(calls.at(-1)).toBe(at)
    }
    expect(calls).toEqual(schedule)
    live.stop()
  })

  it('resets the wait to 1 s after a connection opens', async () => {
    const calls: number[] = []
    const live = createLive({
      fetch: vi.fn(async () => {
        calls.push(Date.now())
        return { ok: true, status: 200, body: bodyOf('event: usage.changed\ndata: {}\n\n') } as unknown as Response
      }) as unknown as typeof fetch,
    })
    const types: string[] = []
    live.onEvent((e) => types.push(e.type))
    live.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(types).toEqual(['usage.changed'])
    // The body closed: the next attempt is one wait away, not the doubled one.
    expect(calls.length).toBe(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(calls.length).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls.length).toBe(2)
    live.stop()
  })

  it('stop aborts the open request and clears the backoff timer', async () => {
    let aborted = false
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => { aborted = true })
      throw new Error('down')
    })
    const live = createLive({ fetch: fetchMock as unknown as typeof fetch })
    live.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // The loop is now waiting on the 1 s backoff timer.
    live.stop()
    expect(aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('the fallback polls', () => {
  beforeEach(() => { vi.useFakeTimers() })

  it('run agents and permissions every 2 s, and ITSAs every 4 s, while broken', async () => {
    let agents = 0
    let perms = 0
    let itsas = 0
    vi.stubGlobal('fetch', stubPolls((p) => { if (p === '/api/agents') agents++; else if (p === '/api/permissions') perms++; else if (p === '/api/itsas') itsas++ }))
    startPolls(false)
    await vi.advanceTimersByTimeAsync(2000)
    expect(agents).toBe(1)
    expect(perms).toBe(1)
    expect(itsas).toBe(0)
    await vi.advanceTimersByTimeAsync(2000)
    expect(agents).toBe(2)
    expect(perms).toBe(2)
    expect(itsas).toBe(1)
    startPolls(false)
  })

  it('slows ITSAs while connected, but keeps agents and permissions at 2 s', async () => {
    let agents = 0
    let perms = 0
    let itsas = 0
    let live = 'held'
    const heldBody = held()
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const path = url.split('?')[0]
      if (path === '/api/live') {
        if (live === 'fail') throw new Error('down')
        return { ok: true, status: 200, body: heldBody.body } as unknown as Response
      }
      if (path === '/api/agents') agents++
      else if (path === '/api/permissions') perms++
      else if (path === '/api/itsas') itsas++
      return jsonRes(path.endsWith('/statuses') ? { statuses: [] } : [])
    }) as unknown as typeof fetch)

    const stream = createLive()
    // main.tsx's wiring: the polls follow the stream's connection.
    stream.onConnection(startPolls)
    startPolls(false)
    stream.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(stream.connected()).toBe(true)
    // Connected: agents and permissions still poll at 2 s; the ITSA poll slows to 15 s.
    await vi.advanceTimersByTimeAsync(4000)
    expect(agents).toBe(2)
    expect(perms).toBe(2)
    expect(itsas).toBe(0)
    // The ITSA poll lands at 15 s.
    await vi.advanceTimersByTimeAsync(11_000)
    expect(itsas).toBe(1)
    // Break it; the stream can't reconnect (fetch fails), so the ITSA poll stays fast.
    live = 'fail'
    heldBody.fail(new Error('break'))
    await vi.advanceTimersByTimeAsync(0)
    expect(stream.connected()).toBe(false)
    agents = 0; perms = 0; itsas = 0
    await vi.advanceTimersByTimeAsync(2000)
    expect(agents).toBe(1)
    expect(perms).toBe(1)
    expect(itsas).toBe(0)
    await vi.advanceTimersByTimeAsync(2000)
    expect(itsas).toBe(1)
    stream.stop()
    startPolls(false)
  })
})
