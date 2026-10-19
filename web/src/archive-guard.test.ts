// @vitest-environment jsdom
// A thread waiting on the human's answer can't be archived (S-311, S-352): a pending permission
// request, the ask thread of an ITSA waiting on them, or an agent's open decision mail. The header
// button, the phone menu, the `e` key and the row's button and swipe all leave such a thread in place.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.fn(async () => ({}))
vi.mock('./api', () => ({ api: (...a: unknown[]) => (api as (...b: unknown[]) => unknown)(...a), hash: new URLSearchParams() }))

const thread = (id: string, permission?: { status: string }) => ({ thread_id: id, mails: [{ id: 'm-' + id, from_id: 'a1', subject: id, created_at: '2026-10-13T10:00:00Z', recipients: [], permission }] })
const statuses = [{ name: 'needs_input', category: 'active', human: true }, { name: 'done', category: 'closed', human: false }]
const waiting = (askThread: string, status = 'needs_input') => ({ id: 'i1', key: 'S-1', status, ask_thread_id: askThread, since: '2026-10-13T10:00:00Z', actions: [] })

describe('the archive guard', () => {
  beforeEach(() => { vi.resetModules(); api.mockClear() })

  it('knows which threads wait on the human', async () => {
    const store = await import('./store')
    store.setData({ humanThreads: [thread('ask'), thread('perm', { status: 'pending' }), thread('plain')], humanArchived: [], attention: [waiting('ask')], itsaStatuses: statuses } as never)
    expect(['ask', 'perm', 'plain'].map((t) => store.threadWaitsOnHuman(t))).toEqual([true, true, false])
    store.setData({ attention: [waiting('ask', 'done')] } as never)
    expect(store.threadWaitsOnHuman('ask')).toBe(false)
  })

  it("keeps a thread an agent waits for the human's reply in, on every archive path", async () => {
    const store = await import('./store')
    const actions = await import('./actions')
    const agent = { id: 'a1', name: 'bob', waits: [{ id: 'w1', kind: 'human', thread: 'wt', since: '2026-10-13T10:00:00Z' }] }
    store.setData({ humanThreads: [thread('wt')], humanArchived: [], decisions: [], attention: [], itsaStatuses: statuses, agents: [agent] } as never)
    expect(store.threadWaitsOnHuman('wt')).toBe(true)
    expect(await actions.setThreadArchived('wt', true)).toBe(false)
    await actions.toggleThreadArchived('wt')
    expect(api.mock.calls.some((c) => JSON.stringify(c).includes('wt/archive'))).toBe(false)
    store.setData({ agents: [{ ...agent, waits: [] }] } as never)
    expect(store.threadWaitsOnHuman('wt')).toBe(false)
  })

  it("keeps an open decision thread in place, on every archive path", async () => {
    const store = await import('./store')
    const actions = await import('./actions')
    const decision = { mail_id: 'm-dec', thread_id: 'dec', from_id: 'a1', from_name: 'alice', subject: 'dec', created_at: '2026-10-13T10:00:00Z' }
    store.setData({ humanThreads: [thread('dec')], humanArchived: [], decisions: [decision], itsaStatuses: statuses, attention: [] } as never)
    expect(store.threadWaitsOnHuman('dec')).toBe(true)
    expect(await actions.setThreadArchived('dec', true)).toBe(false)
    await actions.toggleThreadArchived('dec')
    expect(api.mock.calls.some((c) => JSON.stringify(c).includes('dec'))).toBe(false)
    store.setData({ decisions: [] } as never)
    expect(store.threadWaitsOnHuman('dec')).toBe(false)
  })

  it("archives a thread the human just answered, even while the client still lists it as waiting", async () => {
    const store = await import('./store')
    const actions = await import('./actions')
    store.setData({ humanThreads: [thread('dec')], humanArchived: [], decisions: [{ mail_id: 'm-dec', thread_id: 'dec', from_id: 'a1', from_name: 'alice', subject: 'dec', created_at: '2026-10-13T10:00:00Z' }], itsaStatuses: statuses, attention: [] } as never)
    expect(await actions.setThreadArchived('dec', true)).toBe(false)
    expect(await actions.setThreadArchived('dec', true, true)).toBe(true)
    expect(api.mock.calls.some((c) => JSON.stringify(c).includes('dec/archive'))).toBe(true)
    store.setData({ decisions: [] } as never)
  })

  it("leaves a waiting ITSA's ask thread in place, and still unarchives a thread", async () => {
    const store = await import('./store')
    const actions = await import('./actions')
    store.setData({ humanThreads: [thread('ask')], humanArchived: [thread('plain')], attention: [waiting('ask')], itsaStatuses: statuses } as never)
    await actions.toggleThreadArchived('ask')
    expect(api.mock.calls.some((c) => JSON.stringify(c).includes('ask'))).toBe(false)
    await actions.toggleThreadArchived('plain')
    expect(api.mock.calls.some((c) => JSON.stringify(c).includes('plain'))).toBe(true)
  })
})

describe('defer (S-976)', () => {
  beforeEach(() => { vi.resetModules(); api.mockClear() })

  it('moves a thread to the deferred list, off the unread count, and back', async () => {
    const store = await import('./store')
    const actions = await import('./actions')
    store.setData({ humanThreads: [thread('plain')], humanArchived: [], humanDeferred: [], attention: [], decisions: [], itsaStatuses: statuses } as never)
    expect(await actions.setThreadDeferred('plain', true)).toBe(true)
    expect(api.mock.calls.some((c) => JSON.stringify(c).includes('plain/defer'))).toBe(true)
    expect(store.isDeferredThread('plain')).toBe(true)
    await actions.toggleThreadDeferred('plain')
    expect(api.mock.calls.some((c) => JSON.stringify(c).includes('plain/undefer'))).toBe(true)
  })

  it('defers a thread waiting on the human, ask or decision, and leaves it unanswered (S-1068)', async () => {
    const store = await import('./store')
    const actions = await import('./actions')
    const decision = { mail_id: 'm-dec', thread_id: 'dec', from_id: 'a1', from_name: 'alice', subject: 'dec', created_at: '2026-10-13T10:00:00Z' }
    store.setData({ humanThreads: [thread('ask'), thread('dec')], humanArchived: [], humanDeferred: [], attention: [waiting('ask')], decisions: [decision], itsaStatuses: statuses } as never)
    expect(await actions.setThreadDeferred('ask', true)).toBe(true)
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    await actions.toggleThreadDeferred('dec')
    expect(api.mock.calls.some((c) => JSON.stringify(c).includes('ask/defer'))).toBe(true)
    expect(api.mock.calls.some((c) => JSON.stringify(c).includes('dec/defer'))).toBe(true)
    expect(store.isDeferredThread('ask') && store.isDeferredThread('dec')).toBe(true)
    expect(store.threadWaitsOnHuman('ask') && store.threadWaitsOnHuman('dec')).toBe(true)
  })

  it('defers a thread with a pending permission request without answering it (S-1068)', async () => {
    const store = await import('./store')
    const actions = await import('./actions')
    store.setData({ humanThreads: [thread('perm', { status: 'pending' })], humanArchived: [], humanDeferred: [], attention: [], decisions: [], itsaStatuses: statuses } as never)
    expect(await actions.setThreadDeferred('perm', true)).toBe(true)
    expect(api.mock.calls.some((c) => JSON.stringify(c).includes('perm/defer'))).toBe(true)
    expect(api.mock.calls.some((c) => JSON.stringify(c).includes('permissions'))).toBe(false)
    expect(store.threadWaitsOnHuman('perm')).toBe(true)
  })

  it('archives a deferred thread straight out of the deferred list', async () => {
    const store = await import('./store')
    const actions = await import('./actions')
    store.setData({ humanThreads: [], humanArchived: [], humanDeferred: [thread('d')], attention: [], decisions: [], itsaStatuses: statuses } as never)
    expect(await actions.setThreadArchived('d', true)).toBe(true)
    expect(store.getData().humanDeferred).toEqual([])
    expect(store.isArchivedThread('d')).toBe(true)
  })
})
