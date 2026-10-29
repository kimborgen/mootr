// @vitest-environment jsdom
// A question dialog's card (AskUserQuestion, S-3978) offers one button per option and Deny, with no
// comment field. A choice is staged as the answer, and it is sent as the option alone, even when a
// reply's text is typed with it: the agent gets the choice, and the dialog gets its number.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetOutbox } from '../outbox'
import { ThreadView } from './ThreadView'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLElement
let root: Root
let posts: { path: string; body: any }[]

const details = JSON.stringify({ tool: 'AskUserQuestion', input: { questions: [{ question: 'Which folder?', options: [{ label: 'Alpha' }, { label: 'Beta' }] }] }, session: 's1' })
const thread = [{
  id: 'm1', from_id: 'a1', from_name: 'lead', subject: 'Dialog: which folder', body: 'Asks a question.', created_at: '2026-10-13T10:00:00Z',
  recipients: [{ id: 'human', read_at: '2026-10-13T10:01:00Z' }], permission_id: 'q1',
  permission: { id: 'q1', agent_id: 'a1', status: 'pending', kind: 'dialog', dialog: 1, action: 'Claude Code asks a question', details },
}]

beforeEach(() => {
  posts = []
  resetOutbox()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } })
  vi.stubGlobal('requestAnimationFrame', (f: () => void) => setTimeout(f, 0))
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('760px'), media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }))
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const ok = (d: unknown) => ({ ok: true, status: 200, json: async () => d })
    if (init?.method !== 'POST') return ok(String(path).startsWith('/api/threads/') ? thread : [])
    posts.push({ path, body: JSON.parse(String(init.body ?? '{}')) })
    return ok({})
  }))
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); try { sessionStorage.clear(); localStorage.clear() } catch {} })

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

describe('a question dialog card', () => {
  it('offers one button per option and Deny, with no comment field or Approve', async () => {
    await act(async () => { root.render(<ThreadView tid="t1" viewKey="thread:t1" />) })
    await flush(); await flush()
    const choices = [...host.querySelectorAll<HTMLButtonElement>('[data-perm="q1"][data-perm-choice]')].map((b) => b.dataset.permChoice)
    expect(choices).toEqual(['Alpha', 'Beta'])
    expect(host.querySelector('[data-perm-note="q1"]')).toBeNull()
    expect(host.querySelector('[data-perm="q1"][data-approve="1"]:not([data-perm-choice])')).toBeNull()
    expect(host.querySelector('[data-perm="q1"][data-approve="0"]')).not.toBeNull()
  })

  it('sends the chosen option as the whole answer, even with reply text typed', async () => {
    await act(async () => { root.render(<ThreadView tid="t1" viewKey="thread:t1" />) })
    await flush(); await flush()
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-perm="q1"][data-perm-choice="Beta"]')!.click() })
    const ta = host.querySelector<HTMLTextAreaElement>('textarea')!
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => { set.call(ta, 'use the second one'); ta.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-send')!.click() })
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
    const answers = posts.filter((p) => p.path === '/api/permissions/q1/answer')
    expect(answers).toHaveLength(1)
    expect(answers[0].body).toMatchObject({ approve: true, note: 'Beta' })
  })
})
