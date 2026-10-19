// The saved view tabs (S-1517): Default first, one click switches, a dot marks a view edited since it was saved,
// and the View menu's Save and Revert. On a phone the glance header holds the view picker.
// @vitest-environment jsdom
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Field } from '../itsa/fields'

const apiMock = vi.hoisted(() => vi.fn())
vi.mock('../api', () => ({ api: apiMock }))

import type { Itsa } from '../types'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mk = (id: string, key: string, title: string, status: string) => ({ id, key, title, summary: null, status, parent_id: null, updated_at: '2026-10-12T00:00:00Z', links: [], participants: [], fields: {} }) as unknown as Itsa

let settings: Record<string, unknown>
let defs: Field[]
// A held-back endpoint: its answer waits for the promise.
let hold: { settings?: Promise<void>; fields?: Promise<void> }
let patches: unknown[]
let host: HTMLDivElement
let root: Root
// The page's modules are loaded fresh for each test (the layout's settings cache lives in one), react included.
type Act = (fn: () => void | Promise<void>) => Promise<void>
let act: Act
const flush = () => act(async () => { for (let i = 0; i < 60; i++) await Promise.resolve() })

beforeEach(async () => {
  vi.resetModules()
  settings = {}
  defs = []
  hold = {}
  patches = []
  localStorage.clear()
  apiMock.mockReset()
  apiMock.mockImplementation((method: string, path: string, body?: { patch: Record<string, Record<string, unknown>> }) => {
    if (path === '/api/itsas/fields') return (hold.fields ?? Promise.resolve()).then(() => defs)
    if (method === 'GET' && path === '/api/config/settings') return (hold.settings ?? Promise.resolve()).then(() => ({ text: JSON.stringify(settings) }))
    if (method === 'PATCH' && path === '/api/config/settings') {
      patches.push(body)
      for (const [k, v] of Object.entries(body!.patch)) {
        const next = { ...(settings[k] as object ?? {}) } as Record<string, unknown>
        for (const [id, x] of Object.entries(v)) { if (x === null) delete next[id]; else next[id] = x }
        settings[k] = next
      }
      return Promise.resolve({})
    }
    return Promise.reject(new Error(`unexpected ${method} ${path}`))
  })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1700 })
  host = document.createElement('div')
  document.body.appendChild(host)
  const react = await import('react')
  act = react.act as unknown as Act
  root = (await import('react-dom/client')).createRoot(host)
  const { setData } = await import('../store')
  setData({ itsas: [mk('i1', 'S-1', 'Gamma', 'in_progress'), mk('i2', 'S-2', 'Alpha', 'testing'), mk('i3', 'S-3', 'Beta', 'in_review')], itsaStatuses: [{ name: 'in_progress', category: 'active', human: false }, { name: 'in_review', category: 'review', human: false }, { name: 'testing', category: 'review', human: false }] as never, itsaError: null })
})
// A save still waiting its debounce would land in the next test's record.
afterEach(async () => { await act(async () => root.unmount()); host.remove(); await new Promise((r) => setTimeout(r, 700)) })

async function mount() {
  const { WorkView } = await import('./WorkView')
  const { MenuLayer } = await import('../ui/menu')
  await act(async () => { root.render(<><WorkView viewKey="work" /><MenuLayer /></>) })
  await flush()
}



const q = <T extends Element>(sel: string) => document.querySelector<T>(sel)
const click = async (el: Element | null) => { expect(el).toBeTruthy(); await act(async () => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })) }); await flush() }
const tabs = () => [...document.querySelectorAll<HTMLElement>('[role=tab]')]
const dots = () => document.querySelectorAll('.w-tab .w-tdot').length
const item = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.menu [role=menuitem], .menu [role=menuitemradio]')].find((b) => b.textContent === label)!
const stored = () => (settings.workViews as Record<string, { quick?: string[]; sort?: unknown[] }>)

// Two saved views: Review (the Review quick filter on) and Plain.
const seed = () => { settings = { workViews: {
  work: { cols: ['work', 'status'], group: 'issues', show: 'open' },
  v1: { name: 'Review', cols: ['work', 'status'], group: 'issues', show: 'open', quick: ['review'] },
  v2: { name: 'Plain', cols: ['work', 'status'], group: 'issues', show: 'open' },
} } }
const openMenu = async () => { await click([...document.querySelectorAll('.w-tools .btn')].find((b) => b.textContent === 'View') ?? null) }

describe('view tabs', () => {
  it('lists Default first, then the saved views, and one click switches the view', async () => {
    seed()
    await mount()
    expect(tabs().map((t) => t.textContent)).toEqual(['Default', 'Review', 'Plain'])
    expect(tabs()[0].getAttribute('aria-selected')).toBe('true')
    expect(q('.w-qchip[data-quick=review]')?.getAttribute('aria-pressed')).toBe('false')
    await click(tabs()[1])
    expect(tabs()[1].getAttribute('aria-selected')).toBe('true')
    expect(q('.w-qchip[data-quick=review]')?.getAttribute('aria-pressed')).toBe('true')
    expect(dots()).toBe(0)
    await click(tabs()[0])
    expect(q('.w-qchip[data-quick=review]')?.getAttribute('aria-pressed')).toBe('false')
  })

  it('a dot marks the current view once it is edited, and goes when the edit is undone or the view switches', async () => {
    seed()
    await mount()
    await click(tabs()[1])
    expect(dots()).toBe(0)
    await click(q('.w-qchip[data-quick=pr]'))
    expect(dots()).toBe(1)
    expect(tabs()[1].querySelector('.w-tdot')?.getAttribute('aria-label')).toBe('Edited since saved')
    await click(q('.w-qchip[data-quick=pr]'))
    expect(dots()).toBe(0)
    await click(q('.w-qchip[data-quick=pr]'))
    await click(tabs()[2])
    expect(dots()).toBe(0)
    expect(q('.w-qchip[data-quick=pr]')?.getAttribute('aria-pressed')).toBe('false')
  })

  it('Revert drops the edits, and Save keeps them in the view and clears the dot', async () => {
    seed()
    await mount()
    await click(tabs()[1])
    await click(q('.w-qchip[data-quick=pr]'))
    await openMenu()
    expect(item('Save').disabled).toBe(false)
    await click(item('Revert'))
    expect(dots()).toBe(0)
    expect(q('.w-qchip[data-quick=pr]')?.getAttribute('aria-pressed')).toBe('false')
    expect(q('.w-qchip[data-quick=review]')?.getAttribute('aria-pressed')).toBe('true')
    await click(q('.w-qchip[data-quick=pr]'))
    await openMenu()
    await click(item('Save'))
    expect(dots()).toBe(0)
    await act(async () => { await new Promise((r) => setTimeout(r, 700)) })
    expect(stored().v1.quick).toEqual(['review', 'pr'])
    await openMenu()
    expect(item('Save').disabled).toBe(true)
    expect(item('Revert').disabled).toBe(true)
  })

  it('Save is off on Default, which only Save as can keep', async () => {
    seed()
    await mount()
    await click(q('.w-qchip[data-quick=pr]'))
    expect(dots()).toBe(1)
    await openMenu()
    expect(item('Save').disabled).toBe(true)
    expect(item('Revert').disabled).toBe(false)
  })

  it('a width change does not mark a view edited', async () => {
    seed()
    localStorage.setItem('stam/work-widths', JSON.stringify({ v1: { status: 200 } }))
    await mount()
    await click(tabs()[1])
    expect(JSON.parse(localStorage.getItem('stam/work-widths')!)[''].status).toBe(200)
    const h = q<HTMLElement>('[role=columnheader][data-col=status] .w-resize')!
    await act(async () => { h.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
    const widths = () => JSON.parse(localStorage.getItem('stam/work-widths')!)
    expect(widths()['']?.status).toBeUndefined()
    expect(widths().v1.status).toBe(200)
    expect(dots()).toBe(0)
  })

  it('clicking the current tab, or picking it in the menu, keeps the unsaved edits', async () => {
    seed()
    await mount()
    await click(tabs()[1])
    await click(q('.w-qchip[data-quick=pr]'))
    expect(dots()).toBe(1)
    await click(tabs()[1])
    expect(dots()).toBe(1)
    expect(q('.w-qchip[data-quick=pr]')?.getAttribute('aria-pressed')).toBe('true')
    await openMenu()
    await click(item('Review'))
    expect(dots()).toBe(1)
    expect(q('.w-qchip[data-quick=pr]')?.getAttribute('aria-pressed')).toBe('true')
  })
})

describe('the phone view picker', () => {
  const picker = () => q<HTMLButtonElement>('[data-view-picker]')!
  beforeEach(() => { Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 }) })

  it('shows the current view in the glance header, with the dot when it is edited, and has no tab strip', async () => {
    seed()
    await mount()
    expect(q('.w-tabs')).toBeNull()
    expect(picker().textContent).toBe('View: Default')
    await click(picker())
    expect(document.activeElement?.textContent).toBe('Default')
    await click(item('Review'))
    expect(picker().textContent).toBe('View: Review')
    expect(document.activeElement).toBe(picker())
    expect(q('[data-dirty]')).toBeNull()
    await click(q('.wg-quick .w-qchip[data-quick=pr]'))
    expect(q('[data-dirty]')).toBeTruthy()
    expect(picker().getAttribute('aria-label')).toBe('View: Review, edited since saved')
  })

  it('Escape closes the menu and returns focus to the picker', async () => {
    seed()
    await mount()
    await click(picker())
    expect(q('.menu')).toBeTruthy()
    await act(async () => { q('.menu')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(q('.menu')).toBeNull()
    expect(document.activeElement).toBe(picker())
  })
})
