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
let hold: { settings?: Promise<void>; fields?: Promise<void>; costs?: Promise<void> }
let costs: unknown
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
  costs = null
  patches = []
  localStorage.clear()
  apiMock.mockReset()
  apiMock.mockImplementation((method: string, path: string, body?: { patch: Record<string, Record<string, unknown>> }) => {
    if (path === '/api/itsas/fields') return (hold.fields ?? Promise.resolve()).then(() => defs)
    if (path.startsWith('/api/usage/issues')) return (hold.costs ?? Promise.resolve()).then(() => costs)
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

  it('shows the cost in the Settings unit, a percent for a window, and follows a switch of unit', async () => {
    const part = (v: number) => ({ api: null, five_hour: v, seven_day: null, subscription: null, paid_usd: 0 })
    const issue = (key: string, v: number) => ({ key, own: { cost_usd: 1 }, total: { cost_usd: 1 }, weekly_percent: null, cost: { mode: 'five_hour', own: part(v), total: part(v) } })
    costs = { note: '', issues: [issue('S-1', 3.2), issue('S-2', 1.4)] }
    const { setData } = await import('../store')
    setData({ costMode: 'five_hour' })
    seed()
    await mount()
    expect(totals().cost).toBe('5%')
    expect([...document.querySelectorAll('.w-cost')].map((c) => c.textContent)).toEqual(expect.arrayContaining(['3%']))
    // Switching the unit in Settings refetches the costs, with no reload.
    costs = { note: '', issues: [{ ...issue('S-1', 0), cost: { mode: 'api', own: { api: 2.5, five_hour: null, seven_day: null, subscription: null, paid_usd: 0 }, total: { api: 2.5, five_hour: null, seven_day: null, subscription: null, paid_usd: 0 } } }] }
    await act(async () => { setData({ costMode: 'api' }) })
    await flush()
    expect(totals().cost).toBe('$2.5')
  })

  it('shows a unit switched while Work was unmounted, on the next mount within a minute', async () => {
    const part = (v: number) => ({ api: null, five_hour: v, seven_day: null, subscription: null, paid_usd: 0 })
    const issue = (key: string, v: number) => ({ key, own: { cost_usd: 1 }, total: { cost_usd: 1 }, weekly_percent: null, cost: { mode: 'five_hour', own: part(v), total: part(v) } })
    costs = { note: '', issues: [issue('S-1', 3.2), issue('S-2', 1.4)] }
    const { setData } = await import('../store')
    setData({ costMode: 'five_hour' })
    seed()
    await mount()
    expect(totals().cost).toBe('5%')
    await act(async () => root.unmount())
    // Settings is open meanwhile: the unit changes, and the costs come back in it.
    costs = { note: '', issues: [{ key: 'S-1', own: { cost_usd: 2.5 }, total: { cost_usd: 2.5 }, weekly_percent: null, cost: { mode: 'api', own: { api: 2.5, five_hour: null, seven_day: null, subscription: null, paid_usd: 0 }, total: { api: 2.5, five_hour: null, seven_day: null, subscription: null, paid_usd: 0 } } }] }
    setData({ costMode: 'api' })
    const { createRoot } = await import('react-dom/client')
    root = createRoot(host)
    await mount()
    expect(totals().cost).toBe('$2.5')
  })

  it('reruns a cost fetch that a unit switch overtook, once, with the new unit', async () => {
    const part = (v: number) => ({ api: null, five_hour: v, seven_day: null, subscription: null, paid_usd: 0 })
    const usage = () => apiMock.mock.calls.filter((c) => String(c[1]).startsWith('/api/usage/issues')).length
    costs = { note: '', issues: [{ key: 'S-1', own: { cost_usd: 1 }, total: { cost_usd: 1 }, weekly_percent: null, cost: { mode: 'five_hour', own: part(3.2), total: part(3.2) } }] }
    const { setData } = await import('../store')
    setData({ costMode: 'five_hour' })
    // The first fetch waits here, so the unit can change while it is in flight.
    let release!: () => void
    hold.costs = new Promise<void>((r) => { release = r })
    seed()
    await mount()
    expect(usage()).toBe(1)
    costs = { note: '', issues: [{ key: 'S-1', own: { cost_usd: 2.5 }, total: { cost_usd: 2.5 }, weekly_percent: null, cost: { mode: 'api', own: { api: 2.5, five_hour: null, seven_day: null, subscription: null, paid_usd: 0 }, total: { api: 2.5, five_hour: null, seven_day: null, subscription: null, paid_usd: 0 } } }] }
    await act(async () => { setData({ costMode: 'api' }) })
    release()
    await flush()
    expect(usage()).toBe(2)
    expect(totals().cost).toBe('$2.5')
  })
})
