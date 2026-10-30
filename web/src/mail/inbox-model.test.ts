import { describe, expect, it } from 'vitest'
import type { WaitingRow } from '../itsa/WaitingList'
import type { IndexRow, Thread } from '../types'
import { filtered, grouped, hitGroup, isAwaiting, needsIds, unreadCount } from './inbox-model'
import { indexRow } from './thread-index'

// The lists are index rows (S-4578), built here from whole threads as the store builds them.
const mail = (from: string, at: string, extra = {}) => ({ id: 'm' + at, from_id: from, from_name: from, subject: 's', body: '', created_at: at, recipients: [], ...extra })
const row = (t: unknown): IndexRow => indexRow('human', t as Thread)
const thread = (id: string, from: string, at: string, extra = {}) => row({ thread_id: id, mails: [mail(from, at, extra)] })
const wait = (key: string, threadId: string | null): WaitingRow => ({ key, who: 'a', what: 'w', why: 'waits', since: '2026-10-19T08:00:00Z', icon: threadId ? 'mail' : 'user', open: () => {}, threadId })

const NOW = new Date(2026, 9, 19, 12, 0, 0)
const today = new Date(2026, 9, 19, 9, 0, 0).toISOString()
const yesterday = new Date(2026, 9, 18, 9, 0, 0).toISOString()

describe('inbox groups', () => {
  it('pins what waits on you, then today, then earlier', () => {
    const a = thread('a', 'x', yesterday), b = thread('b', 'x', today), c = thread('c', 'x', yesterday), d = thread('d', 'x', today)
    const g = grouped([a, b, c, d], new Set(['c']), NOW)
    expect(g.map((x) => [x.key, x.threads.map((t) => t.thread_id)])).toEqual([['needs', ['c']], ['today', ['b', 'd']], ['earlier', ['a']]])
  })
  it('leaves out a group with no thread', () => {
    expect(grouped([thread('a', 'x', yesterday)], new Set(), NOW).map((g) => g.key)).toEqual(['earlier'])
  })
  it('orders Needs you oldest first and the rest newest first', () => {
    const g = grouped([thread('n1', 'x', today), thread('n2', 'x', yesterday), thread('t1', 'x', yesterday), thread('t2', 'x', today)], new Set(['n1', 'n2']), NOW)
    expect(g[0].threads.map((t) => t.thread_id)).toEqual(['n2', 'n1'])
    expect(g[1].threads.map((t) => t.thread_id)).toEqual(['t2'])
  })
})

describe('inbox filters', () => {
  const lists = {
    active: [thread('i1', 'x', today, { recipients: [{ id: 'human', read_at: null }] }), thread('i2', 'human', today), thread('i3', 'x', today, { recipients: [{ id: 'human', read_at: today }] })],
    archived: [thread('ar', 'human', yesterday)],
    deferred: [thread('df', 'x', yesterday)],
  }
  const ids = (s: { threads: { thread_id: string }[] }) => s.threads.map((t) => t.thread_id)
  it('lists each chip', () => {
    expect(ids(filtered('all', lists, [], []))).toEqual(['i1', 'i2', 'i3'])
    expect(ids(filtered('unread', lists, [], []))).toEqual(['i1'])
    expect(ids(filtered('awaiting', lists, [], []))).toEqual(['i2', 'ar'])
    expect(ids(filtered('deferred', lists, [], []))).toEqual(['df'])
    expect(ids(filtered('archived', lists, [], []))).toEqual(['ar'])
  })
  it('To answer holds the waiting threads, archived or deferred too, and the waits with no thread apart', () => {
    const s = filtered('toanswer', lists, [wait('w1', 'i3'), wait('w2', 'ar'), wait('w3', null)], [wait('w4', 'df')])
    expect(ids(s)).toEqual(['i3', 'ar', 'df'])
    expect(s.loose.map((w) => w.key)).toEqual(['w3'])
  })
  // The ask's thread: the agent's ask, then the human's deferring reply (the last message), unread for the human.
  const askThread = (extraMails: { from: string; at: string; to?: string }[] = []) => row({ thread_id: 'ask', mails: [mail('x', yesterday, { recipients: [{ id: 'human', read_at: null }] }), mail('human', today), ...extraMails.map((m) => mail(m.from, m.at, { recipients: [{ id: m.to ?? 'human', read_at: null }] }))] })
  it('a deferred ask with a thread is under Deferred, not the inbox', () => {
    const withAsk = { ...lists, active: [...lists.active, askThread()] }
    const deferredWaits = [wait('d1', 'ask')]
    expect(ids(filtered('all', withAsk, [], deferredWaits))).toEqual(['i1', 'i2', 'i3'])
    expect(ids(filtered('unread', withAsk, [], deferredWaits))).toEqual(['i1'])
    expect(ids(filtered('deferred', withAsk, [], deferredWaits))).toEqual(['df', 'ask'])
  })
  it('new mail in a deferred ask\'s thread brings it back to the inbox and the Unread list', () => {
    const replied = { ...lists, active: [...lists.active, askThread([{ from: 'x', at: today }])] }
    const deferredWaits = [wait('d1', 'ask')]
    expect(ids(filtered('all', replied, [], deferredWaits))).toEqual(['i1', 'i2', 'i3', 'ask'])
    expect(ids(filtered('deferred', replied, [], deferredWaits))).toEqual(['df'])
  })
  it('mail between two agents, after the deferral, leaves a deferred ask under Deferred', () => {
    const between = { ...lists, active: [...lists.active, askThread([{ from: 'x', at: today, to: 'fixture-dev' }])] }
    const deferredWaits = [wait('d1', 'ask')]
    expect(ids(filtered('all', between, [], deferredWaits))).toEqual(['i1', 'i2', 'i3'])
    expect(ids(filtered('deferred', between, [], deferredWaits))).toEqual(['df', 'ask'])
  })
  it('the unread count is the Unread list\'s length, with a deferred ask\'s thread left out', () => {
    const withAsk = { ...lists, active: [...lists.active, askThread()] }
    expect(unreadCount(withAsk, [], [wait('d1', 'ask')])).toBe(filtered('unread', withAsk, [], [wait('d1', 'ask')]).threads.length)
    expect(unreadCount(withAsk, [], [wait('d1', 'ask')])).toBe(1)
    expect(unreadCount(withAsk, [], [])).toBe(2)
  })
  it('a deferred thread stays under Deferred once and is not listed twice', () => {
    expect(ids(filtered('deferred', lists, [], [wait('d2', 'df')]))).toEqual(['df'])
  })
  it('needs-you ids are the waiting rows\' threads', () => {
    expect([...needsIds([wait('w1', 'i3'), wait('w3', null)], lists)]).toEqual(['i3'])
  })
  it('isAwaiting is the human\'s last mail', () => {
    expect(isAwaiting(lists.active[1])).toBe(true)
    expect(isAwaiting(lists.active[0])).toBe(false)
  })
  it('a search keeps the hits\' order, and draws an older thread the store does not hold from the hit', () => {
    const old = { thread_id: 'zz', subject: 'An older archived thread', latest: 'mz', people: ['human', 'fixture-dev'], last: '2026-01-02T03:04:05Z', excerpt: 'Found by the API' }
    const g = hitGroup([{ thread_id: 'df' }, old, { thread_id: 'i1' }], lists)
    expect(g).toHaveLength(1)
    expect(g[0].threads.map((t) => t.thread_id)).toEqual(['df', 'zz', 'i1'])
    const t = g[0].threads[1]
    expect(t).toMatchObject({ subject: 'An older archived thread', card_from_id: 'fixture-dev', card_text: 'Found by the API', last_created_at: '2026-01-02T03:04:05Z', unread: 0 })
    expect(isAwaiting(t)).toBe(false)
    expect(hitGroup([], lists)).toEqual([])
  })
})
