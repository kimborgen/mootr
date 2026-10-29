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
import { MenuLayer, hideMenu, menuOpen, menuTrigger, showMenu } from './ui/menu'
import type { Agent } from './types'

vi.mock('./api', () => ({ api: vi.fn(async () => ({ text: '{}' })), sendAsHuman: vi.fn(), hash: new URLSearchParams() }))
vi.mock('./actions', async (orig) => ({ ...(await orig<typeof import('./actions')>()), selectAgent: vi.fn() }))
vi.mock('./spawn', async (orig) => ({ ...(await orig<typeof import('./spawn')>()), spawnMenu: vi.fn() }))
// The pane's own view has its own tests (views.test.tsx); here it shows only which agent it holds, and each agent it mounts
// for (a mount is a usage fetch in the real pane).
const { mounted } = vi.hoisted(() => ({ mounted: [] as string[] }))
vi.mock('./views/DetailsView', async () => {
  const { createElement, useEffect } = await import('react')
  return { DetailsView: ({ id }: { id: string }) => {
    useEffect(() => { mounted.push(id) }, [id])
    return createElement('div', { 'data-details-for': id })
  } }
})

// A chief of staff with two children, so the tree shows three rows in a fixed order.
const AGENTS: Agent[] = [
  agent({ id: 'ka-cos', name: 'key-cos', chief_of_staff: true, created_at: '2026-10-01T09:00:00.000Z' }),
  agent({ id: 'ka-dev', name: 'key-dev', parents: ['ka-cos'], created_at: '2026-10-01T09:01:00.000Z' }),
  agent({ id: 'ka-test', name: 'key-test', parents: ['ka-cos'], created_at: '2026-10-01T09:02:00.000Z' }),
]

// A live agent with a permission request open: it is in the Waiting scope.
const ASKING = agent({ id: 'ka-ask', name: 'key-ask', parents: ['ka-cos'], pending_requests: 1, created_at: '2026-10-01T09:03:00.000Z' })

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
  // The menu is shared state: a popover one test opens must not carry into the next.
  hideMenu()
  vi.clearAllMocks()
})

// Mounts the desk page, with the menu layer that draws its popovers, and returns its section.
async function mount(picked?: string) {
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  roots.push(root)
  await act(async () => { root.render(<><AgentsPage picked={picked} /><MenuLayer /></>) })
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

  it('Space with nothing picked changes nothing, and saves nothing', async () => {
    const el = await mount()
    vi.useFakeTimers()
    try {
      await press(el, ' ')
      expect(pane(el)).toBeNull()
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(vi.mocked(api).mock.calls.find((c) => c[0] === 'PATCH')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  // S-3616: the pane shows only with a pick, at any width and setting.
  describe('with a pick (S-3616)', () => {
    beforeEach(() => {
      vi.stubGlobal('ResizeObserver', function (cb: (entries: unknown[]) => void) {
        return { observe: () => cb([{ contentRect: { width: 1400 } }]), unobserve() {}, disconnect() {} }
      })
    })
    afterEach(() => { vi.unstubAllGlobals() })

    it('a 1400 px window with nothing picked has no pane', async () => {
      const el = await mount()
      expect(pane(el)).toBeNull()
      expect(el.textContent).not.toContain('Select an agent')
    })

    it('a pick opens it, and clearing the pick closes it at once', async () => {
      const el = await mount()
      await act(async () => { el.querySelector<HTMLElement>('tr[data-agent-row="ka-test"] .name')!.click() })
      expect(shown(el)).toBe('ka-test')
      await act(async () => { el.querySelector<HTMLButtonElement>('button[data-scope-chip="archived"]')!.click() })
      expect(picked(el)).toBeNull()
      expect(pane(el)).toBeNull()
      await act(async () => { el.querySelector<HTMLButtonElement>('button[data-scope-chip="live"]')!.click() })
      expect(picked(el)).toBeNull()
      expect(pane(el)).toBeNull()
    })

    it('Space with nothing picked does not stop the next pick opening the pane', async () => {
      const el = await mount()
      await press(el, ' ')
      await act(async () => { el.querySelector<HTMLElement>('tr[data-agent-row="ka-test"] .name')!.click() })
      expect(shown(el)).toBe('ka-test')
    })

    it('pane: false keeps a pick from opening it', async () => {
      const el = await mount()
      await act(async () => { setAgentsView({ pane: false }, { remember: false }) })
      await act(async () => { el.querySelector<HTMLElement>('tr[data-agent-row="ka-test"] .name')!.click() })
      expect(picked(el)).toBe('ka-test')
      expect(pane(el)).toBeNull()
    })
  })

  it('Space hides an open pane', async () => {
    const el = await mount('ka-dev')
    await act(async () => { setAgentsView({ pane: true }, { remember: false }) })
    expect(pane(el)).not.toBeNull()
    await press(el, ' ')
    expect(pane(el)).toBeNull()
  })

  it('Space typed in the search box is left alone', async () => {
    const el = await mount('ka-dev')
    await act(async () => { setAgentsView({ pane: true }, { remember: false }) })
    const input = el.querySelector<HTMLInputElement>('.agents-search')!
    await press(input, ' ')
    expect(pane(el)).not.toBeNull()
  })

  it('the pane opens on the picked agent the page was given', async () => {
    const el = await mount('ka-dev')
    await act(async () => { setAgentsView({ pane: true }, { remember: false }) })
    expect(shown(el)).toBe('ka-dev')
    expect(picked(el)).toBe('ka-dev')
  })

  it('a scope change that still lists the picked agent keeps the pick', async () => {
    setData({ agents: [...AGENTS, ASKING], itsas: [], machine: 'key-machine', loaded: { agents: true, mail: true, itsas: true } } as never)
    const el = await mount('ka-ask')
    await act(async () => { setAgentsView({ pane: true }, { remember: false }) })
    await act(async () => { el.querySelector<HTMLButtonElement>('button[data-scope-chip="waiting"]')!.click() })
    expect(picked(el)).toBe('ka-ask')
    expect(shown(el)).toBe('ka-ask')
    await act(async () => { el.querySelector<HTMLButtonElement>('button[data-scope-chip="live"]')!.click() })
  })

  it('Space on a button in the page is left alone, with the pane open or shut', async () => {
    const el = await mount('ka-dev')
    await press(el.querySelector('button[data-agents-cols]')!, ' ')
    expect(pane(el)).toBeNull()
    await act(async () => { setAgentsView({ pane: true }, { remember: false }) })
    await press(el.querySelector('button[data-agents-cols]')!, ' ')
    expect(pane(el)).not.toBeNull()
  })

  it.each(['shiftKey', 'ctrlKey', 'altKey', 'metaKey'] as const)('Space with %s held does not toggle the pane', async (mod) => {
    const el = await mount('ka-dev')
    await act(async () => { setAgentsView({ pane: true }, { remember: false }) })
    await act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', [mod]: true, bubbles: true })) })
    expect(pane(el)).not.toBeNull()
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

// The pane follows a key pick after PANE_PICK_WAIT (150 ms): holding an arrow key moves the row at once and mounts the pane
// (and its usage fetch) once, for the agent the key stops on. A click shows at once.
describe('the pane after a key pick (S-3088)', () => {

  it('five ArrowDowns in 100 ms mount the pane once, for the last agent', async () => {
    const el = await mount()
    await act(async () => { setAgentsView({ pane: true }, { remember: false }) })
    mounted.length = 0
    vi.useFakeTimers()
    try {
      for (let i = 0; i < 5; i++) {
        await press(el, 'ArrowDown')
        await act(async () => { await vi.advanceTimersByTimeAsync(20) })
      }
      expect(picked(el)).toBe('ka-test')
      expect(mounted).toEqual([])
      await act(async () => { await vi.advanceTimersByTimeAsync(150) })
      expect(mounted).toEqual(['ka-test'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a click shows the agent at once, with no wait', async () => {
    const el = await mount()
    await act(async () => { setAgentsView({ pane: true }, { remember: false }) })
    mounted.length = 0
    await act(async () => { el.querySelector<HTMLElement>('tr[data-agent-row="ka-test"] .name')!.click() })
    expect(mounted).toEqual(['ka-test'])
  })

  it('a pick cleared by a scope that drops it never mounts the pane for it', async () => {
    const el = await mount()
    await act(async () => { setAgentsView({ pane: true }, { remember: false }) })
    mounted.length = 0
    vi.useFakeTimers()
    try {
      await press(el, 'ArrowDown')
      await act(async () => { el.querySelector<HTMLButtonElement>('button[data-scope-chip="archived"]')!.click() })
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      expect(mounted).toEqual([])
    } finally {
      vi.useRealTimers()
      await act(async () => { el.querySelector<HTMLButtonElement>('button[data-scope-chip="live"]')!.click() })
    }
  })

  it('an unmount before the wait ends leaves no timer behind to mount the pane', async () => {
    const el = await mount()
    await act(async () => { setAgentsView({ pane: true }, { remember: false }) })
    mounted.length = 0
    vi.useFakeTimers()
    try {
      await press(el, 'ArrowDown')
      const root = roots.pop()!
      await act(async () => { root.unmount() })
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      expect(mounted).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

// The pane at the desk's width (S-3048): open from 1100 px on, and over the table below 900 px. jsdom has no ResizeObserver,
// so the stub reports the given width to each observed element.
describe('the pane at the desk width (S-3048)', () => {
  const atWidth = (w: number) => vi.stubGlobal('ResizeObserver', function (cb: (entries: unknown[]) => void) {
    return { observe: () => cb([{ contentRect: { width: w } }]), unobserve() {}, disconnect() {} }
  })
  const pane = (el: HTMLElement) => el.querySelector<HTMLElement>('aside[data-agents-pane]')
  const body = (el: HTMLElement) => el.querySelector<HTMLElement>('.agents-body')!
  afterEach(() => { vi.unstubAllGlobals() })

  it('opens the pane on a 1100 px desk, and keeps it shut at 1099 px', async () => {
    atWidth(1100)
    expect(pane(await mount('ka-dev'))).not.toBeNull()
    atWidth(1099)
    expect(pane(await mount('ka-dev'))).toBeNull()
  })

  it('lies over the table below 900 px, and beside it at 900 px', async () => {
    setAgentsView({ pane: true }, { remember: false })
    atWidth(899)
    const over = await mount('ka-dev')
    expect(pane(over)).not.toBeNull()
    expect(body(over).classList.contains('overlay')).toBe(true)
    atWidth(900)
    const beside = await mount('ka-dev')
    expect(body(beside).classList.contains('overlay')).toBe(false)
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

// The checked set (S-3117): x and the checkboxes check rows, Esc clears them, and the set keeps only the rows the table lists.
describe('the checked set (S-3117)', () => {
  // The scope a test chips to is kept in the view record, so each test starts on Live.
  beforeEach(() => { setAgentsView({ scope: 'live' }, { remember: false }) })
  const bar = (el: HTMLElement) => el.querySelector('[data-bulk-count]')?.textContent ?? null
  const checkedRows = (el: HTMLElement) => [...el.querySelectorAll('tr.chk')].map((r) => r.getAttribute('data-agent-row'))
  const box = async (el: HTMLElement, id: string) => { await act(async () => { el.querySelector<HTMLElement>(`tr[data-agent-row="${id}"] td.ac-check`)!.click() }) }
  const type = async (input: HTMLInputElement, text: string) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { set.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })) })
  }

  it('x checks the picked row, and the bar counts it', async () => {
    const el = await mount()
    await press(el, 'j')
    await press(el, 'x')
    expect(checkedRows(el)).toEqual(['ka-cos'])
    expect(bar(el)).toBe('1 selected')
    expect(picked(el)).toBe('ka-cos')
  })

  it('x does nothing with a modifier held, or while focus is in the search box', async () => {
    const el = await mount()
    await press(el, 'j')
    await act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', metaKey: true, bubbles: true })) })
    await act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', ctrlKey: true, bubbles: true })) })
    expect(checkedRows(el)).toEqual([])
    const input = el.querySelector<HTMLInputElement>('.agents-search')!
    await press(input, 'x')
    expect(checkedRows(el)).toEqual([])
    expect(el.querySelector('[data-agents-bulk]')).toBeNull()
  })

  it('Esc clears the checked rows, and a click on a checkbox keeps focus so Esc still reaches the page', async () => {
    const el = await mount()
    await box(el, 'ka-dev')
    await box(el, 'ka-test')
    expect(bar(el)).toBe('2 selected')
    await press(el, 'Escape')
    expect(el.querySelector('[data-agents-bulk]')).toBeNull()
    expect(checkedRows(el)).toEqual([])
  })

  it('a mousedown on a checkbox is not left to take focus', async () => {
    const el = await mount()
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    el.querySelector<HTMLElement>('tr[data-agent-row="ka-dev"] td.ac-check')!.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
  })

  it('a scope change clears the checked set', async () => {
    const el = await mount()
    await box(el, 'ka-dev')
    await act(async () => { el.querySelector<HTMLElement>('[data-scope-chip="archived"]')!.click() })
    expect(el.querySelector('[data-agents-bulk]')).toBeNull()
  })

  it('a poll that drops an agent prunes it from the set', async () => {
    const el = await mount()
    await box(el, 'ka-dev')
    await box(el, 'ka-test')
    await act(async () => { setData({ agents: AGENTS.filter((a) => a.id !== 'ka-test'), itsas: [], machine: 'key-machine', loaded: { agents: true, mail: true, itsas: true } } as never) })
    expect(checkedRows(el)).toEqual(['ka-dev'])
    expect(bar(el)).toBe('1 selected')
  })

  it('a search that hides a checked row drops it, so the bar covers only the rows shown', async () => {
    const el = await mount()
    await box(el, 'ka-dev')
    await type(el.querySelector<HTMLInputElement>('.agents-search')!, 'cos')
    expect(el.querySelector('[data-agents-bulk]')).toBeNull()
    await type(el.querySelector<HTMLInputElement>('.agents-search')!, '')
    expect(checkedRows(el)).toEqual([])
  })
})

// The header's machines strip and Spawn (S-3182).
describe('the Agents header machines and Spawn', () => {
  const GB = 1e9
  const machine = (name: string, cpu: number, ram: number, online = true) => ({
    name, online, ts: 0, cpu: { pct: cpu, cores: [cpu], count: 4 }, ram: { pct: ram, used: GB * ram / 10, total: 10 * GB },
    swap: { pct: 0, used: 0, total: 0 }, load: [0.5],
  })
  // jsdom has no layout, so the header's steps are measured from mocks. The header is `px` wide with `content` px of items.
  // Each form has the width below, the give-way items their CSS min-widths, and the gaps are 8 px. So the full header needs
  // 888 px (level 0), 722 (level 1, strip collapsed), 666 (level 2, Spawn as its plus), 493 (level 3, the scope select) and
  // 444 (level 4, title hidden); a step back is taken once the smaller form fits with 8 px to spare.
  const FORM_WIDTH: [string, number][] = [
    ['.agents-spawn.compact', 28], ['.agents-spawn', 84], ['.agents-scope-select', 120], ['.agents-scope', 293], ['.agents-title', 41],
    ['.mstrip-collapsed', 24], ['.mstrip', 190], ['.agents-count', 0], ['.agents-group', 96], ['.agents-search', 144],
  ]
  const MIN_WIDTH: [string, string][] = [['.agents-count', '0px'], ['.agents-group', '48px'], ['.agents-search', '120px']]
  const headerWidth = (px: number, content = px) => {
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) { return this.classList.contains('agents-head') ? px : 0 })
    vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (this: Element) { return this.classList.contains('agents-head') ? content : 0 })
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const width = this.classList.contains('agents-head') ? px : (FORM_WIDTH.find(([s]) => this.matches(s))?.[1] ?? 24)
      return { width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0, toJSON() {} } as DOMRect
    })
    const real = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => {
      if (!el.closest?.('.agents-head')) return real(el)
      return { columnGap: '8px', minWidth: MIN_WIDTH.find(([s]) => el.matches(s))?.[1] ?? '' } as unknown as CSSStyleDeclaration
    })
  }
  const withMachines = (machines: unknown[]) => act(async () => { setData({ agents: AGENTS, itsas: [], machines, machine: 'key-machine', loaded: { agents: true, mail: true, itsas: true } } as never) })
  // Draws the page again, as a poll does: the header judges one step after each draw, so several draws settle it.
  const redraw = async () => { for (let i = 0; i < 6; i++) await act(async () => { roots.at(-1)!.render(<><AgentsPage /><MenuLayer /></>) }) }
  const widen = (px: number) => { vi.restoreAllMocks(); headerWidth(px) }

  afterEach(() => { vi.restoreAllMocks() })

  it('the strip shows each machine with its CPU and RAM meters, and an offline one says off', async () => {
    await withMachines([machine('fixture-a', 62, 40), machine('fixture-b', 0, 0, false)])
    const el = await mount()
    const items = el.querySelectorAll('[data-machines-strip] .mstrip-item')
    expect(items.length).toBe(2)
    expect(items[0].querySelector('.mmeter[data-kind=cpu]')?.getAttribute('aria-label')).toBe('CPU 62%')
    expect(items[0].querySelector('.mmeter[data-kind=ram]')?.getAttribute('aria-label')).toBe('RAM 40%')
    expect(items[1].classList.contains('off')).toBe(true)
    expect(items[1].textContent).toContain('off')
  })

  it('a header that overflows keeps one Machines button, not the strip', async () => {
    headerWidth(200, 600)
    await withMachines([machine('fixture-a', 85, 40)])
    const el = await mount()
    expect(el.querySelector('[data-machines-strip]')).toBeNull()
    const button = el.querySelector<HTMLElement>('[data-machines-collapsed]')!
    expect(button.getAttribute('aria-label')).toBe('Machines, most used 85%')
  })

  it('a header that still overflows steps Spawn to its icon, then the scope to a select, then hides the title', async () => {
    headerWidth(200, 600)
    await withMachines([machine('fixture-a', 85, 40)])
    const el = await mount()
    const spawn = el.querySelector<HTMLElement>('[data-agents-spawn]')!
    expect(spawn.classList.contains('compact')).toBe(true)
    expect(spawn.getAttribute('aria-label')).toBe('Spawn agent')
    expect(el.querySelector('[data-scope-select]')).not.toBeNull()
    expect(el.querySelector('[data-scope-chip]')).toBeNull()
    expect(el.querySelector('.agents-title')).toBeNull()
  })

  it('a header wide enough for the strip draws it in full', async () => {
    headerWidth(1200)
    await withMachines([machine('fixture-a', 85, 40)])
    const el = await mount()
    expect(el.querySelector('[data-machines-strip]')).not.toBeNull()
    expect(el.querySelector('[data-machines-collapsed]')).toBeNull()
    expect(el.querySelector('[data-scope-select]')).toBeNull()
  })

  it('Spawn opens the spawn menu from the button', async () => {
    const { spawnMenu } = await import('./spawn')
    const el = await mount()
    const spawn = el.querySelector<HTMLElement>('[data-agents-spawn]')!
    await act(async () => { spawn.click() })
    expect(spawnMenu).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), {}, spawn)
  })

  it('the page keys do not fire from the Spawn button, though they move the cursor from the page', async () => {
    const el = await mount()
    const spawn = el.querySelector<HTMLElement>('[data-agents-spawn]')!
    await press(spawn, 'j')
    expect(picked(el)).toBeNull()
    await press(el, 'j')
    expect(picked(el)).toBe('ka-cos')
  })

  it('a header that widens again steps back to the full strip, Spawn with its label, the chips and the title', async () => {
    headerWidth(500, 900)
    await withMachines([machine('fixture-a', 85, 40)])
    const el = await mount()
    await redraw()
    expect(el.querySelector('[data-machines-collapsed]')).not.toBeNull()
    widen(1000)
    await redraw()
    expect(el.querySelector('[data-machines-strip]')).not.toBeNull()
    expect(el.querySelector('[data-agents-spawn]')!.classList.contains('compact')).toBe(false)
    expect(el.querySelector('[data-scope-chip]')).not.toBeNull()
    expect(el.querySelector('[data-scope-select]')).toBeNull()
    expect(el.querySelector('.agents-title')).not.toBeNull()
  })

  it('a header just short of the full strip stays collapsed, and draws it at exactly the needed width', async () => {
    headerWidth(500, 900)
    await withMachines([machine('fixture-a', 85, 40)])
    const el = await mount()
    await redraw()
    // Level 1 needs 722 and level 0 needs 888 with the slack: 895 is short by one step.
    widen(895)
    await redraw()
    await redraw()
    expect(el.querySelector('[data-machines-strip]')).toBeNull()
    expect(el.querySelector('[data-machines-collapsed]')).not.toBeNull()
    expect(el.querySelector('[data-agents-spawn]')!.classList.contains('compact')).toBe(false)
    widen(896)
    await redraw()
    expect(el.querySelector('[data-machines-strip]')).not.toBeNull()
  })

  it('a click on a machine opens its popover with the focus in it, and a second click closes it', async () => {
    vi.useFakeTimers()
    try {
      await withMachines([machine('fixture-a', 62, 40)])
      const el = await mount()
      const item = el.querySelector<HTMLElement>('[data-machines-strip] .mstrip-item')!
      await act(async () => { item.click() })
      await act(async () => { vi.advanceTimersByTime(500) })
      expect(menuOpen()).toBe(true)
      expect(menuTrigger()).toBe(item)
      expect(document.activeElement?.getAttribute('role')).toBe('dialog')
      await act(async () => { item.click() })
      expect(menuOpen()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('Escape closes the machine popover, and it stays closed when focus returns to its item', async () => {
    vi.useFakeTimers()
    try {
      await withMachines([machine('fixture-a', 62, 40)])
      const el = await mount()
      const item = el.querySelector<HTMLElement>('[data-machines-strip] .mstrip-item')!
      await act(async () => { item.click() })
      const pop = document.querySelector<HTMLElement>('.menu.popover')!
      await act(async () => { pop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
      expect(menuOpen()).toBe(false)
      await act(async () => { item.focus(); vi.advanceTimersByTime(500) })
      expect(menuOpen()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a pointer over a machine opens its popover without taking the focus from search, and leaving closes it', async () => {
    vi.useFakeTimers()
    try {
      await withMachines([machine('fixture-a', 62, 40)])
      const el = await mount()
      const search = el.querySelector<HTMLInputElement>('.agents-search')!
      search.focus()
      const item = el.querySelector<HTMLElement>('[data-machines-strip] .mstrip-item')!
      await act(async () => { item.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
      expect(menuOpen()).toBe(true)
      expect(document.activeElement).toBe(search)
      await act(async () => { item.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })) })
      await act(async () => { vi.advanceTimersByTime(300) })
      expect(menuOpen()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a pointer over a machine does not close another menu that is open, when the pointer leaves it', async () => {
    vi.useFakeTimers()
    try {
      await withMachines([machine('fixture-a', 62, 40), machine('fixture-b', 35, 55)])
      const el = await mount()
      const item = el.querySelector<HTMLElement>('[data-machines-strip] .mstrip-item')!
      // A hover opens and closes its popover first, so the machine was the last one a pointer left.
      await act(async () => { item.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
      await act(async () => { item.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })) })
      await act(async () => { vi.advanceTimersByTime(300) })
      expect(menuOpen()).toBe(false)
      const spawn = el.querySelector<HTMLElement>('[data-agents-spawn]')!
      await act(async () => { showMenu(0, 0, [{ label: 'Agent' }], spawn) })
      await act(async () => { item.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
      await act(async () => { item.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })) })
      await act(async () => { vi.advanceTimersByTime(300) })
      expect(menuOpen()).toBe(true)
      expect(menuTrigger()).toBe(spawn)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a pointer moved from one machine to the next shows the next machine, once the timers run', async () => {
    vi.useFakeTimers()
    try {
      await withMachines([machine('fixture-a', 62, 40), machine('fixture-b', 35, 55)])
      const el = await mount()
      const [a, b] = [...el.querySelectorAll<HTMLElement>('[data-machines-strip] .mstrip-item')]
      await act(async () => { a.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
      await act(async () => { a.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: b })) })
      await act(async () => { b.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: a })) })
      await act(async () => { vi.advanceTimersByTime(300) })
      expect(menuOpen()).toBe(true)
      expect(menuTrigger()).toBe(b)
      expect(document.querySelector('.machines-pop')?.getAttribute('data-machine')).toBe('fixture-b')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a pointer that returns to its machine within the close delay keeps the popover open', async () => {
    vi.useFakeTimers()
    try {
      await withMachines([machine('fixture-a', 62, 40)])
      const el = await mount()
      const item = el.querySelector<HTMLElement>('[data-machines-strip] .mstrip-item')!
      await act(async () => { item.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
      const pop = document.querySelector<HTMLElement>('.machines-pop')!
      // The pointer goes from the machine into its popover, and back to the machine within the close delay.
      await act(async () => { item.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: pop })) })
      await act(async () => { vi.advanceTimersByTime(100) })
      await act(async () => { pop.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: item })) })
      await act(async () => { vi.advanceTimersByTime(300) })
      expect(menuOpen()).toBe(true)
      expect(menuTrigger()).toBe(item)
    } finally {
      vi.useRealTimers()
    }
  })
})
