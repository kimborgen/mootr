// @vitest-environment jsdom
// cc pills (S-1464): which suggestions become pills, what a pick adds, and what the send carries.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CC_FLOOR, CC_PILLS, addItem, ccPayload, ccPills } from './cc-pills'
import { ApiError } from './api'
import { Composer, type SendPayload } from './Composer'
import { getRows, resetOutbox } from './outbox'
import { setData } from './store'
import { MenuLayer, hideMenu } from './ui/menu'
import type { Agent, SearchResult } from './types'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hit = (kind: string, id: string, score = 0.8, title = id): SearchResult => ({ kind, id, title, score } as SearchResult)

describe('ccPills', () => {
  it('keeps only near matches, at most CC_PILLS, best first as given', () => {
    const rs = [hit('agent', 'a', 0.9), hit('thread', 't', CC_FLOOR), hit('itsa', 'i', CC_FLOOR - 0.01), hit('agent', 'b', 0.7), hit('agent', 'c', 0.6)]
    expect(ccPills(rs, { cc: [], items: [] }).map((r) => r.id)).toEqual(['a', 't', 'b'].slice(0, CC_PILLS))
  })
  it('skips the recipient, what is already cc\'d, agents it can\'t cc, and kinds a cc can\'t be', () => {
    const rs = [hit('agent', 'to'), hit('agent', 'cc1'), hit('agent', 'gone'), hit('thread', 't1'), hit('itsa', 'i1'), hit('requirement', 'r'), hit('agent', 'ok')]
    const items = [{ kind: 'thread' as const, id: 't1', title: 't1', people: [] }]
    expect(ccPills(rs, { to: 'to', cc: ['cc1'], items }, (id) => id !== 'gone').map((r) => r.kind + ':' + r.id)).toEqual(['itsa:i1', 'agent:ok'])
  })
})

describe('addItem and ccPayload', () => {
  it('files on one ITSA: a second ITSA pick replaces the first; threads add up', () => {
    let xs = addItem([], { kind: 'itsa', id: 'i1', title: 'S-1', people: [] })
    xs = addItem(xs, { kind: 'thread', id: 't1', title: 'T', people: ['p1', 'p2'] })
    xs = addItem(xs, { kind: 'itsa', id: 'i2', title: 'S-2', people: [] })
    expect(xs.map((x) => x.id)).toEqual(['t1', 'i2'])
    expect(ccPayload(['p1', 'a'], xs, 'p2')).toEqual({ cc: ['p1', 'a'], itsa: 'i2' })
    expect(ccPayload(['a'], [])).toEqual({ cc: ['a'] })
  })
})

describe('the prompt input\'s cc pills', () => {
  let calls: { method: string; path: string; body?: any }[]
  let root: Root
  let host: HTMLElement
  let suggestions: SearchResult[]
  // What the rescoring pass answers (S-1465); null is the setting off.
  let rescored: SearchResult[] | null
  // Holds a thread's fetch until the test lets it go.
  let threadGate: Promise<void> | null
  const ag = (id: string, name: string, o: Partial<Agent> = {}) => ({ id, name, kind: 'agent', lifecycle: 'active', activity: 'idle', created_at: id, parents: [], ...o }) as unknown as Agent
  beforeEach(() => {
    calls = []
    threadGate = null
    rescored = null
    resetOutbox()
    suggestions = [hit('agent', 'd1', 0.9, 'dev-one'), hit('thread', 'th1', 0.8, 'Login bug'), hit('itsa', 'it1', 0.7, 'S-9 Login'), hit('agent', 'lo', 0.4, 'too-far')]
    setData({ promptDefaultMode: 'direct', agents: [ag('t1', 'target'), ag('d1', 'dev-one'), ag('w1', 'writer'), ag('lo', 'too-far')] })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }))
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', path, body: init?.body ? JSON.parse(init.body as string) : undefined })
      if (path.startsWith('/api/threads/') && threadGate) await threadGate
      const json = path.startsWith('/api/suggest/rescore') ? rescored
        : path.startsWith('/api/suggest') ? suggestions
        : path.startsWith('/api/threads/') ? [{ id: 'm1', from_id: 'w1', recipients: [{ id: 'human' }] }, { id: 'm2', from_id: 'human', recipients: [{ id: 'w1' }] }]
        : {}
      return { ok: true, status: 200, json: async () => json }
    }))
  })
  afterEach(() => { act(() => { hideMenu(); root.unmount() }); host.remove(); vi.unstubAllGlobals(); try { sessionStorage.clear() } catch {} })

  const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  const mount = async (el: React.ReactElement) => { await act(async () => { root.render(<>{el}<MenuLayer /></>) }); await flush() }
  const type = async (text: string) => {
    const ta = host.querySelector<HTMLTextAreaElement>('textarea')!
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => { set.call(ta, text); ta.dispatchEvent(new Event('input', { bubbles: true })) })
    await flush()
  }
  const pills = () => [...host.querySelectorAll<HTMLButtonElement>('.cmp-pill')].map((b) => b.dataset.ccSuggest)
  const pick = async (key: string) => { await act(async () => { host.querySelector<HTMLButtonElement>(`[data-cc-suggest="${key}"]`)!.click() }); await flush() }
  const box = (mail: (p: SendPayload) => Promise<void>, o: Record<string, unknown> = {}) =>
    <Composer target={{ key: 'agent:t1', enabled: true, name: 'target', to: 't1' }} onSend={async () => {}} mail={mail} {...o} />

  it('suggests on a space, above the floor; a pick adds a cc, switches to Mail, and the rest stay', async () => {
    const mail = vi.fn(async () => {})
    await mount(box(mail))
    await type('the login ')
    expect(calls.some((c) => c.path.startsWith('/api/suggest?') && c.path.includes('q=the+login'))).toBe(true)
    expect(pills()).toEqual(['agent:d1', 'thread:th1', 'itsa:it1'])
    expect(host.querySelector('.cmp-box')!.classList.contains('cc-room')).toBe(true)
    await pick('agent:d1')
    expect(host.querySelector('.cmp-mode-one')!.getAttribute('aria-pressed')).toBe('true')
    expect(pills()).toEqual(['thread:th1', 'itsa:it1'])
    await pick('thread:th1')
    await pick('itsa:it1')
    expect(pills()).toEqual([])
    expect(host.querySelector('.cmp-to-n')!.textContent).toBe('+3')
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-send')!.click() }); await flush()
    expect(mail).toHaveBeenCalledWith({ text: 'the login', files: [], client_id: expect.any(String), cc: ['d1', 'w1'], itsa: 'it1' })
    expect(host.querySelector('.cmp-to-n')).toBeNull()
  })
  it('keeps the ITSA filing of a failed send: the put-back brings it back, the resend files it under the old client id', async () => {
    let fail = true
    const mail = vi.fn(async (_p: SendPayload) => { if (fail) throw new ApiError('no', 409) })
    await mount(box(mail))
    await type('the login ')
    await pick('itsa:it1')
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-send')!.click() }); await flush()
    expect(host.querySelector('.cmp-to-n')).toBeNull()
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-outbox .ob-row.failed')!.click() }); await flush()
    expect(host.querySelector('.cmp-to-n')!.textContent).toBe('+1')
    fail = false
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-send')!.click() }); await flush()
    expect(mail.mock.calls[1][0].itsa).toBe('it1')
    expect(mail.mock.calls[1][0].client_id).toBe(mail.mock.calls[0][0].client_id)
  })
  it('a changed filing after a put-back is a new message; a saved draft keeps its filing', async () => {
    let fail = true
    const mail = vi.fn(async (_p: SendPayload) => { if (fail) throw new ApiError('no', 409) })
    suggestions = [...suggestions, hit('itsa', 'it2', 0.6, 'S-10 Other')]
    await mount(box(mail))
    await type('the login ')
    await pick('itsa:it1')
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-send')!.click() }); await flush()
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-outbox .ob-row.failed')!.click() }); await flush()
    await type('the login ')
    await pick('itsa:it2')
    fail = false
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-send')!.click() }); await flush()
    expect(mail.mock.calls[1][0].itsa).toBe('it2')
    expect(mail.mock.calls[1][0].client_id).not.toBe(mail.mock.calls[0][0].client_id)
    await type('half ')
    await pick('itsa:it1')
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-draft')!.click() })
    expect(getRows('agent:t1').find((r) => r.kind === 'draft')).toMatchObject({ itsa: { id: 'it1', title: 'S-9 Login' } })
  })
  it('drops a thread pick whose participants arrive after the message was sent', async () => {
    let let_go = () => {}
    threadGate = new Promise((r) => { let_go = r })
    const mail = vi.fn(async (_p: SendPayload) => {})
    await mount(box(mail))
    await type('the login ')
    await pick('thread:th1')
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-send')!.click() }); await flush()
    await act(async () => { let_go() }); await flush()
    expect(host.querySelector('.cmp-to-n')).toBeNull()
    await type('next one')
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-send')!.click() }); await flush()
    expect(mail.mock.calls.map((c) => c[0].cc)).toEqual([undefined, undefined])
  })
  it('never suggests the recipient', async () => {
    suggestions = [hit('agent', 't1', 0.9, 'target'), ...suggestions]
    await mount(box(vi.fn(async () => {})))
    await type('the login ')
    expect(pills()).not.toContain('agent:t1')
  })
  it('lists picked threads and ITSAs in the recipient menu, where a click drops one', async () => {
    await mount(box(vi.fn(async () => {}), { assistant: { send: async () => {}, label: () => 'Assistant' } }))
    await type('the login ')
    await pick('thread:th1')
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-to')!.click() })
    const row = document.querySelector<HTMLButtonElement>('.menu [data-cc-item="thread:th1"]')!
    expect(row.getAttribute('aria-checked')).toBe('true')
    expect(row.textContent).toContain('Login bug')
    await act(async () => { row.click() })
    expect(document.querySelector('.menu [data-cc-item="thread:th1"]')).toBeNull()
    expect(pills()).toContain('thread:th1')
  })
  it('a thread reply takes cc pills too; the Alt+A box and a box without mail don\'t ask', async () => {
    await mount(<Composer target={{ key: 'thread:x', enabled: true }} onSend={async () => {}} takesCc />)
    await type('the login ')
    expect(pills()).toEqual(['agent:d1', 'thread:th1', 'itsa:it1'])
    calls = []
    await mount(<Composer target={{ key: 'suggest', enabled: true }} onSend={async () => {}} mail={async () => {}} noCcPills />)
    await type('the login ')
    await mount(<Composer target={{ key: 'shell:x', enabled: true }} onSend={async () => {}} />)
    await type('the login ')
    expect(calls.filter((c) => c.path.startsWith('/api/suggest'))).toEqual([])
  })

  it('the rescored order replaces the pills once the typing has paused for 800 ms (S-1465)', async () => {
    rescored = [hit('thread', 'th1', 0.95, 'Login bug')]
    await mount(box(vi.fn(async () => {})))
    await type('the login ')
    expect(pills()).toEqual(['agent:d1', 'thread:th1', 'itsa:it1'])
    await act(async () => { await new Promise((r) => setTimeout(r, 900)) })
    expect(calls.filter((c) => c.path.startsWith('/api/suggest/rescore'))).toHaveLength(1)
    expect(pills()).toEqual(['thread:th1'])
  })
})
