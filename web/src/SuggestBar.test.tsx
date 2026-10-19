// @vitest-environment jsdom
// The bottom bar in suggestion mode (S-1474): the Alt+A behaviour in place, mail only, and each mail
// carries what the main world showed.
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComposerHandle } from './Composer'
import { setData } from './store'
import { SuggestBar } from './SuggestModal'
import type { SearchResult } from './types'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RESULTS: SearchResult[] = [{ kind: 'agent', id: 'd1', title: 'fixture-dev', snippet: 'developer', score: 0.9 }]
let calls: { method: string; path: string; body?: any }[]
let root: Root
let host: HTMLElement
beforeEach(() => {
  calls = []
  setData({ agents: [{ id: 'd1', name: 'fixture-dev', role: '', lifecycle: 'active', state: 'idle', parents: [] } as never] })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }))
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', path, body: init?.body ? JSON.parse(init.body as string) : undefined })
    return { ok: true, status: 200, json: async () => (path.startsWith('/api/suggest') ? RESULTS : {}) }
  }))
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); try { localStorage.clear(); sessionStorage.clear() } catch {} })

const wait = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)) })
const box = () => host.querySelector<HTMLTextAreaElement>('textarea')!
const type = async (text: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box(), text)
    box().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const mount = async () => { await act(async () => { root.render(<SuggestBar composerRef={createRef<ComposerHandle>()} context="Usage · tokens" />) }); await wait() }
const mails = () => calls.filter((c) => c.path === '/api/mail')

describe('the bottom bar in suggestion mode', () => {
  it('suggests as you type, and has no Direct/Mail toggle', async () => {
    await mount()
    await type('fix the ')
    await wait()
    expect(host.querySelectorAll('.sg-card')).toHaveLength(1)
    expect(host.querySelector('[data-go]')).not.toBeNull()
    expect(host.querySelector('.cmp-mode')).toBeNull()
    expect(host.querySelector('textarea')!.getAttribute('placeholder')).toContain('Usage · tokens')
  })

  it('a pick mails that agent with looking_at', async () => {
    await mount()
    await type('fix the ')
    await wait()
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-suggest="agent:d1"] .sg-pick')!.click() })
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-send')!.click() })
    await wait()
    expect(mails()).toHaveLength(1)
    expect(mails()[0].body).toMatchObject({ from: 'human', to: ['d1'], looking_at: 'Usage · tokens' })
    expect(mails()[0].body.routing_uncertain).toBeUndefined()
  })

  it('with no pick the mail goes to the top target, marked uncertain, with looking_at', async () => {
    setData({ agents: [{ id: 'e1', name: 'assistant', role: '', lifecycle: 'active', state: 'idle', parents: [], kind: 'assistant' } as never] })
    await mount()
    await type('hello there')
    await act(async () => { host.querySelector<HTMLButtonElement>('.cmp-send')!.click() })
    await wait()
    expect(mails()[0].body).toMatchObject({ routing_uncertain: true, looking_at: 'Usage · tokens' })
  })
})
