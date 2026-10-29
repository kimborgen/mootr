// The one list of what waits on the human (`waitingRows`, behind `useWaiting`): each thing
// shows once, so every count of it agrees. An agent's wait for your reply folds into the row
// of the ask its thread is (S-351): an ITSA's ask thread, or a pending permission request's;
// an untied wait, or one in another thread, keeps its own row; a closed ITSA never counts. An
// agent's decision mail is its thread's row (S-352), unless an ask or a request already has it.
// A deferred ask or decision (S-353) leaves the rows and their count; deferredRows lists it instead.
import { beforeAll, describe, expect, it } from 'vitest'
import { setData } from '../store'
import { deferredRows, isPlainWait, waitingRows } from './WaitingList'
import type { Agent, DecisionMail, ItsaAttention, Permission, Wait } from '../types'

const itsa = (id: string, owner: string, status = 'needs_input', since = '2026-10-13T10:00:00Z') => ({
  id, key: `S-${id}`, parent_id: null, kind: null, title: `Item ${id}`, summary: null, body: null, status, owner, thread_id: `t-${id}`,
  created_by: owner, created_at: since, updated_at: since, closed_at: null, since, actions: [], ask_thread_id: `t-${id}`, ask_mail_id: `m-${id}`,
}) as unknown as ItsaAttention
const wait = (id: string, target: string | null = null, thread: string | null = null): Wait => ({ id, kind: 'human', target, thread, detail: 'Your answer', since: '2026-10-13T11:00:00Z', source: 'wait_for' })
const agent = (id: string, waits: Wait[]) => ({ id, name: id, waits }) as unknown as Agent
const perm = (id: string, agentId: string) => ({ id, agent_id: agentId, action: 'Push the branch', reason: '', status: 'pending', created_at: '2026-10-13T12:00:00Z' }) as unknown as Permission

describe('waitingRows', () => {
  beforeAll(() => setData({ itsaStatuses: [{ name: 'needs_input', category: 'active', human: true }, { name: 'done', category: 'closed', human: false }] }))

  it("folds an agent's reply wait tied to an ITSA's ask thread into that ITSA's row", () => {
    const rows = waitingRows({ attention: [itsa('1', 'a1')], agents: [agent('a2', [wait('w1', null, 't-1')])], perms: [], decisions: [] })
    expect(rows.map((r) => r.key)).toEqual(['i:1'])
  })

  it('marks only an untied wait as plain; an ask or a request row opens its mail, not the chat (S-984)', () => {
    const rows = waitingRows({ attention: [itsa('1', 'a1')], agents: [agent('a1', [wait('w1')]), agent('a2', [])], perms: [perm('p1', 'a2')], decisions: [] })
    expect(rows.filter(isPlainWait).map((r) => r.key)).toEqual(['w:w1'])
  })

  it('does not mark a wait tied to a mail thread as plain; its row opens that thread (S-984)', () => {
    const rows = waitingRows({ attention: [], agents: [agent('a1', [wait('w1', null, 't-mail'), wait('w2')])], perms: [], decisions: [] })
    expect(rows.filter(isPlainWait).map((r) => r.key)).toEqual(['w:w2'])
    expect(rows.find((r) => r.key === 'w:w1')?.threadId).toBe('t-mail')
  })

  it('keeps an untied wait as its own row, even from the agent that owns the ITSA', () => {
    const rows = waitingRows({ attention: [itsa('1', 'a1')], agents: [agent('a1', [wait('w1')])], perms: [], decisions: [] })
    expect(rows.map((r) => r.key)).toEqual(['i:1', 'w:w1'])
  })

  it("keeps a wait in another thread as its own row, even from the ITSA's owner", () => {
    const rows = waitingRows({ attention: [itsa('1', 'a1')], agents: [agent('a1', [wait('w1', null, 't-other')])], perms: [], decisions: [] })
    expect(rows.map((r) => r.key)).toEqual(['i:1', 'w:w1'])
  })

  it("folds a reply wait tied to a pending permission request's thread into that request's row", () => {
    const p = perm('p1', 'a2')
    // The request's thread is the one its mail is in (store.permThread).
    setData({ humanThreads: [{ thread_id: 'tp1', mails: [{ permission_id: 'p1' }] }] } as unknown as Parameters<typeof setData>[0])
    const rows = waitingRows({ attention: [], agents: [agent('a2', [wait('w1', null, 'tp1')])], perms: [p], decisions: [] })
    expect(rows.map((r) => r.key)).toEqual(['p:p1'])
  })

  it("keeps a permission request's row, even from an agent whose ITSA waits on you", () => {
    const p = perm('p1', 'a1')
    const rows = waitingRows({ attention: [itsa('1', 'a1')], agents: [agent('a1', [wait('w1', 'p1')])], perms: [p], decisions: [] })
    expect(rows.map((r) => r.key)).toEqual(['i:1', 'w:w1'])
  })

  it('never counts a closed ITSA, and then keeps the wait', () => {
    const rows = waitingRows({ attention: [itsa('1', 'a1', 'done')], agents: [agent('a1', [wait('w1')])], perms: [], decisions: [] })
    expect(rows.map((r) => r.key)).toEqual(['w:w1'])
  })

  it("shows an agent's decision mail as one row of its thread, the latest when a thread has several", () => {
    const rows = waitingRows({ attention: [], agents: [], perms: [], decisions: [dec('m1', 't1', '10:00'), dec('m2', 't1', '11:00'), dec('m3', 't2', '09:00')] })
    expect(rows.map((r) => r.key)).toEqual(['d:m3', 'd:m2'])
    expect(rows.map((r) => r.threadId)).toEqual(['t2', 't1'])
    expect(rows[1]).toMatchObject({ who: 'alice', what: 'Pick one', icon: 'mail', since: '2026-10-13T11:00:00Z' })
  })

  it('shows no decision row for a thread that is already an ask row or a request row', () => {
    // The request's thread is the one its mail is in (store.permThread).
    setData({ humanThreads: [{ thread_id: 'tp1', mails: [{ permission_id: 'p1' }] }] } as unknown as Parameters<typeof setData>[0])
    const rows = waitingRows({ attention: [itsa('1', 'a1')], agents: [], perms: [perm('p1', 'a2')], decisions: [dec('m1', 't-1', '10:00'), dec('m2', 'tp1', '10:00')] })
    expect(rows.map((r) => r.key)).toEqual(['i:1', 'p:p1'])
  })

  it("keeps another agent's decision and reply wait as rows in a thread that holds a placed ask (S-3827)", () => {
    // The request's mail joined thread th1, which another agent's mail started: the ask doesn't stand for that thread.
    setData({ humanThreads: [{ thread_id: 'th1', mails: [{ id: 'th1' }, { id: 'mp', thread_id: 'th1', permission_id: 'p1' }] }] } as unknown as Parameters<typeof setData>[0])
    const rows = waitingRows({ attention: [], agents: [agent('a3', [wait('w1', null, 'th1')])], perms: [perm('p1', 'a2')], decisions: [dec('m2', 'th1', '10:00')] })
    expect(rows.map((r) => r.key).sort()).toEqual(['d:m2', 'p:p1'])
  })

  it("folds an agent's reply wait tied to a decision mail's thread into that row", () => {
    const rows = waitingRows({ attention: [], agents: [agent('a2', [wait('w1', null, 't1')])], perms: [], decisions: [dec('m1', 't1', '10:00')] })
    expect(rows.map((r) => r.key)).toEqual(['d:m1'])
  })

  // S-609: the human answered p30282c and p47654e, and the agent's own waits about them still counted.
  it("shows a request once: stam's wait for it and the agent's wait_for tied to it are one row", () => {
    const stamWait = { ...wait('w1', 'p000001'), detail: 'your approval', source: 'stam' }
    const own = { ...wait('w2', 'p000001'), detail: 'merge authorization for PR #129 (p000001)', source: 'declared' }
    const rows = waitingRows({ attention: [], agents: [agent('a2', [stamWait, own])], perms: [perm('p000001', 'a2')], decisions: [] })
    expect(rows.map((r) => r.key)).toEqual(['w:w1'])
  })

  it("never counts an agent's wait_for tied to a request that is no longer pending", () => {
    const own = { ...wait('w2', 'p30282c'), detail: 'answer to p30282c (commit of allow rules)', source: 'declared' }
    const untied = { ...wait('w3'), source: 'declared' }
    const rows = waitingRows({ attention: [], agents: [agent('a2', [own, untied])], perms: [], decisions: [] })
    expect(rows.map((r) => r.key)).toEqual(['w:w3'])
  })
})

describe('deferred rows', () => {
  beforeAll(() => setData({ itsaStatuses: [{ name: 'needs_input', category: 'active', human: true }] }))

  it('leaves a deferred ask out of the rows and lists it under deferredRows', () => {
    const data = { attention: [{ ...itsa('1', 'a1'), deferred: true }, itsa('2', 'a2')], agents: [], perms: [], decisions: [] }
    expect(waitingRows(data).map((r) => r.key)).toEqual(['i:2'])
    expect(deferredRows(data).map((r) => r.key)).toEqual(['i:1'])
    expect(deferredRows(data)[0].deferred).toBe(true)
  })

  it("folds an agent's wait into a deferred ask's row, so it leaves the count too", () => {
    const data = { attention: [{ ...itsa('1', 'a1'), deferred: true }], agents: [agent('a2', [wait('w1', null, 't-1')])], perms: [], decisions: [] }
    expect(waitingRows(data)).toEqual([])
    expect(deferredRows(data).map((r) => r.key)).toEqual(['i:1'])
  })

  it('leaves a deferred decision mail out of the rows and lists it under deferredRows', () => {
    const data = { attention: [], agents: [], perms: [], decisions: [{ ...dec('m1', 't1', '10:00'), deferred: true }, dec('m2', 't2', '11:00')] }
    expect(waitingRows(data).map((r) => r.key)).toEqual(['d:m2'])
    expect(deferredRows(data).map((r) => r.key)).toEqual(['d:m1'])
  })

  it('leaves a plain agent wait in its own row, deferred or not', () => {
    const data = { attention: [], agents: [agent('a2', [wait('w1', null, 't9')])], perms: [], decisions: [] }
    expect(waitingRows(data).map((r) => r.key)).toEqual(['w:w1'])
    expect(deferredRows(data)).toEqual([])
  })
})

const dec = (mailId: string, thread: string, time: string): DecisionMail => ({
  mail_id: mailId, thread_id: thread, from_id: 'a2', from_name: 'alice', subject: 'Pick one', created_at: `2026-10-13T${time}:00Z`,
})

describe('a thread set aside with Defer (S-1068)', () => {
  it('moves its ask, decision and permission request from the waiting rows to the deferred rows', () => {
    setData({ humanThreads: [], humanDeferred: [{ thread_id: 'tp1', mails: [{ permission_id: 'p1' }] }] } as unknown as Parameters<typeof setData>[0])
    const decision = { mail_id: 'm-d', thread_id: 't-d', from_id: 'a1', from_name: 'a1', subject: 'Pick', created_at: '2026-10-13T10:00:00Z', deferred: false } as unknown as DecisionMail
    const data = { attention: [itsa('1', 'a1')], agents: [], perms: [perm('p1', 'a2')], decisions: [decision], humanDeferred: [{ thread_id: 't-1' }, { thread_id: 't-d' }, { thread_id: 'tp1' }] } as unknown as Parameters<typeof waitingRows>[0]
    expect(waitingRows(data).map((r) => r.key)).toEqual([])
    expect(deferredRows(data).map((r) => r.key).sort()).toEqual(['d:m-d', 'i:1', 'p:p1'])
  })
})
