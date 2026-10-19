// The Work header: click sorts, shift-click adds a key, the menu filters, and the active-filter row (S-1513).
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
const heads = () => [...host.querySelectorAll('[role=columnheader]')].map((h) => h.textContent)

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


const head = (col: string) => host.querySelector<HTMLElement>(`[role=columnheader][data-col=${col}]`)!
const titles = () => [...host.querySelectorAll('.w-row:not(.w-need) .w-title')].map((t) => t.textContent)
const click = (el: Element, init: MouseEventInit = {}) => act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init })) })
const keydown = (el: Element, key: string, init: KeyboardEventInit = {}) => act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init })) })
const menu = () => document.querySelector('.menu.popover')

describe('Work header sort', () => {
  it('a click sorts ascending, then descending, then off; shift adds a key with its rank', async () => {
    await mount()
    expect(titles()).toEqual(['Gamma', 'Alpha', 'Beta'])
    await click(head('work'))
    expect(head('work').getAttribute('aria-sort')).toBe('ascending')
    expect(titles()).toEqual(['Gamma', 'Alpha', 'Beta'])
    await click(head('work'))
    expect(head('work').getAttribute('aria-sort')).toBe('descending')
    expect(titles()).toEqual(['Beta', 'Alpha', 'Gamma'])
    await click(head('work'))
    expect(head('work').hasAttribute('aria-sort')).toBe(false)
    await click(head('status'))
    expect(titles()).toEqual(['Gamma', 'Beta', 'Alpha'])
    await click(head('work'), { shiftKey: true })
    expect([...host.querySelectorAll('.w-hrank')].map((r) => r.textContent)).toEqual(['2', '1'])
  })

  it('a click on the resize edge does not sort', async () => {
    await mount()
    await click(head('status').querySelector('.w-resize')!)
    expect(head('status').hasAttribute('aria-sort')).toBe(false)
  })

  it('Enter on a focused header sorts it; with shift it flips the direction', async () => {
    await mount()
    await keydown(head('status'), 'Enter')
    expect(head('status').getAttribute('aria-sort')).toBe('ascending')
    await keydown(head('status'), 'Enter', { shiftKey: true })
    expect(head('status').getAttribute('aria-sort')).toBe('descending')
  })

  it('a reorder drag does not sort when the click follows it', async () => {
    await mount()
    const h = head('status')
    await act(async () => { h.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 100 })) })
    await act(async () => { window.dispatchEvent(new MouseEvent('pointermove', { clientX: 130 })) })
    await act(async () => { window.dispatchEvent(new MouseEvent('pointerup', { clientX: 130 })) })
    await click(head('status'))
    expect(head('status').hasAttribute('aria-sort')).toBe(false)
    // The next plain click sorts again.
    await act(async () => { head('status').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 100 })) })
    await act(async () => { window.dispatchEvent(new MouseEvent('pointerup', { clientX: 100 })) })
    await click(head('status'))
    expect(head('status').getAttribute('aria-sort')).toBe('ascending')
  })

  it('a resize that ends on the header, off the edge, does not sort', async () => {
    await mount()
    await act(async () => { head('status').querySelector('.w-resize')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 100 })) })
    await act(async () => { window.dispatchEvent(new MouseEvent('pointermove', { clientX: 140 })) })
    await act(async () => { window.dispatchEvent(new MouseEvent('pointerup', { clientX: 140 })) })
    // The release landed on the header itself, so the click goes to it, not to the edge.
    await click(head('status'))
    expect(head('status').hasAttribute('aria-sort')).toBe(false)
  })
})

describe('Work header menu', () => {
  it('Alt+Down opens it with the sort items; a sort item sorts and closes it', async () => {
    await mount()
    await keydown(head('status'), 'ArrowDown', { altKey: true })
    expect(menu()?.textContent).toContain('Sort A→Z')
    expect(menu()?.textContent).toContain('Clear filter')
    await click(menu()!.querySelector('[data-sort=desc]')!)
    expect(head('status').getAttribute('aria-sort')).toBe('descending')
    expect(menu()).toBeNull()
  })

  it('the filter applies live: a status unticked drops its rows, a token and N of M show, and Clear all clears', async () => {
    await mount()
    expect(host.querySelector('.w-filters')).toBeNull()
    await click(head('status').querySelector('.w-hmenu')!)
    const rowOf = (label: string) => [...menu()!.querySelectorAll<HTMLElement>('.rm-row')].find((r) => r.textContent?.includes(label))!
    await click(rowOf('testing'))
    expect(titles()).toEqual(['Gamma', 'Beta'])
    expect(menu()).not.toBeNull()
    // Unticking with no filter starts a standing rule, so a status that appears later still shows (S-1890).
    expect(host.querySelector('.w-ftoken')?.textContent).toBe('Status ≠ testing')
    expect(host.querySelector('.work-bar .count')?.textContent).toBe('2 of 3')
    expect(head('status').querySelector('.w-hfilter')).not.toBeNull()
    await click(host.querySelector('.w-fclear')!)
    expect(host.querySelector('.w-filters')).toBeNull()
    expect(titles()).toHaveLength(3)
  })

  it('lists the filter of a column the layout hides, and its x removes it', async () => {
    settings = { workViews: { work: { show: 'open', cols: ['work', 'status'], group: 'issues', filters: { cost: { kind: 'range', min: 5 } } } } }
    await mount()
    expect(heads()).toEqual(['Work', 'Status'])
    expect(host.querySelector('.w-ftoken[data-col=cost]')?.textContent).toBe('Cost: at least 5')
    await click(host.querySelector('.w-ftoken[data-col=cost] .w-fx')!)
    expect(host.querySelector('.w-filters')).toBeNull()
  })
})
