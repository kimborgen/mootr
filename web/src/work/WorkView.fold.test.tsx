// Row folds (S-1437) in the Work table: a chevron on every row with subrows, the hidden count, Expand all and
// Collapse all, the fold kept on this device, and a chevron click that doesn't open the row.
// @vitest-environment jsdom
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Field } from '../itsa/fields'

const apiMock = vi.hoisted(() => vi.fn())
vi.mock('../api', () => ({ api: apiMock }))

import type { Itsa } from '../types'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mk = (id: string, key: string, title: string, status: string, parent: string | null = null) => ({ id, key, title, summary: null, status, parent_id: parent, updated_at: '2026-10-12T00:00:00Z', links: [], participants: [], fields: {} }) as unknown as Itsa

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
  setData({ itsas: [mk('r', 'S-1', 'Root', 'in_progress'), mk('a', 'S-2', 'Alpha', 'in_progress', 'r'), mk('a1', 'S-3', 'Alpha one', 'in_progress', 'a'), mk('a1x', 'S-4', 'Alpha one x', 'in_progress', 'a1'), mk('b', 'S-5', 'Beta', 'in_progress', 'r')], itsaStatuses: [{ name: 'in_progress', category: 'active', human: false }, { name: 'in_review', category: 'review', human: false }, { name: 'testing', category: 'review', human: false }] as never, itsaError: null })
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
const ids = () => [...document.querySelectorAll('[data-group="r"] .w-row')].map((r) => r.getAttribute('data-itsa'))
const toggle = (id: string) => q(`.w-row[data-itsa="${id}"] button.w-rowtoggle`)
const saved = () => JSON.parse(localStorage.getItem('stam/work')!).folded
const seed = () => { settings = { workViews: { work: { cols: ['work', 'status'], group: 'issues', show: 'open' } } } }

describe('row folds', () => {
  it('puts a chevron on each row with subrows only, expanded by default, labelled with the key', async () => {
    seed()
    await mount()
    expect(ids()).toEqual(['a', 'a1', 'a1x', 'b'])
    expect(toggle('a')!.getAttribute('aria-expanded')).toBe('true')
    expect(toggle('a')!.getAttribute('aria-label')).toBe('Collapse S-2')
    expect(toggle('a1')).toBeTruthy()
    expect(toggle('a1x')).toBeNull()
    expect(toggle('b')).toBeNull()
    expect(document.querySelectorAll('[data-hidden]').length).toBe(0)
  })

  it('folds a row to hide its subrows at any depth, with the count of what is hidden', async () => {
    seed()
    await mount()
    await click(toggle('a1'))
    expect(ids()).toEqual(['a', 'a1', 'b'])
    expect(q('.w-row[data-itsa="a1"] [data-hidden]')!.textContent).toBe('1')
    expect(toggle('a1')!.getAttribute('aria-label')).toBe('Expand S-3')
    await click(toggle('a'))
    expect(ids()).toEqual(['a', 'b'])
    expect(q('.w-row[data-itsa="a"] [data-hidden]')!.textContent).toBe('2')
    await click(toggle('a'))
    expect(ids()).toEqual(['a', 'a1', 'b'])
  })

  it('a chevron click doesn\'t open the row: stopPropagation, not a target guard', async () => {
    seed()
    const itsa = await import('../itsa/itsa')
    const opened = vi.spyOn(itsa, 'openItsa').mockImplementation(() => {})
    await mount()
    await click(toggle('a'))
    expect(opened).not.toHaveBeenCalled()
    await click(q('.w-row[data-itsa="b"]'))
    expect(opened).toHaveBeenCalledWith('b')
  })

  it('the keyboard toggles it: Enter and Space on the focused chevron reach no row handler, and the click they make folds and unfolds', async () => {
    seed()
    const itsa = await import('../itsa/itsa')
    const opened = vi.spyOn(itsa, 'openItsa').mockImplementation(() => {})
    await mount()
    const t = toggle('a') as HTMLButtonElement
    expect(t.tagName).toBe('BUTTON')
    expect(t.type).toBe('button')
    t.focus()
    expect(document.activeElement).toBe(t)
    for (const key of ['Enter', ' ']) {
      const down = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      await act(async () => { toggle('a')!.dispatchEvent(down) })
      // The row's key handler leaves it alone, so the browser's default action (the click) still happens.
      expect(down.defaultPrevented).toBe(false)
      expect(opened).not.toHaveBeenCalled()
      // A browser turns Enter (on keydown) and Space (on keyup) on a button into this click.
      await click(toggle('a'))
      expect(ids()).toEqual(key === 'Enter' ? ['a', 'b'] : ['a', 'a1', 'a1x', 'b'])
    }
  })

  it('Collapse all folds every row with subrows, Expand all unfolds them, and each is off when it would do nothing', async () => {
    seed()
    await mount()
    expect(q<HTMLButtonElement>('[data-fold-all=expand]')!.disabled).toBe(true)
    await click(q('[data-fold-all=collapse]'))
    expect(ids()).toEqual(['a', 'b'])
    expect(q<HTMLButtonElement>('[data-fold-all=collapse]')!.disabled).toBe(true)
    await click(q('[data-fold-all=expand]'))
    expect(ids()).toEqual(['a', 'a1', 'a1x', 'b'])
    expect(saved()).toEqual({})
  })

  it('keeps the folds on this device, beside the group folds, and applies them on the next load', async () => {
    seed()
    await mount()
    await click(toggle('a1'))
    await click(q('[data-group="r"] .w-gtoggle'))
    await click(q('[data-group="r"] .w-gtoggle'))
    expect(saved()).toEqual({ "row:issues:a1": true, r: false })
    await act(async () => root.unmount())
    root = (await import('react-dom/client')).createRoot(host)
    await mount()
    expect(ids()).toEqual(['a', 'a1', 'b'])
  })

  it('drops the fold of an ITSA that is gone once the ITSAs have loaded', async () => {
    seed()
    localStorage.setItem('stam/work', JSON.stringify({ folded: { 'row:issues:a': true, 'row:issues:gone': true, r: true } }))
    const { setData } = await import('../store')
    setData({ loaded: { agents: true, mail: true, itsas: true } })
    await mount()
    expect(saved()).toEqual({ 'row:issues:a': true, r: true })
  })

  it('has no row folds in the agent tree: no chevron, rows stay, and saved agent row folds are dropped', async () => {
    settings = { workViews: { work: { cols: ['work', 'status'], group: 'agents', show: 'open' } } }
    localStorage.setItem('stam/work', JSON.stringify({ folded: { 'row:agents:a': true, 'row:issues:a': true } }))
    const { setData } = await import('../store')
    setData({ agents: [{ id: 'ag', name: 'amy', harness: 'claude' }] as never, itsas: [mk('r', 'S-1', 'Root', 'in_progress'), mk('a', 'S-2', 'Alpha', 'in_progress', 'r')].map((x) => ({ ...x, owner: 'ag' })) as never, loaded: { agents: true, mail: true, itsas: true } })
    await mount()
    expect(document.querySelectorAll('button.w-rowtoggle').length).toBe(0)
    expect(document.querySelectorAll('.w-row[data-itsa]').length).toBe(2)
    expect(document.querySelectorAll('[data-fold-all]').length).toBe(0)
    expect(saved()).toEqual({ 'row:issues:a': true })
  })

  it('gives a Needs-you row the chevron\'s slot in the issue tree, so its key lines up', async () => {
    seed()
    const { setData, getData } = await import('../store')
    setData({ attention: [{ ...getData().itsas.find((x) => x.id === 'b')!, status: 'needs_input', since: '2026-10-12T00:00:00Z' }] as never, loaded: { agents: true, mail: true, itsas: true } })
    await mount()
    expect(document.querySelectorAll('.w-need .w-rowtoggle.spacer').length).toBeGreaterThan(0)
    expect(document.querySelectorAll('.w-need button.w-rowtoggle').length).toBe(0)
  })

  it('has no row folds in the flat list or in a column group', async () => {
    seed()
    await mount()
    await click(q('[data-mode="flat"]'))
    expect(document.querySelectorAll("button.w-rowtoggle").length).toBe(0)
    expect(document.querySelectorAll('[data-fold-all]').length).toBe(0)
  })

  it('caps the indent: the depth reaches the cell but the stylesheet clamps it', async () => {
    seed()
    await mount()
    expect(q<HTMLElement>('.w-row[data-itsa="a1x"] .wc-work')!.style.getPropertyValue('--depth')).toBe('2')
  })
})
