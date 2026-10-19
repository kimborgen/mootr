// A thread reply advances to the next mail (S-148) only once the daemon has accepted it. A draft
// (the pencil) or a failed send keeps the thread open, with its strip row showing (S-509).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getRows, resetOutbox } from '../outbox'
import { ThreadView } from './ThreadView'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLElement
let root: Root
let posts: { path: string; body: any }[]
let mailStatus: number
let gate: Promise<void> | null

const thread = [{
  id: 'm1', from_id: 'a1', from_name: 'lead', subject: 'Which one', body: 'Pick one.', created_at: '2026-10-13T10:00:00Z',
  recipients: [{ id: 'human', read_at: '2026-10-13T10:01:00Z' }],
}]

beforeEach(() => {
  posts = []
  mailStatus = 200
  gate = null
  resetOutbox()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } })
  vi.stubGlobal('requestAnimationFrame', (f: () => void) => setTimeout(f, 0))
  // A phone, where the thread view keeps its own reply box; a desktop's is the bottom world's (S-1436).
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('760px'), media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }))
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const ok = (d: unknown) => ({ ok: true, status: 200, json: async () => d })
    if (init?.method !== 'POST') return ok(String(path).startsWith('/api/threads/') ? thread : [])
    const body = JSON.parse(String(init.body ?? '{}'))
    posts.push({ path, body })
    if (path === '/api/mail' && gate) await gate
    if (path === '/api/mail' && mailStatus !== 200) return { ok: false, status: mailStatus, json: async () => ({ error: 'refused' }) }
    return ok({})
  }))
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); try { sessionStorage.clear(); localStorage.clear() } catch {} })

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const archives = () => posts.filter((p) => p.path.endsWith('/archive'))
const type = async (s: string) => {
  const ta = host.querySelector<HTMLTextAreaElement>('textarea')!
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => { set.call(ta, s); ta.dispatchEvent(new Event('input', { bubbles: true })) })
}

describe('a thread reply and the next mail', () => {
  it('a draft keeps the thread open: nothing is sent or archived', async () => {
    await act(async () => { root.render(<ThreadView tid="t1" viewKey="thread:t1" />) })
    await flush(); await flush()
    await type('Not yet, keep this one.')
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-draft')!.click() })
    await flush(); await flush()
    expect(getRows().map((r) => r.kind)).toEqual(['draft'])
    expect(posts.filter((p) => p.path === '/api/mail')).toHaveLength(0)
    expect(archives()).toHaveLength(0)
  })

  it('a refused send keeps the thread open, with its failed row shown', async () => {
    mailStatus = 400
    await act(async () => { root.render(<ThreadView tid="t1" viewKey="thread:t1" />) })
    await flush(); await flush()
    await type('This one fails.')
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-send')!.click() })
    await flush(); await flush()
    expect(getRows().map((r) => r.kind)).toEqual(['failed'])
    expect(posts.filter((p) => p.path === '/api/mail')).toHaveLength(1)
    expect(archives()).toHaveLength(0)
    expect(host.querySelector('.cmp-outbox')).not.toBeNull()
  })

  it('an accepted reply archives its thread', async () => {
    await act(async () => { root.render(<ThreadView tid="t1" viewKey="thread:t1" />) })
    await flush(); await flush()
    await type('Accepted.')
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-send')!.click() })
    await flush(); await flush()
    expect(getRows()).toEqual([])
    expect(archives()).toHaveLength(1)
    // Kim named no one: the thread's people are inferred, so one nobody can mail any more is skipped, not refused (S-603).
    const [sent] = posts.filter((p) => p.path === '/api/mail')
    expect(sent.body.to).toEqual(['a1'])
    expect(sent.body.inferred).toEqual(['a1'])
  })

  it('a draft typed while the reply is pending keeps the thread open after the reply is accepted', async () => {
    let release!: () => void
    gate = new Promise<void>((r) => { release = r })
    await act(async () => { root.render(<ThreadView tid="t1" viewKey="thread:t1" />) })
    await flush(); await flush()
    await type('Sent while I draft.')
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-send')!.click() })
    await flush()
    await type('Next one, saved as a draft.')
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-draft')!.click() })
    await flush()
    expect(getRows().map((r) => r.kind).sort()).toEqual(['draft', 'pending'])
    await act(async () => { release() })
    await flush(); await flush()
    expect(posts.filter((p) => p.path === '/api/mail')).toHaveLength(1)
    expect(getRows().map((r) => r.kind)).toEqual(['draft'])
    expect(archives()).toHaveLength(0)
  })
})
