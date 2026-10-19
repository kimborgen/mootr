// The Columns popover's search (S-1522): the filter by label, the keys, the reset, and the empty state.
// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ColumnsPanel, matchColumns, type ColumnChoice } from './columns-menu'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const cols: ColumnChoice[] = [
  { id: 'work', label: 'Work', on: true, locked: true },
  { id: 'status', label: 'Status', on: true, locked: false },
  { id: 'cost', label: 'Cost', on: false, locked: false },
  { id: 'branch', label: 'Branch', on: true, locked: false },
]

let host: HTMLDivElement
let root: Root
const toggle = vi.fn()
const reset = vi.fn()
const labels = () => [...host.querySelectorAll('.cm-list button')].map((b) => b.textContent)
const search = () => host.querySelector<HTMLInputElement>('input')!
const type = async (v: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search(), v)
  search().dispatchEvent(new Event('input', { bubbles: true }))
})
const key = async (el: Element, k: string) => act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: k })) })

beforeEach(async () => {
  toggle.mockReset(); reset.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root.render(<ColumnsPanel cols={cols} onToggle={toggle} onReset={reset} />) })
})
afterEach(async () => { await act(async () => { root.unmount() }); host.remove() })

describe('matchColumns', () => {
  it('keeps the columns whose label holds the query, case aside', () => {
    expect(matchColumns(cols, 'STAT').map((c) => c.id)).toEqual(['status'])
    expect(matchColumns(cols, ' ')).toHaveLength(4)
    expect(matchColumns(cols, 'zzz')).toEqual([])
  })
})

describe('ColumnsPanel', () => {
  it('focuses the search on open and lists every column', () => {
    expect(document.activeElement).toBe(search())
    expect(labels()).toEqual(['Work', 'Status', 'Cost', 'Branch'])
  })

  it('narrows the list as you type, and says so when nothing matches', async () => {
    await type('bra')
    expect(labels()).toEqual(['Branch'])
    await type('nope')
    expect(labels()).toEqual([])
    expect(host.querySelector('.rm-none')!.textContent).toBe('No column matches “nope”')
    // The empty state sits beside the list, not in role=menu, which may own only menu items.
    expect(host.querySelector('.cm-list .rm-none')).toBeNull()
    await type('')
    expect(labels()).toHaveLength(4)
  })

  it('moves with the arrows, types on a column go to the search, and a click on a column toggles', async () => {
    await key(search(), 'ArrowDown')
    // Work is locked, so the first column to land on is Status.
    expect(document.activeElement!.textContent).toBe('Status')
    await key(document.activeElement!, 'ArrowUp')
    expect(document.activeElement).toBe(search())
    await key(search(), 'ArrowUp')
    expect(document.activeElement!.textContent).toBe('Branch')
    await key(document.activeElement!, 'x')
    expect(document.activeElement).toBe(search())
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('.cm-list button')].find((b) => b.textContent === 'Cost')!.click() })
    expect(toggle).toHaveBeenCalledWith('cost', true)
  })

  it('the list is a menu of checkboxes', async () => {
    expect(host.querySelector('.cm-list')!.getAttribute('role')).toBe('menu')
  })

  it('does not toggle the locked Work column, and Reset to default stays', async () => {
    expect(host.querySelector<HTMLButtonElement>('.cm-list button')!.disabled).toBe(true)
    await type('zzz')
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Reset to default')!.click() })
    expect(reset).toHaveBeenCalledTimes(1)
  })
})
