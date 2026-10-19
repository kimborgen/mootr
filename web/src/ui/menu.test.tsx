// @vitest-environment jsdom
// S-270: a checked menu item is a radio unless it says it is a checkbox (the multi-select
// Columns menu), so screen readers announce the right kind of choice.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { hideMenu, MenuLayer, showMenu } from './menu'

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
