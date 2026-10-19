// @vitest-environment jsdom
// S-628: one hook for a context action: a hold on touch, a right click or the menu key on a desktop.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hideMenu } from './menu'
import { holdMs, useLongPress, type LongPressAt } from './longpress'

let host: HTMLElement, root: Root, calls: LongPressAt[]
let shown = true
function Row() {
  const lp = useLongPress((at) => calls.push(at), '.row')
  return <div id="list" tabIndex={0} {...lp}><div className="row" data-id="r1">one</div></div>
}
function Host() { return shown ? <Row /> : null }
beforeEach(() => {
  calls = []
  document.documentElement.style.setProperty('--duration-hold', '400ms')
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
  act(() => { shown = true; root.render(<Host />) })
})
afterEach(() => { act(() => { root.unmount() }); hideMenu(); document.body.innerHTML = ''; vi.useRealTimers() })

const ptr = (el: Element, type: string, pointerType: string, x = 5, y = 5) => act(async () => {
  const e = new Event(type, { bubbles: true }); Object.defineProperties(e, { pointerType: { value: pointerType }, clientX: { value: x }, clientY: { value: y } }); el.dispatchEvent(e)
})
const row = () => host.querySelector('.row')!

describe('useLongPress', () => {
  it('opens after a touch hold of the --duration-hold token, once, with the native menu cancelled', async () => {
    vi.useFakeTimers()
    await ptr(row(), 'pointerdown', 'touch')
    await act(async () => { vi.advanceTimersByTime(350) })
    expect(calls).toHaveLength(0)
    await act(async () => { vi.advanceTimersByTime(100) })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ x: 5, y: 5, how: 'hold' })
    expect((calls[0].el as HTMLElement).dataset.id).toBe('r1')
    // Android sends its own contextmenu after the hold: cancelled, not a second open.
    const cm = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    await act(async () => { row().dispatchEvent(cm) })
    expect(cm.defaultPrevented).toBe(true)
    expect(calls).toHaveLength(1)
  })

  // S-703: the build's CSS minifier writes the token as .4s; read bare, that was 0.4 ms and every tap a hold.
  it('reads the hold token in seconds as the build writes it, so a tap is not a hold', async () => {
    document.documentElement.style.setProperty('--duration-hold', '.4s')
    expect(holdMs()).toBe(400)
    vi.useFakeTimers()
    await ptr(row(), 'pointerdown', 'touch')
    await act(async () => { vi.advanceTimersByTime(100) })
    await ptr(row(), 'pointerup', 'touch')
    expect(calls).toHaveLength(0)
    document.documentElement.style.setProperty('--duration-hold', '')
    expect(holdMs()).toBe(400)
  })

  it('does not open when the finger moves, lifts early, or the page scrolls', async () => {
    vi.useFakeTimers()
    await ptr(row(), 'pointerdown', 'touch'); await ptr(row(), 'pointermove', 'touch', 5, 40)
    await act(async () => { vi.advanceTimersByTime(500) })
    await ptr(row(), 'pointerdown', 'touch'); await ptr(row(), 'pointerup', 'touch')
    await act(async () => { vi.advanceTimersByTime(500) })
    await ptr(row(), 'pointerdown', 'touch'); await act(async () => { document.dispatchEvent(new Event('scroll')); window.dispatchEvent(new Event('scroll')) })
    await act(async () => { vi.advanceTimersByTime(500) })
    expect(calls).toHaveLength(0)
  })

  it('removes the scroll listener it added, even after a re-render', async () => {
    vi.useFakeTimers()
    const add = vi.spyOn(window, 'addEventListener'), rem = vi.spyOn(window, 'removeEventListener')
    await ptr(row(), 'pointerdown', 'touch')
    await act(async () => { root.render(<Host />) }) // a re-render in the middle of the hold
    await ptr(row(), 'pointerup', 'touch')
    const added = add.mock.calls.filter((c) => c[0] === 'scroll').map((c) => c[1])
    const removed = rem.mock.calls.filter((c) => c[0] === 'scroll').map((c) => c[1])
    expect(added).toHaveLength(1)
    expect(removed).toContain(added[0])
  })

  it('opens no menu after its item unmounts mid-hold, and drops the scroll listener', async () => {
    vi.useFakeTimers()
    const add = vi.spyOn(window, 'addEventListener'), rem = vi.spyOn(window, 'removeEventListener')
    await ptr(row(), 'pointerdown', 'touch')
    shown = false
    await act(async () => { root.render(<Host />) })
    await act(async () => { vi.advanceTimersByTime(600) })
    expect(calls).toHaveLength(0)
    const added = add.mock.calls.filter((c) => c[0] === 'scroll').map((c) => c[1])
    expect(rem.mock.calls.filter((c) => c[0] === 'scroll').map((c) => c[1])).toContain(added[0])
  })

  it('ignores a mouse hold, and a right click opens at the pointer', async () => {
    vi.useFakeTimers()
    await ptr(row(), 'pointerdown', 'mouse')
    await act(async () => { vi.advanceTimersByTime(500) })
    expect(calls).toHaveLength(0)
    const cm = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 })
    await act(async () => { row().dispatchEvent(cm) })
    expect(cm.defaultPrevented).toBe(true)
    expect(calls).toMatchObject([{ x: 30, y: 40, how: 'click' }])
  })

  it('does not open from a right click outside a row', async () => {
    const cm = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    await act(async () => { host.querySelector('#list')!.dispatchEvent(cm) })
    expect(calls).toHaveLength(0)
  })

  it('opens from the context-menu key and Shift+F10 on the focused row', async () => {
    const list = host.querySelector('#list')!
    row().classList.add('focus')
    await act(async () => { list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true })) })
    await act(async () => { list.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })) })
    expect(calls.map((c) => c.how)).toEqual(['key', 'key'])
  })

  // S-776: the threshold buzzes, once; a hold that fires doesn't buzz again when its item is right-clicked.
  it('buzzes once when the hold fires', async () => {
    vi.useFakeTimers()
    const buzz = vi.fn()
    Object.defineProperty(navigator, 'vibrate', { value: buzz, configurable: true, writable: true })
    try {
      await ptr(row(), 'pointerdown', 'touch')
      await act(async () => { vi.advanceTimersByTime(350) })
      expect(buzz).not.toHaveBeenCalled()
      await act(async () => { vi.advanceTimersByTime(100) })
      expect(buzz).toHaveBeenCalledTimes(1)
      await act(async () => { row().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
      expect(buzz).toHaveBeenCalledTimes(1)
    } finally {
      delete (navigator as { vibrate?: unknown }).vibrate
      vi.useRealTimers()
    }
  })
})
