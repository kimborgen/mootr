// @vitest-environment jsdom
// A thread reply with a staged permission answer goes through the outbox (S-373): the answer
// leaves the box at submit, a retry after a lost connection answers the permission once, and
// a second submit doesn't send the answer again.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getRows, resetOutbox } from '../outbox'
import { sha256Hex } from '../perm/input'
import { getData, setData } from '../store'
import { ThreadView } from './ThreadView'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLElement
let root: Root
let posts: { path: string; body: any }[]
let mailUp: boolean

const thread = [{
  id: 'm1', from_id: 'a1', from_name: 'lead', subject: 'Permission: run it', body: 'May I?', created_at: '2026-10-13T10:00:00Z',
  recipients: [{ id: 'human', read_at: '2026-10-13T10:01:00Z' }], permission_id: 'p1', permission: { id: 'p1', agent_id: 'a1', status: 'pending', action: 'run it' },
}, {
  id: 'm2', from_id: 'a1', from_name: 'lead', subject: 'Which one', body: '```decision\nShip it today?\n- Yes: now\n- No: wait\n```', created_at: '2026-10-13T10:02:00Z',
  recipients: [{ id: 'human', read_at: '2026-10-13T10:03:00Z' }],
}]

beforeEach(() => {
  posts = []
  mailUp = false
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
    if (path === '/api/mail' && !mailUp) throw new TypeError('Failed to fetch')
    return ok({})
  }))
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); try { sessionStorage.clear(); localStorage.clear() } catch {} })

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

describe('a thread reply with a staged answer', () => {
  it('takes the answer at submit, answers the permission once across retries, and sends the reply once', async () => {
    await act(async () => { root.render(<ThreadView tid="t1" viewKey="thread:t1" />) })
    await flush(); await flush()
    const approve = host.querySelector<HTMLButtonElement>('[data-perm="p1"][data-approve="1"]')!
    await act(async () => { approve.click() })
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-choose="Yes"]')!.click() })
    expect(host.querySelector('.rp-perm')).not.toBeNull()
    const ta = host.querySelector<HTMLTextAreaElement>('textarea')!
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => { set.call(ta, 'go ahead, with a note'); ta.dispatchEvent(new Event('input', { bubbles: true })) })
    vi.useFakeTimers()
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-send')!.click() })
    // The answer left the box with the submit.
    expect(host.querySelector('.rp-perm')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    // The daemon is unreachable for the reply: the row retries and stays pending.
    for (const ms of [1000, 2000]) await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
    expect(getRows().map((r) => r.kind)).toEqual(['pending'])
    mailUp = true
    await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
    expect(getRows()).toEqual([])
    const answers = posts.filter((p) => p.path === '/api/permissions/p1/answer')
    // Answered on the first try only (the retries skip it), under an id derived from the reply's.
    expect(answers).toHaveLength(1)
    const mails = posts.filter((p) => p.path === '/api/mail')
    expect(new Set(mails.map((m) => m.body.client_id)).size).toBe(1)
    expect(answers[0].body.client_id).toBe(`${mails[0].body.client_id}:perm:p1`)
    expect(mails.length).toBeGreaterThanOrEqual(3)
  })

  it('brings back an answer that was never sent when the reply fails for good', async () => {
    await act(async () => { root.render(<ThreadView tid="t1" viewKey="thread:t1" />) })
    await flush(); await flush()
    // The permission answer itself is refused (a 409), so it was never sent.
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return { ok: true, status: 200, json: async () => (String(path).startsWith('/api/threads/') ? thread : []) }
      return { ok: false, status: 409, json: async () => ({ error: 'already answered' }) }
    }))
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-perm="p1"][data-approve="1"]')!.click() })
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-choose="Yes"]')!.click() })
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-send')!.click() })
    await flush(); await flush()
    expect(getRows().map((r) => r.kind)).toEqual(['failed'])
    // The permission answer was refused, so it is staged again; the choice came back too.
    expect(host.querySelector('.rp-perm')).not.toBeNull()
    expect(host.querySelector('.mb-decision.staging')).not.toBeNull()
  })

  it('after one of two permission answers is refused, restores only the one that was not sent', async () => {
    const two = [{ ...thread[0] }, { ...thread[0], id: 'm3', permission_id: 'p2', permission: { ...thread[0].permission, id: 'p2' } }, thread[1]]
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return { ok: true, status: 200, json: async () => (String(path).startsWith('/api/threads/') ? two : []) }
      posts.push({ path, body: JSON.parse(String(init.body)) })
      if (path === '/api/permissions/p2/answer') return { ok: false, status: 409, json: async () => ({ error: 'already answered' }) }
      return { ok: true, status: 200, json: async () => ({}) }
    }))
    await act(async () => { root.render(<ThreadView tid="t1" viewKey="thread:t1" />) })
    await flush(); await flush()
    for (const id of ['p1', 'p2']) await act(async () => { host.querySelector<HTMLButtonElement>(`[data-perm="${id}"][data-approve="1"]`)!.click() })
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-choose="Yes"]')!.click() })
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-send')!.click() })
    await flush(); await flush()
    expect(getRows().map((r) => r.kind)).toEqual(['failed'])
    expect(posts.filter((p) => p.path === '/api/permissions/p1/answer')).toHaveLength(1)
    // p1 went out, so only p2 (and the choice) are staged again.
    expect(host.querySelectorAll('.rp-perm')).toHaveLength(1)
    expect(host.querySelector('.rp-perm')!.textContent).toContain('run it')
    expect(host.querySelector('[data-perm="p1"].staged')).toBeNull()
    expect(host.querySelector('[data-perm="p2"].staged')).not.toBeNull()
  })

  // S-500: a suggested input staged through a plain Approve (its mail's request carries no kind,
  // the pending list says input) is approved with the hash of its text, and says what came of it.
  it('approves a staged suggested input with its text hash, and shows the outcome', async () => {
    const text = '! rm ~/.local/share/stam/deploy-hold'
    setData({ perms: [{ id: 'p1', agent_id: 'a1', agent_name: 'lead', status: 'pending', kind: 'input', action: 'Type suggested input', text }] })
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      const ok = (d: unknown) => ({ ok: true, status: 200, json: async () => d })
      if (init?.method !== 'POST') return ok(String(path).startsWith('/api/threads/') ? thread : [])
      posts.push({ path, body: JSON.parse(String(init.body ?? '{}')) })
      return ok(path === '/api/permissions/p1/answer' ? { outcome: 'failed' } : {})
    }))
    await act(async () => { root.render(<ThreadView tid="t1" viewKey="thread:t1" />) })
    await flush(); await flush()
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-perm="p1"][data-approve="1"]')!.click() })
    const ta = host.querySelector<HTMLTextAreaElement>('textarea')!
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => { set.call(ta, 'I authorize'); ta.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-send')!.click() })
    await flush(); await flush()
    const answers = posts.filter((p) => p.path === '/api/permissions/p1/answer')
    expect(answers.map((a) => a.body)).toEqual([{ approve: true, text_sha256: await sha256Hex(text), client_id: expect.stringMatching(/:perm:p1$/) }])
    expect(getRows()).toEqual([])
    expect(host.textContent).toContain("Failed: @lead's box didn't show it")
    setData({ perms: [] })
  })

  // A lost response to a committed approval: the retry carries the same client_id, so the daemon
  // answers it from the first try (dedupByClientId) instead of a 409.
  it('retries a staged suggested-input approval under the same client id after a lost response', async () => {
    const text = '! rm ~/.local/share/stam/deploy-hold'
    setData({ perms: [{ id: 'p1', agent_id: 'a1', agent_name: 'lead', status: 'pending', kind: 'input', action: 'Type suggested input', text }] })
    let lost = true
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      const ok = (d: unknown) => ({ ok: true, status: 200, json: async () => d })
      if (init?.method !== 'POST') return ok(String(path).startsWith('/api/threads/') ? thread : [])
      posts.push({ path, body: JSON.parse(String(init.body ?? '{}')) })
      if (path === '/api/permissions/p1/answer' && lost) { lost = false; throw new TypeError('Failed to fetch') }
      return ok(path === '/api/permissions/p1/answer' ? { outcome: 'typed' } : {})
    }))
    await act(async () => { root.render(<ThreadView tid="t1" viewKey="thread:t1" />) })
    await flush(); await flush()
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-perm="p1"][data-approve="1"]')!.click() })
    vi.useFakeTimers()
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-send')!.click() })
    for (const ms of [0, 1000, 2000, 4000]) await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
    const answers = posts.filter((p) => p.path === '/api/permissions/p1/answer')
    expect(answers).toHaveLength(2)
    expect(answers[0].body.client_id).toMatch(/:perm:p1$/)
    expect(answers[1].body.client_id).toBe(answers[0].body.client_id)
    expect(getRows()).toEqual([])
    setData({ perms: [] })
  })

  // S-518: a request answered meanwhile is not a failure: a neutral note, the card refreshed to
  // answered (who, no buttons), and the staged answer gone. A real refusal says what to do.
  it('says "Already approved by X; nothing sent" when the request was answered meanwhile', async () => {
    let live = thread
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return { ok: true, status: 200, json: async () => (String(path).startsWith('/api/threads/') ? live : []) }
      // The daemon refuses the answer, and the thread now shows the request as answered.
      live = [{ ...thread[0], permission: { ...thread[0].permission, status: 'approved', decided_by: 'a1', decided_at: '2026-10-13T10:05:00Z' } }, thread[1]] as typeof thread
      return { ok: false, status: 409, json: async () => ({ error: 'request p1 is already approved' }) }
    }))
    await act(async () => { root.render(<ThreadView tid="t1" viewKey="thread:t1" />) })
    await flush(); await flush()
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-perm="p1"][data-approve="1"]')!.click() })
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-send')!.click() })
    await flush(); await flush(); await flush()
    expect(getRows()).toEqual([])
    expect(host.querySelector('.ob-row.failed')).toBeNull()
    expect(host.textContent).toContain('Already approved by a1; nothing sent for "run it"')
    expect(host.querySelector('.rp-perm')).toBeNull()
    expect(host.querySelector('[data-perm-pending]')).toBeNull()
    expect(host.querySelector('.perm.approved')?.textContent).toContain('Approved by a1')
    // Nothing was answered here, so the thread stays open.
    expect(posts.some((p) => p.path.endsWith('/archive'))).toBe(false)
  })

  it('shows any other refusal on the failed row, with what to do', async () => {
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return { ok: true, status: 200, json: async () => (String(path).startsWith('/api/threads/') ? thread : []) }
      return { ok: false, status: 403, json: async () => ({ error: 'request p1 is with the human only' }) }
    }))
    await act(async () => { root.render(<ThreadView tid="t1" viewKey="thread:t1" />) })
    await flush(); await flush()
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-perm="p1"][data-approve="1"]')!.click() })
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-send')!.click() })
    await flush(); await flush(); await flush()
    const row = host.querySelector('.ob-row.failed .ob-text')!.textContent
    expect(row).toContain('Approve "run it" failed: request p1 is with the human only. Tap this row to put the reply back in the box, then try again.')
  })

  // Polling: a status-only change (same ids, same read marks) still refreshes the card and drops the staged answer.
  // A request that is gone from the thread, or lost its permission, drops it too. Nothing is sent.
  for (const [name, after] of [
    ['a status-only change', () => [{ ...thread[0], permission: { ...thread[0].permission, status: 'denied' } }, thread[1]]],
    ['a request that lost its permission', () => [{ ...thread[0], permission: undefined, permission_id: undefined }, thread[1]]],
    ['a request gone from the thread', () => [thread[1]]],
  ] as const) it(`drops a staged answer after ${name}, on the next poll`, async () => {
    let live: unknown[] = thread
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return { ok: true, status: 200, json: async () => (String(path).startsWith('/api/threads/') ? live : []) }
      posts.push({ path, body: JSON.parse(String(init.body ?? '{}')) })
      return { ok: true, status: 200, json: async () => ({}) }
    }))
    await act(async () => { root.render(<ThreadView tid="t1" viewKey="thread:t1" />) })
    await flush(); await flush()
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-perm="p1"][data-approve="1"]')!.click() })
    expect(host.querySelector('.rp-perm')).not.toBeNull()
    live = after()
    await act(async () => { setData({ mailTick: getData().mailTick + 1 }) })
    await flush(); await flush()
    expect(host.querySelector('.rp-perm')).toBeNull()
    expect(host.querySelector('[data-perm-pending]')).toBeNull()
    expect(posts.filter((p) => p.path.includes('/answer'))).toEqual([])
  })

  // A held request (a suggested input approved elsewhere) and a failed one are refused with a 409 too.
  for (const [status, said] of [['held', 'Already approved by a1; nothing sent for "run it"'], ['failed', '"run it" already failed; nothing sent']] as const) it(`treats a request already ${status} as answered, and gives a typed note back`, async () => {
    let live = thread
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return { ok: true, status: 200, json: async () => (String(path).startsWith('/api/threads/') ? live : []) }
      live = [{ ...thread[0], permission: { ...thread[0].permission, status, decided_by: 'a1' } }, thread[1]] as typeof thread
      return { ok: false, status: 409, json: async () => ({ error: `request p1 is already ${status}` }) }
    }))
    await act(async () => { root.render(<ThreadView tid="t1" viewKey="thread:t1" />) })
    await flush(); await flush()
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-perm="p1"][data-approve="1"]')!.click() })
    const ta = host.querySelector<HTMLTextAreaElement>('textarea')!
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => { set.call(ta, 'my note'); ta.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-send')!.click() })
    await flush(); await flush(); await flush()
    expect(host.querySelector('.ob-row.failed')).toBeNull()
    expect(host.querySelector('.rp-info')?.textContent).toBe(said)
    // The note was for the answer, which went nowhere: it is back in the box.
    expect(host.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('my note')
    // A later send clears the row.
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-send')!.click() })
    await flush()
    expect(host.querySelector('.rp-info')).toBeNull()
  })
})
