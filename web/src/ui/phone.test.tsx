// @vitest-environment jsdom
// S-610: the touch shim turns a 600 ms hold into a contextmenu and eats the click that ends it;
// a control that owns its long press (data-lp, the paperclip) is left alone.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initPhone } from './phone'

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof matchMedia
  initPhone()
})
afterEach(() => { document.body.innerHTML = ''; vi.useRealTimers() })

const touch = (el: Element, type: string) => {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(e, { pointerType: { value: 'touch' }, clientX: { value: 5 }, clientY: { value: 5 } })
  el.dispatchEvent(e)
}

describe('the touch long-press shim', () => {
  for (const [name, own] of [['sends contextmenu and eats the click on a plain control', false], ['leaves a data-lp control alone', true]] as const) {
    it(name, () => {
      vi.useFakeTimers()
      document.body.innerHTML = `<button id="b"${own ? ' data-lp=""' : ''}>x</button>`
      const b = document.getElementById('b')!
      const menu = vi.fn(), click = vi.fn()
      b.addEventListener('contextmenu', menu); b.addEventListener('click', click)
      touch(b, 'pointerdown')
      vi.advanceTimersByTime(700) // past the shim's 600 ms
      touch(b, 'pointerup')
      b.click()
      expect(menu).toHaveBeenCalledTimes(own ? 0 : 1)
      expect(click).toHaveBeenCalledTimes(own ? 1 : 0)
    })
  }
})
