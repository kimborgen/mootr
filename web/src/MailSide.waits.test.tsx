// @vitest-environment jsdom
// A reply wait tied to an inbox thread marks that thread's row, "waiting on you" counts the rows,
// an unresolved thread id opens the agent, and closing a deferred thread opens the next deferred one.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act, createRef } from 'react'

// jsdom has no matchMedia; the shell asks whether it is a phone.
vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
vi.mock('./api', () => ({ api: vi.fn(async () => ({})), hash: new URLSearchParams() }))

const mail = (id: string, tid: string, created_at: string) => ({ id, thread_id: tid, from_id: 'a1', from_name: 'bob', subject: 'Subject ' + tid, created_at, recipients: [{ id: 'human', read_at: created_at }] })
const thread = (tid: string, created_at = '2026-10-13T10:00:00Z') => ({ thread_id: tid, mails: [mail('m-' + tid, tid, created_at)] })
const wait = (id: string, thread: string | null) => ({ id, kind: 'human', target: null, thread, detail: 'Your answer', since: '2026-10-13T11:00:00Z', source: 'wait_for' })
const agent = (waits: unknown[]) => ({ id: 'a1', name: 'bob', waits })
const base = { humanArchived: [], humanDeferred: [], attention: [], decisions: [], perms: [], delegateDialogs: [], itsaStatuses: [] }

const pthread = { thread_id: 'tp', mails: [{ ...mail('m-tp', 'tp', '2026-10-13T10:00:00Z'), permission_id: 'p1', permission: { status: 'pending' } }] }
const perm = { id: 'p1', agent_id: 'a1', status: 'pending', created_at: '2026-10-13T10:00:00Z', action: 'run x' }

describe('MailSide waiting rows', () => {
  beforeEach(() => { ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true })

  it('marks a thread row tied to a wait, and counts only the rows', async () => {
    const store = await import('./store')
    const { MailSide } = await import('./MailSide')
    store.setData({ ...base, humanThreads: [thread('t1'), thread('t2')], agents: [agent([wait('w1', 't1'), wait('w2', null)])] } as never)
    const el = document.createElement('div')
    document.body.append(el)
    await act(async () => { createRoot(el).render(<MailSide leftRef={createRef()} />) })
    const row = el.querySelector<HTMLElement>('[data-thread="t1"]')!
    expect(row.classList.contains('ask')).toBe(true)
    expect(row.title).toContain('Waits for your reply')
    expect(el.querySelector<HTMLButtonElement>('[data-arch="t1"]')!.disabled).toBe(true)
    expect(el.querySelector<HTMLElement>('[data-thread="t2"]')!.classList.contains('ask')).toBe(false)
    // The plain wait (w2) has no row in the inbox, so it isn't counted.
    expect(el.querySelector('.count .asks')!.textContent).toBe('1 waiting on you')
  })

  it('opens the agent when the wait names a thread the human does not hold', async () => {
    const store = await import('./store')
    const { waitingRows } = await import('./itsa/WaitingList')
    const world = await import('./shell/layout')
    store.setData({ ...base, humanThreads: [thread('t1')], agents: [agent([wait('w1', 'raw-mail-id')])] } as never)
    const d = store.getData()
    waitingRows(d).find((r) => r.key === 'w:w1')!.open()
    expect(world.currentWorld()).toBe('a1')
    store.setData({ agents: [agent([wait('w3', 't1')])] } as never)
    waitingRows(store.getData()).find((r) => r.key === 'w:w3')!.open()
    expect(world.currentWorld()).toBe('t:t1')
  })

  it('opens the next deferred thread when one is closed from the Deferred list', async () => {
    const store = await import('./store')
    const actions = await import('./actions')
    const world = await import('./shell/layout')
    store.setData({ ...base, humanThreads: [thread('i1')], humanDeferred: [thread('d1'), thread('d2')], agents: [] } as never)
    actions.selectThread('d1')
    await act(async () => { await actions.archiveThreadAndAdvance('d1') })
    expect(world.currentWorld()).toBe('t:d2')
  })

  it('counts a pending request thread that has no wait row, as the list shows it', async () => {
    const store = await import('./store')
    const { MailSide } = await import('./MailSide')
    store.setData({ ...base, humanThreads: [pthread, thread('t2')], perms: [perm], agents: [] } as never)
    const el = document.createElement('div')
    document.body.append(el)
    await act(async () => { createRoot(el).render(<MailSide leftRef={createRef()} />) })
    expect(el.querySelectorAll('.mail-side-list .mrow.ask').length).toBe(1)
    expect(el.querySelector('.count .asks')!.textContent).toBe('1 waiting on you')
  })
})
