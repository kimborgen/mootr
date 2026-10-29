// A cell's menu (S-1518): right-click a table cell, or long-press a card's value on the phone, to filter to it,
// exclude it, or sort by its column. The row click, and a tap on a card, still open the ITSA.
// @vitest-environment jsdom
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.hoisted(() => vi.fn())
vi.mock('../api', () => ({ api: apiMock }))
const opened = vi.hoisted(() => vi.fn())
const diffOpened = vi.hoisted(() => vi.fn())
vi.mock('../files/open', async (orig) => ({ ...(await orig<typeof import('../files/open')>()), openDiff: diffOpened }))
vi.mock('../itsa/itsa', async (orig) => ({ ...(await orig<typeof import('../itsa/itsa')>()), openItsa: opened }))

import type { Itsa } from '../types'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PR = 'https://github.com/example/repo/pull/15'
const mk = (id: string, key: string, title: string, status: string) => ({ id, key, title, summary: null, status, parent_id: null, updated_at: '2026-10-12T00:00:00Z', links: id === 'i2' ? [{ n: 1, system: 'branch', external_id: 'stam/x', url: '' }, { n: 2, system: 'github', external_id: null, url: PR }] : [], participants: [], fields: {} }) as unknown as Itsa

let host: HTMLDivElement
let root: Root
type Act = (fn: () => void | Promise<void>) => Promise<void>
let act: Act
const flush = () => act(async () => { for (let i = 0; i < 60; i++) await Promise.resolve() })
const q = <T extends Element>(sel: string) => document.querySelector<T>(sel)

async function setup(width: number) {
  vi.resetModules()
  localStorage.clear()
  opened.mockReset()
  diffOpened.mockReset()
  apiMock.mockReset()
  apiMock.mockImplementation((method: string, path: string) => {
    if (path === '/api/itsas/fields') return Promise.resolve([])
    if (method === 'GET' && path === '/api/config/settings') return Promise.resolve({ text: '{}' })
    if (method === 'PATCH' && path === '/api/config/settings') return Promise.resolve({})
    return Promise.reject(new Error(`unexpected ${method} ${path}`))
  })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  host = document.createElement('div')
  document.body.appendChild(host)
  const react = await import('react')
  act = react.act as unknown as Act
  root = (await import('react-dom/client')).createRoot(host)
  const { setData } = await import('../store')
  setData({ itsas: [mk('i1', 'S-1', 'Gamma', 'in_progress'), mk('i2', 'S-2', 'Alpha', 'testing'), mk('i3', 'S-3', 'Beta', 'in_review')], itsaStatuses: [{ name: 'in_progress', category: 'active', human: false }, { name: 'in_review', category: 'review', human: false }, { name: 'testing', category: 'review', human: false }] as never, itsaError: null })
  const { WorkView } = await import('./WorkView')
  const { MenuLayer } = await import('../ui/menu')
  await act(async () => { root.render(<><WorkView viewKey="work" /><MenuLayer /></>) })
  await flush()
}
afterEach(async () => { await act(async () => root.unmount()); host.remove(); await new Promise((r) => setTimeout(r, 700)) })

const menuLabels = () => [...document.querySelectorAll('.menu [role=menuitem] .ml')].map((e) => e.textContent)
const choose = async (label: string, nth = 0) => {
  const items = [...document.querySelectorAll<HTMLElement>('.menu [role=menuitem]')].filter((b) => b.querySelector('.ml')?.textContent === label)
  expect(items[nth]).toBeTruthy()
  await act(async () => { items[nth].click() })
  await flush()
}
const rows = () => [...document.querySelectorAll('.w-row:not(.w-need) .wc-work .ikey')].map((e) => e.textContent)

describe('right-click a table cell', () => {
  beforeEach(() => setup(1700))
  const cell = (id: string, col: string) => q<HTMLElement>(`.w-row[data-itsa=${id}] .w-cell[data-cell=${col}]`)!
  const rightClick = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })) }); await flush() }

  it('opens the status cell\'s menu, and Filter to this value keeps the rows with it', async () => {
    expect(rows().sort()).toEqual(['S-1', 'S-2', 'S-3'])
    await rightClick(cell('i2', 'status'))
    expect(menuLabels()).toEqual(['Filter to this value', 'Exclude this value', 'Sort by this column, ascending', 'Sort by this column, descending'])
    await choose('Filter to this value')
    expect(rows()).toEqual(['S-2'])
    expect(q('.w-ftoken[data-col=status]')).toBeTruthy()
    expect(opened).not.toHaveBeenCalled()
    expect(q('.menu')).toBeNull()
  })

  it('Exclude adds to an earlier exclusion', async () => {
    await rightClick(cell('i1', 'status'))
    await choose('Exclude this value')
    expect(rows().sort()).toEqual(['S-2', 'S-3'])
    await rightClick(cell('i2', 'status'))
    await choose('Exclude this value')
    expect(rows()).toEqual(['S-3'])
    expect(q('.w-ftoken[data-col=status] .w-ftext')?.textContent).toMatch(/^Status ≠ .+, .+/)
  })

  it('a status that first appears after an Exclude shows, and is ticked in the editor', async () => {
    await rightClick(cell('i1', 'status'))
    await choose('Exclude this value')
    expect(rows().sort()).toEqual(['S-2', 'S-3'])
    const { setData, getData } = await import('../store')
    await act(async () => { setData({ itsas: [...getData().itsas, mk('i4', 'S-4', 'Delta', 'blocked')] }) })
    await flush()
    expect(rows().sort()).toEqual(['S-2', 'S-3', 'S-4'])
    await act(async () => { q<HTMLElement>('.w-ftoken[data-col=status] .w-ftext')!.click() })
    await flush()
    const ticks = [...document.querySelectorAll('.rm-row')].map((r) => [r.querySelector('.ml')?.textContent?.toLowerCase(), r.getAttribute('aria-checked')])
    expect(ticks.find(([n]) => n === 'blocked')?.[1]).toBe('true')
    expect(ticks.filter(([, on]) => on === 'false').length).toBe(1)
  })

  it('Sort by this column sorts the rows', async () => {
    await rightClick(cell('i1', 'work'))
    expect(menuLabels()).toEqual(['Sort by this column, ascending', 'Sort by this column, descending'])
    await choose('Sort by this column, descending')
    expect(rows()).toEqual(['S-3', 'S-2', 'S-1'])
    expect(q('[role=columnheader][data-col=work]')?.getAttribute('aria-sort')).toBe('descending')
  })

  it('a column with nothing to offer keeps the browser\'s menu', async () => {
    const { showCellMenu } = await import('./cell-menu')
    const live = { layout: {}, col: (id: string) => ({ id, label: id, width: '', render: () => null }), rows: () => [], cx: { now: 0, extras: {} }, edit: () => {} }
    expect(showCellMenu(0, 0, live as never, 'x', { it: mk('i1', 'S-1', 'T', 'todo'), depth: 0, context: false })).toBe(false)
    expect(q('.menu')).toBeNull()
  })
})

describe('keyboard path to the cell menu (S-1683)', () => {
  beforeEach(() => setup(1700))
  const row = (id: string) => q<HTMLElement>(`.w-row[data-itsa=${id}]`)!
  const press = async (el: Element, key: string, init: KeyboardEventInit = {}) => {
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
    await act(async () => { el.dispatchEvent(e) }); await flush()
    return e
  }
  const colItems = () => [...document.querySelectorAll('.menu [role=menuitem]')].map((b) => [b.querySelector('.ml')?.textContent, b.getAttribute('aria-haspopup')])

  it('the ContextMenu key lists the row\'s columns, and choosing Status opens its cell actions', async () => {
    row('i2').focus()
    const e = await press(row('i2'), 'ContextMenu')
    expect(e.defaultPrevented).toBe(true)
    expect(colItems().map(([l]) => l)).toContain('Status')
    expect(colItems().every(([, p]) => p === 'menu')).toBe(true)
    await choose('Status')
    expect(menuLabels()).toEqual(['Filter to this value', 'Exclude this value', 'Sort by this column, ascending', 'Sort by this column, descending'])
    await choose('Filter to this value')
    expect(rows()).toEqual(['S-2'])
    expect(opened).not.toHaveBeenCalled()
  })

  it('Shift+F10 opens it too, F10 alone does not, and the row announces a popup', async () => {
    expect(row('i1').getAttribute('aria-haspopup')).toBe('menu')
    const plain = await press(row('i1'), 'F10')
    expect(plain.defaultPrevented).toBe(false)
    expect(q('.menu')).toBeNull()
    await press(row('i1'), 'F10', { shiftKey: true })
    expect(q('.menu')).toBeTruthy()
  })

  it('Arrow keys move through the columns and Escape returns focus to the row, from either menu', async () => {
    row('i3').focus()
    await press(row('i3'), 'ContextMenu')
    const first = document.activeElement as HTMLElement
    expect(first.closest('.menu')).toBeTruthy()
    await press(first, 'ArrowDown')
    expect(document.activeElement).not.toBe(first)
    await press(document.activeElement!, 'Escape')
    expect(q('.menu')).toBeNull()
    expect(document.activeElement).toBe(row('i3'))
    await press(row('i3'), 'ContextMenu')
    await choose('Status')
    await press(document.activeElement!, 'Escape')
    expect(q('.menu')).toBeNull()
    expect(document.activeElement).toBe(row('i3'))
  })

  it('the contextmenu event the key also fires is cancelled, and leaves the row menu open', async () => {
    row('i2').focus()
    await press(row('i2'), 'ContextMenu')
    const ctx = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    await act(async () => { row('i2').dispatchEvent(ctx) }); await flush()
    expect(ctx.defaultPrevented).toBe(true)
    expect(colItems().map(([l]) => l)).toContain('Status')
    expect(document.querySelectorAll('.menu').length).toBe(1)
  })

  it('a mouse right-click on the row itself is left to the pane menu', async () => {
    const ctx = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
    await act(async () => { row('i2').dispatchEvent(ctx) }); await flush()
    expect(ctx.defaultPrevented).toBe(false)
    expect(q('.menu')).toBeNull()
  })

  it('after a choice, focus returns to the row', async () => {
    row('i2').focus()
    await press(row('i2'), 'ContextMenu')
    await choose('Status')
    await choose('Sort by this column, descending')
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(q('.menu')).toBeNull()
    expect(document.activeElement).toBe(row('i2'))
  })

  it('a contextmenu on the focused menu button (Windows fires it on keyup) is cancelled, so the native menu stays shut', async () => {
    row('i2').focus()
    await press(row('i2'), 'ContextMenu')
    const before = colItems()
    const ctx = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0 })
    await act(async () => { document.activeElement!.dispatchEvent(ctx) }); await flush()
    expect(ctx.defaultPrevented).toBe(true)
    expect(document.querySelectorAll('.menu').length).toBe(1)
    expect(colItems()).toEqual(before)
  })

  it('a pointer-less contextmenu (button -1) on the row opens the menu with no flag, a Ctrl+click (button 0) does not', async () => {
    const ctrl = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0 })
    await act(async () => { row('i2').dispatchEvent(ctrl) }); await flush()
    expect(ctrl.defaultPrevented).toBe(false)
    expect(q('.menu')).toBeNull()
    const key = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: -1 })
    await act(async () => { row('i2').dispatchEvent(key) }); await flush()
    expect(key.defaultPrevented).toBe(true)
    expect(colItems().map(([l]) => l)).toContain('Status')
  })

  it('the flag ends on the next keyup, and an unmount clears its timer', async () => {
    const spy = vi.spyOn(window, 'clearTimeout')
    await press(row('i2'), 'ContextMenu')
    const { hideMenu } = await import('../ui/menu')
    await act(async () => { hideMenu() }); await flush()
    const up = new KeyboardEvent('keyup', { key: 'ContextMenu', bubbles: true })
    await act(async () => { row('i2').dispatchEvent(up) }); await flush()
    const late = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0 })
    await act(async () => { row('i2').dispatchEvent(late) }); await flush()
    expect(late.defaultPrevented).toBe(false)
    const n = spy.mock.calls.length
    await act(async () => root.render(<></>))
    expect(spy.mock.calls.length).toBeGreaterThan(n)
    spy.mockRestore()
  })

  it('a key inside the row (the fold chevron) does not open the menu', async () => {
    const inner = row('i1').querySelector('.w-cell')!
    await press(inner, 'ContextMenu')
    expect(q('.menu')).toBeNull()
  })
})

describe('long-press a card value on the phone', () => {
  beforeEach(() => setup(400))
  // jsdom has no PointerEvent: a mouse event under the pointer names carries what the page reads.
  const ptr = (el: Element, type: string, x = 20, y = 20, pointerType = 'touch') => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y })
    Object.defineProperty(e, 'pointerType', { value: pointerType })
    return act(async () => { el.dispatchEvent(e) })
  }
  const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)) })
  const chip = () => q<HTMLElement>('.wg-card[data-itsa=i2] [data-cell=status]')!
  const longPress = async (el: Element) => { await ptr(el, 'pointerdown'); await wait(650); await ptr(el, 'pointerup'); await act(async () => { (el as HTMLElement).click() }) }

  it('opens the menu, Filter to this value filters, and the press does not open the ITSA', async () => {
    await longPress(chip())
    expect(menuLabels()).toContain('Filter to this value')
    expect(opened).not.toHaveBeenCalled()
    await choose('Filter to this value')
    expect(q('[data-matches]')?.textContent).toBe('1 of 3')
    expect(opened).not.toHaveBeenCalled()
  })

  it('a long-press marks the press, for a link chip\'s lift click (S-1533), and the next touch clears it', async () => {
    const { takePress } = await import('./press-flag')
    await longPress(chip())
    expect(takePress()).toBe(true)
    await longPress(chip())
    await ptr(chip(), 'pointerdown')
    expect(takePress()).toBe(false)
    await ptr(chip(), 'pointerup')
    await ptr(document.body, 'pointerdown')
  })

  it('a tap still opens the ITSA, and so does one after a long-press', async () => {
    await act(async () => { chip().click() })
    expect(opened).toHaveBeenCalledTimes(1)
    expect(q('.menu')).toBeNull()
    await longPress(chip())
    expect(opened).toHaveBeenCalledTimes(1)
    // A tap outside closes the menu and only that; the next tap on the card opens it.
    await ptr(document.body, 'pointerdown')
    expect(q('.menu')).toBeNull()
    await ptr(chip(), 'pointerdown')
    await ptr(chip(), 'pointerup')
    await act(async () => { chip().click() })
    expect(opened).toHaveBeenCalledTimes(2)
  })

  it('a touch that moves is a scroll: no menu', async () => {
    await ptr(chip(), 'pointerdown')
    await ptr(chip(), 'pointermove', 20, 60)
    await wait(650)
    await ptr(chip(), 'pointerup')
    expect(q('.menu')).toBeNull()
  })

  it('a card that unmounts mid-press opens no menu', async () => {
    await ptr(chip(), 'pointerdown')
    // Unmount the page but keep the menu layer, or `.menu` is always absent.
    const { MenuLayer } = await import('../ui/menu')
    await act(async () => { root.render(<MenuLayer />) })
    await wait(650)
    expect(q('.menu')).toBeNull()
  })

  it('Android\'s own long-press contextmenu opens the menu at once, even if the pointer was cancelled first', async () => {
    await ptr(chip(), 'pointerdown')
    await ptr(chip(), 'pointercancel')
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })
    await act(async () => { chip().dispatchEvent(e) })
    expect(e.defaultPrevented).toBe(true)
    expect(menuLabels()).toContain('Filter to this value')
    expect(opened).not.toHaveBeenCalled()
    await act(async () => { chip().click() })
    expect(opened).not.toHaveBeenCalled()
  })

  it('a long-press away from any value opens nothing', async () => {
    const title = q('.wg-card[data-itsa=i2] .bc-title')!
    await ptr(title, 'pointerdown')
    await wait(650)
    expect(q('.menu')).toBeNull()
  })

  // The links on a card are icons (the board's card, S-3560) that keep the table chip's behaviour.
  const prLink = async () => {
    const { resetDiffRepos } = await import('../diff/diffRepos')
    resetDiffRepos([{ name: 'stam2', github: 'example/repo' }], true)
    await flush()
    return q<HTMLElement>('.wg-card[data-itsa=i2] [data-cell=github] a.bc-link')!
  }

  it('a tap on a PR link opens the diff, not the ITSA', async () => {
    const a = await prLink()
    expect(a.getAttribute('aria-label')).toBe('PR #15')
    await act(async () => { a.click() })
    expect(diffOpened).toHaveBeenCalledWith('stam2', 15)
    expect(opened).not.toHaveBeenCalled()
  })

  it('a branch is only named: a span, not a link, and a tap opens the ITSA', async () => {
    const b = q<HTMLElement>('.wg-card[data-itsa=i2] [data-cell=branch] .bc-link')!
    expect(b.tagName).toBe('SPAN')
    expect(b.getAttribute('aria-label')).toBe('stam/x')
    await act(async () => { b.click() })
    expect(opened).toHaveBeenCalledTimes(1)
  })

  it('a long-press on a PR link opens the cell menu naming the link, and the lift click opens neither diff nor ITSA', async () => {
    const a = await prLink()
    await longPress(a)
    expect(menuLabels()).toEqual(expect.arrayContaining(['View diff', 'Open on GitHub']))
    expect(document.querySelector('.menu')?.textContent).toContain('PR #15')
    expect(diffOpened).not.toHaveBeenCalled()
    expect(opened).not.toHaveBeenCalled()
    await choose('View diff')
    expect(diffOpened).toHaveBeenCalledWith('stam2', 15)
  })

  it('a long-press on a branch names it in the menu', async () => {
    await longPress(q('.wg-card[data-itsa=i2] [data-cell=branch] .bc-link')!)
    expect(document.querySelector('.menu')?.textContent).toContain('stam/x')
  })
})
