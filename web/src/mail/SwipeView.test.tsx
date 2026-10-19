// @vitest-environment jsdom
// The Swipe view (S-1003): the keys act on the top card through the inbox's own calls, a thread
// that waits on the human's answer stays, leaving changes nothing on the server, and archiving a
// thread opened from the stack comes back to it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'

// The polls after a change never answer, so the fixture stays the data.
const api = vi.fn((method: string) => (method === 'GET' ? new Promise(() => {}) : Promise.resolve({})))
vi.mock('../api', () => ({ api: (...a: unknown[]) => (api as (...b: unknown[]) => unknown)(...a), hash: new URLSearchParams() }))
let world: string | null = 'w:swipe'
vi.mock('../shell/layout', async (orig) => ({ ...(await orig<object>()), currentWorld: () => world, showAgentWorld: (id: string | null) => { world = id } }))

const thread = (id: string, at: string) => ({ thread_id: id, mails: [{ id: 'm-' + id, from_id: 'a1', from_name: 'fixture-dev', subject: 'About ' + id, body: '', created_at: at, recipients: [{ id: 'human', read_at: null }] }] })
const statuses = [{ name: 'needs_input', category: 'active', human: true }]
const top = (el: HTMLElement) => el.querySelector<HTMLElement>('.swipe-top')?.dataset.card
const key = (k: string) => act(async () => { dispatchEvent(new KeyboardEvent('keydown', { key: k })) })
const calls = () => api.mock.calls.filter((c) => c[0] !== 'GET').map((c) => String((c as unknown[])[1]))

let unmount: (() => void) | null = null
async function mount(threads: ReturnType<typeof thread>[], attention: unknown[] = []) {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const store = await import('../store')
  const { SwipeView } = await import('./SwipeView')
  store.setData({ humanThreads: threads, humanArchived: [], humanDeferred: [], attention, decisions: [], itsas: [], itsaStatuses: statuses, loaded: { agents: true, mail: true, itsas: true } } as never)
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  unmount = () => act(() => root.unmount())
  await act(async () => { root.render(<SwipeView />) })
  return el
}

describe('the Swipe view', () => {
  afterEach(() => { unmount?.(); unmount = null })
  beforeEach(() => { vi.resetModules(); api.mockClear(); world = 'w:swipe'; document.body.innerHTML = '' })

  it('stacks the newest thread on top and archives it with the left arrow', async () => {
    const el = await mount([thread('old', '2026-10-15T08:00:00Z'), thread('new', '2026-10-15T09:00:00Z')])
    expect(top(el)).toBe('new')
    expect(el.querySelector('[data-swipe-count]')?.textContent).toBe('2 in your inbox')
    await key('ArrowLeft')
    expect(calls()).toContain('/api/agents/human/threads/new/archive')
    expect(top(el)).toBe('old')
    expect(el.querySelector('[data-swipe-last]')?.textContent).toContain('Archived')
  })

  it('a tap on a link in the card follows the link alone; a tap elsewhere opens the thread', async () => {
    const t = thread('md', '2026-10-15T09:00:00Z')
    ;(t.mails[0] as { summary?: string }).summary = 'See [the report](#report) now'
    const el = await mount([t])
    const card = el.querySelector<HTMLElement>('.swipe-top')!
    const tap = (target: Element) => act(async () => { target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    const opened = () => world
    await tap(card.querySelector('a')!)
    expect(opened()).toBe('w:swipe')
    await tap(card.querySelector('.mc-title')!)
    expect(opened()).not.toBe('w:swipe')
  })

  it('names a left card in plain text in the undo notice', async () => {
    const t = thread('md2', '2026-10-15T09:00:00Z')
    ;(t.mails[0] as { body: string }).body = '## Build **green**\n\n[Report](https://example.com/report)'
    const el = await mount([t, thread('b', '2026-10-15T08:00:00Z')])
    await key('ArrowRight')
    const last = el.querySelector('[data-swipe-last]')?.textContent ?? ''
    expect(last).toContain('Build green')
    expect(last).not.toMatch(/\*\*|\]\(|##/)
  })

  it('links an ITSA key in the title and the text once the ITSAs load, and follows a status change', async () => {
    const mb = await import('./mailblocks')
    const itsa = await import('../itsa/itsa')
    mb.configure({ itsa: itsa.itsaKeyLink })
    const t = thread('late', '2026-10-15T09:00:00Z')
    t.mails[0].subject = 'Status of S-123'
    ;(t.mails[0] as { summary?: string }).summary = 'Waiting on S-123'
    const el = await mount([t])
    expect(el.querySelector('[data-open-itsa]')).toBeNull()
    const store = await import('../store')
    const itsaRow = (status: string) => ({ id: 'i123', key: 'S-123', title: 'Late issue', status })
    await act(async () => { store.setData({ itsas: [itsaRow('needs_input')] } as never) })
    expect(el.querySelector('.mc-title [data-open-itsa="i123"]')).not.toBeNull()
    expect(el.querySelector('.mc-text [data-open-itsa="i123"]')).not.toBeNull()
    const before = el.querySelector('.mc-title [data-open-itsa="i123"]')!.innerHTML
    await act(async () => { store.setData({ itsas: [itsaRow('done')] } as never) })
    expect(el.querySelector('.mc-title [data-open-itsa="i123"]')!.innerHTML).not.toBe(before)
  })

  it('defers with the up arrow, and undo moves it back', async () => {
    const el = await mount([thread('a', '2026-10-15T09:00:00Z'), thread('b', '2026-10-15T08:00:00Z')])
    await key('ArrowUp')
    expect(calls()).toContain('/api/agents/human/threads/a/defer')
    await key('z')
    expect(calls()).toContain('/api/agents/human/threads/a/undefer')
    expect(top(el)).toBe('a')
  })

  it('leaves a card with the right arrow: the next is on top, and the server hears nothing', async () => {
    const el = await mount([thread('a', '2026-10-15T09:00:00Z'), thread('b', '2026-10-15T08:00:00Z')])
    await key('ArrowRight')
    expect(top(el)).toBe('b')
    await key('ArrowRight')
    expect(top(el)).toBe('a')
    expect(calls()).toEqual([])
  })

  it("keeps a thread that waits on the human's answer on archive, and disables its archive but not its defer", async () => {
    const el = await mount([thread('ask', '2026-10-15T09:00:00Z')], [{ id: 'i1', key: 'S-1', title: 'x', status: 'needs_input', ask_thread_id: 'ask', since: '2026-10-15T09:00:00Z', actions: [] }])
    await key('ArrowLeft')
    expect(calls()).toEqual([])
    expect(top(el)).toBe('ask')
    expect(el.querySelector<HTMLButtonElement>('[data-swipe-act=archive]')?.disabled).toBe(true)
    expect(el.querySelector<HTMLButtonElement>('[data-swipe-act=defer]')?.disabled).toBe(false)
    expect(el.querySelector('[data-chip=ask]')?.textContent).toContain('S-1')
    await key('ArrowUp')
    expect(calls()).toContain('/api/agents/human/threads/ask/defer')
  })

  it('opens the top thread with Enter; archiving it there comes back to the stack', async () => {
    await mount([thread('a', '2026-10-15T09:00:00Z'), thread('b', '2026-10-15T08:00:00Z')])
    await key('Enter')
    expect(world).toBe('t:a')
    const actions = await import('../actions')
    await act(async () => { await actions.archiveThreadAndAdvance('a') })
    expect(world).toBe('w:swipe')
  })

  // Review of #340: keys another part of the page handles, and mail arriving mid-read.
  it("doesn't act on arrow keys the focused agent tree handled", async () => {
    const el = await mount([thread('a', '2026-10-15T09:00:00Z'), thread('b', '2026-10-15T08:00:00Z')])
    const tree = document.createElement('div')
    tree.setAttribute('role', 'tree'); tree.tabIndex = 0
    tree.addEventListener('keydown', (e) => e.preventDefault())
    document.body.append(tree)
    await act(async () => { tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })) })
    await act(async () => { tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })) })
    tree.focus()
    await key('ArrowLeft')
    expect(calls()).toEqual([])
    expect(top(el)).toBe('a')
  })

  it('keeps the card being read on top when new mail arrives; the new one is next', async () => {
    const el = await mount([thread('a', '2026-10-15T09:00:00Z')])
    expect(top(el)).toBe('a')
    const store = await import('../store')
    await act(async () => { store.setData({ ...store.getData(), humanThreads: [thread('a', '2026-10-15T09:00:00Z'), thread('n', '2026-10-15T10:00:00Z')] } as never) })
    expect(top(el)).toBe('a')
    await key('ArrowRight')
    expect(top(el)).toBe('n')
  })

  // Review of #340: the button that opened the view keeps focus; the view takes it, so the keys work at once.
  it('takes focus when it opens, so the keys work right after the Swipe button', async () => {
    const btn = document.createElement('button')
    btn.setAttribute('data-swipe-toggle', '')
    document.body.append(btn)
    btn.focus()
    const el = await mount([thread('a', '2026-10-15T09:00:00Z'), thread('b', '2026-10-15T08:00:00Z')])
    expect(el.querySelector('.swipe-view')!.contains(document.activeElement)).toBe(true)
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })) })
    expect(calls()).toContain('/api/agents/human/threads/a/archive')
  })

  it("doesn't take focus from a text box", async () => {
    const input = document.createElement('textarea')
    document.body.append(input)
    input.focus()
    await mount([thread('a', '2026-10-15T09:00:00Z')])
    expect(document.activeElement).toBe(input)
  })

  // S-1310: archiving a Decision or Blocker card asks first; defer, leave and other kinds don't.
  const kinded = (id: string, kind: string) => {
    const t = thread(id, '2026-10-15T09:00:00Z')
    return { ...t, mails: [{ ...t.mails[0], verdict: { follows: true, score: 1, concise: null, fluff: null, value: null, kind, at: '2026-10-15T09:00:00Z' } }] } as unknown as ReturnType<typeof thread>
  }
  const archived = (id: string) => '/api/agents/human/threads/' + id + '/archive'

  it('asks before archiving a blocker card, and Enter confirms; undo still works', async () => {
    const el = await mount([kinded('b', 'blocker'), thread('x', '2026-10-15T08:00:00Z')])
    await key('ArrowLeft')
    expect(calls()).toEqual([])
    expect(top(el)).toBe('b')
    expect(el.querySelector('[data-swipe-confirm]')?.textContent).toContain('Archive this blocker?')
    await key('Enter')
    expect(calls()).toContain(archived('b'))
    expect(top(el)).toBe('x')
    expect(el.querySelector('[data-swipe-confirm]')).toBeNull()
    await key('z')
    expect(calls()).toContain('/api/agents/human/threads/b/unarchive')
  })

  it('asks for a decision card by the Archive button; Cancel keeps the card', async () => {
    const el = await mount([kinded('d', 'decision')])
    await act(async () => { el.querySelector<HTMLButtonElement>('[data-swipe-act=archive]')!.click() })
    expect(el.querySelector('[data-swipe-confirm]')?.textContent).toContain('Archive this decision?')
    await act(async () => { el.querySelector<HTMLButtonElement>('[data-swipe-confirm-cancel]')!.click() })
    expect(el.querySelector('[data-swipe-confirm]')).toBeNull()
    expect(top(el)).toBe('d')
    expect(calls()).toEqual([])
    await key('ArrowLeft')
    await key('Escape')
    expect(el.querySelector('[data-swipe-confirm]')).toBeNull()
    expect(calls()).toEqual([])
    await key('ArrowLeft')
    await act(async () => { el.querySelector<HTMLButtonElement>('[data-swipe-confirm-yes]')!.click() })
    expect(calls()).toContain(archived('d'))
  })

  it('lets Enter on the focused Cancel button cancel instead of archiving', async () => {
    const el = await mount([kinded('b', 'blocker')])
    await key('ArrowLeft')
    const cancel = el.querySelector<HTMLButtonElement>('[data-swipe-confirm-cancel]')!
    cancel.focus()
    await act(async () => { cancel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    expect(calls()).toEqual([])
    await act(async () => { cancel.click() })
    expect(el.querySelector('[data-swipe-confirm]')).toBeNull()
    expect(top(el)).toBe('b')
    expect(calls()).toEqual([])
  })

  it('lets Enter on the focused Undo button undo instead of opening the thread', async () => {
    const el = await mount([kinded('g', 'update'), thread('x', '2026-10-15T08:00:00Z')])
    await key('ArrowLeft')
    const undo = el.querySelector<HTMLButtonElement>('[data-swipe-undo]')!
    undo.focus()
    await act(async () => { undo.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    expect(world).toBe('w:swipe')
    expect(calls().filter((c) => c.endsWith('/unarchive'))).toEqual([])
    await act(async () => { undo.click() })
    expect(calls()).toContain('/api/agents/human/threads/g/unarchive')
    expect(top(el)).toBe('g')
  })

  it('archives done and general cards directly', async () => {
    const el = await mount([kinded('g', 'update'), kinded('n', 'done'), thread('p', '2026-10-15T07:00:00Z')])
    await key('ArrowLeft')
    await key('ArrowLeft')
    await key('ArrowLeft')
    expect(el.querySelector('[data-swipe-confirm]')).toBeNull()
    expect(calls().filter((c) => c.endsWith('/archive')).length).toBe(3)
  })

  it('never asks on defer or leave', async () => {
    const el = await mount([kinded('b', 'blocker'), kinded('d', 'decision')])
    await key('ArrowUp')
    expect(calls()).toContain('/api/agents/human/threads/b/defer')
    await key('ArrowRight')
    expect(el.querySelector('[data-swipe-confirm]')).toBeNull()
  })

  it('refuses a thread that waits on the human before any confirm', async () => {
    const el = await mount([thread('ask', '2026-10-15T09:00:00Z')], [{ id: 'i1', key: 'S-1', title: 'x', status: 'needs_input', ask_thread_id: 'ask', since: '2026-10-15T09:00:00Z', actions: [] }])
    await key('ArrowLeft')
    expect(el.querySelector('[data-swipe-confirm]')).toBeNull()
  })

  it('shows the empty state when nothing is left', async () => {
    const el = await mount([])
    expect(el.querySelector('[data-swipe-empty]')?.textContent).toContain('Nothing left to swipe')
  })
})
