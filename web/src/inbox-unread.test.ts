// @vitest-environment jsdom
// `u` on the Inbox page (S-2246): a thread with unread mail for the human is marked read through the read route, and one
// without is marked unread at its latest mail to them, through the new route. The rows and counts change at once, `z`
// undoes it, and `z` refocuses the Inbox only while the page still shows.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Thread } from './types'

// The store module of the running test, so the fake daemon below can show a write in the polled data.
let store: typeof import('./store') | null = null
// The fake daemon: a write answers at once and the polled threads show it, as the next poll would. The store's refreshes
// (GETs) never answer, so only the writes change the data the tests read.
const api = vi.fn((method: unknown, path: unknown, body?: unknown) => {
  if (method === 'GET') return new Promise(() => {})
  const ids = (body as { ids?: string[] } | undefined)?.ids ?? []
  const read = String(path).endsWith('/unread') ? null : '2026-10-20T12:00:00.000Z'
  if (store) {
    const mark = (t: Thread): Thread => ({ ...t, mails: t.mails.map((m) => (ids.includes(m.id) ? { ...m, recipients: m.recipients.map((r) => (r.id === 'human' ? { ...r, read_at: read } : r)) } : m)) })
    const threads = store.getPolled().humanThreads.map(mark)
    store.setData({ humanThreads: threads, unread: threads.filter((t) => t.mails.some((m) => m.recipients.some((r) => r.id === 'human' && !r.read_at))).length })
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
  store.setData({ humanThreads: threads, humanArchived: [], humanDeferred: [], decisions: [], attention: [], itsaStatuses: statuses, agents: [], unread: threads.filter((t) => t.mails.some((m) => m.recipients.some((r) => r.id === 'human' && !r.read_at))).length } as never)
  return store
}
// The writes only: the store's refreshes are GETs.
const calls = () => api.mock.calls.map((c) => c as unknown[]).filter((c) => c[0] === 'POST')

describe('u on the Inbox page', () => {
  beforeEach(() => { vi.resetModules(); api.mockClear(); showAgentWorld.mockClear(); shown.world = 'w:inbox' })

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
