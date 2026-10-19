import { describe, expect, it } from 'vitest'
import { between, repeatedIds, withdrawnFor } from './ThreadPanel'
import { isUnreadForHuman } from '../store'
import type { Mail } from '../types'

const mail = (id: string, extra: Partial<Mail> = {}): Mail => ({
  id, from_id: 'a1', body: id, recipients: [], created_at: '2026-10-13T08:00:00Z', kind: 'comment', thread_id: 't1', ...extra,
})

describe('repeatedIds', () => {
  it('finds the comment an ask repeats, and nothing else', () => {
    const mails = [
      mail('c1'),
      mail('c2', { body: 'Pick Redis.' }),
      mail('ask1', { kind: 'ask', reply_to: 'c2', body: 'Header\n\nPick Redis.' }),
      mail('c3', { reply_to: 'c1' }),
    ]
    expect([...repeatedIds(mails)]).toEqual(['c2'])
  })

  it('is empty when no ask names a comment', () => {
    expect(repeatedIds([mail('c1'), mail('ask', { kind: 'ask' })]).size).toBe(0)
  })

  it('does not fold a non-comment mail an ask replies to', () => {
    const mails = [
      mail('m1', { kind: 'mail', body: 'Earlier note' }),
      mail('ask1', { kind: 'ask', reply_to: 'm1', body: 'Header\n\nEarlier note' }),
    ]
    expect(repeatedIds(mails).size).toBe(0)
  })

  it('does not fold a comment from someone other than the ask sender', () => {
    const mails = [
      mail('c1', { from_id: 'bob', body: 'Pick Redis.' }),
      mail('ask1', { kind: 'ask', reply_to: 'c1', from_id: 'a1', body: 'Header\n\nPick Redis.' }),
    ]
    expect(repeatedIds(mails).size).toBe(0)
  })

  it('does not fold a comment from another thread', () => {
    const mails = [
      mail('c1', { thread_id: 't2', body: 'Pick Redis.' }),
      mail('ask1', { kind: 'ask', reply_to: 'c1', body: 'Header\n\nPick Redis.' }),
    ]
    expect(repeatedIds(mails).size).toBe(0)
  })

  it('does not fold a comment the ask body does not carry', () => {
    const mails = [
      mail('c1', { body: 'Pick Redis.' }),
      mail('ask1', { kind: 'ask', reply_to: 'c1', body: 'Header\n\nSomething else.' }),
    ]
    expect(repeatedIds(mails).size).toBe(0)
  })
})

describe('withdrawnFor', () => {
  const gone = { id: 'human', read_at: '2026-10-13T08:05:00Z', withdrawn_at: '2026-10-13T08:05:00Z', withdrawn_by: 'p1', withdrawn_note: 'Answered by @pa: approved' }

  it('finds the human\'s withdrawn copy, and nothing for an ordinary or unread one', () => {
    expect(withdrawnFor(mail('m1', { recipients: [{ id: 'a2' }, gone] }))?.withdrawn_note).toBe('Answered by @pa: approved')
    expect(withdrawnFor(mail('m2', { recipients: [{ id: 'human', read_at: null }] }))).toBeUndefined()
    expect(withdrawnFor(mail('m3', { recipients: [{ id: 'a2', withdrawn_at: '2026-10-13T08:05:00Z' }] }))).toBeUndefined()
  })

  it('counts in no unread count: the copy is read', () => {
    const t = { thread_id: 't1', mails: [mail('m1', { recipients: [gone] })] }
    expect(isUnreadForHuman(t as never)).toBe(false)
  })
})

describe('between', () => {
  it('marks mail the human neither sent nor received, and counts it in no unread count', () => {
    expect(between(mail('m1', { recipients: [{ id: 'a2' }] }))).toBe(true)
    expect(between(mail('m2', { recipients: [{ id: 'a2' }, { id: 'human', read_at: null }] }))).toBe(false)
    expect(between(mail('m3', { from_id: 'human', recipients: [{ id: 'a2' }] }))).toBe(false)
    expect(between(mail('m4', { recipients: [] }))).toBe(false)
    const t = { thread_id: 't1', mails: [mail('m5', { recipients: [{ id: 'a2', read_at: null }] })] }
    expect(isUnreadForHuman(t as never)).toBe(false)
  })
})
