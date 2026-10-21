// Grouping by a column (S-1520) in the Work table: the By column… menu, group heads with counts that fold,
// the (Blank) group last, the choice saved in the view, and cleanup on unmount.
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
  setData({ itsas: [mk('i1', 'S-1', 'Gamma', 'in_progress'), mk('i2', 'S-2', 'Alpha', 'testing'), mk('i3', 'S-3', 'Beta', 'in_review'), mk('i4', 'S-4', 'Delta', 'in_progress')], itsaStatuses: [{ name: 'in_progress', category: 'active', human: false }, { name: 'in_review', category: 'review', human: false }, { name: 'testing', category: 'review', human: false }] as never, itsaError: null })
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
const item = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.menu [role=menuitem], .menu [role=menuitemradio], .menu [role=menuitemcheckbox]')].find((b) => b.textContent === label)!
const heads = () => [...document.querySelectorAll('.w-group:not(.w-needs) .w-gtoggle')].map((h) => h.textContent)
const rowKeys = (group: string) => [...document.querySelectorAll(`[data-group="${group}"] .w-row`)].map((r) => r.getAttribute('data-itsa'))
const stored = () => (settings.workViews as Record<string, { group?: string; groupBy?: string }>)
const seed = () => { settings = { workViews: { work: { cols: ['work', 'status', 'health'], group: 'issues', show: 'open' } } } }

describe('group by column', () => {
  it('lists the groupable columns, groups by the pick with a count per head, and saves it in the view', async () => {
    seed()
    await mount()
    expect(q('[data-group-col-btn]')!.textContent).toBe('By column…')
    await click(q('[data-group-col-btn]'))
    expect([...document.querySelectorAll('.menu [role=menuitemradio]')].map((b) => b.textContent)).toEqual(['Status', 'Agents', 'GitHub', 'Health', 'Review', 'Tests'])
    await click(item('Status'))
    expect(q('[data-group-col-btn]')!.textContent).toBe('By Status')
    expect(q('[data-group-col-btn]')!.getAttribute('aria-pressed')).toBe('true')
    expect(heads()).toEqual(['in progress2', 'in review1', 'testing1'])
    expect(rowKeys('status:in_progress')).toEqual(['i1', 'i4'])
    expect(document.querySelectorAll('[data-mode][aria-checked=true]').length).toBe(0)
    await new Promise((r) => setTimeout(r, 700))
    expect(stored().work).toMatchObject({ group: 'column', groupBy: 'status' })
  })

  it('folds a group head like the others and remembers it on this device', async () => {
    seed()
    await mount()
    await click(q('[data-group-col-btn]'))
    await click(item('Status'))
    await click(q('[data-group="status:in_progress"] .w-gtoggle'))
    expect(rowKeys('status:in_progress')).toEqual([])
    expect(q('[data-group="status:in_progress"]')!.classList.contains('folded')).toBe(true)
    expect(JSON.parse(localStorage.getItem('stam/work')!).folded).toEqual({ 'column:status:in_progress': true })
  })

  it('puts rows without a value in a (Blank) group, last, and a radio button leaves the column grouping', async () => {
    seed()
    await mount()
    await click(q('[data-group-col-btn]'))
    await click(item('Health'))
    expect(heads()).toEqual(['(Blank)4'])
    await click(q('[data-mode="flat"]'))
    expect(q('[data-group-col-btn]')!.textContent).toBe('By column…')
    await new Promise((r) => setTimeout(r, 700))
    expect(stored().work.group).toBe('flat')
    expect(stored().work.groupBy).toBeUndefined()
  })

  it('lists a row with two agents under both and counts it once in the total', async () => {
    seed()
    const { setData, getData } = await import('../store')
    setData({ itsas: getData().itsas.map((x) => (x.id === 'i1' ? { ...x, owner: 'a1', participants: ['a2'] } : x)) } as never)
    await mount()
    await click(q('[data-group-col-btn]'))
    await click(item('Agents'))
    expect(document.querySelectorAll('.w-group:not(.w-needs) .w-row').length).toBe(5)
    expect(rowKeys('agents:a1')).toEqual(['i1'])
    expect(rowKeys('agents:a2')).toEqual(['i1'])
    expect(q('.work-bar > .count')!.textContent).toBe('4')
  })

  it('lists an ITSA under its owner, and under a participant in another tree marked participant', async () => {
    seed()
    const { setData, getData } = await import('../store')
    setData({ itsas: getData().itsas.map((x) => (x.id === 'i1' ? { ...x, owner: 'a1', participants: ['a2', 'human'] } : x)), agents: [{ id: 'a1', name: 'amy', harness: 'claude-code', parents: [] }, { id: 'a2', name: 'bo', harness: 'claude-code', parents: [] }] } as never)
    await mount()
    await click(q('[data-mode="agents"]'))
    expect(rowKeys('a1')).toEqual(['i1'])
    expect(rowKeys('a2')).toEqual(['i1'])
    // Only the participant row says so; the owner row is the default.
    expect(document.querySelector('[data-group="a1"] .w-row[data-itsa="i1"] .w-role')).toBeNull()
    expect(document.querySelector('[data-group="a2"] .w-row[data-itsa="i1"] .w-role')!.textContent).toBe('participant')
    expect(q('.work-bar > .count')!.textContent).toBe('4')
  })

  it('lists an ITSA once in a tree where its participant is the owner\'s parent, the head count too', async () => {
    seed()
    const { setData, getData } = await import('../store')
    setData({ itsas: getData().itsas.map((x) => (x.id === 'i1' ? { ...x, owner: 'a2', participants: ['a1'] } : x)), agents: [{ id: 'a1', name: 'amy', harness: 'claude-code', parents: [] }, { id: 'a2', name: 'bo', harness: 'claude-code', parents: ['a1'] }] } as never)
    await mount()
    await click(q('[data-mode="agents"]'))
    const keys = [...document.querySelectorAll('[data-group="a1"] .w-row[data-itsa]')].map((r) => r.getAttribute('data-itsa'))
    expect(keys).toEqual(['i1'])
    expect(new Set(keys).size).toBe(keys.length)
    expect(document.querySelector('[data-group="a1"] .w-gtoggle .count')!.textContent).toBe('1')
    expect(document.querySelector('[data-group="a1"] .w-row[data-itsa="i1"] .w-role')).toBeNull()
  })

  it('shows a stored column grouping on a column that is gone as the issue tree', async () => {
    settings = { workViews: { work: { cols: ['work', 'status'], group: 'column', groupBy: 'field:gone', show: 'open' } } }
    await mount()
    expect(q('[data-group-col-btn]')!.textContent).toBe('By column…')
    expect(document.querySelectorAll('.w-row:not(.w-need)').length).toBe(4)
  })

  it('drops the saved folds of agents that are gone once the agents have loaded', async () => {
    seed()
    localStorage.setItem('stam/work', JSON.stringify({ folded: { 'column:agents:a1': true, 'column:agents:gone': true, 'column:status:testing': true } }))
    const { setData } = await import('../store')
    setData({ agents: [{ id: 'a1', name: 'amy' }] as never, loaded: { agents: false, mail: true, itsas: true } })
    await mount()
    expect(Object.keys(JSON.parse(localStorage.getItem('stam/work')!).folded)).toHaveLength(3)
    setData({ loaded: { agents: true, mail: true, itsas: true } })
    await flush()
    expect(JSON.parse(localStorage.getItem('stam/work')!).folded).toEqual({ 'column:agents:a1': true, 'column:status:testing': true })
  })

  it('leaves no timer running after unmount', async () => {
    seed()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      await mount()
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      await act(async () => root.unmount())
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
})
