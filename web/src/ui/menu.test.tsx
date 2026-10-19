// @vitest-environment jsdom
// S-270: a checked menu item is a radio unless it says it is a checkbox (the multi-select
// Columns menu), so screen readers announce the right kind of choice.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { hideMenu, MenuLayer, showMenu, showPopover } from './menu'

afterEach(() => { hideMenu(); document.body.innerHTML = '' })

describe('menu item roles', () => {
  it('marks a checked item as a radio, and a checkbox when it says so', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => { root.render(<MenuLayer />) })
    act(() => {
      showMenu(0, 0, [
        { label: 'Single', checked: true },
        { label: 'Multi', checked: true, checkbox: true },
        { label: 'Plain' },
      ])
    })
    const roles = [...document.querySelectorAll('.menu button')].map((b) => [b.textContent, b.getAttribute('role'), b.getAttribute('aria-checked')])
    expect(roles).toEqual([
      ['Single', 'menuitemradio', 'true'],
      ['Multi', 'menuitemcheckbox', 'true'],
      ['Plain', 'menuitem', null],
    ])
    act(() => { root.unmount() })
  })
})

// Home and End move the caret in a text field in the menu; on a menu item they jump to the first and last.
describe('Home and End in a menu', () => {
  it('stay in a text field inside the menu, and on an item jump to the first', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => { root.render(<MenuLayer />) })
    act(() => { showPopover(0, 0, 'Save view', <><input aria-label="Name" /><button>Save</button></>) })
    const input = document.querySelector<HTMLInputElement>('.menu input')!
    act(() => { input.focus() })
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Home' })) })
    expect(document.activeElement).toBe(input)
    act(() => { hideMenu() })
    act(() => { showMenu(0, 0, [{ label: 'First' }, { label: 'Last' }]) })
    const last = document.querySelectorAll<HTMLButtonElement>('.menu button')[1]
    act(() => { last.focus() })
    act(() => { last.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Home' })) })
    expect(document.activeElement?.textContent).toBe('First')
    act(() => { root.unmount() })
  })
})

// S-2073: a right-click in a menu is cancelled, but a text field in it keeps the browser's paste and spelling menu.
describe('contextmenu in a menu', () => {
  const context = (el: Element) => {
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
    act(() => { el.dispatchEvent(e) })
    return e.defaultPrevented
  }
  it('is cancelled on an item and on a popover, and left alone in a text field', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => { root.render(<MenuLayer />) })
    act(() => { showMenu(0, 0, [{ label: 'Item' }]) })
    expect(context(document.querySelector('.menu button')!)).toBe(true)
    act(() => { hideMenu() })
    act(() => { showPopover(0, 0, 'Save view', <><input aria-label="Name" /><textarea aria-label="Note" /><button>Save</button></>) })
    expect(context(document.querySelector('.menu input')!)).toBe(false)
    expect(context(document.querySelector('.menu textarea')!)).toBe(false)
    expect(context(document.querySelector('.menu.popover button')!)).toBe(true)
    act(() => { root.unmount() })
  })
})

// S-1997: Up and Down step a textarea, select or date field in a menu; from a one-line text field they reach the items.
describe('Up and Down in a menu field', () => {
  const press = (el: Element, key: string) => {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key })
    act(() => { el.dispatchEvent(e) })
    return e.defaultPrevented
  }
  it('stay in a textarea, select and date field, and leave a text field for the first item', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => { root.render(<MenuLayer />) })
    act(() => { showPopover(0, 0, 'Fields', <><input aria-label="Search" /><textarea aria-label="Note" /><select aria-label="Pick"><option>a</option><option>b</option></select><input type="date" aria-label="Day" /><input type="number" aria-label="N" /><button>Save</button></>) })
    for (const f of ['textarea', 'select', 'input[type=date]', 'input[type=number]']) {
      const el = document.querySelector<HTMLElement>('.menu ' + f)!
      act(() => { el.focus() })
      expect([f, press(el, 'ArrowDown'), press(el, 'ArrowUp')]).toEqual([f, false, false])
      expect(document.activeElement).toBe(el)
    }
    const search = document.querySelector<HTMLInputElement>('.menu input[aria-label=Search]')!
    act(() => { search.focus() })
    expect(press(search, 'ArrowDown')).toBe(true)
    expect(document.activeElement?.textContent).toBe('Save')
    act(() => { root.unmount() })
  })
})

// S-286: on a phone a menu is a sheet over a scrim that is only a shadow, so the tap that
// closes it lands on what lies under the scrim. It must only close, not press that too.
describe('closing a menu by a tap outside', () => {
  const tapOn = (el: Element, pointerType: string) => {
    const down = new Event('pointerdown', { bubbles: true, cancelable: true })
    Object.defineProperty(down, 'pointerType', { value: pointerType })
    el.dispatchEvent(down)
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  }
  const setup = async () => {
    const host = document.createElement('div')
    const under = document.createElement('button')
    let pressed = 0
    under.addEventListener('click', () => pressed++)
    document.body.append(host, under)
    const root = createRoot(host)
    act(() => { root.render(<MenuLayer />) })
    act(() => { showMenu(0, 0, [{ label: 'Item' }]) })
    // The outside listener goes on after the opening tap.
    await act(() => new Promise((r) => setTimeout(r)))
    return { root, under, pressed: () => pressed }
  }

  it('a touch closes it and presses nothing; the next tap presses', async () => {
    const { root, under, pressed } = await setup()
    act(() => { tapOn(under, 'touch') })
    expect(document.querySelector('.menu')).toBeNull()
    expect(pressed()).toBe(0)
    act(() => { tapOn(under, 'touch') })
    expect(pressed()).toBe(1)
    act(() => { root.unmount() })
  })

  it('a mouse click outside still reaches what it clicked', async () => {
    const { root, under, pressed } = await setup()
    act(() => { tapOn(under, 'mouse') })
    expect(document.querySelector('.menu')).toBeNull()
    expect(pressed()).toBe(1)
    act(() => { root.unmount() })
  })
})
