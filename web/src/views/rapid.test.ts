// Rapid-fire mode (S-1004): which threads show, where a send goes as cards are picked and
// unpicked, and the mail each send posts.
import { beforeEach, describe, expect, it, vi } from 'vitest'
const posted = vi.hoisted(() => [] as { method: string; path: string; body: Record<string, unknown> }[])
vi.mock('../api', async (orig) => ({
  ...(await orig<typeof import('../api')>()),
  api: vi.fn(async (method: string, path: string, body?: Record<string, unknown>) => { posted.push({ method, path, body: body ?? {} }); return method === 'GET' ? [] : {} }),
}))
import { humanRowsOf } from '../mail/thread-index'
import { getUi } from '../ui/state'
import type { Agent, Mail, Thread } from '../types'
import { getPick, isRapid, pickOf, rapidKey, rapidTarget, rapidThreads, sendRapid, setPick, setRapid } from './rapid'

const at = (min: number) => new Date(Date.UTC(2026, 9, 15, 12, min)).toISOString()
const m = (id: string, tid: string, from: string, to: string[], min: number, subject = 'Idea ' + id): Mail =>
  ({ id, thread_id: tid, from_id: from, subject, body: subject + ' body', created_at: at(min), recipients: to.map((r) => ({ id: r, read_at: null })) })
const T = (tid: string, mails: Mail[]): Thread => ({ thread_id: tid, mails })
const DEV = { id: 'dev', name: 'fixture-dev' } as Agent

// Two ideas you fired at dev (the second answered, the first started later than it), one thread
// dev started with you, and threads with someone else only.
const fired = T('t1', [m('a1', 't1', 'human', ['dev'], 20)])
const answered = T('t2', [m('b1', 't2', 'human', ['dev'], 10), m('b2', 't2', 'dev', ['human'], 30)])
const fromDev = T('t3', [m('c1', 't3', 'dev', ['human'], 25)])
const other = T('t4', [m('d1', 't4', 'human', ['ops'], 5)])
const cc = T('t5', [m('e1', 't5', 'dev', ['ops'], 1)])
// Each agent's pages from the inbox, archive and deferred list (`with=`); a thread can be on two of them.
const pages = { threads: [fired, other, cc, answered, fromDev, fired], more: false }
const data = { rapidWith: { dev: pages, ops: pages } }

beforeEach(() => { posted.length = 0; setPick('dev', null); setRapid('dev', false) })

describe('rapidThreads', () => {
  it('lists every thread between you and the agent once, in inbox, archived, and deferred, oldest first by start', () => {
    expect(rapidThreads('dev', data).map((t) => t.thread_id)).toEqual(['t2', 't1', 't3'])
  })
  it('leaves out threads with others only', () => {
    expect(rapidThreads('ops', data).map((t) => t.thread_id)).toEqual(['t4'])
  })
})

describe('rapidThreads from the agent\'s own pages (S-1121, S-4580)', () => {
  const old = [answered, fromDev]
  it('lists the agent\'s threads from its with= pages, and none before they load', () => {
    expect(rapidThreads('dev', {})).toEqual([])
    expect(rapidThreads('dev', { rapidWith: { dev: { threads: old, more: false } } }).map((t) => t.thread_id)).toEqual(['t2', 't3'])
  })
  it('never reads the human\'s lists, which hold index rows', () => {
    const d = { humanRows: humanRowsOf([fired]), rapidWith: { dev: { threads: old, more: true } } }
    expect(rapidThreads('dev', d).map((t) => t.thread_id)).toEqual(['t2', 't3'])
  })
})

describe('the send target', () => {
  const threads = rapidThreads('dev', data)
  it('is a new thread to the agent while nothing is picked', () => {
    expect(rapidTarget('dev', null, threads)).toEqual({ kind: 'new', to: ['dev'] })
  })
  it('is a follow-up in the picked thread, at its latest mail, to those who wrote in it', () => {
    const p = pickOf(answered, 'dev')
    expect(p.text).toBe('Idea b1 body')
    expect(rapidTarget('dev', p, threads)).toEqual({ kind: 'reply', thread_id: 't2', reply_to: 'b2', to: ['dev'] })
  })
  it('follows the thread as it grows, and keeps to it after it leaves the list', () => {
    const p = pickOf(fired, 'dev')
    const grown = T('t1', [...fired.mails, m('a2', 't1', 'dev', ['human'], 40)])
    expect(rapidTarget('dev', p, [grown])).toMatchObject({ kind: 'reply', reply_to: 'a2' })
    expect(rapidTarget('dev', p, [])).toMatchObject({ kind: 'reply', thread_id: 't1', reply_to: 'a1' })
  })
})

describe('recipients of a follow-up (review of #356)', () => {
  // You asked dev and ops; only ops answered.
  const both = T('t6', [m('f1', 't6', 'human', ['dev', 'ops'], 50), m('f2', 't6', 'ops', ['human'], 51)])
  it('always include this view\'s agent, even when only another agent answered', () => {
    expect(pickOf(both, 'dev').to.sort()).toEqual(['dev', 'ops'])
    expect(rapidTarget('dev', pickOf(both, 'dev'), [both]).to.sort()).toEqual(['dev', 'ops'])
  })
  it('follow the thread as it is at the send, not as it was at the pick', () => {
    const p = pickOf(fired, 'dev')
    expect(p.to).toEqual(['dev'])
    const joined = T('t1', [...fired.mails, m('a3', 't1', 'review', ['human'], 41)])
    expect(rapidTarget('dev', p, [joined])).toMatchObject({ reply_to: 'a3' })
    expect(rapidTarget('dev', p, [joined]).to.sort()).toEqual(['dev', 'review'])
  })
})

describe('keys (review of #356)', () => {
  const o = { id: 'dev', active: 'view:dev', picked: true, emptyBox: true, cards: 3 }
  it('Esc unpicks, and ↑ in an empty prompt input picks the newest, in the active rapid-fire view', () => {
    expect(rapidKey('Escape', o)).toBe('unpick')
    expect(rapidKey('ArrowUp', { ...o, picked: false })).toBe('pick-newest')
  })
  it('do nothing in a rapid-fire view that is not the active tab', () => {
    expect(rapidKey('Escape', { ...o, active: 'view:ops' })).toBeNull()
    expect(rapidKey('ArrowUp', { ...o, picked: false, active: 'agent:dev' })).toBeNull()
  })
  it('↑ needs an empty prompt input, no pick, and a card', () => {
    expect(rapidKey('ArrowUp', { ...o, picked: false, emptyBox: false })).toBeNull()
    expect(rapidKey('ArrowUp', o)).toBeNull()
    expect(rapidKey('ArrowUp', { ...o, picked: false, cards: 0 })).toBeNull()
    expect(rapidKey('Escape', { ...o, picked: false })).toBeNull()
  })
})

describe('mode and pick', () => {
  it('remembers the mode per agent on this device, and leaving it unpicks', () => {
    setRapid('dev', true)
    expect(isRapid('dev')).toBe(true)
    expect(isRapid('ops')).toBe(false)
    expect(getUi().rapid).toMatchObject({ dev: true })
    expect(JSON.parse(localStorage.getItem('stam/ui')!).rapid).toMatchObject({ dev: true })
    setPick('dev', pickOf(fired, 'dev'))
    setRapid('dev', false)
    expect(getPick('dev')).toBeNull()
  })
  it('a pick lasts through sends until unpicked', async () => {
    setRapid('dev', true)
    setPick('dev', pickOf(answered, 'dev'))
    for (const text of ['one', 'two']) await sendRapid(DEV, rapidTarget('dev', getPick('dev'), [answered]), { text, files: [] })
    expect(getPick('dev')?.thread_id).toBe('t2')
    setPick('dev', null)
    await sendRapid(DEV, rapidTarget('dev', getPick('dev'), [answered]), { text: 'three', files: [] })
    const mails = posted.filter((p) => p.path === '/api/mail').map((p) => p.body)
    expect(mails).toMatchObject([
      { from: 'human', to: ['dev'], reply_to: 'b2', body: 'one' },
      { from: 'human', to: ['dev'], reply_to: 'b2', body: 'two' },
      { from: 'human', to: ['dev'], new_thread: true, subject: 'three', body: 'three' },
    ])
    expect(mails[0]).not.toHaveProperty('new_thread')
    expect(mails[2]).not.toHaveProperty('reply_to')
  })
})
