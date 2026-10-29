// @vitest-environment jsdom
// The phone Agents list (S-1432): a row per agent in the tree's order, indented 12 px a level and capped at 3, a tap opens
// the agent, and a long press opens its menu without the tap that follows it. The phone is the matchMedia the page reads.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentsPage } from './AgentsPage'
import { api } from './api'
import { selectAgent } from './actions'
import { setAgentsView } from './agents-table-view'
import { setData } from './store'
import { getUi, setUi } from './ui/state'
import { agent } from './stories/fixtures'
import { MenuLayer, hideMenu, menuOpen, toast } from './ui/menu'
import type { Agent } from './types'

vi.mock('./api', () => ({ api: vi.fn(async () => ({ text: '{}' })), sendAsHuman: vi.fn(), hash: new URLSearchParams() }))
vi.mock('./actions', async (orig) => ({ ...(await orig<typeof import('./actions')>()), selectAgent: vi.fn() }))
vi.mock('./spawn', async (orig) => ({ ...(await orig<typeof import('./spawn')>()), spawnMenu: vi.fn() }))
vi.mock('./ui/menu', async (orig) => ({ ...(await orig<typeof import('./ui/menu')>()), toast: vi.fn() }))

// A chain five deep: the fifth agent is past the indent cap.
const CHAIN: Agent[] = Array.from({ length: 5 }, (_, i) => agent({
  id: `ch-${i}`, name: `key-${i}`, parents: i ? [`ch-${i - 1}`] : undefined, created_at: `2026-10-01T09:0${i}:00.000Z`,
}))

const roots: Root[] = []
beforeEach(() => {
  vi.useFakeTimers()
  Object.defineProperty(window, 'matchMedia', { writable: true, value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) })
  setData({ agents: CHAIN, itsas: [], machine: 'key-machine', loaded: { agents: true, mail: true, itsas: true } } as never)
  setAgentsView({ scope: 'live', pane: undefined }, { remember: false })
  setUi({ collapsed: {}, agentSelect: false })
})
afterEach(async () => {
  for (const r of roots.splice(0)) await act(async () => { r.unmount() })
  document.body.innerHTML = ''
  hideMenu()
  vi.useRealTimers()
  vi.clearAllMocks()
})

async function mount() {
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  roots.push(root)
  await act(async () => { root.render(<><AgentsPage /><MenuLayer /></>) })
  return el.querySelector<HTMLElement>('section.agents-phone')!
}
const rowOf = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`.arow[data-id="${id}"]`)!
const pointer = async (target: Element, type: string, x = 10, y = 10) => {
  await act(async () => { target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: 'touch', clientX: x, clientY: y })) })
}

describe('the phone Agents list', () => {
  it('lists the tree in its order, indented 12 px a level and capped at 3', async () => {
    const el = await mount()
    const pads = ['ch-0', 'ch-1', 'ch-2', 'ch-3', 'ch-4'].map((id) => (rowOf(el, id) as HTMLElement).style.paddingLeft)
    expect(pads).toEqual(['8px', '20px', '32px', '44px', '44px'])
  })

  it('shows the parent hint only past the cap', async () => {
    const el = await mount()
    expect(rowOf(el, 'ch-3').querySelector('.arow-parent')).toBeNull()
    expect(rowOf(el, 'ch-4').querySelector('.arow-parent')?.textContent).toContain('key-3')
  })

  it('shows a parent its activity on line 2, and its child count only while folded', async () => {
    setData({ agents: [{ ...CHAIN[0], activity_detail: 'reviewing the plan', waits: [{ kind: 'children', detail: '4 children' }] } as Agent, ...CHAIN.slice(1)], itsas: [], machine: 'key-machine', loaded: { agents: true, mail: true, itsas: true } } as never)
    const el = await mount()
    expect(rowOf(el, 'ch-0').querySelector('.arow-state')?.textContent).toBe('reviewing the plan')
    expect(rowOf(el, 'ch-0').querySelector('.arow-kids')).toBeNull()
  })

  it('shows a parent its own and tree cost, and a leaf only its own', async () => {
    const cost = (own: number, tree: number) => ({ mode: 'api', own: { api: own, five_hour: null, seven_day: null, subscription: null, paid_usd: 0 }, tree: { api: tree, five_hour: null, seven_day: null, subscription: null, paid_usd: 0 } })
    setData({ agents: CHAIN.map((a) => (a.id === 'ch-0' ? { ...a, cost: cost(160, 352) } : a.id === 'ch-4' ? { ...a, cost: cost(7, 7) } : a)), itsas: [], machine: 'key-machine', loaded: { agents: true, mail: true, itsas: true } } as never)
    const el = await mount()
    expect(rowOf(el, 'ch-0').querySelector('.arow-cost > [aria-hidden="true"]')?.textContent).toBe('$160/$352')
    expect(rowOf(el, 'ch-0').querySelector('.sr-only')?.textContent).toBe('own $160, tree $352')
    expect(rowOf(el, 'ch-4').querySelector('.sr-only')?.textContent).toBe('$7.0')
  })

  it('folds a row with its chevron: its children hide, the count shows, and unfolding shows them again', async () => {
    const el = await mount()
    await act(async () => { rowOf(el, 'ch-0').querySelector<HTMLElement>('[data-chev]')!.click() })
    expect(rowOf(el, 'ch-1')).toBeNull()
    expect(rowOf(el, 'ch-0').querySelector('.arow-kids')?.textContent).toBe('1 child')
    await act(async () => { rowOf(el, 'ch-0').querySelector<HTMLElement>('[data-chev]')!.click() })
    expect(rowOf(el, 'ch-1')).not.toBeNull()
    expect(rowOf(el, 'ch-0').querySelector('.arow-kids')).toBeNull()
  })

  it('keeps a folded archived parent foldable in the Archived scope, as its children are hidden there', async () => {
    setData({ agents: [
      agent({ id: 'ar-p', name: 'key-archived-parent', lifecycle: 'archived', created_at: '2026-10-01T09:00:00.000Z' }),
      agent({ id: 'ar-c', name: 'key-archived-child', lifecycle: 'archived', parents: ['ar-p'], created_at: '2026-10-01T09:01:00.000Z' }),
    ], itsas: [], machine: 'key-machine', loaded: { agents: true, mail: true, itsas: true } } as never)
    setAgentsView({ scope: 'archived' }, { remember: false })
    setUi({ collapsed: { 'ar-p': true } })
    const el = await mount()
    expect(rowOf(el, 'ar-c')).toBeNull()
    expect(rowOf(el, 'ar-p').querySelector('[data-chev]')).not.toBeNull()
  })

  it('opens the agent on a tap', async () => {
    const el = await mount()
    await act(async () => { rowOf(el, 'ch-1').querySelector<HTMLElement>('.arow-main')!.click() })
    expect(selectAgent).toHaveBeenCalledWith('ch-1')
  })

  it('opens the menu on a long press, and the tap after it does not fire', async () => {
    const el = await mount()
    const main = rowOf(el, 'ch-2').querySelector<HTMLElement>('.arow-main')!
    await pointer(main, 'pointerdown')
    await act(async () => { vi.advanceTimersByTime(500) })
    expect(menuOpen()).toBe(true)
    await pointer(main, 'pointerup')
    await act(async () => { main.click() })
    expect(selectAgent).not.toHaveBeenCalled()
  })

  it('cancels a long press when the finger moves past the slop', async () => {
    const el = await mount()
    const main = rowOf(el, 'ch-2').querySelector<HTMLElement>('.arow-main')!
    await pointer(main, 'pointerdown', 10, 10)
    await pointer(main, 'pointermove', 40, 10)
    await act(async () => { vi.advanceTimersByTime(500) })
    expect(menuOpen()).toBe(false)
  })
})

// Select mode (S-3282): a tap checks a row, Select all and Done are in the header, and the checked set keeps by id.
describe('the phone select mode', () => {
  const enter = async (el: HTMLElement) => { await act(async () => { el.querySelector<HTMLElement>('[data-select-on]')!.click() }) }
  const tap = async (el: HTMLElement, id: string) => { await act(async () => { el.querySelector<HTMLElement>(`.arow[data-id="${id}"] .arow-main`)!.click() }) }
  const count = (el: HTMLElement) => el.querySelector('[data-select-count]')?.textContent
  const checkedIds = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.arow.on')].map((r) => r.dataset.id)

  it('Select shows the header of select mode, and a tap checks the row without opening the agent', async () => {
    const el = await mount()
    expect(el.querySelector('[data-agents-count]')).not.toBeNull()
    await enter(el)
    expect(count(el)).toBe('0 selected')
    expect(el.querySelector('[data-agents-count]')).toBeNull()
    await tap(el, 'ch-1')
    expect(selectAgent).not.toHaveBeenCalled()
    expect(count(el)).toBe('1 selected')
    expect(checkedIds(el)).toEqual(['ch-1'])
    expect(rowOf(el, 'ch-1').querySelector('input')?.checked).toBe(true)
  })

  it('Select all checks every listed row, and Done leaves select mode and clears the set', async () => {
    const el = await mount()
    await enter(el)
    await act(async () => { el.querySelector<HTMLElement>('[data-select-all]')!.click() })
    expect(count(el)).toBe('5 selected')
    await act(async () => { el.querySelector<HTMLElement>('[data-select-done]')!.click() })
    expect(el.querySelector('[data-select-count]')).toBeNull()
    expect(el.querySelector('.arow.on')).toBeNull()
    expect(el.querySelector('[data-agents-count]')).not.toBeNull()
  })

  it('leaving the list by any route ends select mode, so it never outlives the list', async () => {
    const el = await mount()
    await enter(el)
    expect(getUi().agentSelect).toBe(true)
    await act(async () => { roots.pop()!.unmount() })
    expect(getUi().agentSelect).toBe(false)
  })

  it('Esc leaves select mode without leaving the page', async () => {
    const el = await mount()
    await enter(el)
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(getUi().agentSelect).toBe(false)
    expect(el.isConnected).toBe(true)
    expect(el.querySelector('[data-agents-count]')).not.toBeNull()
  })

  it('keeps the checked ids through a poll that brings new objects, and drops an id that leaves the list', async () => {
    const el = await mount()
    await enter(el)
    await tap(el, 'ch-1')
    await tap(el, 'ch-3')
    await act(async () => {
      setData({ agents: CHAIN.filter((a) => a.id !== 'ch-3').map((a) => ({ ...a })), itsas: [], machine: 'key-machine', loaded: { agents: true, mail: true, itsas: true } } as never)
    })
    expect(count(el)).toBe('1 selected')
    expect(checkedIds(el)).toEqual(['ch-1'])
  })

  it('a tap on a disabled action says why in the summary line, and checks nothing', async () => {
    const el = await mount()
    await enter(el)
    await tap(el, 'ch-1')
    await act(async () => { el.ownerDocument.querySelector<HTMLElement>('[data-bulk="resume"]')!.click() })
    expect(toast).toHaveBeenCalledWith('None of the 1 can resume: all are running or archived')
    expect(api).not.toHaveBeenCalledWith('POST', expect.stringMatching(/resume$/))
  })

  it('acts on the kept selection after a poll, and the action leaves select mode open', async () => {
    const el = await mount()
    await enter(el)
    await tap(el, 'ch-1')
    await act(async () => { setData({ agents: CHAIN.map((a) => ({ ...a })), itsas: [], machine: 'key-machine', loaded: { agents: true, mail: true, itsas: true } } as never) })
    await act(async () => { el.ownerDocument.querySelector<HTMLElement>('[data-bulk="pause"]')!.click() })
    expect(api).toHaveBeenCalledWith('POST', '/api/agents/ch-1/pause')
    expect(getUi().agentSelect).toBe(true)
    expect(checkedIds(el)).toEqual(['ch-1'])
  })
})

// One source of truth (S-3282): the same agents checked on the desk and on the phone give the same bar, with the same
// counts and the same disabled buttons.
describe('the bulk bar on the desk and the phone', () => {
  // Each action by its name, its count and whether it is disabled: the phone's icons and the desk's words show the same.
  const labels = (root: ParentNode) => [...root.querySelectorAll<HTMLButtonElement>('[data-bulk]')].map((b) => `${b.dataset.bulk}:${b.dataset.count ?? ''}:${b.disabled}`)
  it('shows the same counts and disabled buttons for the same checked agents', async () => {
    // A paused agent in the set: pause applies to the other two, resume only to it.
    setData({ agents: [...CHAIN.slice(0, 3)].map((a, i) => (i === 2 ? { ...a, lifecycle: 'paused' } : a)), itsas: [], machine: 'key-machine', loaded: { agents: true, mail: true, itsas: true } } as never)
    const phone = await mount()
    await act(async () => { phone.querySelector<HTMLElement>('[data-select-on]')!.click() })
    for (const id of ['ch-0', 'ch-1', 'ch-2']) await act(async () => { phone.querySelector<HTMLElement>(`.arow[data-id="${id}"] .arow-main`)!.click() })
    const phoneBar = labels(phone.ownerDocument.querySelector('[data-agents-bulk]')!)
    await act(async () => { for (const r of roots.splice(0)) r.unmount() })
    document.body.innerHTML = ''

    Object.defineProperty(window, 'matchMedia', { writable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
    setUi({ agentSelect: false })
    const desk = document.createElement('div')
    document.body.append(desk)
    const root = createRoot(desk)
    roots.push(root)
    await act(async () => { root.render(<><AgentsPage /><MenuLayer /></>) })
    for (const id of ['ch-0', 'ch-1', 'ch-2']) await act(async () => { desk.querySelector<HTMLElement>(`tr[data-agent-row="${id}"] td.ac-check`)!.click() })
    const deskBar = labels(desk.querySelector('[data-agents-bulk]')!)
    // Clear is the desk's alone: the phone's header has Done, which leaves the selection.
    expect(phoneBar).toEqual(deskBar.filter((l) => !l.startsWith('clear:')))
    expect(deskBar).toContain('pause:2:false')
    expect(deskBar).toContain('resume:1:false')
    expect(deskBar).toContain('archive:3:false')
  })
})
