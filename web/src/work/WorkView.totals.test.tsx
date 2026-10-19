// The Work totals footer (S-1521): the sticky last row that follows the shown columns, the filters and the
// grouping, and is gone once the page unmounts.
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
  setData({ itsas: [mk('i1', 'S-1', 'Gamma', 'in_progress'), mk('i2', 'S-2', 'Alpha', 'testing'), mk('i3', 'S-3', 'Beta', 'in_review'), mk('i4', 'S-4', 'Delta', 'in_progress'), mk('i5', 'S-5', 'Child', 'todo')], itsaStatuses: [{ name: 'todo', category: 'ready', human: false }, { name: 'in_progress', category: 'active', human: false }, { name: 'in_review', category: 'review', human: false }, { name: 'testing', category: 'review', human: false }] as never, itsaError: null })
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
const totals = () => Object.fromEntries([...document.querySelectorAll('[data-totals] [data-total]')].map((c) => [c.getAttribute('data-total'), c.textContent]))
const seed = (more: Record<string, unknown> = {}) => { settings = { workViews: { work: { cols: ['work', 'status', 'cost', 'health'], group: 'issues', show: 'open', ...more } } } }

describe('the totals footer', () => {
  it('is one sticky row on the shown columns: the count, the status categories, and blank where nothing sums', async () => {
    seed()
    await mount()
    expect(document.querySelectorAll('[data-totals]')).toHaveLength(1)
    expect(totals()).toEqual({ work: '5 issues', status: '1 ready · 2 active · 2 review', cost: '', health: '' })
    expect(q('.w-footgroup')).toBeTruthy()
  })

  it('counts only the rows that pass the filters', async () => {
    seed({ filters: { status: { kind: 'values', values: ['in_progress'] } } })
    await mount()
    expect(totals()).toEqual({ work: '2 issues', status: '2 active', cost: '', health: '' })
  })

  it('counts each ITSA once under another grouping', async () => {
    seed({ group: 'flat' })
    await mount()
    expect(totals().work).toBe('5 issues')
  })

  it('is gone when nothing is shown, and on unmount', async () => {
    seed({ filters: { status: { kind: 'values', values: ['nope'] } } })
    await mount()
    expect(q('[data-totals]')).toBeNull()
    await act(async () => root.unmount())
    expect(q('.w-table')).toBeNull()
    root = (await import('react-dom/client')).createRoot(host)
  })

  it('is one summary line under the filtered list in a narrow pane, and no table footer', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 })
    seed({ filters: { status: { kind: 'values', values: ['in_progress', 'in_review'] } } })
    await mount()
    expect(q('.w-foot')).toBeNull()
    expect(document.querySelectorAll('.wg-totals')).toHaveLength(1)
    expect(q('.wg-totals')!.textContent).toBe('3 issues · 2 active · 1 review')
    expect(q('.wg-sec[data-sec=matches] > .wg-totals')).toBeTruthy()
  })
})
