// The system view's springs (S-463), for Motion (`motion/react`): card moves, spawns, archives,
// and stamps. Each preset's length is a share of --duration-slow, read from the tokens at run
// time, so no duration is written here, reduced motion (which zeroes the token) makes every one
// instant, and a check that slows the token slows them too. Bounce stays at 0.2 or less
// (system-view-motion). The lengths below are at the token's 220 ms.
import type { Transition } from 'motion/react'
import { durationMs } from '../ui/duration'

export interface Preset { bounce: number; slows: number }
export const SPRINGS = {
  // A card gliding to its new place when the layout changes (FLIP by transform): bounce 0.1, 440 ms.
  move: { bounce: 0.1, slows: 2 },
  // A spawn growing out of its parent's place: bounce 0.15, 550 ms.
  grow: { bounce: 0.15, slows: 2.5 },
  // A card appearing in place on the phone's outline (S-462): a short settle, no bounce, 330 ms.
  appear: { bounce: 0, slows: 1.5 },
  // An archive shrinking back into its parent: no bounce, so it never swells on the way out, 330 ms.
  shrink: { bounce: 0, slows: 1.5 },
  // A status stamp settling from 1.15 and a slight turn: bounce 0.2, 330 ms.
  stamp: { bounce: 0.2, slows: 1.5 },
} satisfies Record<string, Preset>

// A preset as a Motion transition, for a --duration-slow of `slowMs`. At 0 ms (reduced motion)
// the change is instant.
export function spring(p: Preset, slowMs: number): Transition {
  const s = (p.slows * slowMs) / 1000
  return s > 0 ? { type: 'spring', bounce: p.bounce, visualDuration: s } : { duration: 0 }
}

// A cubic-bezier() easing token as Motion's four numbers, or null when it isn't one.
export type Bezier = [number, number, number, number]
export function parseBezier(css: string): Bezier | null {
  const m = /cubic-bezier\(([^)]*)\)/.exec(css)
  const n = m?.[1].split(',').map(Number)
  return n && n.length === 4 && n.every(Number.isFinite) ? (n as Bezier) : null
}

// What the view reads from its tokens for Motion (SystemView, through TimingContext).
// `keep`: how long a card keeps an ITSA just done, for its done sheet's flight and the mark after.
export interface Timing { slow: number; tick: number; keep: number; ease: Bezier | null }

// A tween over `ms` on the ease-out token's curve, for a number's roll.
export const tween = (ms: number, ease: Bezier | null): Transition => (ms > 0 ? { duration: ms / 1000, ease: ease ?? 'easeOut' } : { duration: 0 })

// A duration token's ms, read through a throwaway probe, so the reduced-motion zeroing and a
// check's override both apply. Custom properties inherit, so a child probe on `el` sees the same
// tokens; `el` itself is never written, since an inline transition-duration leaves it with
// `transition: all` (transition-property defaults to all) and fades its background on hover
// (S-1023).
export function tokenMs(el: HTMLElement, token: string): number {
  return onProbe(el, (probe) => {
    probe.style.transitionDuration = `var(${token})`
    return durationMs(getComputedStyle(probe).transitionDuration)
  })
}

// Runs `read` on a fresh probe, an empty out-of-flow child of `el` (hidden, so it can never show
// or take a click), and removes it again before this returns, so the caller is left untouched.
function onProbe<T>(el: HTMLElement, read: (probe: HTMLElement) => T): T {
  const probe = el.ownerDocument.createElement('i')
  probe.style.cssText = 'position: absolute; visibility: hidden'
  el.appendChild(probe)
  try { return read(probe) } finally { probe.remove() }
}

// The view's tokens for Motion: each duration read through a throwaway probe, so nothing is
// written to `el`.
export const readTiming = (el: HTMLElement): Timing => ({
  slow: tokenMs(el, '--duration-slow'), tick: tokenMs(el, '--duration-tick'), keep: tokenMs(el, '--duration-flight') + tokenMs(el, '--duration-mark'), ease: parseBezier(getComputedStyle(el).getPropertyValue('--ease-out')),
})

// A full transform string for a card at a place, at a scale: Motion animates the whole string,
// so it runs as one composited transform (never scale(0); a spawn starts at GROW_FROM).
export const cardTransform = (x: number, y: number, k = 1) => `translate(${x}px, ${y}px) scale(${k})`
