// @vitest-environment jsdom
// S-628: a trusted contextmenu on a data-lp control (Android's, after a paperclip hold) must not set the
// shim to swallow the next click, even within 2 s of a touch elsewhere. A test can't make a trusted
// event, so the shim's own listener is captured and given one.
import { describe, expect, it, vi } from 'vitest'
import { initPhone } from './phone'

describe('the shim\'s trusted contextmenu listener', () => {
  it('skips a data-lp target, and still swallows the click for any other', () => {
    window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof matchMedia
    const on: Record<string, (e: unknown) => void> = {}
    vi.spyOn(window, 'addEventListener').mockImplementation(((t: string, fn: (e: unknown) => void, capture?: unknown) => { if (capture === true) on[t] = fn }) as typeof window.addEventListener)
    initPhone()
    vi.restoreAllMocks()
    document.body.innerHTML = '<button id="a">x</button><button id="b" data-lp="">y</button>'
    const a = document.getElementById('a')!, b = document.getElementById('b')!
    const press = (t: Element) => on.pointerdown({ pointerType: 'touch', target: t, clientX: 1, clientY: 1 })
    const click = (t: Element) => { const e = { target: t, preventDefault: vi.fn(), stopPropagation: vi.fn() }; on.click(e); return e.stopPropagation.mock.calls.length }
    press(a); on.contextmenu({ isTrusted: true, target: b })
    expect(click(b)).toBe(0) // the paperclip's click goes through
    press(a); on.contextmenu({ isTrusted: true, target: a })
    expect(click(a)).toBe(1) // a plain control's click is still eaten
  })
})
