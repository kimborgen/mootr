// @vitest-environment jsdom
// The footer's page icons (S-1428): the open page's icon is pressed, and the Inbox count is the one the sidebar
// Mail header shows (the attention list), not every waiting row (a plain wait has no row in the inbox).
import { act, createRef, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, emptyLayout, type Layout, type LayoutOp } from '../../src/layout-ops.ts'

vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
vi.mock('./api', () => ({ api: vi.fn(async () => ({})), hash: new URLSearchParams() }))

const mail = (id: string, tid: string, created_at: string) => ({ id, thread_id: tid, from_id: 'a1', from_name: 'bob', subject: 'Subject ' + tid, created_at, recipients: [{ id: 'human', read_at: created_at }] })
const thread = (tid: string, created_at = '2026-10-13T10:00:00Z') => ({ thread_id: tid, mails: [mail('m-' + tid, tid, created_at)] })
const wait = (id: string, thread: string | null) => ({ id, kind: 'human', target: null, thread, detail: 'Your answer', since: '2026-10-13T11:00:00Z', source: 'wait_for' })
const agent = (waits: unknown[]) => ({ id: 'a1', name: 'bob', waits })
const base = { humanArchived: [], humanDeferred: [], attention: [], decisions: [], perms: [], delegateDialogs: [], itsaStatuses: [] }

// The shell reads its layout from the daemon's stream: a stub daemon with one layout, as the nav-pages test has.
let daemon: Layout = emptyLayout()
let stream: ReadableStreamDefaultController<Uint8Array>
const enc = new TextEncoder()
const push = (l: Layout) => stream.enqueue(enc.encode(`event: layout\ndata: ${JSON.stringify(l)}\n\n`))
const tick = () => new Promise((r) => setTimeout(r, 10))

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/layout/stream') return new Response(new ReadableStream<Uint8Array>({ start: (c) => { stream = c; push(daemon) } }))
    if (path === '/api/layout/ops' && init?.method === 'POST') {
      const ops = JSON.parse(String(init.body)).ops as LayoutOp[]
      daemon = { ...ops.reduce((l, op) => apply(l, op), daemon), version: daemon.version + 1 }
      queueMicrotask(() => push(daemon))
      return new Response(JSON.stringify(daemon))
    }
    return new Response('{}', { status: 404 })
  }))
  const shell = await import('./shell/layout')
  shell.init({ valid: () => true, keep: () => true, keepWorld: () => true })
  await tick()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(() => { vi.unstubAllGlobals() })

// Each test's tree is unmounted and removed, so a later test's ids are the only ones in the document.
const roots: Root[] = []
const mount = async (node: ReactNode) => {
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  roots.push(root)
  await act(async () => { root.render(node) })
  return el
}
afterEach(async () => {
  for (const r of roots.splice(0)) await act(async () => { r.unmount() })
  document.body.innerHTML = ''
})

describe('the footer page icons', () => {
  beforeEach(() => { ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true })

  it('presses the icon of the page that is open, and no other', async () => {
    const shell = await import('./shell/layout')
    const { PageButtons } = await import('./PageButtons')
    await act(async () => { shell.showAgentWorld('w:work'); await tick() })
    const el = await mount(<PageButtons />)
    expect(el.querySelector('#open-work')!.classList.contains('on')).toBe(true)
    expect(el.querySelector('#open-work')!.getAttribute('aria-current')).toBe('page')
    expect(el.querySelector('#open-inbox')!.classList.contains('on')).toBe(false)
    expect(el.querySelector('#open-inbox')!.getAttribute('aria-current')).toBeNull()
  })

  it('opens its page when the icon is clicked: the Agents icon opens w:agents', async () => {
    const shell = await import('./shell/layout')
    const { PageButtons } = await import('./PageButtons')
    await act(async () => { shell.showAgentWorld('w:work'); await tick() })
    const el = await mount(<PageButtons />)
    await act(async () => { el.querySelector<HTMLButtonElement>('#open-agents')!.click(); await tick() })
    expect(shell.currentWorld()).toBe('w:agents')
  })

  it('shows the sidebar Mail header count on Inbox, not the count of every waiting row', async () => {
    const store = await import('./store')
    const { MailSide } = await import('./MailSide')
    const { PageButtons } = await import('./PageButtons')
    // One plain wait (no thread: To answer only) and one wait tied to a thread the human holds (an ask in the inbox).
    store.setData({ ...base, humanThreads: [thread('t1'), thread('t2')], agents: [agent([wait('w1', 't1'), wait('w2', null)])] } as never)
    const el = await mount(<><MailSide leftRef={createRef()} /><PageButtons /></>)
    expect(el.querySelector('.count .asks')!.textContent).toBe('1 waiting on you')
    expect(el.querySelector('#open-inbox .badge')!.textContent).toBe('1')
  })
})
