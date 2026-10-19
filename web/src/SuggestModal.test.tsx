// @vitest-environment jsdom
// The Alt+A prompt (S-1461): it asks for suggestions as the human types, a pick sets the
// recipient and stops asking, and removing the pick asks again.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setData } from './store'
import { SuggestModal, openSuggest } from './SuggestModal'
import { getUi, setUi } from './ui/state'
import type { SearchResult } from './types'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RESULTS: SearchResult[] = [
  { kind: 'agent', id: 'd1', title: 'fixture-dev', snippet: 'developer', score: 0.9 },
  { kind: 'thread', id: 't1', title: 'Fixture thread', snippet: 'The build fails', score: 0.8 },
]
let calls: { method: string; path: string; body?: any }[]
// What the rescoring pass answers (S-1465); null is the setting off.
let rescored: SearchResult[] | null
let root: Root
let host: HTMLElement
beforeEach(() => {
  calls = []
  rescored = null
  setData({ agents: [{ id: 'd1', name: 'fixture-dev', role: '', lifecycle: 'active', state: 'idle', parents: [] } as never] })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }))
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', path, body: init?.body ? JSON.parse(init.body as string) : undefined })
    return { ok: true, status: 200, json: async () => (path.startsWith('/api/suggest/rescore') ? rescored : path.startsWith('/api/suggest') ? RESULTS : {}) }
  }))
})
afterEach(() => { act(() => root.unmount()); host.remove(); setUi({ suggestOpen: false }); vi.unstubAllGlobals(); try { localStorage.clear(); sessionStorage.clear() } catch {} })

const wait = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)) })
const asks = () => calls.filter((c) => c.path.startsWith('/api/suggest?'))
const box = () => host.querySelector<HTMLTextAreaElement>('#suggest-modal textarea')!
const type = async (text: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box(), text)
    box().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const mount = async () => { await act(async () => { openSuggest(); root.render(<SuggestModal />) }); await wait() }

describe('the Alt+A prompt', () => {
  it('asks once the typing pauses, and at once after a space', async () => {
    await mount()
    await type('fix')
    expect(asks()).toHaveLength(0)
    await wait(350)
    expect(asks()).toHaveLength(1)
    expect(new URL(asks()[0].path, 'http://x').searchParams.get('q')).toBe('fix')
    await type('fix the ')
    expect(asks()).toHaveLength(2)
    expect(host.querySelectorAll('.sg-card')).toHaveLength(2)
  })

  it('a pick sets the recipient, hides the cards and stops asking; removing it asks again', async () => {
    await mount()
    await type('fix the ')
    await wait()
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-suggest="agent:d1"] .sg-pick')!.click() })
    expect(host.querySelector('.sg-list')!.hasAttribute('hidden')).toBe(true)
    expect(host.querySelector('.sg-chip')?.textContent).toContain('fixture-dev')
    const n = asks().length
    await type('fix the build ')
    await wait(350)
    expect(asks()).toHaveLength(n)
    await act(async () => { host.querySelector<HTMLButtonElement>('.sg-unpick')!.click() })
    await wait(350)
    expect(asks()).toHaveLength(n + 1)
    expect(host.querySelector('.sg-chip')).toBeNull()
  })

  it('arrow keys and Enter pick a card instead of sending', async () => {
    await mount()
    await type('fix the ')
    await wait()
    const key = (k: string) => act(async () => { box().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })) })
    await key('ArrowUp')
    await key('ArrowUp')
    expect(host.querySelector('.sg-card.sel')?.getAttribute('data-suggest')).toBe('thread:t1')
    await key('ArrowDown')
    expect(host.querySelector('.sg-card.sel')?.getAttribute('data-suggest')).toBe('agent:d1')
    await key('Enter')
    expect(host.querySelector('.sg-chip')?.getAttribute('data-pick')).toBe('agent:d1')
    expect(calls.filter((c) => c.path === '/api/mail')).toHaveLength(0)
  })

  it('Escape closes it', async () => {
    await mount()
    await act(async () => { box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(getUi().suggestOpen).toBe(false)
  })

  it('Enter on the focused Go to button is not taken as a pick', async () => {
    await mount()
    await type('fix the ')
    await wait()
    await act(async () => { host.querySelector<HTMLElement>('[data-suggest="agent:d1"]')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    const go = host.querySelector<HTMLButtonElement>('[data-suggest="agent:d1"] [data-go]')!
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    await act(async () => { go.dispatchEvent(ev) })
    expect(ev.defaultPrevented).toBe(false)
    expect(host.querySelector('.sg-chip')).toBeNull()
  })

  it('Escape the box already took (a recording it discards) leaves the prompt open', async () => {
    await mount()
    box().addEventListener('keydown', (e) => { if (e.key === 'Escape') e.preventDefault() })
    await act(async () => { box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(getUi().suggestOpen).toBe(true)
  })

  it('Go to closes the prompt and moves the text into the item\'s draft, after the one it holds', async () => {
    sessionStorage.setItem('stam/draft/thread:t1', 'earlier thought')
    await mount()
    await type('fix the ')
    await wait()
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-suggest="thread:t1"] [data-go]')!.click() })
    expect(getUi().suggestOpen).toBe(false)
    expect(sessionStorage.getItem('stam/draft/thread:t1')).toBe('earlier thought\n\nfix the')
    expect(sessionStorage.getItem('stam/draft/suggest')).toBeNull()
  })

  it('a failed send put back keeps its pick, and a retry goes to that agent', async () => {
    vi.mocked(fetch).mockImplementation((async (path: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', path, body: init?.body ? JSON.parse(init.body as string) : undefined })
      if (path === '/api/mail' && calls.filter((c) => c.path === '/api/mail').length === 1) return { ok: false, status: 400, json: async () => ({ error: 'no' }) }
      return { ok: true, status: 200, json: async () => (path.startsWith('/api/suggest/rescore') ? rescored : path.startsWith('/api/suggest') ? RESULTS : {}) }
    }) as never)
    await mount()
    await type('fix the ')
    await wait()
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-suggest="agent:d1"] .sg-pick')!.click() })
    await act(async () => { box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    await wait(20)
    expect(getUi().suggestOpen).toBe(false)
    await act(async () => { setUi({ suggestOpen: true }) })
    await wait()
    await act(async () => { host.querySelector<HTMLElement>('.cmp-outbox [role=listitem] button, .cmp-outbox button')!.click() })
    expect(host.querySelector('.sg-chip')?.getAttribute('data-pick')).toBe('agent:d1')
    await act(async () => { box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    await wait(20)
    const mails = calls.filter((c) => c.path === '/api/mail')
    expect(mails).toHaveLength(2)
    expect(mails[1].body).toMatchObject({ to: ['d1'] })
    expect(mails[1].body.routing_uncertain).toBeUndefined()
  })

  it('cards come from the newest ask: an older answer that lands later is dropped', async () => {
    vi.useFakeTimers()
    try {
      const pending: { q: string; signal?: AbortSignal | null; done: (rs: SearchResult[]) => void }[] = []
      vi.mocked(fetch).mockImplementation(((path: string, init?: RequestInit) => {
        const q = new URL(path, 'http://x').searchParams.get('q') ?? ''
        return new Promise((res) => pending.push({ q, signal: init?.signal, done: (rs) => res({ ok: true, status: 200, json: async () => rs } as never) }))
      }) as never)
      await act(async () => { openSuggest(); root.render(<SuggestModal />) })
      await type('fix ')
      await type('fix the ')
      expect(pending.map((p) => p.q)).toEqual(['fix', 'fix the'])
      expect(pending[0].signal?.aborted).toBe(true)
      await act(async () => { pending[1].done([RESULTS[1]]) })
      await act(async () => { pending[0].done([RESULTS[0]]) })
      expect([...host.querySelectorAll('.sg-card')].map((c) => c.getAttribute('data-suggest'))).toEqual(['thread:t1'])
    } finally { vi.useRealTimers() }
  })
})

// The rescoring pass (S-1465): after 800 ms still, the daemon's order replaces the embedding order.
describe('the Alt+A prompt rescoring', () => {
  const rescores = () => calls.filter((c) => c.path.startsWith('/api/suggest/rescore'))
  const titles = () => [...host.querySelectorAll('.sg-card .sg-t')].map((t) => t.textContent)

  it('the embedding order shows first, then the rescored one replaces it after the typing has paused for 800 ms', async () => {
    rescored = [RESULTS[1]]
    await mount()
    await type('login loop')
    await wait(400)
    expect(titles()).toEqual(['fixture-dev', 'Fixture thread'])
    expect(rescores()).toHaveLength(0)
    await wait(600)
    expect(rescores()).toHaveLength(1)
    expect(new URL(rescores()[0].path, 'http://x').searchParams.get('q')).toBe('login loop')
    expect(titles()).toEqual(['Fixture thread'])
  })

  it('a newer text aborts the pass for the older one: only the newest text is rescored', async () => {
    rescored = [RESULTS[0]]
    await mount()
    await type('login')
    await wait(400)
    await type('login loop')
    await wait(400)
    expect(rescores()).toHaveLength(0)
    await wait(500)
    expect(rescores().map((c) => new URL(c.path, 'http://x').searchParams.get('q'))).toEqual(['login loop'])
  })

  it('with the setting off (null) the embedding order stays', async () => {
    rescored = null
    await mount()
    await type('login loop')
    await wait(1200)
    expect(rescores()).toHaveLength(1)
    expect(titles()).toEqual(['fixture-dev', 'Fixture thread'])
  })

  it('a rescored list stays at SUGGEST_LIMIT cards, and the arrow stays on the card it was on', async () => {
    // The thread the arrow lands on moves from second to fourth place in the rescored list.
    const others = Array.from({ length: 8 }, (_, i) => ({ kind: 'thread', id: `r${i}`, title: `Mail ${i}`, score: 0.9 - i / 100 }) as SearchResult)
    rescored = [others[0], others[1], others[2], RESULTS[1], ...others.slice(3)]
    await mount()
    await type('login loop')
    await wait(400)
    for (let i = 0; i < 2; i++) await act(async () => { box().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })) })
    expect(host.querySelector('.sg-card.sel')?.getAttribute('data-suggest')).toBe('thread:t1')
    await wait(600)
    expect(host.querySelectorAll('.sg-card')).toHaveLength(6)
    expect(host.querySelector('.sg-card.sel')?.getAttribute('data-suggest')).toBe('thread:t1')
  })
})
