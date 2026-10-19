// The agents sidebar's row motion (S-698), on the S-696 motion gate: a spend hairline under a
// row's cost, a one-off stamp on a mark whose value changed (the state ring, the ITSA chip, the
// unread badge), and a one-off nudge when an agent's owned issue changes status. Every trigger
// calls `canAnimate(kind, el)` at the moment it fires, so nothing moves while the tree scrolls,
// for an off-screen row, under reduced motion, or with its kind switched off in Settings ›
// Motion. `transform` and `opacity` only, and each element's own duration token.
import { useEffect, useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from 'react'
import { animate } from 'motion/react'
import { canAnimate } from './motion-gate'
import { readTiming, SPRINGS, spring, tween } from './system/springs'

// A stamp settling from 1.15 and a slight turn, as the system view's marks do (system-view-motion).
const STAMP_FROM = 'scale(1.15) rotate(-6deg)'
const STAMP_TO = 'scale(1) rotate(0deg)'
// A one-off nudge of an issue-event row: right and back. A row that starts waiting on the human
// gets the longer one (S-698).
const NUDGE_PX = 4
const NUDGE_WAIT_PX = 7
// In a document with no `--duration-slow` (a test), a stamp still coalesces its burst.
const COALESCE_FLOOR_MS = 120

interface StampProps extends HTMLAttributes<HTMLSpanElement> {
  // The value the mark shows. A change to it is the event a stamp marks.
  value: unknown
  // The motion kind the gate checks ('stamps' unless the mark belongs to another kind).
  kind?: string
  // Only a rise stamps; a fall (mail read, a count going down) is not the event.
  increaseOnly?: boolean
  children?: ReactNode
}

// The stamp wrapper: a span that IS the mark (the glyph wrapper, the ITSA chip, the unread
// badge), stamped once each time `value` changes. Bursts coalesce: a change arriving while the
// spring still runs doesn't start a second stamp. The stamp leaves `data-stamps` behind, so a
// check or a screenshot can see it happened.
export function Stamp({ value, kind = 'stamps', increaseOnly, children, ...rest }: StampProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const prev = useRef(value)
  const last = useRef(0)
  // The stamp in flight, so a coalesced change does not stop it: React runs an effect's cleanup
  // before the next run, and `stop()` tears down mid-flight without reverting, which would freeze
  // the mark part-way (S-698 review). Stop only on unmount, or when a new stamp replaces it.
  const run = useRef<ReturnType<typeof animate> | null>(null)
  useLayoutEffect(() => {
    const was = prev.current
    if (Object.is(was, value)) return
    prev.current = value
    if (increaseOnly && typeof value === 'number' && typeof was === 'number' && value <= was) return
    const el = ref.current
    if (!el) return
    const { slow } = readTiming(el)
    // Coalesce a burst (the daemon may send several changes at once): one stamp per spring.
    const now = performance.now()
    if (now - last.current < Math.max(SPRINGS.stamp.slows * slow, COALESCE_FLOOR_MS)) return
    if (!canAnimate(kind, el)) return
    last.current = now
    el.dataset.stamps = String(Number(el.dataset.stamps ?? '0') + 1)
    run.current?.stop()
    run.current = animate(el, { transform: [STAMP_FROM, STAMP_TO] }, spring(SPRINGS.stamp, slow))
  }, [value, kind, increaseOnly])
  useEffect(() => () => { run.current?.stop() }, [])
  return <span ref={ref} {...rest}>{children}</span>
}

// The spend hairline under a row's cost: the agent's own spend against the biggest spender shown,
// on a square-root scale, so a small agent's bar still reads. Spend that grows eases the fill to
// its new width by `transform: scaleX` alone and flashes the working colour, then settles. A
// shrink (a mode change, a smaller max) jumps; only growth is an event.
export function SpendBar({ value, max }: { value: number | null | undefined; max: number }) {
  const ref = useRef<HTMLElement>(null)
  const frac = value != null && max > 0 ? Math.min(1, Math.sqrt(Math.max(0, value) / max)) : 0
  const settle = useRef<ReturnType<typeof setTimeout>>(undefined)
  const run = useRef<ReturnType<typeof animate> | null>(null)
  const drawn = useRef(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // The first draw is not an event: a row mounting (or a newly visible row) shows its bar at
    // once, with no sweep and no flash of the working colour (S-698 review).
    if (!drawn.current) { drawn.current = true; el.style.transform = `scaleX(${frac})`; return }
    // Where the fill is drawn now, so an interrupted grow continues from there, not from its
    // old target.
    const from = () => {
      const m = getComputedStyle(el).transform
      const s = /matrix\(([-\d.e]+)/.exec(m || '')
      return s ? Math.abs(parseFloat(s[1])) : 0
    }
    const was = from()
    if (!(frac > was) || !canAnimate('spend', el)) { el.style.transform = `scaleX(${frac})`; return }
    const t = readTiming(el)
    el.classList.add('fresh')
    clearTimeout(settle.current)
    settle.current = setTimeout(() => el.classList.remove('fresh'), t.slow + 400)
    run.current?.stop()
    run.current = animate(el, { transform: [`scaleX(${was})`, `scaleX(${frac})`] }, tween(t.slow, t.ease))
  }, [frac])
  useEffect(() => () => { run.current?.stop(); clearTimeout(settle.current) }, [])
  return <span className="spend" aria-hidden="true"><i ref={ref} /></span>
}

interface TreeRowProps extends HTMLAttributes<HTMLDivElement> {
  // The row's owned-issue signature (the shown ITSA's id and status): a change nudges the row.
  event: string
  // Whether the issue now waits on the human: the nudge is longer.
  waiting: boolean
  children?: ReactNode
}

// How far an issue-event row nudges: longer when the issue has just started waiting on the human.
export const nudgePx = (waiting: boolean, wasWaiting: boolean) => (waiting && !wasWaiting ? NUDGE_WAIT_PX : NUDGE_PX)

// A tree row that nudges once when its owned issue changes status. `event` is the signature the
// row watches; `waiting` says whether the new state is one that waits on the human.
export function TreeRow({ event, waiting, children, ...rest }: TreeRowProps) {
  const ref = useRef<HTMLDivElement>(null)
  const prev = useRef<{ event: string; waiting: boolean } | null>(null)
  const run = useRef<Animation | null>(null)
  useLayoutEffect(() => {
    const was = prev.current
    prev.current = { event, waiting }
    if (!was || was.event === event) return
    const el = ref.current
    if (!el || !canAnimate('issue-events', el)) return
    el.dataset.nudge = String(Number(el.dataset.nudge ?? '0') + 1)
    const x = nudgePx(waiting, was.waiting)
    const t = readTiming(el)
    run.current?.cancel()
    run.current = null
    if (typeof el.animate !== 'function') return
    // A native play that adds onto the row's transform, not Motion's: a Motion transform replaces
    // the row's other effects (the S-700 grow and FLIP, which are `add` plays), and would win.
    run.current = el.animate({ transform: ['translateX(0px)', `translateX(${x}px)`, 'translateX(0px)'] }, { duration: t.slow * 1.5, easing: t.ease ? `cubic-bezier(${t.ease.join(', ')})` : 'ease-out', composite: 'add' })
  }, [event, waiting])
  useEffect(() => () => { run.current?.cancel() }, [])
  return <div ref={ref} {...rest}>{children}</div>
}
