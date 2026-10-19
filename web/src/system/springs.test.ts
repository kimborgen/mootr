import { afterEach, describe, expect, it } from 'vitest'
import { readTiming, tokenMs } from './springs'

// The tokens a view sets on the element it hands in, on one attached to the document so a
// browser resolves them as it would in the view. jsdom leaves a var() computed value as written,
// so durationMs reads 0 here: the value is the browser's, the untouched element is this test's.
const mounted = (): HTMLElement => {
  const el = document.createElement('i')
  el.id = 'timing-probe'
  el.style.setProperty('--duration-slow', '220ms')
  el.style.setProperty('--duration-tick', '120ms')
  el.style.setProperty('--duration-flight', '330ms')
  el.style.setProperty('--duration-mark', '110ms')
  el.style.setProperty('--ease-out', 'cubic-bezier(0.2, 0, 0, 1)')
  document.body.appendChild(el)
  return el
}

afterEach(() => { document.body.replaceChildren() })

describe('tokenMs', () => {
  it('reads a duration without writing the element it is handed', () => {
    const el = mounted()
    const style = el.getAttribute('style')
    tokenMs(el, '--duration-slow')
    // An inline transition-duration here would leave the element with `transition: all`, so a
    // hover would fade it (S-1023).
    expect(el.style.transitionDuration).toBe('')
    expect(el.getAttribute('style')).toBe(style)
  })
  it('leaves no probe behind, on the element or anywhere in the document', () => {
    const el = mounted()
    const kids = el.childElementCount
    expect(tokenMs(el, '--duration-slow')).toBe(0)
    expect(el.childElementCount).toBe(kids)
    expect(document.querySelectorAll('#timing-probe i').length).toBe(0)
  })
  it('reads each call on a probe that is a child of the element, so it inherits its tokens', () => {
    const el = mounted()
    const seen: { childOfEl: boolean; connected: boolean }[] = []
    const real = window.getComputedStyle
    const spy = (node: Element, pseudo?: string | null) => {
      if (node !== el) seen.push({ childOfEl: node.parentElement === el, connected: node.isConnected })
      return real.call(window, node, pseudo)
    }
    window.getComputedStyle = spy as typeof window.getComputedStyle
    try { tokenMs(el, '--duration-slow') } finally { window.getComputedStyle = real }
    expect(seen).toHaveLength(1)
    expect(seen[0].childOfEl).toBe(true)
    expect(seen[0].connected).toBe(true)
  })
})

describe('readTiming', () => {
  it('reads every token and the ease without writing the element it is handed', () => {
    const el = mounted()
    const style = el.getAttribute('style')
    const kids = el.childElementCount
    const t = readTiming(el)
    expect(t).toEqual({ slow: 0, tick: 0, keep: 0, ease: [0.2, 0, 0, 1] })
    expect(el.style.transitionDuration).toBe('')
    expect(el.getAttribute('style')).toBe(style)
    expect(el.childElementCount).toBe(kids)
    expect(document.querySelectorAll('#timing-probe i').length).toBe(0)
  })
})
