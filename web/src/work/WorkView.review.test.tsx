// The review probes for the load order and stale ids (S-369), as the reviewer wrote them.
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

const field = (over: Partial<Field>): Field => ({ id: 'f1', key: 'k', label: 'K', type: 'text', options: null, description: null, hint: null, width: 'm', align: 'start', card: 'meta', position: 0, ...over })
const prio = field({ id: 'f1', key: 'prio', label: 'Priority', type: 'choice', options: [{ value: 'hi', label: 'High', tone: 'bad' }] })
const doc = field({ id: 'f2', key: 'doc', label: 'Doc', type: 'link', position: 1 })
const itsa = { id: 'i1', key: 'S-1', title: 'First', summary: null, status: 'in_progress', parent_id: null, updated_at: '2026-10-12T00:00:00Z', links: [], participants: [], fields: { prio: 'hi' } } as unknown as Itsa

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
let WORK_LAYOUT_EVENT: string
const flush = () => act(async () => { for (let i = 0; i < 60; i++) await Promise.resolve() })
const heads = () => [...host.querySelectorAll('[role=columnheader]')].map((h) => h.textContent)

beforeEach(async () => {
  vi.resetModules()
  settings = {}
  defs = [prio]
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
  ;({ WORK_LAYOUT_EVENT } = await import('./WorkView'))
  setData({ itsas: [itsa], itsaStatuses: [{ name: 'in_progress', category: 'active', human: false } as never], itsaError: null })
})
// A save still waiting its debounce would land in the next test's record.
afterEach(async () => { await act(async () => root.unmount()); host.remove(); await new Promise((r) => setTimeout(r, 700)) })

async function mount() {
  const { WorkView } = await import('./WorkView')
  await act(async () => { root.render(<WorkView viewKey="work" />) })
  await flush()
}

// Needs you draws on mail, ITSAs and the agents' waits (S-1451): until each has loaded it shows
// the loading mark, never "Nothing needs you", and the rows replace it once the agents arrive.
describe('Work page Needs you while loading', () => {
  it('shows the loading mark until the agents load, then their human wait', async () => {
    const { setData } = await import('../store')
    const { AGENTS } = await import('../stories/fixtures')
    setData({ agents: [], loaded: { agents: false, mail: true, itsas: true } })
    await mount()
    const needs = () => host.querySelector('[data-group=needs]')!
    expect(needs().querySelector('.stam-loader')).not.toBeNull()
    expect(needs().textContent).not.toContain('Nothing needs you')
    await act(async () => { setData({ agents: AGENTS.filter((a) => a.id === 'fx-ops'), loaded: { agents: true, mail: true, itsas: true } }) })
    await flush()
    expect(needs().querySelector('.stam-loader')).toBeNull()
    expect(needs().querySelector('[data-needs-count]')?.textContent).toBe('1')
  })
})

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
    v.saveStore({ views: [], current: '', show: 'open', layout: { cols: ['work', 'status'], widths: {}, group: 'issues', seen: ['f1'] } })
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
      settings = STORED
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
})

it('keeps saved field columns when a reorder is queued before fields load', async () => {
  settings = { workViews: { work: { show: 'all', cols: ['work','status','cost','field:f1'], group: 'issues', seen: ['f1'] } } }
  let release!:()=>void
  hold.fields = new Promise<void>(r=>{release=r})
  await mount()
  await act(async()=>{host.querySelector('.w-head .wc-status')!.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,altKey:true,key:'ArrowRight'}))})
  release()
  await flush()
  await act(async()=>{await new Promise(r=>setTimeout(r,700))})
  expect((settings.workViews as any).work.cols).toContain('field:f1')
})
it('can persist a layout after fields GET rejects', async () => {
  settings = { workViews: { work: { show: 'all', cols: ['work','status','field:f1'], group: 'issues', seen: ['f1'] } } }
  const original=apiMock.getMockImplementation()!
  apiMock.mockImplementation((method,path,body)=>path==='/api/itsas/fields'?Promise.reject(new Error('503 fields unavailable')):original(method,path,body))
  await mount()
  await act(async()=>{host.querySelector<HTMLButtonElement>('[data-mode="flat"]')!.click()})
  await act(async()=>{await new Promise(r=>setTimeout(r,700))})
  expect((settings.workViews as any).work.group).toBe('flat')
  expect((settings.workViews as any).work.cols).toContain('field:f1')
})
it('keeps a newly hidden field across layout event while field refresh is pending', async () => {
 settings={workViews:{work:{show:'all',cols:['work','status'],group:'issues',seen:['f1']}}}
 await mount()
 defs=[prio,doc]
 let release!:()=>void
 hold.fields=new Promise<void>(r=>{release=r})
 const v=await import('./views')
 v.saveStore({views:[],current:'',show:'all',layout:{cols:['work','status'],group:'issues',widths:{},seen:['f1','f2']}})
 await act(async()=>{window.dispatchEvent(new Event(WORK_LAYOUT_EVENT))})
 await act(async()=>{host.querySelector<HTMLButtonElement>('[data-mode="flat"]')!.click()})
 release()
 await flush()
 await act(async()=>{await new Promise(r=>setTimeout(r,700))})
 expect((settings.workViews as any).work.cols).not.toContain('field:f2')
})
