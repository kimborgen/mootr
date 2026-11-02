// @vitest-environment jsdom
// The unread hold (S-4740) with the Inbox page and the Mail sidebar mounted together and a thread open in the page's
// pane: reading the open thread moves no row in either list, and both sort by what is unread once none is open.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createRef } from 'react'
import { humanRowsOf } from './thread-index'
import { resetHeldUnread } from './hold'

vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
const state = { open: null as string | null }
vi.mock('../api', () => ({ api: vi.fn(async () => []), hash: new URLSearchParams() }))
vi.mock('../actions', async (orig) => ({ ...(await orig<object>()), inboxThread: () => state.open, threadIsOpen: () => state.open !== null }))
vi.mock('../shell/layout', async (orig) => ({ ...(await orig<object>()), currentWorld: () => 'w:inbox', isPhone: () => false }))

const thread = (id: string, at: string, unread: boolean) => ({ thread_id: id, mails: [{ id: 'm-' + id, thread_id: id, from_id: 'a1', from_name: 'dev', subject: 'S ' + id, created_at: at, recipients: [{ id: 'human', read_at: unread ? null : at }], body: 'b' }] })
const roots: Root[] = []
afterEach(() => { for (const r of roots.splice(0)) act(() => r.unmount()) })

describe('the unread hold, Inbox page and sidebar together', () => {
  it('keeps the read thread in place while it is open, in both lists, then lets it fall', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    resetHeldUnread()
    const store = await import('../store')
    const { InboxView } = await import('./InboxView')
    const { MailSide } = await import('../MailSide')
    const today = new Date(); today.setHours(9, 0, 0, 0)
    const t = (h: number) => new Date(today.getTime() + h * 36e5).toISOString()
    const rows = (aUnread: boolean) => humanRowsOf([thread('R', t(3), false), thread('A', t(2), aUnread), thread('B', t(1), true)] as never)
    store.setData({ loaded: { agents: true, mail: true, itsas: true }, error: null, agents: [], perms: [], itsas: [], itsaStatuses: [], decisions: [], attention: [], delegateDialogs: [], humanRows: rows(true) } as never)
    const page = document.createElement('div'), side = document.createElement('div')
    document.body.append(page, side)
    for (const [el, node] of [[page, <InboxView />], [side, <MailSide leftRef={createRef()} />]] as const) {
      const root = createRoot(el); roots.push(root)
      await act(async () => { root.render(node) })
    }
    const order = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-thread]')].map((r) => r.dataset.thread)
    expect(order(page)).toEqual(['A', 'B', 'R'])
    expect(order(side)).toEqual(['A', 'B', 'R'])
    // A is opened in the page's pane and read.
    state.open = 'A'
    await act(async () => { store.setData({ humanRows: rows(false) } as never) })
    expect(order(page)).toEqual(['A', 'B', 'R'])
    expect(order(side)).toEqual(['A', 'B', 'R'])
    // Nothing is open: both sort by what is unread.
    state.open = null
    await act(async () => { store.setData({ humanRows: rows(false), mailTick: store.getData().mailTick + 1 } as never) })
    expect(order(page)).toEqual(['B', 'R', 'A'])
    expect(order(side)).toEqual(['B', 'R', 'A'])
  })
})
