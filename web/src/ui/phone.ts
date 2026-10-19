// What a phone needs that CSS alone can't do: the visible viewport's size and offset (the
// virtual keyboard shrinks it, and iOS Safari doesn't resize the page for it), whether
// something is being typed into (the bottom navigation steps aside for the keyboard), and
// a long press standing in for the right-click that opens menus. Framework-free; main.tsx
// starts it once.
import { useSyncExternalStore } from 'react'

const EDITABLE = 'input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=range]), textarea, select, [contenteditable=""], [contenteditable=true]'
const LONG_PRESS = 600
// The least a virtual keyboard takes off the visible height; browser bars take less.
const KEYBOARD = 150

let typing: Element | null = null
const ls = new Set<() => void>()
// The element being typed into, or null: a terminal's hidden textarea counts.
export const useTyping = () => useSyncExternalStore((fn) => { ls.add(fn); return () => { ls.delete(fn) } }, () => typing)

export const coarse = () => matchMedia('(hover: none) and (pointer: coarse)').matches

// Whether the phone layout is on (shell/layout.ts's isPhone), following resizes and turns.
const PHONE = '(max-width: 760px)'
const onPhoneChange = (fn: () => void) => { const q = matchMedia(PHONE); q.addEventListener('change', fn); return () => q.removeEventListener('change', fn) }
export const usePhone = () => useSyncExternalStore(onPhoneChange, () => matchMedia(PHONE).matches)

export function initPhone() {
  const root = document.documentElement
  const vv = window.visualViewport
  // --vv-h and --vv-top: the part of the page the user sees. The phone layout pins the shell
  // to it, so the prompt input sits right above the keyboard on every browser.
  let raf = 0
  const fit = () => {
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => {
      root.style.setProperty('--vv-h', `${Math.round(vv ? vv.height : innerHeight)}px`)
      root.style.setProperty('--vv-top', `${Math.round(vv ? vv.offsetTop : 0)}px`)
      keyboardState()
    })
  }
  vv?.addEventListener('resize', fit)
  vv?.addEventListener('scroll', fit)
  addEventListener('resize', fit)
  fit()

  // data-typing on the root while the keyboard is up. A text field taking the focus raises
  // it; putting it away (Android's back button, iOS's chevron) can leave the focus where it
  // was, so the visible height tells: once it has shrunk by a keyboard's height during this
  // focus and grown back, the keyboard is away until the height shrinks again.
  let full = 0, fullW = 0, shrunk = false
  const keyboardState = () => {
    const h = vv ? vv.height : innerHeight, w = vv ? vv.width : innerWidth
    if (Math.abs(w - fullW) > 1) { fullW = w; full = h } // turned: a new full height
    full = Math.max(full, h)
    const up = h < full - KEYBOARD
    if (!typing) shrunk = false
    else if (up) shrunk = true
    root.toggleAttribute('data-typing', !!typing && (up || !shrunk))
  }
  const focus = () => {
    const el = document.activeElement
    const now = el && el !== document.body && el.matches(EDITABLE) ? el : null
    if (now === typing) return
    typing = now
    shrunk = false
    keyboardState()
    fit()
    for (const fn of ls) fn()
  }
  document.addEventListener('focusin', focus)
  document.addEventListener('focusout', () => setTimeout(focus, 0))

  // A long touch opens the context menu where the finger is. Android sends contextmenu by
  // itself; iOS doesn't, so a press held without moving sends one, unless one came already.
  let timer = 0, start: { x: number; y: number } | null = null, got = false, swallow = false, touched = 0
  const cancel = () => { clearTimeout(timer); start = null }
  addEventListener('pointerdown', (e) => {
    swallow = false
    if (e.pointerType !== 'touch') return
    const target = e.target as Element
    // A control that owns its long press (data-lp: the paperclip, rows using useLongPress in ui/longpress.ts)
    // gets no shim contextmenu, and its click isn't eaten.
    if (target.closest?.(EDITABLE) || target.closest?.('[data-lp]')) return
    touched = Date.now()
    start = { x: e.clientX, y: e.clientY }
    got = false
    clearTimeout(timer)
    timer = window.setTimeout(() => {
      if (!start || got) return
      swallow = true
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: start.x, clientY: start.y }))
      start = null
    }, LONG_PRESS)
  }, true)
  addEventListener('pointermove', (e) => { if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel() }, true)
  addEventListener('pointerup', cancel, true)
  addEventListener('pointercancel', cancel, true)
  addEventListener('contextmenu', (e) => { if (e.isTrusted && Date.now() - touched < 2000 && !(e.target as Element).closest?.('[data-lp]')) { got = true; swallow = true } }, true)
  // The finger lifting after a long press isn't a tap.
  addEventListener('click', (e) => { if (swallow) { swallow = false; e.preventDefault(); e.stopPropagation() } }, true)
}
