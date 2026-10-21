// The chip sets of a mail thread's tab (S-2311): the wait mark's priority, the linked ITSAs and the
// agents' order, and the tab's title and tooltip.
import { describe, expect, it } from 'vitest'
import { getData, setData } from '../store'
import type { Agent, Itsa, Mail, Thread } from '../types'
import { threadAgents, threadChips, threadHead, threadItsas, threadWaitMark } from './thread-chips'

const mail = (id: string, o: Partial<Mail> & { to?: string[]; read?: boolean } = {}): Mail => {
  const { to = ['human'], read = false, ...rest } = o
  return {
    id, from_id: 'a1', subject: 'Re: `Deploy` plan', body: '', created_at: '2026-10-19T10:00:00Z', title: null,
    recipients: to.map((r) => ({ id: r, read_at: r === 'human' && read ? '2026-10-19T10:01:00Z' : null })),
    ...rest,
  } as unknown as Mail
}
const itsa = (id: string): Itsa => ({ id, key: 'S-' + id, title: 'Title ' + id, parent_id: null, status: 'in_progress', owner: 'a1' } as unknown as Itsa)
const agent = (id: string): Agent => ({ id, name: id + '-name', lifecycle: 'active' } as unknown as Agent)
const flags = { perm: false, onHuman: false, unread: 0, deferred: false, archived: false }

describe('threadWaitMark', () => {
  it('shows the most urgent state only, by priority', () => {
    expect(threadWaitMark({ ...flags, perm: true, onHuman: true, unread: 3, deferred: true, archived: true })).toEqual({ kind: 'perm', count: 0 })
    expect(threadWaitMark({ ...flags, onHuman: true, unread: 3, deferred: true, archived: true })).toEqual({ kind: 'human', count: 0 })
    expect(threadWaitMark({ ...flags, unread: 3, deferred: true, archived: true })).toEqual({ kind: 'unread', count: 3 })
    expect(threadWaitMark({ ...flags, deferred: true, archived: true })).toEqual({ kind: 'deferred', count: 0 })
    expect(threadWaitMark({ ...flags, archived: true })).toEqual({ kind: 'archived', count: 0 })
  })

  it('shows nothing for a read, live thread', () => {
    expect(threadWaitMark(flags)).toBeNull()
  })
})

describe('threadItsas', () => {
  it('lists the linked ITSAs and the one each mail is about, once, in order', () => {
    const itsas = [itsa('1'), itsa('2'), itsa('3')]
    const mails = [
      mail('m1', { itsas: [{ id: '2', key: 'S-2', title: '', status: '', source: 'itsa' }] } as Partial<Mail>),
      mail('m2', { itsas: [{ id: '1', key: 'S-1', title: '', status: '', source: 'thread' }] } as Partial<Mail>),
      mail('m3', { about_itsa: '3' } as Partial<Mail>),
      mail('m4', { about_itsa: '2' } as Partial<Mail>),
    ]
    expect(threadItsas(mails, itsas).map((x) => x.id)).toEqual(['2', '1', '3'])
  })

  it('builds a link the store lacks from the link\'s own key, title and status, as the head does', () => {
    const itsas = [itsa('1')]
    const mails = [
      mail('m1', { itsas: [{ id: 'gone', key: 'S-9', title: 'Gone one', status: 'in_review', source: 'thread' }] } as Partial<Mail>),
      mail('m2', { itsas: [{ id: '1', key: 'S-1', title: 'Stale title', status: 'todo', source: 'itsa' }] } as Partial<Mail>),
    ]
    const out = threadItsas(mails, itsas)
    expect(out.map((x) => x.id)).toEqual(['gone', '1'])
    expect(out[0]).toMatchObject({ id: 'gone', key: 'S-9', title: 'Gone one', status: 'in_review' })
    expect(out[1].title).toBe('Title 1')
  })

  it('drops an about ITSA the store lacks, since no link carries its data', () => {
    const mails = [mail('m1', { about_itsa: 'gone' } as Partial<Mail>)]
    expect(threadItsas(mails, [itsa('1')])).toEqual([])
  })
})

describe('threadAgents', () => {
  it('lists attached agents first, then senders and recipients by latest mail, without the human', () => {
    const mails = [
      mail('m1', { from_id: 'a1', to: ['human', 'a2'], agents: ['a4'] } as Partial<Mail>),
      mail('m2', { from_id: 'a3', to: ['human'] }),
      mail('m3', { from_id: 'human', to: ['a1', 'a5'] }),
    ]
    // a5 is not an agent the store knows: it is left out.
    expect(threadAgents(mails, (id) => id !== 'a5')).toEqual(['a4', 'a3', 'a1', 'a2'])
  })
})

describe('threadChips and threadHead', () => {
  const base = { attention: [], decisions: [], humanArchived: [], humanDeferred: [], openThreads: [], itsaStatuses: [] }
  const thread = (mails: Mail[]): Thread => ({ thread_id: 't1', mails })

  it('reads the thread from the store, with its wait mark, ITSAs and agents', () => {
    setData({ ...base, agents: [agent('a1'), agent('a2')], itsas: [itsa('1')], humanThreads: [thread([
      mail('m1', { from_id: 'a1', to: ['human'], itsas: [{ id: '1', key: 'S-1', title: '', status: '', source: 'itsa' }] } as Partial<Mail>),
      mail('m2', { from_id: 'a2', to: ['human'], read: true }),
    ])] } as never)
    const c = threadChips('t1', getData())
    expect(c.mark).toEqual({ kind: 'unread', count: 1 })
    expect(c.itsas.map((x) => x.key)).toEqual(['S-1'])
    expect(c.agents).toEqual(['a2', 'a1'])
  })

  it('titles the tab with the short title and carries the subject and people in the tooltip', () => {
    const mails = [mail('m1', { title: 'Deploy plan', from_id: 'a1', to: ['human'] }), mail('m2', { from_id: 'human', to: ['a1'] })]
    expect(threadHead(mails, [{ id: 'a1', name: 'process-mgr' }])).toEqual({
      title: 'Deploy plan',
      tooltip: 'Deploy plan · process-mgr, you · 2 messages',
    })
  })

  it('falls back to the subject when no mail has a short title', () => {
    expect(threadHead([mail('m1')], []).title).toBe('Deploy plan')
    expect(threadHead([], []).title).toBe('')
  })
})
