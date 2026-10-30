// @vitest-environment jsdom
// The Inbox page and the sidebar's Mail list draw from index rows alone (S-4578): rows as the thread index route
// answers them, with no whole thread in the store, show their subject, title, count, age, unread dot, card text and
// ITSA chip; a route row without the card fields shows its snippet and last sender.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createRef } from 'react'
import type { IndexRow, ThreadList } from '../types'
import { humanRowsOf } from './thread-index'

vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
vi.mock('../api', () => ({ api: vi.fn(async () => []), hash: new URLSearchParams() }))
vi.mock('../shell/layout', async (orig) => ({ ...(await orig<object>()), currentWorld: () => 'w:inbox', isPhone: () => false }))
// The lists the route would answer, in place of rows built from the store's whole threads.
const route: Record<ThreadList, IndexRow[]> = { active: [], archived: [], deferred: [] }
vi.mock('../store', async (orig) => ({ ...(await orig<object>()), humanIndex: (_d: unknown, list: ThreadList) => route[list] }))

const now = Date.now()
const iso = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString()
const row = (id: string, patch: Partial<IndexRow> = {}): IndexRow => ({
  thread_id: id, subject: 'Subject ' + id, title: null, kind: null, itsa_id: null, from_id: 'a1', from_name: 'fixture-dev',
  last_at: iso(5), mail_count: 1, unread: 0, ask: null, snippet: 'Snippet of ' + id, ...patch,
})
// The card fields the route adds (stam/mail-index-card).
const card = (patch: Partial<IndexRow> = {}): Partial<IndexRow> => ({
  card_from_id: 'a2', card_from_name: 'fixture-review', card_text: 'First line of the card.\nSecond line.', card_title: null, verdict_kind: null,
  about_itsa: null, itsa_chip: { key: 'S-77', title: 'Index rows' }, box_last_from: 'a2', first_created_at: iso(60), last_created_at: iso(2), ...patch,
})

const roots: Root[] = []
afterEach(() => { for (const r of roots.splice(0)) act(() => r.unmount()) })
beforeEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const store = await import('../store')
  store.setData({
    loaded: { agents: true, mail: true, itsas: true }, error: null, agents: [], perms: [], itsas: [], itsaStatuses: [], decisions: [], attention: [],
    delegateDialogs: [], asks: [], humanRows: humanRowsOf(),
  } as never)
})
async function render(node: React.ReactNode) {
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  roots.push(root)
  await act(async () => { root.render(node) })
  return el
}

describe('the Inbox page from index rows', () => {
  it('draws each row from its index row, the card fields included', async () => {
    route.active = [
      row('c1', { unread: 2, mail_count: 3, ...card() }),
      // A route without the card fields: the snippet and the last sender stand in.
      row('r1', { last_at: iso(30) }),
      // A later mail with no text of its own speaks by its own subject, not the thread's first (S-4579).
      row('e1', { subject: 'Deploy plan', last_at: iso(40), ...card({ card_text: '', card_subject: 'Re: Deployment canceled' }) }),
    ]
    route.archived = [row('ar', { from_id: 'human' })]
    const { InboxView } = await import('./InboxView')
    const el = await render(<InboxView />)
    const c1 = el.querySelector<HTMLElement>('[data-thread="c1"]')!
    expect(c1.querySelector('.s')!.textContent).toBe('Subject c1')
    expect(c1.querySelector('.ir-sum')!.textContent).toBe('First line of the card.')
    expect(c1.querySelector('[data-chip="itsa"]')!.textContent).toBe('S-77')
    expect(c1.querySelector('.badge.n')!.textContent).toBe('3')
    expect(c1.querySelector('.dot')).not.toBeNull()
    expect(c1.title).toContain('from fixture-review')
    const r1 = el.querySelector<HTMLElement>('[data-thread="r1"]')!
    expect(r1.querySelector('.ir-sum')!.textContent).toBe('Snippet of r1')
    expect(r1.title).toContain('from fixture-dev')
    expect(r1.querySelector('.dot')).toBeNull()
    expect(el.querySelector('[data-thread="e1"] .ir-sum')!.textContent).toBe('Deployment canceled')
    // The header and chips count the rows: one unread thread, one awaiting (the archived row's last mail is yours).
    expect(el.querySelector('[data-inbox-count]')!.textContent).toBe('1 unread')
    expect(el.querySelector('[data-filter="awaiting"] .n')!.textContent).toBe(' 1')
    expect(el.querySelector('[data-filter="archived"] .n')!.textContent).toBe(' 1')
  })
})

describe('the sidebar Mail list from index rows', () => {
  it('draws titles, counts and ages from the rows, and pins a pending ask by when its thread started', async () => {
    route.active = [
      row('t1', { title: 'Deploy plan', mail_count: 4, unread: 1, ...card({ last_created_at: iso(3) }) }),
      row('p1', { ask: 'pending', ...card({ first_created_at: iso(90) }) }),
      row('p2', { ask: 'pending', ...card({ first_created_at: iso(120) }) }),
    ]
    route.archived = []
    route.deferred = [row('d1')]
    const { MailSide } = await import('../MailSide')
    const el = await render(<MailSide leftRef={createRef()} />)
    const t1 = el.querySelector<HTMLElement>('[data-thread="t1"]')!
    expect(t1.querySelector('.mtitle')!.textContent).toBe('Deploy plan')
    expect(t1.querySelector('.badge.n')!.textContent).toBe('4')
    expect(t1.querySelector('.t')!.textContent).toBe('3 min ago')
    expect(t1.classList.contains('unread')).toBe(true)
    // The pending asks top the list, oldest thread first.
    const pinned = [...el.querySelectorAll<HTMLElement>('.mail-side-list .mrow.ask')].map((r) => r.dataset.thread)
    expect(pinned).toEqual(['p2', 'p1'])
    expect(el.querySelector('.count .asks')!.textContent).toBe('2 waiting on you')
    expect(el.textContent).toContain('Deferred (1)')
  })
})
