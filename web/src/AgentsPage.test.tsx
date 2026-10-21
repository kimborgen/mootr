// @vitest-environment jsdom
// The Agents page's desktop keys and saved view (S-1432): j and k move the cursor, Enter opens the picked agent but not
// from a button, / searches, Esc clears the search, and the view's grouping is saved as a settings record.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentsPage } from './AgentsPage'
import { api } from './api'
import { selectAgent } from './actions'
import { setAgentsView } from './agents-table-view'
import { setData } from './store'
import { agent } from './stories/fixtures'
import type { Agent } from './types'

vi.mock('./api', () => ({ api: vi.fn(async () => ({ text: '{}' })), sendAsHuman: vi.fn(), hash: new URLSearchParams() }))
vi.mock('./actions', async (orig) => ({ ...(await orig<typeof import('./actions')>()), selectAgent: vi.fn() }))
// The pane's own view has its own tests (views.test.tsx); here it shows only which agent it holds.
vi.mock('./views/DetailsView', async () => {
  const { createElement } = await import('react')
  return { DetailsView: ({ id }: { id: string }) => createElement('div', { 'data-details-for': id }) }
})

// A chief of staff with two children, so the tree shows three rows in a fixed order.
const AGENTS: Agent[] = [
  agent({ id: 'ka-cos', name: 'key-cos', chief_of_staff: true, created_at: '2026-10-01T09:00:00.000Z' }),
  agent({ id: 'ka-dev', name: 'key-dev', parents: ['ka-cos'], created_at: '2026-10-01T09:01:00.000Z' }),
  agent({ id: 'ka-test', name: 'key-test', parents: ['ka-cos'], created_at: '2026-10-01T09:02:00.000Z' }),
]

const roots: Root[] = []
beforeEach(() => {
  // No phone here: the desk page is the one under test.
  Object.defineProperty(window, 'matchMedia', { writable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
  setData({ agents: AGENTS, itsas: [], machine: 'key-machine', loaded: { agents: true, mail: true, itsas: true } } as never)
  // The pane is closed unless a test opens it: the test window's width is not measured.
  setAgentsView({ pane: undefined }, { remember: false })
})
afterEach(async () => {
  for (const r of roots.splice(0)) await act(async () => { r.unmount() })
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

// Mounts the desk page and returns its section.
async function mount(picked?: string) {
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  roots.push(root)
  await act(async () => { root.render(<AgentsPage picked={picked} />) })
  return el.querySelector<HTMLElement>('section.agents-desk')!
}
const press = async (target: Element, k: string) => { await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })) }) }
const picked = (el: HTMLElement) => el.querySelector('tr.sel')?.getAttribute('data-agent-row') ?? null

describe('the Agents page keys', () => {
  it('j and k move the cursor down and up the rows', async () => {
    const el = await mount()
    await press(el, 'j')
    expect(picked(el)).toBe('ka-cos')
    await press(el, 'j')
    expect(picked(el)).toBe('ka-dev')
    await press(el, 'k')
    expect(picked(el)).toBe('ka-cos')
  })

  it('Enter opens the picked agent', async () => {
    const el = await mount()
    await press(el, 'j')
    await press(el, 'j')
    await press(el, 'Enter')
    expect(selectAgent).toHaveBeenCalledWith('ka-dev')
  })

  it('Enter on a button does not open the picked agent', async () => {
    const el = await mount()
    await press(el, 'j')
    await press(el.querySelector('button[data-agents-cols]')!, 'Enter')
    expect(selectAgent).not.toHaveBeenCalled()
  })

  it('/ focuses the search, and Esc clears it and the rows come back', async () => {
    const el = await mount()
    await press(el, '/')
    const input = el.querySelector<HTMLInputElement>('.agents-search')!
    expect(document.activeElement).toBe(input)
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { set.call(input, 'dev'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(el.querySelectorAll('tr[data-agent-row]')).toHaveLength(2)
    await press(el, 'Escape')
    expect(input.value).toBe('')
    expect(el.querySelectorAll('tr[data-agent-row]')).toHaveLength(3)
  })
})

describe('the detail pane (S-3048)', () => {
  const pane = (el: HTMLElement) => el.querySelector<HTMLElement>('aside[data-agents-pane]')
  const shown = (el: HTMLElement) => pane(el)?.querySelector('[data-details-for]')?.getAttribute('data-details-for') ?? null

  it('arrow keys move the selection up and down the rows', async () => {
    const el = await mount()
    await press(el, 'ArrowDown')
    expect(picked(el)).toBe('ka-cos')
    await press(el, 'ArrowDown')
    expect(picked(el)).toBe('ka-dev')
    await press(el, 'ArrowUp')
    expect(picked(el)).toBe('ka-cos')
  })

  it('a row click selects it, and the pane shows that agent', async () => {
    const el = await mount()
    await act(async () => { setAgentsView({ pane: true }, { remember: false }) })
    await act(async () => { el.querySelector<HTMLElement>('tr[data-agent-row="ka-test"] .name')!.click() })
    expect(picked(el)).toBe('ka-test')
    expect(shown(el)).toBe('ka-test')
  })

  it('Space shows the pane with no selection as an empty state, and saves the choice', async () => {
    const el = await mount()
    expect(pane(el)).toBeNull()
    vi.useFakeTimers()
    try {
      await press(el, ' ')
      expect(pane(el)!.textContent).toContain('Select an agent')
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      const put = vi.mocked(api).mock.calls.find((c) => c[0] === 'PATCH')
      expect(put?.[2]).toMatchObject({ patch: { agentsTableCols: { main: { pane: true } } } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('Space hides an open pane', async () => {
    const el = await mount('ka-dev')
    await act(async () => { setAgentsView({ pane: true }, { remember: false }) })
    expect(pane(el)).not.toBeNull()
    await press(el, ' ')
    expect(pane(el)).toBeNull()
  })

  it('Space typed in the search box is left alone', async () => {
    const el = await mount()
    const input = el.querySelector<HTMLInputElement>('.agents-search')!
    await press(input, ' ')
    expect(pane(el)).toBeNull()
  })

  it('the pane opens on the picked agent the page was given', async () => {
    const el = await mount('ka-dev')
    await act(async () => { setAgentsView({ pane: true }, { remember: false }) })
    expect(shown(el)).toBe('ka-dev')
    expect(picked(el)).toBe('ka-dev')
  })

  it('a scope that no longer lists the picked agent clears the pick', async () => {
    const el = await mount()
    await press(el, 'j')
    expect(picked(el)).toBe('ka-cos')
    await act(async () => { el.querySelector<HTMLButtonElement>('button[data-scope-chip="archived"]')!.click() })
    expect(picked(el)).toBeNull()
    await act(async () => { el.querySelector<HTMLButtonElement>('button[data-scope-chip="live"]')!.click() })
  })
})

describe('the scope chips (S-2937)', () => {
  const chip = (el: HTMLElement, id: string) => el.querySelector<HTMLButtonElement>(`button[data-scope-chip="${id}"]`)!
  const click = async (b: HTMLElement) => { await act(async () => { b.click() }) }
  const RETIRED = Array.from({ length: 150 }, (_, i) => agent({ id: `re-${i}`, name: `key-old-${i}`, lifecycle: 'archived', created_at: '2026-09-01T09:00:00.000Z', updated_at: '2026-09-02T09:00:00.000Z' }))

  it('shows the four chips with their counts, Live picked, and the header count as the live count', async () => {
    setData({ agents: [...AGENTS, ...RETIRED.slice(0, 2)], itsas: [], machine: 'key-machine', loaded: { agents: true, mail: true, itsas: true } } as never)
    const el = await mount()
    expect(chip(el, 'live').getAttribute('aria-checked')).toBe('true')
    expect(chip(el, 'archived').textContent).toContain('2')
    expect(el.querySelector('[data-agents-count]')!.textContent).toContain('3 live')
  })

  it('a chip lists its agents, keeps the header count, and saves the scope in the view record', async () => {
    setData({ agents: [...AGENTS, ...RETIRED.slice(0, 2)], itsas: [], machine: 'key-machine', loaded: { agents: true, mail: true, itsas: true } } as never)
    const el = await mount()
    vi.useFakeTimers()
    try {
      await click(chip(el, 'archived'))
      expect(el.querySelectorAll('tr[data-agent-row]')).toHaveLength(2)
      expect(el.querySelector('[data-agents-count]')!.textContent).toContain('3 live')
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      const put = vi.mocked(api).mock.calls.find((c) => c[0] === 'PATCH')
      expect(put?.[2]).toMatchObject({ patch: { agentsTableCols: { main: { scope: 'archived' } } } })
    } finally {
      vi.useRealTimers()
      await click(chip(el, 'live'))
    }
  })

  it('pages a long archive, a hundred rows at a time', async () => {
    setData({ agents: [...AGENTS, ...RETIRED], itsas: [], machine: 'key-machine', loaded: { agents: true, mail: true, itsas: true } } as never)
    const el = await mount()
    await click(chip(el, 'archived'))
    expect(el.querySelectorAll('tr[data-agent-row]')).toHaveLength(100)
    const more = el.querySelector<HTMLButtonElement>('button[data-agents-more]')!
    expect(more.textContent).toBe('Show 50 more')
    await click(more)
    expect(el.querySelectorAll('tr[data-agent-row]')).toHaveLength(150)
    expect(el.querySelector('button[data-agents-more]')).toBeNull()
    await click(chip(el, 'live'))
  })

  it('says what an empty scope is', async () => {
    setData({ agents: AGENTS, itsas: [], machine: 'key-machine', loaded: { agents: true, mail: true, itsas: true } } as never)
    const el = await mount()
    await click(chip(el, 'archived'))
    expect(el.textContent).toContain('No archived agents.')
    await click(chip(el, 'live'))
  })
})

describe('the Agents view', () => {
  it('a grouping change is saved as the view record, under its id', async () => {
    await mount()
    vi.useFakeTimers()
    try {
      setAgentsView({ group: 'machine' })
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      const put = vi.mocked(api).mock.calls.find((c) => c[0] === 'PATCH')
      expect(put?.[2]).toMatchObject({ patch: { agentsTableCols: { main: { group: 'machine' } } } })
    } finally {
      vi.useRealTimers()
    }
  })
})
