// What the bottom world's prompt input needs to write for the main pane a desktop shows: a view
// that used to carry its own input (a mail thread, an ITSA) publishes it while it is open, and the
// bottom input reads it, so there is one input, always in the bottom world (S-1436). A phone keeps
// the in-view boxes and publishes nothing.
import { useSyncExternalStore } from 'react'
import type { ComposerHandle, ComposerNote, ComposerTarget, SendPayload } from './Composer'

export interface BottomSlot {
  target: ComposerTarget
  onSend: (p: SendPayload) => Promise<string | void>
  // Something besides the text is ready to send (staged answers or an action).
  staged?: boolean
  onInput?: (text: string) => void
  // Takes what the send consumes at submit; the function it returns undoes that if the send fails.
  onSubmit?: () => (() => void) | void
  note?: ComposerNote | null
  // Its send takes cc and an ITSA (a thread reply), so the box offers cc pills (S-1464).
  takesCc?: boolean
}
const slots = new Map<string, BottomSlot>()
const ls = new Set<() => void>()
let v = 0
const bump = () => { v++; for (const fn of ls) fn() }
export function setBottomSlot(key: string, s: BottomSlot | null) {
  if (s) slots.set(key, s)
  else if (!slots.delete(key)) return
  bump()
}
export const getBottomSlot = (key: string) => slots.get(key)
export const useBottomSlotVersion = () => useSyncExternalStore((fn) => { ls.add(fn); return () => { ls.delete(fn) } }, () => v)

// The bottom input's handle, for a view that focuses it or puts a draft back in it.
let handle: Pick<ComposerHandle, 'focus' | 'restore'> | null = null
export const setBottomHandle = (h: Pick<ComposerHandle, 'focus' | 'restore'> | null) => { handle = h }
export const bottomHandle = () => handle
