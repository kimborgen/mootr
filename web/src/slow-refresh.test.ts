// The mailbox refresh (S-4519): triggers close together share one round, and mailTick, which every open
// mail view reloads on, moves only when something it shows may have changed. No network: fetch is stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const stream = vi.hoisted(() => ({ connected: true, listeners: [] as ((c: boolean) => void)[] }))
vi.mock('./live', async (orig) => ({
  ...(await orig<typeof import('./live')>()),
  liveConnected: () => stream.connected,
  onLiveConnection: (cb: (c: boolean) => void) => { stream.listeners.push(cb); return () => {} },
}))

import { applyLiveEvent, getData, refreshItsas, refreshSlow, refreshSlowNow, SLOW_COALESCE } from './store'
import { resetIndexRoute } from './mail/thread-index'

let rounds = 0
let threads: unknown[] = []
let itsas: unknown[] = []
// The index route's answer: 'ok', 'fail' (a 500), or 'missing' (a daemon without it: 404). `old` is what the old
// /threads route answers then, whole threads.
let route: 'ok' | 'fail' | 'missing' = 'ok'
let old: unknown[] = []
const asked: string[] = []
// While set, the decisions read waits for `release`: a round in flight.
let hold: Promise<void> | null = null
let release = () => {}
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response
beforeEach(() => {
  vi.useFakeTimers()
  rounds = 0
  threads = []
  itsas = []
  hold = null
  route = 'ok'
  old = []
  asked.length = 0
  stream.connected = true
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = input.split('?')[0]
    if (path.startsWith('/api/agents/human/thread')) asked.push(input)
    if (path === '/api/agents/human/thread-index' && route !== 'ok') return { ok: false, status: route === 'fail' ? 500 : 404, json: async () => ({ error: 'no' }), text: async () => 'no' } as unknown as Response
    if (input === '/api/agents/human/threads?limit=60') return ok(old)
    if (path === '/api/rings') rounds++
    if (path === '/api/mail/decisions' && hold) await hold
    if (input === '/api/agents/human/thread-index?list=active&limit=60') return ok({ threads, next_cursor: null })
    if (path === '/api/agents/human/thread-index') return ok({ threads: [], next_cursor: null })
    if (path === '/api/itsas') return ok(itsas)
    if (path === '/api/itsas/statuses') return ok({ statuses: [] })
    return ok([])
  }))
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); resetIndexRoute() })

describe('a burst of mailbox refreshes', () => {
  it('shares one round, SLOW_COALESCE ms after the first', async () => {
    // Answering a mail: archive, the thread's reload, and mark read, each asking for a refresh.
    const a = refreshSlow()
    await vi.advanceTimersByTimeAsync(100)
    const b = refreshSlow()
    const c = refreshSlow()
    expect(b).toBe(a)
    expect(c).toBe(a)
    expect(rounds).toBe(0)
    await vi.advanceTimersByTimeAsync(SLOW_COALESCE - 100)
    await a
    expect(rounds).toBe(1)
  })

  it('starts a new round for a refresh asked after one began', async () => {
    const a = refreshSlow()
    await vi.advanceTimersByTimeAsync(SLOW_COALESCE)
    await a
    const b = refreshSlow()
    expect(b).not.toBe(a)
    await vi.advanceTimersByTimeAsync(SLOW_COALESCE)
    await b
    expect(rounds).toBe(2)
  })

  it('runs a new round for a write made while one is in flight', async () => {
    hold = new Promise<void>((r) => { release = () => { hold = null; r() } })
    const a = refreshSlow()
    await vi.advanceTimersByTimeAsync(SLOW_COALESCE)
    expect(rounds).toBe(1)
    // The round's reads went out before this write landed: it gets its own round, after, which shows it.
    threads = [{ thread_id: 'w1', unread: 0 }]
    const b = refreshSlow()
    expect(b).not.toBe(a)
    release()
    await a
    expect(getData().humanRows.active).toEqual([])
    await vi.advanceTimersByTimeAsync(SLOW_COALESCE)
    await b
    expect(rounds).toBe(2)
    expect(getData().humanRows.active).toEqual([{ thread_id: 'w1', unread: 0 }])
  })

  it('leaves refreshSlowNow at once', async () => {
    await refreshSlowNow()
    expect(rounds).toBe(1)
  })
})

describe('mailTick', () => {
  const tick = () => getData().mailTick

  it('stays when a round finds nothing new while the stream is connected', async () => {
    await refreshSlowNow()
    const t = tick()
    await refreshSlowNow()
    await refreshSlowNow()
    expect(tick()).toBe(t)
  })

  it('moves when the human\'s threads changed', async () => {
    await refreshSlowNow()
    const t = tick()
    threads = [{ thread_id: 't1', unread: 0 }]
    await refreshSlowNow()
    expect(tick()).toBe(t + 1)
  })

  it('moves after a mail was sent or read anywhere, once', async () => {
    await refreshSlowNow()
    const t = tick()
    // Two agents mailing each other: the human's lists don't change, but an open thread of theirs does.
    applyLiveEvent('mail.sent', { id: 'm1', from: 'a', to: ['b'], thread: 'x' })
    await refreshSlowNow()
    expect(tick()).toBe(t + 1)
    applyLiveEvent('mail.read', { id: 'm1', by: 'b' })
    await refreshSlowNow()
    expect(tick()).toBe(t + 2)
    await refreshSlowNow()
    expect(tick()).toBe(t + 2)
  })

  it('moves after an ITSA changed: retro items are ITSAs, and their panels reload on it', async () => {
    await refreshSlowNow()
    const t = tick()
    applyLiveEvent('itsa.changed', { id: 'r1', status: 'todo' })
    await refreshSlowNow()
    expect(tick()).toBe(t + 1)
    // A change only the ITSA poll saw.
    itsas = [{ id: 'r2', key: 'S-2', title: 'x', status: 'todo' }]
    await refreshItsas()
    await refreshSlowNow()
    expect(tick()).toBe(t + 2)
    await refreshSlowNow()
    expect(tick()).toBe(t + 2)
  })

  it('moves after an agent was archived: its final retro round', async () => {
    await refreshSlowNow()
    const t = tick()
    applyLiveEvent('agent.archived', { id: 'a1' })
    await refreshSlowNow()
    expect(tick()).toBe(t + 1)
  })

  it('moves once after the stream broke and came back between rounds: it replays nothing', async () => {
    await refreshSlowNow()
    const t = tick()
    // A mail between two agents went out while the stream was down; no round ran in the gap.
    for (const cb of stream.listeners) cb(false)
    for (const cb of stream.listeners) cb(true)
    await refreshSlowNow()
    expect(tick()).toBe(t + 1)
    await refreshSlowNow()
    expect(tick()).toBe(t + 1)
  })

  it('moves every round while the stream is down', async () => {
    await refreshSlowNow()
    const t = tick()
    stream.connected = false
    await refreshSlowNow()
    await refreshSlowNow()
    expect(tick()).toBe(t + 2)
  })
})

describe('the human\'s lists (S-4617)', () => {
  const row = (tid: string, unread: number) => ({ thread_id: tid, unread })

  it('reads the first 60 index rows of each list, and counts the inbox\'s unread mail from them', async () => {
    threads = [row('a', 2), row('b', 0), row('c', 1)]
    await refreshSlowNow()
    expect(asked).toEqual(['/api/agents/human/thread-index?list=active&limit=60', '/api/agents/human/thread-index?list=archived&limit=60', '/api/agents/human/thread-index?list=deferred&limit=60'])
    expect(getData().humanRows.active.map((r) => r.thread_id)).toEqual(['a', 'b', 'c'])
    expect(getData().unread).toBe(3)
  })

  it('keeps the rows a failed poll would have replaced', async () => {
    threads = [row('k', 1)]
    await refreshSlowNow()
    route = 'fail'
    threads = []
    await refreshSlowNow()
    expect(getData().humanRows.active.map((r) => r.thread_id)).toEqual(['k'])
    expect(getData().unread).toBe(1)
  })

  it('builds the rows from the old route\'s threads on a daemon without the index', async () => {
    route = 'missing'
    const mail = { id: 'm1', thread_id: 'o1', from_id: 'cos', subject: 'Old daemon', body: 'hi', created_at: '2026-10-29T10:00:00Z', recipients: [{ id: 'human', read_at: null }] }
    old = [{ thread_id: 'o1', mails: [mail] }]
    await refreshSlowNow()
    expect(asked).toContain('/api/agents/human/threads?limit=60')
    expect(getData().humanRows.active.map((r) => [r.thread_id, r.subject, r.unread])).toEqual([['o1', 'Old daemon', 1]])
  })
})
