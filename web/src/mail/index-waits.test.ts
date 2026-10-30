// The waits and a thread tab's chips read index rows (S-4579): with rows as the thread index route answers them
// and no whole thread in the store, a permission finds its thread, a pending ask holds the thread on you, a wait's
// thread is held, and a tab's chips show the row's unread count, ITSAs and agents. A loaded copy still wins.
// So do the tab's head and the mail order (S-4580).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IndexRow, Thread, ThreadList } from '../types'

vi.mock('../api', () => ({ api: vi.fn(async () => []), hash: new URLSearchParams() }))
// The rows the route would answer: the store holds no mail at all, so nothing here can be read from a mail.
async function lists(rows: Partial<Record<ThreadList, IndexRow[]>>) {
  const store = await import('../store')
  store.setData({ humanRows: { active: rows.active ?? [], archived: rows.archived ?? [], deferred: rows.deferred ?? [] } })
}

const row = (id: string, patch: Partial<IndexRow> = {}): IndexRow => ({
  thread_id: id, subject: 'Subject ' + id, title: null, kind: null, itsa_id: null, from_id: 'a1', from_name: 'fixture-dev',
  last_at: '2026-10-29T10:00:00Z', mail_count: 1, unread: 0, ask: null, snippet: '', ...patch,
})
const itsa = (id: string, key: string) => ({ id, key, title: key + ' title', status: 'todo', parent_id: null, owner: null })

beforeEach(async () => {
  const store = await import('../store')
  store.setData({ agents: [{ id: 'a1', name: 'fixture-dev' }, { id: 'a2', name: 'fixture-review' }], itsas: [itsa('i1', 'S-1')], perms: [], decisions: [], attention: [], openThreads: [], humanRows: { active: [], archived: [], deferred: [] } } as never)
})

describe('the waits from index rows', () => {
  it('finds a permission\'s thread in the inbox and the deferred list, and its own thread only when the request started it', async () => {
    const store = await import('../store')
    await lists({
      active: [row('own', { perms: [{ id: 'p1', placed: false }] }), row('placed', { perms: [{ id: 'p2', placed: true }] })],
      deferred: [row('later', { perms: [{ id: 'p3', placed: false }] })],
      archived: [row('gone', { perms: [{ id: 'p4', placed: false }] })],
    })
    expect(store.permThread('p1')).toBe('own')
    expect(store.ownPermThread('p1')).toBe('own')
    expect(store.permThread('p2')).toBe('placed')
    expect(store.ownPermThread('p2')).toBeUndefined()
    expect(store.permThread('p3')).toBe('later')
    // The archive isn't searched, as before.
    expect(store.permThread('p4')).toBeUndefined()
  })

  it('a pending ask in a row holds the thread on you, and a loaded copy answers for a thread no list holds', async () => {
    const store = await import('../store')
    await lists({ archived: [row('ask', { ask: 'pending' }), row('done')] })
    expect(store.threadWaitsOnHuman('ask')).toBe(true)
    expect(store.threadWaitsOnHuman('done')).toBe(false)
    expect(store.isArchivedThread('ask')).toBe(true)
    const open: Thread = { thread_id: 'elsewhere', mails: [{ id: 'm', from_id: 'a1', body: '', created_at: '2026-10-29T10:00:00Z', recipients: [], permission: { status: 'pending' } as never }] }
    store.setData({ openThreads: [open] })
    expect(store.threadWaitsOnHuman('elsewhere')).toBe(true)
  })

  it('a wait\'s thread is held when a list has its row', async () => {
    const { holds } = await import('../itsa/WaitingList')
    await lists({ deferred: [row('d1')] })
    expect(holds('d1')).toBe(true)
    expect(holds('raw-mail-id')).toBe(false)
  })
})

describe('a thread tab\'s chips from index rows', () => {
  it('shows the row\'s unread count, ITSAs and known agents', async () => {
    const store = await import('../store')
    const { threadChips } = await import('./thread-chips')
    await lists({ active: [row('t1', { unread: 2, itsa_links: [{ id: 'i1', key: 'S-1', title: 'stale', status: 'todo' }, { id: 'i9', key: 'S-9', title: 'Nine', status: 'done' }], about_itsas: ['i1', 'i8'], agents: ['a2', 'gone', 'a1'] })] })
    const c = threadChips('t1', store.getData())
    expect(c.mark).toEqual({ kind: 'unread', count: 2 })
    // The store's ITSA over the link's copy; a link the store lacks from its own fields; an about with no link has none.
    expect(c.itsas.map((x) => [x.key, x.title])).toEqual([['S-1', 'S-1 title'], ['S-9', 'Nine']])
    expect(c.agents).toEqual(['a2', 'a1'])
  })

  it('marks a pending ask, and a loaded copy of the thread wins over its row', async () => {
    const store = await import('../store')
    const { threadChips } = await import('./thread-chips')
    await lists({ active: [row('t2', { ask: 'pending', unread: 1, agents: ['a1'] })] })
    expect(threadChips('t2', store.getData()).mark).toEqual({ kind: 'perm', count: 0 })
    store.setData({ openThreads: [{ thread_id: 't2', mails: [{ id: 'm', from_id: 'a2', body: '', created_at: '2026-10-29T10:00:00Z', recipients: [{ id: 'human', read_at: null }] }] }] })
    const c = threadChips('t2', store.getData())
    // The loaded copy has no pending permission, but the row still says the thread waits on you.
    expect(c.mark).toEqual({ kind: 'human', count: 0 })
    expect(c.agents).toEqual(['a2'])
  })
})

describe('the readers S-4580 moves onto index rows', () => {
  it('a thread tab\'s head shows the row\'s title, subject, people and count, and a loaded copy wins', async () => {
    const store = await import('../store')
    const { threadTabHead } = await import('./thread-chips')
    await lists({ active: [row('t1', { title: 'Short', subject: 'Re: Long subject', mail_count: 3, agents: ['a2', 'gone'] })], deferred: [row('t2')] })
    expect(threadTabHead('t1', store.getData())).toEqual({ title: 'Short', tooltip: 'Long subject · you, fixture-review, gone · 3 messages' })
    expect(threadTabHead('t2', store.getData()).title).toBe('Subject t2')
    store.setData({ openThreads: [{ thread_id: 't1', mails: [{ id: 'm', from_id: 'a1', subject: 'Loaded', body: '', created_at: '2026-10-29T10:00:00Z', recipients: [{ id: 'human', read_at: null }] }] }] })
    expect(threadTabHead('t1', store.getData())).toEqual({ title: 'Loaded', tooltip: 'Loaded · fixture-dev, you · 1 message' })
    expect(threadTabHead('none', store.getData())).toEqual({ title: '', tooltip: '0 messages' })
  })

  it('the chips mark a deferred or archived thread from the lists\' rows', async () => {
    const store = await import('../store')
    const { threadChips } = await import('./thread-chips')
    await lists({ deferred: [row('d1')], archived: [row('a1')] })
    expect(threadChips('d1', store.getData()).mark).toEqual({ kind: 'deferred', count: 0 })
    expect(threadChips('a1', store.getData()).mark).toEqual({ kind: 'archived', count: 0 })
  })

  it('the mail order puts a pending ask\'s row first', async () => {
    const store = await import('../store')
    const actions = await import('../actions')
    await lists({ active: [row('p1'), row('p2', { ask: 'pending' }), row('p3')] })
    expect(actions.mailOrder(store.getData()).map((r) => r.thread_id)).toEqual(['p2', 'p1', 'p3'])
  })
})
