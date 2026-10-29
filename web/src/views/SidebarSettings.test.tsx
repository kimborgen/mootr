// Settings › Sidebar (S-1422): the controls edit the layout live.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { currentPanes, DEFAULT_PANES, setSidebarPanes, setTabBar } from '../sidebar-panes'
import { SidebarSettings } from './SidebarSettings'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLElement
let root: Root
const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel)!
const click = (sel: string) => act(async () => { q(sel).click() })
const choose = (sel: string, value: string) => act(async () => {
  const el = q<HTMLSelectElement>(sel)
  el.value = value
  el.dispatchEvent(new Event('change', { bubbles: true }))
})
const panes = () => host.querySelectorAll('.sbs-pane').length

beforeEach(async () => {
  setSidebarPanes(DEFAULT_PANES.map((p) => ({ tabs: [...p.tabs], active: p.active })))
  setTabBar('compact')
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root.render(<SidebarSettings />) })
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('Settings › Sidebar', () => {
  it('moves a tab down and picks a default', async () => {
    expect(panes()).toBe(3)
    await click('[aria-label="Move Agents down"]')
    expect([...host.querySelectorAll('[data-pane="0"] .sbs-tab')].map((e) => (e as HTMLElement).dataset.tab)).toEqual(['issues', 'agents'])
    await click('[aria-label="Issues is the default tab of pane 1"]')
    expect(q<HTMLInputElement>('[aria-label="Issues is the default tab of pane 1"]').checked).toBe(true)
  })
  it('removes a tab to unused and adds it back as a new pane', async () => {
    // Mail shares its pane with history, so removing Mail alone keeps the pane
    await click('[aria-label="Remove Mail from the sidebar"]')
    expect(panes()).toBe(3)
    await click('[aria-label="Remove History from the sidebar"]')
    expect(panes()).toBe(2)
    expect(host.querySelector('[data-unused="mail"]')).not.toBeNull()
    await choose('[aria-label="Add Mail to"]', 'new')
    expect(panes()).toBe(3)
    expect(host.querySelector('[data-unused="history"]')).not.toBeNull()
  })
  it('sets the tab bar height and resets to mootr\'s default', async () => {
    await click('[role=radio][aria-checked=false]')
    expect(host.querySelector('.seg button.on')?.textContent).toBe('Regular')
    await click('[aria-label="Remove pane 1"]')
    await click('#sidebar-reset')
    expect(panes()).toBe(3)
    expect(host.querySelector('.seg button.on')?.textContent).toBe('Compact')
  })
  it('saves a default, edits, and reverts to it; reverting to mootr\'s leaves the default', async () => {
    expect(q<HTMLButtonElement>('#sidebar-revert-user').disabled).toBe(true)
    await click('[aria-label="Remove pane 1"]')
    await click('[role=radio][aria-checked=false]')
    await click('#sidebar-save-default')
    expect(q<HTMLButtonElement>('#sidebar-revert-user').disabled).toBe(false)
    await click('[aria-label="Remove pane 1"]')
    expect(panes()).toBe(1)
    await click('#sidebar-revert-user')
    expect(panes()).toBe(2)
    expect(host.querySelector('.seg button.on')?.textContent).toBe('Regular')
    await click('#sidebar-reset')
    expect(panes()).toBe(3)
    expect(currentPanes()).toEqual(DEFAULT_PANES)
    expect(q<HTMLButtonElement>('#sidebar-revert-user').disabled).toBe(false)
    await click('#sidebar-revert-user')
    expect(panes()).toBe(2)
  })
})
