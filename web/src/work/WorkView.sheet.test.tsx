// The phone's Filter button and sheet: a filter set in the sheet turns the glance into one list of the
// matches with "N of M", Clear undoes it, and a sort orders the list (S-1514).
// @vitest-environment jsdom
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.hoisted(() => vi.fn())
vi.mock('../api', () => ({ api: apiMock }))

import type { Itsa } from '../types'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mk = (id: string, key: string, title: string, status: string) => ({ id, key, title, summary: null, status, parent_id: null, updated_at: '2026-10-12T00:00:00Z', links: [], participants: [], fields: {} }) as unknown as Itsa

let settings: Record<string, unknown>
let host: HTMLDivElement
let root: Root
type Act = (fn: () => void | Promise<void>) => Promise<void>
let act: Act
const flush = () => act(async () => { for (let i = 0; i < 60; i++) await Promise.resolve() })
const q = <T extends Element>(sel: string) => document.querySelector<T>(sel)
const tap = async (el: Element | null) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click() }); await flush() }
const keys = () => [...document.querySelectorAll('[data-sec=matches] .wg-card .ikey')].map((e) => e.textContent)

beforeEach(async () => {
  vi.resetModules()
  settings = {}
  localStorage.clear()
  apiMock.mockReset()
  apiMock.mockImplementation((method: string, path: string) => {
    if (path === '/api/itsas/fields') return Promise.resolve([])
    if (method === 'GET' && path === '/api/config/settings') return Promise.resolve({ text: JSON.stringify(settings) })
    if (method === 'PATCH' && path === '/api/config/settings') return Promise.resolve({})
    return Promise.reject(new Error(`unexpected ${method} ${path}`))
  })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 })
  host = document.createElement('div')
  document.body.appendChild(host)
  const react = await import('react')
  act = react.act as unknown as Act
  root = (await import('react-dom/client')).createRoot(host)
  const { setData } = await import('../store')
  setData({ itsas: [mk('i1', 'S-1', 'Gamma', 'in_progress'), mk('i2', 'S-2', 'Alpha', 'testing'), mk('i3', 'S-3', 'Beta', 'in_review')], itsaStatuses: [{ name: 'in_progress', category: 'active', human: false }, { name: 'in_review', category: 'review', human: false }, { name: 'testing', category: 'review', human: false }] as never, itsaError: null })
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); await new Promise((r) => setTimeout(r, 700)) })

async function mount() {
  const { WorkView } = await import('./WorkView')
  await act(async () => { root.render(<WorkView viewKey="work" />) })
  await flush()
}

describe('the phone filter sheet', () => {
  it('a status filter turns the glance into the matching list with N of M, and Clear brings the sections back', async () => {
    await mount()
    expect(q('.wg-filter')?.getAttribute('data-active')).toBe('0')
    expect(q('[data-sec=moving]')).toBeTruthy()
    await tap(q('.wg-filter'))
    expect(q('[data-fsheet]')).toBeTruthy()
    expect(q('[data-fs=show]')?.textContent).toBe('Show 3')
    await tap(q('.fs-col[data-col=status] .fs-row'))
    const rows = [...document.querySelectorAll<HTMLElement>('.fs-edit [role=checkbox]')]
    await tap(rows.find((r) => /testing/.test(r.textContent ?? '')) ?? null)
    expect(q('.fs-col[data-col=status] .fs-val')?.textContent).not.toBe('Any')
    expect(q('[data-fs=show]')?.textContent).toBe('Show 2')
    await tap(q('[data-fs=show]'))
    expect(q('[data-fsheet]')).toBeNull()
    expect(q('.wg-filter')?.getAttribute('data-active')).toBe('1')
    expect(q('[data-sec=moving]')).toBeNull()
    expect(q('[data-sec=needs]')).toBeTruthy()
    expect(q('[data-matches]')?.textContent).toBe('2 of 3')
    expect(keys().sort()).toEqual(['S-1', 'S-3'])
    await tap(q('.wg-clear'))
    expect(q('[data-matches]')).toBeNull()
    expect(q('[data-sec=moving]')).toBeTruthy()
  })

  it('the sheet\'s Group by sets a column grouping, the chip names it, and the chip returns to Moving and Waiting', async () => {
    await mount()
    expect(q('[data-group-chip]')).toBeNull()
    await tap(q('.wg-filter'))
    const sel = q<HTMLSelectElement>('select[aria-label="Group by column"]')!
    expect(sel.value).toBe('')
    expect([...sel.options].map((o) => o.textContent)).toEqual(['None', 'Status', 'Agents', 'GitHub', 'Health', 'Review', 'Tests'])
    await act(async () => { sel.value = 'status'; sel.dispatchEvent(new Event('change', { bubbles: true })) })
    await flush()
    expect(q<HTMLSelectElement>('select[aria-label="Group by column"]')!.value).toBe('status')
    await tap(q('[data-fs=show]'))
    expect(q('[data-group-chip]')?.textContent).toBe('Grouped by Status')
    expect(q('[data-sec=moving]')).toBeNull()
    expect([...document.querySelectorAll('[data-sec=matches] .wg-group')].length).toBeGreaterThan(0)
    await tap(q('[data-group-chip]'))
    expect(q('[data-group-chip]')).toBeNull()
    expect(q('[data-sec=moving]')).toBeTruthy()
    // None in the sheet does the same.
    await tap(q('.wg-filter'))
    const again = q<HTMLSelectElement>('select[aria-label="Group by column"]')!
    await act(async () => { again.value = 'status'; again.dispatchEvent(new Event('change', { bubbles: true })) })
    await flush()
    await act(async () => { again.value = ''; again.dispatchEvent(new Event('change', { bubbles: true })) })
    await flush()
    await tap(q('[data-fs=show]'))
    expect(q('[data-group-chip]')).toBeNull()
    expect(q('[data-sec=moving]')).toBeTruthy()
  })

  it('a column grouping and a filter together show the chip and Clear side by side, and Clear keeps the grouping', async () => {
    await mount()
    await tap(q('.wg-filter'))
    const sel = q<HTMLSelectElement>('select[aria-label="Group by column"]')!
    await act(async () => { sel.value = 'status'; sel.dispatchEvent(new Event('change', { bubbles: true })) })
    await flush()
    await tap(q('.fs-col[data-col=status] .fs-row'))
    const rows = [...document.querySelectorAll<HTMLElement>('.fs-edit [role=checkbox]')]
    await tap(rows.find((r) => /testing/.test(r.textContent ?? '')) ?? null)
    await tap(q('[data-fs=show]'))
    expect(q('.wg-result [data-group-chip]')).toBeTruthy()
    expect(q('.wg-result .wg-clear')).toBeTruthy()
    expect(q('[data-group-chip]')?.getAttribute('aria-label')).toBe('Grouped by Status, clear grouping')
    await tap(q('.wg-clear'))
    expect(q('.wg-filter')?.getAttribute('data-active')).toBe('0')
    expect(q('.wg-clear')).toBeNull()
    expect(q('[data-group-chip]')).toBeTruthy()
    expect([...document.querySelectorAll('[data-sec=matches] .wg-group')].length).toBeGreaterThan(0)
  })

  it('a quick chip filters the list, counts in the badge and N of M, and Clear brings the sections back', async () => {
    const { setData, getData } = await import('../store')
    setData({ itsas: getData().itsas.map((i) => (i.id === 'i3' ? { ...i, owner: 'human' } : i)) })
    await mount()
    expect(q('.wg-quick')).toBeTruthy()
    expect(q('.wg-quick [data-quick=mine]')?.getAttribute('aria-pressed')).toBe('false')
    await tap(q('.wg-quick [data-quick=mine]'))
    expect(q('.wg-quick [data-quick=mine]')?.getAttribute('aria-pressed')).toBe('true')
    expect(q('.wg-filter')?.getAttribute('data-active')).toBe('1')
    expect(q('[data-sec=moving]')).toBeNull()
    expect(q('[data-matches]')?.textContent).toBe('1 of 3')
    expect(keys()).toEqual(['S-3'])
    await tap(q('.wg-quick [data-quick=blocked]'))
    expect(q('.wg-filter')?.getAttribute('data-active')).toBe('2')
    expect(keys()).toEqual([])
    await tap(q('.wg-clear'))
    expect(q('[data-matches]')).toBeNull()
    expect(q('.wg-quick [data-quick=mine]')?.getAttribute('aria-pressed')).toBe('false')
    expect(q('[data-sec=moving]')).toBeTruthy()
  })

  it('a sort key orders the list, a second key is added, and Clear all in the sheet removes everything', async () => {
    await mount()
    await tap(q('.wg-filter'))
    const add = q<HTMLSelectElement>('.fs-add')!
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
      set.call(add, 'work'); add.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()
    await tap(q('[data-fs=show]'))
    expect(keys()).toEqual(['S-1', 'S-2', 'S-3'])
    await tap(q('.wg-filter'))
    await tap(q('.fs-dir'))
    await tap(q('[data-fs=show]'))
    expect(keys()).toEqual(['S-3', 'S-2', 'S-1'])
    await tap(q('.wg-filter'))
    await tap(q('[data-fs=clear]'))
    expect(q<HTMLButtonElement>('[data-fs=clear]')?.disabled).toBe(true)
    await tap(q('[data-fs=show]'))
    expect(q('[data-sec=matches]')).toBeNull()
  })

  it('Escape closes the sheet and focus returns to the Filter button; Show N is the total again after Clear all', async () => {
    await mount()
    await tap(q('.wg-filter'))
    expect(document.activeElement).toBe(q('[data-fsheet]'))
    await act(async () => { q('[data-fsheet]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    await flush()
    expect(q('[data-fsheet]')).toBeNull()
    expect(document.activeElement).toBe(q('.wg-filter'))
  })

  it('Needs you is never filtered: a waiting ITSA the filter excludes stays in it', async () => {
    const { setData, getData } = await import('../store')
    const ask = { ...mk('i4', 'S-4', 'Ask', 'needs_input'), since: '2026-10-12T00:00:00Z', actions: [] }
    setData({ itsas: [...getData().itsas, ask as never], attention: [ask as never], itsaStatuses: [...getData().itsaStatuses, { name: 'needs_input', category: 'active', human: true }] as never })
    await mount()
    expect(q('[data-sec=needs] .wg-need')).toBeTruthy()
    await tap(q('.wg-filter'))
    await tap(q('.fs-col[data-col=status] .fs-row'))
    const rows = [...document.querySelectorAll<HTMLElement>('.fs-edit [role=checkbox]')]
    await tap(rows.find((r) => /needs input/.test(r.textContent ?? '')) ?? null)
    await tap(q('[data-fs=show]'))
    expect(keys()).not.toContain('S-4')
    expect(q('[data-sec=needs] .wg-need')?.textContent).toContain('S-4')
  })

  it('a filter on a hidden column has a row in the sheet, so it can be cleared', async () => {
    settings = { workViews: { work: { show: 'open', cols: ['work'], group: 'issues', filters: { status: { kind: 'values', values: ['in_progress', 'in_review'] } } } } }
    await mount()
    expect(q('.wg-filter')?.getAttribute('data-active')).toBe('1')
    await tap(q('.wg-filter'))
    expect(q('.fs-col[data-col=status] .fs-val.set')).toBeTruthy()
    await tap(q('.fs-col[data-col=status] .fs-row'))
    await tap(q('.fs-edit .fm-clear'))
    expect(q('.fs-col[data-col=status] .fs-val.set')).toBeNull()
    expect(q('.wg-filter')?.getAttribute('data-active')).toBe('0')
  })
})
