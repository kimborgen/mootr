// @vitest-environment jsdom
// The Work page and the ITSA fields (S-369): a column per field, a new field showing by default, and
// the reload when Settings saves the shared layout, so an open page never writes its old copy back.
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Field } from '../itsa/fields'

const apiMock = vi.hoisted(() => vi.fn())
vi.mock('../api', () => ({ api: apiMock }))

import type { Itsa } from '../types'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const idsRef = () => ['work', 'status', 'agents', 'cost', 'updated', 'field:f1']
const field = (over: Partial<Field>): Field => ({ id: 'f1', key: 'k', label: 'K', type: 'text', options: null, description: null, hint: null, width: 'm', align: 'start', card: 'meta', position: 0, ...over })
const prio = field({ id: 'f1', key: 'prio', label: 'Priority', type: 'choice', options: [{ value: 'hi', label: 'High', tone: 'bad' }] })
const doc = field({ id: 'f2', key: 'doc', label: 'Doc', type: 'link', position: 1 })
const itsa = { id: 'i1', key: 'S-1', title: 'First', summary: null, status: 'in_progress', parent_id: null, updated_at: '2026-10-12T00:00:00Z', links: [], participants: [], fields: { prio: 'hi' } } as unknown as Itsa

let settings: Record<string, unknown>
let defs: Field[]
// A held-back endpoint: its answer waits for the promise.
let hold: { settings?: Promise<void>; fields?: Promise<void> }
let fieldsDown = false
let patches: unknown[]
let host: HTMLDivElement
let root: Root
// The page's modules are loaded fresh for each test (the layout's settings cache lives in one), react included.
type Act = (fn: () => void | Promise<void>) => Promise<void>
let act: Act
let WORK_LAYOUT_EVENT: string
const flush = () => act(async () => { for (let i = 0; i < 60; i++) await Promise.resolve() })
const heads = () => [...host.querySelectorAll('[role=columnheader]')].map((h) => h.textContent)

beforeEach(async () => {
  vi.resetModules()
  settings = {}
  defs = [prio]
  hold = {}
  fieldsDown = false
  patches = []
  localStorage.clear()
  apiMock.mockReset()
  apiMock.mockImplementation((method: string, path: string, body?: { patch: Record<string, Record<string, unknown>> }) => {
    if (path === '/api/itsas/fields') return (() => { const snap = defs; return (hold.fields ?? Promise.resolve()).then(() => { if (fieldsDown) throw new Error('503'); return snap }) })()
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
  ;({ WORK_LAYOUT_EVENT } = await import('./WorkView'))
  setData({ itsas: [itsa], itsaStatuses: [{ name: 'in_progress', category: 'active', human: false } as never], itsaError: null })
})
// A save still waiting its debounce would land in the next test's record.
afterEach(async () => { await act(async () => root.unmount()); host.remove(); await new Promise((r) => setTimeout(r, 700)) })

async function mount() {
  const { WorkView } = await import('./WorkView')
  const { MenuLayer } = await import('../ui/menu')
  await act(async () => { root.render(<><WorkView viewKey="work" /><MenuLayer /></>) })
  await flush()
}

describe('Work page fields', () => {
  it('shows a column per field after the built-ins, with its value in the row', async () => {
    await mount()
    expect(heads().slice(-2)).toEqual(['Updated', 'Priority'])
    expect(host.querySelector('.w-row .wc-field\\:f1 .badge.err')?.textContent).toBe('High')
  })

  it('shows a field added later, and leaves a field the user hid hidden', async () => {
    settings = { workViews: { work: { show: 'open', cols: ['work', 'status'], group: 'issues', seen: ['f1'] } } }
    await mount()
    expect(heads()).toEqual(['Work', 'Status'])
    defs = [prio, doc]
    await act(async () => { window.dispatchEvent(new Event(WORK_LAYOUT_EVENT)) })
    await flush()
    expect(heads()).toEqual(['Work', 'Status', 'Doc'])
    await act(async () => { await new Promise((r) => setTimeout(r, 700)) })
    expect((settings.workViews as Record<string, { seen: string[] }>).work.seen).toEqual(['f1', 'f2'])
  })

  it('reloads the layout Settings saved instead of writing its old copy back', async () => {
    await mount()
    expect(heads()).toContain('Cost')
    // Settings saves its layout through the same record the page reads.
    const v = await import('./views')
    v.saveStore({ views: [], current: '', show: 'open', layout: { cols: ['work', 'status'], widths: {}, group: 'issues', seen: ['f1'] } }, idsRef())
    await act(async () => { window.dispatchEvent(new Event(WORK_LAYOUT_EVENT)) })
    await flush()
    expect(heads()).toEqual(['Work', 'Status'])
  })

  it('drops a removed field from the layout', async () => {
    await mount()
    expect(heads()).toContain('Priority')
    defs = []
    await act(async () => { window.dispatchEvent(new Event(WORK_LAYOUT_EVENT)) })
    await flush()
    expect(heads()).not.toContain('Priority')
  })

  // Loads that finish in either order, with a tap in between: it shows at once, nothing is saved
  // before both are in, then the stored layout is kept, the tap applied on it, and that saved.
  const STORED = { workViews: { work: { show: 'all', cols: ['work', 'status', 'cost'], group: 'agents', seen: ['f1'] } } }
  const open = () => { let go!: () => void; const p = new Promise<void>((r) => { go = r }); return { p, go } }
  const tapFlat = async () => { await act(async () => { host.querySelector<HTMLButtonElement>('[data-mode="flat"]')!.click() }) }
  const dragWidth = async () => {
    await act(async () => {
      host.querySelector('.w-head .wc-status .w-resize')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 0 }))
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 90 }))
      window.dispatchEvent(new MouseEvent('pointerup'))
    })
  }
  const saved = () => settings.workViews as Record<string, { group: string; show: string; cols: string[] }> | undefined

  for (const late of ['settings', 'fields'] as const) {
    it(`saves nothing before both loads are in, with the ${late} held back, then applies a tap on the stored layout`, async () => {
      settings = structuredClone(STORED)
      localStorage.setItem('stam/work-widths', JSON.stringify({ '': { 'field:f1': 200, cost: 150 } }))
      const gate = open()
      hold = { [late]: gate.p }
      await mount()
      await tapFlat()
      await dragWidth()
      await act(async () => { await new Promise((r) => setTimeout(r, 700)) })
      expect(patches).toEqual([])
      expect(JSON.parse(localStorage.getItem('stam/work-widths')!)).toEqual({ '': { 'field:f1': 200, cost: 150 } })
      expect(host.querySelector('[data-mode="flat"]')!.getAttribute('aria-checked')).toBe('true')
      gate.go()
      await flush()
      await act(async () => { await new Promise((r) => setTimeout(r, 700)) })
      expect(saved()!.work).toMatchObject({ group: 'flat', show: 'all', cols: ['work', 'status', 'cost'] })
      const widths = JSON.parse(localStorage.getItem('stam/work-widths')!)['']
      expect(widths).toMatchObject({ 'field:f1': 200, cost: 150 })
      expect(widths.status).toBeGreaterThan(0)
      expect(heads()).toEqual(['Work', 'Status', 'Cost'])
    })
  }

  // The queued edits are replayed with the columns as they are once the fields are in: a closure
  // over the ids from before would drop the field column from the saved layout.
  const FIELD_STORED = { workViews: { work: { show: 'open', cols: ['work', 'status', 'cost', 'field:f1'], group: 'issues', seen: ['f1'] } } }
  const queued = async (act2: () => Promise<void>) => {
    settings = structuredClone(FIELD_STORED)
    const gate = open()
    hold = { fields: gate.p }
    await mount()
    await act2()
    gate.go()
    await flush()
    await act(async () => { await new Promise((r) => setTimeout(r, 700)) })
    return saved()!.work.cols
  }

  it('keeps the field column through a reorder queued before the fields loaded', async () => {
    const cols = await queued(async () => {
      await act(async () => { host.querySelector('.w-head .wc-status')!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, altKey: true, key: 'ArrowRight' })) })
    })
    expect(cols).toEqual(['work', 'cost', 'status', 'field:f1'])
  })

  it('keeps the field column through a visibility change queued before the fields loaded', async () => {
    let columnsButton: HTMLButtonElement | undefined
    const cols = await queued(async () => {
      columnsButton = [...host.querySelectorAll<HTMLButtonElement>('.w-tools button')].find((b) => b.textContent === 'Columns')!
      await act(async () => { columnsButton!.click() })
      await act(async () => { [...document.querySelectorAll<HTMLElement>('.menu [role=menuitemcheckbox]')].find((m) => m.textContent === 'Cost')!.click() })
    })
    expect(cols).toEqual(['work', 'status', 'field:f1'])
    // Toggling closes the panel and hands the focus back to the Columns button.
    expect(document.activeElement).toBe(columnsButton)
  })

  it('keeps the field column through a save-as queued before the fields loaded', async () => {
    await queued(async () => {
      await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('.w-tools button')].find((b) => b.textContent === 'View')!.click() })
      await act(async () => { [...document.querySelectorAll<HTMLElement>('.menu [role=menuitem]')].find((m) => m.textContent?.startsWith('Save as'))!.click() })
      const input = document.querySelector<HTMLInputElement>('.w-save input')!
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Mine')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => { document.querySelector<HTMLFormElement>('.w-save')!.requestSubmit() })
    })
    const views = Object.values(settings.workViews as Record<string, { name?: string; cols: string[]; seen?: string[] }>).filter((v) => v.name)
    expect(views).toHaveLength(1)
    expect(views[0].cols).toEqual(['work', 'status', 'cost', 'field:f1'])
    expect(views[0].seen).toEqual(['f1'])
  })

  it('opens saves when the fields fail to load, keeping the stored field columns, seen list and widths', async () => {
    settings = structuredClone(FIELD_STORED)
    localStorage.setItem('stam/work-widths', JSON.stringify({ '': { 'field:f1': 200 } }))
    fieldsDown = true
    await mount()
    await tapFlat()
    await act(async () => { await new Promise((r) => setTimeout(r, 700)) })
    expect(saved()!.work).toMatchObject({ group: 'flat', cols: expect.arrayContaining(['work', 'status', 'cost', 'field:f1']), seen: ['f1'] })
    expect(JSON.parse(localStorage.getItem('stam/work-widths')!)['']).toMatchObject({ 'field:f1': 200 })
    expect(heads()).toEqual(['Work', 'Status', 'Cost'])
  })

  // Settings saves a new field as hidden and the page's refresh of the fields is still out: a tap in
  // between saves from the page's old ids, and must not reveal the hidden field.
  it('keeps a field Settings just saved as hidden through a save from stale ids', async () => {
    await mount()
    const v = await import('./views')
    v.saveStore({ views: [], current: '', show: 'open', layout: { cols: ['work', 'status'], widths: {}, group: 'issues', seen: ['f1', 'f2'] } })
    const gate = open()
    hold = { fields: gate.p }
    defs = [prio, doc]
    await act(async () => { window.dispatchEvent(new Event(WORK_LAYOUT_EVENT)) })
    await tapFlat()
    gate.go()
    await flush()
    await act(async () => { await new Promise((r) => setTimeout(r, 700)) })
    expect(saved()!.work).toMatchObject({ group: 'flat', cols: ['work', 'status'] })
    expect(heads()).toEqual(['Work', 'Status'])
  })

  // The fields cached from an earlier mount are not a fresh read: settling against them would delete
  // what Settings stored since (a hidden new field, its seen entry and width).
  it('does not settle against the fields cached from an earlier mount', async () => {
    await mount()
    await act(async () => root.unmount())
    await act(async () => { await new Promise((r) => setTimeout(r, 700)) })
    // Settings stores a new field as hidden, through the page's own record.
    ;(await import('./views')).saveStore({ views: [], current: '', show: 'open', layout: { cols: ['work', 'status'], widths: {}, group: 'issues', seen: ['f1', 'f2'] } }, ['work', 'status', 'field:f1', 'field:f2'], true)
    localStorage.setItem('stam/work-widths', JSON.stringify({ '': { 'field:f2': 200 } }))
    await act(async () => { await new Promise((r) => setTimeout(r, 700)) })
    const gate = open()
    hold = { fields: gate.p }
    defs = [prio, doc]
    // The same page modules, so the cache still holds f1; the stored views are read again.
    const { WorkView } = await import('./WorkView')
    const { MenuLayer } = await import('../ui/menu')
    root = (await import('react-dom/client')).createRoot(host)
    await act(async () => { root.render(<><WorkView viewKey="work" /><MenuLayer /></>) })
    await flush()
    await act(async () => { await new Promise((r) => setTimeout(r, 700)) })
    expect(saved()!.work).toMatchObject({ cols: ['work', 'status'], seen: ['f1', 'f2'] })
    expect(JSON.parse(localStorage.getItem('stam/work-widths')!)['']).toMatchObject({ 'field:f2': 200 })
    gate.go()
    await flush()
    await act(async () => { await new Promise((r) => setTimeout(r, 700)) })
    expect(heads()).toEqual(['Work', 'Status'])
    expect(saved()!.work).toMatchObject({ cols: ['work', 'status'], seen: ['f1', 'f2'] })
  })

  it('a view saved while the fields are unknown carries the working layout\'s field columns, seen entries and widths', async () => {
    settings = structuredClone(FIELD_STORED)
    localStorage.setItem('stam/work-widths', JSON.stringify({ '': { 'field:f1': 200 } }))
    fieldsDown = true
    await mount()
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('.w-tools button')].find((b) => b.textContent === 'View')!.click() })
    await act(async () => { [...document.querySelectorAll<HTMLElement>('.menu [role=menuitem]')].find((m) => m.textContent?.startsWith('Save as'))!.click() })
    const input = document.querySelector<HTMLInputElement>('.w-save input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Mine')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { document.querySelector<HTMLFormElement>('.w-save')!.requestSubmit() })
    await act(async () => { await new Promise((r) => setTimeout(r, 700)) })
    const [id, view] = Object.entries(settings.workViews as Record<string, { name?: string; cols: string[]; seen?: string[] }>).find(([, v]) => v.name)!
    expect(view.cols).toEqual(['work', 'status', 'cost', 'field:f1'])
    expect(view.seen).toEqual(['f1'])
    expect(JSON.parse(localStorage.getItem('stam/work-widths')!)[id]).toEqual({ 'field:f1': 200 })
  })

  // A fields read already out when Settings saves is stale against that save: it must not settle
  // (drop what Settings just stored) before a read that started after the layout event.
  it('does not settle a fields read that started before the layout was read again', async () => {
    const third = field({ id: 'f3', key: 'third', label: 'Third', position: 2 })
    settings = { workViews: { work: { show: 'open', cols: ['work', 'status'], group: 'issues', seen: ['f1'] } } }
    await mount()
    const old = open()
    hold = { fields: old.p }
    defs = [prio, doc]
    const { setData } = await import('../store')
    await act(async () => { setData({ itsas: [{ ...itsa }] }) })
    // Settings saves f3 as hidden, with f1 and f2 seen; then the layout event.
    const v = await import('./views')
    v.saveStore({ views: [], current: '', show: 'open', layout: { cols: ['work', 'status'], widths: {}, group: 'issues', seen: ['f1', 'f2', 'f3'] } }, ['work', 'status', 'field:f1', 'field:f2', 'field:f3'], true)
    defs = [prio, doc, third]
    await act(async () => { window.dispatchEvent(new Event(WORK_LAYOUT_EVENT)) })
    hold = {}
    old.go()
    await flush()
    await act(async () => { await new Promise((r) => setTimeout(r, 700)) })
    expect(saved()!.work).toMatchObject({ cols: ['work', 'status'], seen: ['f1', 'f2', 'f3'] })
    expect(heads()).toEqual(['Work', 'Status'])
  })
})
