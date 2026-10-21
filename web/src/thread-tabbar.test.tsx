// @vitest-environment jsdom
// The thread tab bar's Defer and Archive icons (S-2286): on a desktop they keep today's texts with the
// key added, Archive is disabled while something waits on the human (also for a thread past the
// list's 60), and a click does what the header button did: it opens the next mail.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'

vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
const api = vi.fn(async () => ({}))
vi.mock('./api', () => ({ api: (...a: unknown[]) => (api as (...b: unknown[]) => unknown)(...a), hash: new URLSearchParams() }))
// The world the tests set; otherwise the layout's own.
let world: string | null = null
vi.mock('./shell/layout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./shell/layout')>()
  return { ...actual, currentWorld: () => world ?? actual.currentWorld() }
})

const mail = (id: string, tid: string, permission?: { status: string }) => ({ id, thread_id: tid, from_id: 'a1', from_name: 'bob', subject: 'Subject ' + tid, created_at: '2026-10-13T10:00:00Z', recipients: [{ id: 'human', read_at: '2026-10-13T10:00:00Z' }], permission })
const thread = (tid: string, permission?: { status: string }) => ({ thread_id: tid, mails: [mail('m-' + tid, tid, permission)] })
const statuses = [{ name: 'needs_input', category: 'active', human: true }, { name: 'done', category: 'closed', human: false }]
const waiting = (askThread: string) => ({ id: 'i1', key: 'S-1', status: 'needs_input', ask_thread_id: askThread, since: '2026-10-13T10:00:00Z', actions: [] })
const base = { humanThreads: [], humanArchived: [], humanDeferred: [], openThreads: [], attention: [], decisions: [], perms: [], delegateDialogs: [], agents: [], itsaStatuses: statuses }
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

describe('the thread tab bar icons', () => {
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.resetModules(); api.mockClear(); world = null
    document.body.innerHTML = ''
  })

  async function render(node: (m: typeof import('./views/ThreadView')) => React.ReactNode) {
    const m = await import('./views/ThreadView')
    const el = document.createElement('div')
    document.body.append(el)
    await act(async () => { createRoot(el).render(node(m)) })
    return el
  }

  it('keeps the texts, adds the key, and disables Archive while a permission waits', async () => {
    const store = await import('./store')
    store.setData({ ...base, humanThreads: [thread('t1', { status: 'pending' })] } as never)
    const el = await render((m) => <m.ThreadArchive tid="t1" desktop />)
    const defer = el.querySelector<HTMLButtonElement>('[data-defer]')!
    const archive = el.querySelector<HTMLButtonElement>('[data-archive]')!
    expect(defer.title).toBe('Save this thread for later; it stays under To answer (d)')
    expect(defer.getAttribute('aria-label')).toBe('Defer (d)')
    expect(archive.disabled).toBe(true)
    expect(archive.title).toBe('Answer the permission request first')
  })

  it('names what waits on the human as the reason Archive is disabled, on the desktop only', async () => {
    const store = await import('./store')
    store.setData({ ...base, humanThreads: [thread('ask')], attention: [waiting('ask')] } as never)
    const desk = await render((m) => <m.ThreadArchive tid="ask" desktop />)
    expect(desk.querySelector<HTMLButtonElement>('[data-archive]')!.title).toBe('Answer what waits on you first')
    expect(desk.querySelector<HTMLButtonElement>('[data-archive]')!.disabled).toBe(true)
    // The phone's Archive is unchanged: an ask holds only a pending permission.
    const phone = await render((m) => <m.ThreadArchive tid="ask" />)
    expect(phone.querySelector<HTMLButtonElement>('[data-archive]')!.disabled).toBe(false)
    expect(phone.querySelector<HTMLButtonElement>('[data-archive]')!.title).toBe('Hide this thread from your mail')
  })

  it('keeps a pending permission past the list of 60 held, in the thread the view loaded', async () => {
    const store = await import('./store')
    const actions = await import('./actions')
    store.setData({ ...base, humanThreads: [], openThreads: [thread('old', { status: 'pending' })] } as never)
    const el = await render((m) => <m.ThreadArchive tid="old" desktop />)
    expect(el.querySelector<HTMLButtonElement>('[data-archive]')!.disabled).toBe(true)
    await actions.toggleThreadArchived('old')
    expect(api.mock.calls.some((c) => JSON.stringify(c).includes('old/archive'))).toBe(false)
  })

  it('shows the deferred and archived icons with their undo texts and keys', async () => {
    const store = await import('./store')
    store.setData({ ...base, humanDeferred: [thread('d1')], humanArchived: [thread('a1')] } as never)
    const el = await render((m) => <><m.ThreadArchive tid="d1" desktop /><m.ThreadArchive tid="a1" desktop /></>)
    expect(el.querySelector<HTMLButtonElement>('[data-defer]')!.getAttribute('aria-label')).toBe('Undefer (d)')
    expect(el.querySelector<HTMLButtonElement>('[data-defer]')!.title).toBe('Move this thread back to your mail (d)')
    const arch = el.querySelectorAll<HTMLButtonElement>('[data-archive]')[1]
    expect(arch.title).toBe('Move this thread back to your mail (e)')
    expect(arch.getAttribute('aria-label')).toBe('Unarchive (e)')
  })

  it('opens the next mail in the Inbox page when its archive icon is clicked', async () => {
    const store = await import('./store')
    const shell = await import('./shell/layout')
    store.setData({ ...base, humanThreads: [thread('t1'), thread('t2')] } as never)
    shell.init({ valid: () => true, keep: () => true, keepWorld: () => true })
    shell.open('main', 'inbox')
    shell.open('main', 'thread:t1', { split: 'right' })
    world = 'w:inbox'
    const el = await render((m) => <m.ThreadArchive tid="t1" desktop />)
    await act(async () => { el.querySelector<HTMLButtonElement>('[data-archive]')!.click() })
    await settle()
    expect(api.mock.calls.some((c) => JSON.stringify(c).includes('t1/archive'))).toBe(true)
    const actions = await import('./actions')
    expect(actions.inboxThread()).toBe('t2')
  })

  it('opens the next mail elsewhere when its defer icon is clicked, as the header did', async () => {
    const store = await import('./store')
    const shell = await import('./shell/layout')
    store.setData({ ...base, humanThreads: [thread('t1'), thread('t2')] } as never)
    shell.init({ valid: () => true, keep: () => true, keepWorld: () => true })
    shell.showAgentWorld('t:t1')
    const el = await render((m) => <m.ThreadArchive tid="t1" desktop />)
    await act(async () => { el.querySelector<HTMLButtonElement>('[data-defer]')!.click() })
    await settle()
    expect(api.mock.calls.some((c) => JSON.stringify(c).includes('t1/defer'))).toBe(true)
    expect(shell.currentWorld()).toBe('t:t2')
  })
})
