// @vitest-environment jsdom
// The Assistant tab opened and closed over one mounted page: its hooks run in the same order
// whether it is open or not (a hook after the early return threw on reopening).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TopWorld } from './App'
import { setData } from './store'
import { setUi } from './ui/state'
import type { Agent } from './types'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const agent = (over: Partial<Agent> & { id: string; name: string }) => ({ role: '', lifecycle: 'paused', state: 'idle', created_at: '2026-10-01T00:00:00Z', kind: null, parents: [], ...over }) as unknown as Agent
const cos = agent({ id: 'cos1', name: 'cos', chief_of_staff: true })
const intake = agent({ id: 'aa5sp', name: 'intake', role: "cos's intake assistant: triages Kim's ideas", parents: ['cos1'] })

let root: Root
let host: HTMLElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  // The composer measures itself; jsdom has no ResizeObserver.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })))
  setData({ agents: [cos, intake], assistantDefault: 'assistant' })
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); setUi({ topOpen: false, topTarget: null }) })

describe('the Assistant tab', () => {
  it('opens and closes over one mounted page without changing its hooks', () => {
    act(() => root.render(<TopWorld />))
    expect(host.querySelector('#top-world')).toBeNull()
    act(() => setUi({ topOpen: true }))
    expect(host.querySelector('#top-world')).not.toBeNull()
    act(() => setUi({ topOpen: false }))
    expect(host.querySelector('#top-world')).toBeNull()
    act(() => setUi({ topOpen: true, topTarget: 'aa5sp' }))
    expect(host.querySelector('#top-world')?.getAttribute('data-target')).toBe('aa5sp')
  })
})

describe('the Assistant tab writing to a chief of staff', () => {
  // The composer offers Direct (typed into the chief's agent) and Mail (mail from the human).
  const send = async (text: string, mode: 'Direct' | 'Mail') => {
    const pick = [...host.querySelectorAll<HTMLButtonElement>('#top-world .cmp-mode button')].find((b) => b.textContent === mode)!
    act(() => pick.click())
    const ta = host.querySelector<HTMLTextAreaElement>('#top-world textarea')!
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    act(() => { set.call(ta, text); ta.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { host.querySelector<HTMLButtonElement>('#top-world .cmp-send')!.click() })
  }
  const calls = () => (vi.mocked(fetch).mock.calls as unknown as [string, RequestInit][]).map(([url, init]) => [url, init?.method, init?.body ? JSON.parse(String(init.body)) : undefined])

  it('offers Direct and Mail, and Direct types into the chief of staff', async () => {
    act(() => root.render(<TopWorld />))
    act(() => setUi({ topOpen: true, topTarget: 'cos1' }))
    await send('hello cos', 'Direct')
    expect(calls()).toContainEqual(['/api/agents/cos1/prompt', 'POST', { text: 'hello cos', files: [], client_id: expect.any(String) }])
    expect(calls().some(([url]) => String(url).startsWith('/api/mail'))).toBe(false)
  })

  it('Mail sends mail from the human to the chief of staff', async () => {
    act(() => root.render(<TopWorld />))
    act(() => setUi({ topOpen: true, topTarget: 'cos1' }))
    await send('mail cos', 'Mail')
    expect(calls().find(([url]) => String(url) === '/api/mail')?.[2]).toMatchObject({ from: 'human', to: ['cos1'], body: 'mail cos' })
  })
})

describe('the Assistant tab writing to a chief of staff: how Direct reaches it', () => {
  const type = async (text: string) => {
    const ta = host.querySelector<HTMLTextAreaElement>('#top-world textarea')!
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    act(() => { set.call(ta, text); ta.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { host.querySelector<HTMLButtonElement>('#top-world .cmp-send')!.click() })
  }
  const calls = () => (vi.mocked(fetch).mock.calls as unknown as [string, RequestInit][]).map(([url, init]) => [url, init?.method, init?.body ? JSON.parse(String(init.body)) : undefined])
  const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('#top-world .cmp-mode button')].find((b) => b.textContent === name)!

  it('a running chief with a view that takes prompts gets Direct through view/prompt', async () => {
    setData({ agents: [agent({ id: 'cos1', name: 'cos', chief_of_staff: true, lifecycle: 'active', machine: 'm1', view: { can_stream: true, can_send: true, can_interrupt: true, can_approve: true } } as Partial<Agent> & { id: string; name: string })], machine: 'm1', assistantDefault: 'assistant' })
    act(() => root.render(<TopWorld />))
    act(() => setUi({ topOpen: true, topTarget: 'cos1' }))
    expect(button('Direct').disabled).toBe(false)
    await act(async () => { button('Direct').click() })
    await type('through the view')
    expect(calls()).toContainEqual(['/api/agents/cos1/view/prompt', 'POST', { text: 'through the view', client_id: expect.any(String) }])
  })
})
