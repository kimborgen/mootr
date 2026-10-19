// The one rule for a context action (S-610, S-628). On a touch screen a hold of --duration-hold
// opens the item's actions, which the menu layer shows as a bottom sheet; on a desktop a right
// click opens the same actions as a popover, and the context-menu key or Shift+F10 opens them at
// the item. The browser's own menu never shows: contextmenu is always cancelled here.
import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import { durationMs } from './duration'
import { swallowNextClick } from './menu'

// A finger that slides further than a tap's wobble is scrolling or dragging, not holding.
export const HOLD_SLOP = 10
// How long a touch holds before it counts as a long press: the --duration-hold token, which the
// build writes as .4s (S-703: read as a bare number, every tap was a hold).
export const holdMs = () => durationMs(getComputedStyle(document.documentElement).getPropertyValue('--duration-hold')) || 400

// The hold's haptic, in one place: the buzz that tells the finger the hold is long enough to lift
// (S-776). A browser without it, or one that refuses the call, simply stays quiet.
export function buzz() { try { navigator.vibrate?.(15) } catch { /* no haptics here */ } }

export interface LongPressAt {
  // Where the menu belongs: the pointer, or for the keyboard the item's bottom-left corner.
  x: number
  y: number
  // The item the action is for: the closest match of `selector`, else the handlers' element.
  el: HTMLElement
  // Why it opened, so a caller can place the menu: a hold, a right click, or a key.
  how: 'hold' | 'click' | 'key'
}

// Handlers to spread on the element (or a container, with `selector`, for rows it holds).
export function useLongPress(open: (at: LongPressAt) => void, selector?: string) {
  const openRef = useRef(open)
  openRef.current = open
  const st = useRef({ timer: 0, from: null as { x: number; y: number } | null, fired: 0, touched: 0 })
  // One function for good, so the scroll listener that was added is the one removed.
  const stop = useRef(function stop() {
    const s = st.current
    clearTimeout(s.timer); s.from = null; removeEventListener('scroll', stop, true)
  }).current
  // A hold in progress never opens a menu after its item is gone.
  useEffect(() => stop, [stop])
  const find = (t: EventTarget | null, fallback: HTMLElement) => selector ? (t as Element).closest<HTMLElement>(selector) : fallback
  const fire = (el: HTMLElement, x: number, y: number) => {
    stop()
    st.current.fired = Date.now()
    buzz()
    // The finger lifting after the hold isn't a tap on the item.
    swallowNextClick()
    openRef.current({ x, y, el, how: 'hold' })
  }
  return {
    // Marks the element for the CSS that turns the native callout and text selection off, and for
    // the global touch shim in ui/phone.ts to leave alone.
    'data-lp': '',
    onPointerDown(e: PointerEvent<HTMLElement>) {
      if (e.pointerType !== 'touch') return
      const el = find(e.target, e.currentTarget)
      if (!el) return
      const s = st.current
      s.touched = Date.now()
      s.from = { x: e.clientX, y: e.clientY }
      clearTimeout(s.timer)
      addEventListener('scroll', stop, true)
      s.timer = window.setTimeout(() => { if (s.from) fire(el, s.from.x, s.from.y) }, holdMs())
    },
    onPointerMove(e: PointerEvent<HTMLElement>) {
      const f = st.current.from
      if (f && Math.hypot(e.clientX - f.x, e.clientY - f.y) > HOLD_SLOP) stop()
    },
    onPointerUp: stop,
    onPointerCancel: stop,
    onContextMenu(e: MouseEvent<HTMLElement>) {
      const el = find(e.target, e.currentTarget)
      if (!el) return
      e.preventDefault()
      e.stopPropagation()
      const s = st.current
      // Android sends its own contextmenu for a hold, a little after ours: the hold already opened it.
      if (Date.now() - s.fired < 1500) return
      if (Date.now() - s.touched < 1500) return fire(el, e.clientX, e.clientY)
      open({ x: e.clientX, y: e.clientY, el, how: 'click' })
    },
    onKeyDown(e: KeyboardEvent<HTMLElement>) {
      if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return
      const el = selector ? e.currentTarget.querySelector<HTMLElement>(selector + '.focus, ' + selector + ':focus') : e.currentTarget
      if (!el) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      open({ x: r.left + 40, y: r.bottom, el, how: 'key' })
    },
  }
}
