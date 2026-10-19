// A card's long-press and right-click on a value (S-1518): opens the cell menu for the value under
// the pointer. A card value carries `data-cell` (its column id). A touch that rests on one for
// LONG_PRESS_MS opens the menu, and the click that lifting the finger makes is swallowed, so the card
// doesn't also open its ITSA. A touch that drifts LONG_PRESS_SLOP is a scroll and opens nothing. A
// mouse (a narrow desktop pane shows the same cards) right-clicks instead.
import { useEffect, useRef, type MouseEvent, type PointerEvent } from 'react'
import { LONG_PRESS_MS, LONG_PRESS_SLOP, showCellMenu } from './cell-menu'
import { clearPress, markPress, refreshPress } from './press-flag'
import type { HeaderLive } from './header-menu'
import type { WorkRow } from './model'

const cellOf = (t: EventTarget | null): string | null => (t instanceof Element ? t.closest<HTMLElement>('[data-cell]')?.dataset.cell ?? null : null)

export function useCellPress(live: HeaderLive | undefined, row: WorkRow) {
  const timer = useRef(0)
  const start = useRef<{ x: number; y: number } | null>(null)
  // A long-press opened the menu: the click that ends the touch is not a tap on the card.
  const fired = useRef(false)
  const mouse = useRef(false)
  // The card can unmount mid-press (a poll reorders the list): the timer must not open a menu for it.
  useEffect(() => () => clearTimeout(timer.current), [])
  const cancel = () => { clearTimeout(timer.current); start.current = null }
  const open = (x: number, y: number, cell: string) => live ? showCellMenu(x, y, live, cell, row) : false
  return {
    // True when the card's click is the end of a long-press, and was spent on it.
    swallow(): boolean { const f = fired.current; fired.current = false; return f },
    handlers: live ? {
      onPointerDown(e: PointerEvent) {
        fired.current = false
        clearPress()
        mouse.current = e.pointerType === 'mouse'
        cancel()
        const cell = cellOf(e.target)
        if (e.pointerType === 'mouse' || !cell) return
        const [x, y] = [e.clientX, e.clientY]
        start.current = { x, y }
        timer.current = window.setTimeout(() => { start.current = null; fired.current = open(x, y, cell); if (fired.current) markPress() }, LONG_PRESS_MS)
      },
      onPointerMove(e: PointerEvent) {
        const s = start.current
        if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > LONG_PRESS_SLOP) cancel()
      },
      onPointerUp() { cancel(); refreshPress() },
      onPointerCancel: cancel,
      // A mouse's right-click opens our menu. Android Chrome's own long-press fires contextmenu too, and may
      // cancel the pointer before our timer: a touch contextmenu opens the menu at once, unless the timer did.
      onContextMenu(e: MouseEvent) {
        const cell = cellOf(e.target)
        if (!cell) return
        e.preventDefault()
        if (mouse.current) { open(e.clientX, e.clientY, cell); return }
        if (fired.current) return
        cancel()
        fired.current = open(e.clientX, e.clientY, cell)
        if (fired.current) markPress()
      },
    } : {},
  }
}
