// @vitest-environment jsdom
// `u` on the Inbox page (S-2246): a thread with unread mail for the human is marked read through the read route, and one
// without is marked unread at its latest mail to them, through the new route. The rows and counts change at once, `z`
// undoes it, and `z` refocuses the Inbox only while the page still shows.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { humanRowsOf } from './mail/thread-index'
import type { Thread } from './types'

// The store module of the running test, so the fake daemon below can show a write in the polled data.
let store: typeof import('./store') | null = null
// The fake daemon holds the human's whole threads (`server`): a write answers at once and the polled rows show it, as
// the next poll would. A thread's own read answers with its mail (`u` reads the ids there, S-4580); the store's
// refreshes (the other GETs) never answer, so only the writes change the data the tests read. A test can hold the thread
// reads (`held`) and let them answer later; `reload` says whether a write reaches the open thread's copy as its reload would.
let server: Thread[] = []
let held: Promise<void> | null = null
let reload = true
const unreadOf = (ts: Thread[]) => ts.reduce((n, t) => n + t.mails.filter((m) => m.recipients.some((r) => r.id === 'human' && !r.read_at)).length, 0)
const api = vi.fn((method: unknown, path: unknown, body?: unknown) => {
  const tid = String(path).match(/^\/api\/threads\/([^/?]+)$/)?.[1]
  if (method === 'GET' && tid) {
    const mails = () => server.find((t) => t.thread_id === tid)?.mails ?? []
    return held ? held.then(mails) : Promise.resolve(mails())
  }
  if (method === 'GET') return new Promise(() => {})
  const ids = (body as { ids?: string[] } | undefined)?.ids ?? []
  const read = String(path).endsWith('/unread') ? null : '2026-10-20T12:00:00.000Z'
  const mark = (t: Thread): Thread => ({ ...t, mails: t.mails.map((m) => (ids.includes(m.id) ? { ...m, recipients: m.recipients.map((r) => (r.id === 'human' ? { ...r, read_at: read } : r)) } : m)) })
  server = server.map(mark)
  if (store) {
    // The open thread's reload shows the write too, unless the test holds it back.
    store.setData({ humanRows: humanRowsOf(server), openThreads: reload ? store.getPolled().openThreads.map(mark) : store.getPolled().openThreads, unread: unreadOf(server) })
  }
  return Promise.resolve({})
})
vi.mock('./api', () => ({ api: (...a: unknown[]) => (api as (...b: unknown[]) => unknown)(...a), hash: new URLSearchParams() }))
// The shown world is the test's to set; a thread opened outside the Inbox page goes to its own world.
const shown = { world: 'w:inbox' as string | null }
const showAgentWorld = vi.fn()
vi.mock('./shell/layout', async (orig) => ({ ...(await orig<object>()), currentWorld: () => shown.world, isPhone: () => false, showAgentWorld: (...a: unknown[]) => showAgentWorld(...a) }))

const to = (read: string | null) => [{ id: 'human', read_at: read }]
// A thread whose latest mail is to the human, read or not, after one mail from the human (no recipient row for them).
const thread = (id: string, read: string | null) => ({ thread_id: id, mails: [
  { id: 'h-' + id, from_id: 'human', subject: id, created_at: '2026-10-13T09:00:00Z', recipients: [] },
  { id: 'm-' + id, from_id: 'a1', subject: id, created_at: '2026-10-13T10:00:00Z', recipients: to(read) },
] })
const statuses = [{ name: 'needs_input', category: 'active', human: true }, { name: 'done', category: 'closed', human: false }]
const seed = async (threads: ReturnType<typeof thread>[]) => {
  store = await import('./store')
  server = threads as never
  store.setData({ humanRows: humanRowsOf(server), decisions: [], attention: [], itsaStatuses: statuses, agents: [], unread: unreadOf(server) } as never)
  return store
}
// The writes only: the store's refreshes are GETs.
const calls = () => api.mock.calls.map((c) => c as unknown[]).filter((c) => c[0] === 'POST')

describe('u on the Inbox page', () => {
  beforeEach(() => { vi.resetModules(); api.mockClear(); showAgentWorld.mockClear(); shown.world = 'w:inbox'; held = null; reload = true })

  it('marks an unread thread read through the read route, and the count follows at once', async () => {
    const store = await seed([thread('u1', null), thread('u2', '2026-10-13T10:05:00Z')])
    expect(store.getData().unread).toBe(1)
    const { toggleInboxUnread } = await import('./actions')
    await toggleInboxUnread('u1')
    expect(calls()).toEqual([['POST', '/api/agents/human/read', { ids: ['m-u1'] }]])
    expect(store.getData().unread).toBe(0)
  })

  it('marks a read thread unread at its latest mail to the human, and the count follows at once', async () => {
    const store = await seed([thread('r1', '2026-10-13T10:05:00Z')])
    expect(store.getData().unread).toBe(0)
    const { toggleInboxUnread } = await import('./actions')
    await toggleInboxUnread('r1')
    expect(calls()).toEqual([['POST', '/api/agents/human/threads/r1/unread', { ids: ['m-r1'] }]])
    expect(store.getData().unread).toBe(1)
  })

  it('does nothing for a thread the list does not hold, or one with no mail to the human', async () => {
    await seed([{ thread_id: 'mine', mails: [{ id: 'h-mine', from_id: 'human', subject: 'mine', created_at: '2026-10-13T10:00:00Z', recipients: [] }] }])
    const { toggleInboxUnread } = await import('./actions')
    await toggleInboxUnread('mine')
    await toggleInboxUnread('missing')
    expect(calls()).toEqual([])
  })

  it('reads the ids from the copy the open thread loaded, without a fetch (S-4580)', async () => {
    const store = await seed([thread('o1', null)])
    store.setData({ openThreads: [thread('o1', null)] as never })
    const { toggleInboxUnread } = await import('./actions')
    await toggleInboxUnread('o1')
    expect(api.mock.calls.some((c) => c[0] === 'GET' && String(c[1]).startsWith('/api/threads/'))).toBe(false)
    expect(calls()).toEqual([['POST', '/api/agents/human/read', { ids: ['m-o1'] }]])
    await toggleInboxUnread('o1')
    expect(calls().at(-1)).toEqual(['POST', '/api/agents/human/threads/o1/unread', { ids: ['m-o1'] }])
  })

  it('marks the open copy at once, before the daemon answers', async () => {
    const store = await seed([thread('o2', null)])
    store.setData({ openThreads: [thread('o2', null)] as never })
    const { markMailRead } = await import('./actions')
    api.mockImplementationOnce(() => new Promise(() => {}))
    void markMailRead('o2', ['m-o2'])
    expect(store.getData().openThreads[0].mails[1].recipients[0].read_at).not.toBeNull()
    expect(store.getPolled().openThreads[0].mails[1].recipients[0].read_at).toBeNull()
  })

  it('a z pressed while u still reads the ids undoes that u, not the triage before it (S-4580)', async () => {
    const store = await seed([thread('q1', null), thread('q2', '2026-10-13T10:05:00Z')])
    const { toggleInboxUnread, undoInboxTriage } = await import('./actions')
    await toggleInboxUnread('q2')
    let answer!: () => void
    held = new Promise((ok) => { answer = ok })
    const u = toggleInboxUnread('q1')
    const z = undoInboxTriage()
    answer()
    await u
    await z
    // q1 was marked read and then unread again; q2's earlier mark stays.
    expect(calls().map((c) => c[1])).toEqual(['/api/agents/human/threads/q2/unread', '/api/agents/human/read', '/api/agents/human/threads/q1/unread'])
    expect(store.getData().unread).toBe(2)
  })

  it('an e pressed while u still reads the ids stays the newest triage (S-4580)', async () => {
    await seed([thread('r1', null)])
    const { toggleInboxUnread, triageInboxThread, undoInboxTriage } = await import('./actions')
    let answer!: () => void
    held = new Promise((ok) => { answer = ok })
    const u = toggleInboxUnread('r1')
    const e = triageInboxThread('r1', 'archive')
    answer()
    await u
    await e
    api.mockClear()
    // Off the Inbox page, so the undo opens nothing.
    shown.world = 'w:calendar'
    await undoInboxTriage()
    expect(calls().map((c) => c[1])).toEqual(['/api/agents/human/threads/r1/unarchive'])
  })

  it('a read holds on the open copy until its reload shows it, so a second u marks it unread (S-4580)', async () => {
    const store = await seed([thread('s1', null)])
    store.setData({ openThreads: [thread('s1', null)] as never })
    reload = false
    const { toggleInboxUnread } = await import('./actions')
    await toggleInboxUnread('s1')
    // The lists show the read; the open copy's reload hasn't come yet, and the mark still covers it.
    expect(store.getPolled().openThreads[0].mails[1].recipients[0].read_at).toBeNull()
    expect(store.getData().openThreads[0].mails[1].recipients[0].read_at).not.toBeNull()
    await toggleInboxUnread('s1')
    expect(calls().at(-1)).toEqual(['POST', '/api/agents/human/threads/s1/unread', { ids: ['m-s1'] }])
    // The unread mark settled; the older read mark no longer shows, though the open copy's reload still hasn't come.
    expect(store.getData().openThreads[0].mails[1].recipients[0].read_at).toBeNull()
    expect(store.getData().unread).toBe(1)
    // So a third u reads it again, and z undoes that.
    const { undoInboxTriage } = await import('./actions')
    await toggleInboxUnread('s1')
    expect(calls().at(-1)).toEqual(['POST', '/api/agents/human/read', { ids: ['m-s1'] }])
    expect(store.getData().unread).toBe(0)
    await undoInboxTriage()
    expect(calls().at(-1)).toEqual(['POST', '/api/agents/human/threads/s1/unread', { ids: ['m-s1'] }])
    expect(store.getData().unread).toBe(1)
  })

  it('z undoes the last u in either direction, and the thread is back as it was', async () => {
    const store = await seed([thread('z1', null)])
    const { toggleInboxUnread, undoInboxTriage } = await import('./actions')
    await toggleInboxUnread('z1')
    expect(store.getData().unread).toBe(0)
    await undoInboxTriage()
    expect(calls().at(-1)).toEqual(['POST', '/api/agents/human/threads/z1/unread', { ids: ['m-z1'] }])
    expect(store.getData().unread).toBe(1)
  })

  it('z undoes only the newest triage, and a second z does nothing', async () => {
    await seed([thread('z2', null)])
    const { toggleInboxUnread, undoInboxTriage } = await import('./actions')
    await toggleInboxUnread('z2')
    await undoInboxTriage()
    api.mockClear()
    await undoInboxTriage()
    expect(calls()).toEqual([])
  })
})

describe('z after e refocuses the Inbox only while it shows', () => {
  beforeEach(() => { vi.resetModules(); api.mockClear(); showAgentWorld.mockClear(); shown.world = 'w:inbox' })

  it('does not pull the user back to the thread after they left the Inbox page', async () => {
    await seed([thread('f1', '2026-10-13T10:05:00Z')])
    const { triageInboxThread, undoInboxTriage } = await import('./actions')
    await triageInboxThread('f1', 'archive')
    shown.world = 'w:calendar'
    await undoInboxTriage()
    // The thread went back to the inbox on the server, and nothing opened it on the page the user is on.
    expect(calls().some((c) => c[1] === '/api/agents/human/threads/f1/unarchive')).toBe(true)
    expect(showAgentWorld).not.toHaveBeenCalledWith('t:f1')
  })
})
