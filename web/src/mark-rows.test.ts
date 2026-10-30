// @vitest-environment jsdom
// A read or unread mark over the human's index rows (S-4617): a row counts its unread mail but not which, so the mark
// moves the count by the mail it changes and holds until a poll begun after the write lands; that poll's count then
// shows, a mail that came since included. No network: fetch is stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The stream is up, so a round that finds nothing new changes no data.
vi.mock('./live', async (orig) => ({
  ...(await orig<typeof import('./live')>()),
  liveConnected: () => true,
  onLiveConnection: () => () => {},
}))

import { getData, refreshSlowNow, setData, SLOW_COALESCE } from './store'
import { markMailRead, markThreadUnread, toggleInboxUnread, undoInboxTriage } from './actions'

// The inbox's rows the daemon answers with; `hold` keeps a poll's answer back, and it then answers with the rows as
// they are when it is let go.
let rows: { thread_id: string; unread: number; last_at: string }[] = []
let hold: Promise<void> | null = null
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  hold = null
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (input.startsWith('/api/agents/human/thread-index?list=active')) {
      if (hold) await hold
      return ok({ threads: rows, next_cursor: null })
    }
    if (input.startsWith('/api/agents/human/thread-index')) return ok({ threads: [], next_cursor: null })
    if (input === '/api/threads/f') return ok([mail('f1', 'a1', [to('human', null)])])
    if (input === '/api/threads/g') return ok([mail('g1', 'a1', [to('human', null)])])
    return ok([])
  }))
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

// Each test has its own thread and mail, so a mark another test left waiting covers nothing here.
const row = (tid: string, unread: number) => ({ thread_id: tid, unread, last_at: '2026-10-29T10:00:00Z' })
const shown = (tid: string) => getData().humanRows.active.find((r) => r.thread_id === tid)?.unread
const to = (id: string, read: string | null) => ({ id, read_at: read })
const mail = (id: string, from: string, recipients: { id: string; read_at: string | null }[]) => ({ id, from_id: from, subject: 'x', body: '', created_at: '2026-10-29T10:00:00Z', recipients })
// Holds the poll that asks next until the returned release runs.
const holdNext = () => { let release!: () => void; hold = new Promise((r) => { release = () => { hold = null; r() } }); return release }

describe('a mark on the rows', () => {
  it('holds over a poll begun before the write, and gives way to the poll after it', async () => {
    rows = [row('a', 2)]
    await refreshSlowNow()
    expect(shown('a')).toBe(2)
    // A poll goes out before the write lands; it answers with the count from before the read.
    const release = holdNext()
    const stale = refreshSlowNow()
    const marked = markMailRead('a', ['a1', 'a2'])
    expect(shown('a')).toBe(0)
    expect(getData().unread).toBe(0)
    await marked
    release()
    await stale
    expect(shown('a')).toBe(0)
    // The poll the write asked for shows the daemon's count: one mail came since the read.
    rows = [row('a', 1)]
    await vi.advanceTimersByTimeAsync(SLOW_COALESCE)
    await vi.waitFor(() => expect(shown('a')).toBe(1))
    expect(getData().unread).toBe(1)
  })

  it('settles on the poll after the write though that poll finds nothing new', async () => {
    rows = [row('b', 0)]
    await refreshSlowNow()
    // The daemon takes the write but marks nothing (its mail isn't the human's), so its count stays.
    await markThreadUnread('b', ['b1'])
    expect(shown('b')).toBe(1)
    // The poll after the write finds the same rows; it still settles the mark, long before the overlay's own time ends.
    await vi.advanceTimersByTimeAsync(SLOW_COALESCE)
    await vi.waitFor(() => expect(shown('b')).toBe(0))
  })

  it('shows the daemon\'s count once a poll moved it, rather than counting the mail twice', async () => {
    rows = [row('e', 0)]
    await refreshSlowNow()
    // A poll begun before the write answers after the daemon took it.
    const release = holdNext()
    const stale = refreshSlowNow()
    const marked = markThreadUnread('e', ['e1'])
    expect(shown('e')).toBe(1)
    await marked
    rows = [row('e', 1)]
    release()
    await stale
    // Its count holds the write: the mark no longer adds to it, though it waits for the poll after the write.
    expect(shown('e')).toBe(1)
    await vi.advanceTimersByTimeAsync(SLOW_COALESCE)
    await vi.waitFor(() => expect(shown('e')).toBe(1))
  })

  it('counts a mail once when it is marked read again before the daemon answers', async () => {
    rows = [row('c', 2)]
    await refreshSlowNow()
    setData({ openThreads: [{ thread_id: 'c', mails: [mail('c1', 'a1', [to('human', null)]), mail('c2', 'a1', [to('human', null)])] }] as never })
    void markMailRead('c', ['c1'])
    void markMailRead('c', ['c1'])
    expect(shown('c')).toBe(1)
  })

  it('leaves the count for a mail the human isn\'t a recipient of', async () => {
    rows = [row('d', 0)]
    await refreshSlowNow()
    // The human's own reply, last in the thread: no copy of it is theirs to mark.
    setData({ openThreads: [{ thread_id: 'd', mails: [mail('d1', 'a1', [to('human', '2026-10-29T09:00:00Z')]), mail('d2', 'human', [to('a1', null)])] }] as never })
    void markThreadUnread('d', ['d2'])
    expect(shown('d')).toBe(0)
  })

  it('puts the count back when z undoes u on a thread no view loaded, before any poll', async () => {
    rows = [row('f', 1)]
    await refreshSlowNow()
    // `u` from the list reads the thread's mail from the daemon; no thread view holds a copy.
    await toggleInboxUnread('f')
    expect(shown('f')).toBe(0)
    await undoInboxTriage()
    expect(shown('f')).toBe(1)
    expect(getData().unread).toBe(1)
  })

  it('starts z afresh once the u it undoes has settled, though a new mail brought the count back', async () => {
    rows = [row('g', 1)]
    await refreshSlowNow()
    await toggleInboxUnread('g')
    // The poll after the read settles it.
    rows = [row('g', 0)]
    await vi.advanceTimersByTimeAsync(SLOW_COALESCE)
    await vi.waitFor(() => expect(getData().humanRows.active.find((r) => r.thread_id === 'g')?.unread).toBe(0))
    // A new mail comes, and a poll counts it.
    rows = [row('g', 1)]
    await refreshSlowNow()
    expect(shown('g')).toBe(1)
    // z marks the first mail unread again: both are unread now.
    await undoInboxTriage()
    expect(shown('g')).toBe(2)
  })
})
