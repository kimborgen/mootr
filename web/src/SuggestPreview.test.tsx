// @vitest-environment jsdom
// The suggestion preview (S-1910): a hold, right click or Alt+P on a card shows what it is; Esc closes
// it and leaves the list; Pick does what a tap on the card does.
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComposerHandle } from './Composer'
import { setData } from './store'
import { SuggestBar, } from './SuggestModal'
import { firstLines } from './SuggestPreview'
import { MenuLayer, hideMenu } from './ui/menu'
import type { SearchResult } from './types'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RESULTS: SearchResult[] = [
  { kind: 'thread', id: 't1', title: 'Which option', snippet: 'snippet', meta: 'you, fixture-dev', score: 0.9 },
  { kind: 'itsa', id: 'i1', title: 'Fixture issue', meta: 'F-1 · in_progress', score: 0.8 },
  { kind: 'agent', id: 'd1', title: 'fixture-dev', score: 0.7 },
]
let root: Root
let host: HTMLElement
beforeEach(() => {
  setData({
    agents: [{ id: 'd1', name: 'fixture-dev', role: '', type: 'developer', harness: 'claude', machine: 'm', lifecycle: 'active', activity: 'working', parents: [] } as never],
    itsas: [{ id: 'i1', key: 'F-1', title: 'Fixture issue', summary: 'Make the build pass', status: 'in_progress', owner: 'd1' } as never],
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }))
  vi.stubGlobal('fetch', vi.fn(async (path: string) => ({
    ok: true, status: 200,
    json: async () => path.startsWith('/api/suggest') ? RESULTS : path.startsWith('/api/threads/') ? [{ id: 'm1', from_id: 'a', from_name: 'fixture-dev', body: 'First line\nSecond line', recipients: [], created_at: '' }] : {},
  })))
})
afterEach(() => { act(() => hideMenu()); act(() => root.unmount()); host.remove(); vi.unstubAllGlobals() })

const wait = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)) })
const mount = async () => {
  await act(async () => { root.render(<><SuggestBar composerRef={createRef<ComposerHandle>()} context="Usage" /><MenuLayer /></>) })
  const box = host.querySelector<HTMLTextAreaElement>('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'fix the ')
    box.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await wait()
}
const card = (k: string) => host.querySelector<HTMLElement>(`[data-suggest="${k}"]`)!
const preview = () => document.querySelector<HTMLElement>('[data-preview]')

describe('suggestion preview', () => {
  it('firstLines keeps the first lines and collapses blank runs', () => {
    expect(firstLines('a\n\n\n\nb\nc', 3)).toBe('a\n\nb')
  })

  it('a right click on a mail card shows its sender and first lines; Esc closes it and keeps the list', async () => {
    await mount()
    await act(async () => { card('thread:t1').querySelector('.sg-pick')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    await wait()
    expect(preview()!.dataset.preview).toBe('thread:t1')
    expect(preview()!.textContent).toContain('fixture-dev')
    expect(preview()!.textContent).toContain('First line\nSecond line')
    await act(async () => { document.querySelector('.menu')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(preview()).toBeNull()
    expect(host.querySelectorAll('.sg-card')).toHaveLength(3)
    expect(host.querySelector('.sg-chip')).toBeNull()
  })

  it('Alt+P previews the highlighted ITSA, with status, owner and summary; Pick picks it', async () => {
    await mount()
    const ta = host.querySelector('textarea')!
    await act(async () => { card('itsa:i1').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); card('itsa:i1').dispatchEvent(new MouseEvent('mouseenter')) })
    await act(async () => { ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', altKey: true, bubbles: true, cancelable: true })) })
    expect(preview()!.dataset.preview).toBe('itsa:i1')
    expect(preview()!.textContent).toContain('in progress')
    expect(preview()!.textContent).toContain('fixture-dev')
    expect(preview()!.textContent).toContain('Make the build pass')
    await act(async () => { preview()!.querySelector<HTMLButtonElement>('[data-preview-pick]')!.click() })
    expect(preview()).toBeNull()
    expect(host.querySelector('.sg-chip[data-pick="itsa:i1"]')).not.toBeNull()
  })

  it('an agent shows its role and state', async () => {
    await mount()
    await act(async () => { card('agent:d1').querySelector<HTMLButtonElement>('[data-preview-btn]')!.click() })
    expect(preview()!.textContent).toContain('developer')
    expect(preview()!.textContent).toContain('working')
  })
})
