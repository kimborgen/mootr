// The Swipe view's gestures (S-1003): a card follows the finger (or a mouse drag), and the
// direction it is pulled says what lifting it does: left archives, right leaves it (the card
// goes to the back, nothing changes on the server), up defers. A pull short of the threshold,
// or a downward one, springs back; a fast flick past a third of it counts. A press that barely
// moves is a tap, left to the card's click. The decisions are pure, so they test without a DOM.
export type SwipeAction = 'archive' | 'leave' | 'defer'

// Movement under this many px is a tap, not a drag.
export const TAP_SLOP = 8
// A release this fast (px per ms) along the pull fires its action from a third of the threshold.
export const FLICK = 0.5
// The shortest time a release velocity is measured over.
export const MIN_FLICK_MS = 50

// How far a card must be pulled to fire: 30% of its width, kept between 72 and 120 px, so a
// phone's card needs a deliberate pull and a desktop's isn't a long mouse drag.
export const threshold = (width: number) => Math.min(120, Math.max(72, width * 0.3))

// The action a pull points at, and how far it is toward firing (0 to 1). Up wins only when it
// is the larger part of the pull; a pull mostly down points at nothing.
export function pullAction(dx: number, dy: number, limit: number): { action: SwipeAction | null; progress: number } {
  const ax = Math.abs(dx)
  const up = -dy
  if (up > ax) return { action: 'defer', progress: Math.min(1, up / limit) }
  if (ax > 0 && ax >= Math.abs(dy)) return { action: dx < 0 ? 'archive' : 'leave', progress: Math.min(1, ax / limit) }
  return { action: null, progress: 0 }
}

// The action a release fires, or null to spring back: past the threshold, or a flick along the
// pull's direction (velocity in px per ms) past a third of it.
export function releaseAction(dx: number, dy: number, vx: number, vy: number, limit: number): SwipeAction | null {
  const { action, progress } = pullAction(dx, dy, limit)
  if (!action) return null
  if (progress >= 1) return action
  const speed = action === 'defer' ? -vy : action === 'archive' ? -vx : vx
  return speed >= FLICK && progress >= 1 / 3 ? action : null
}

// The pointer's speed (px per ms) from a sample to the release, measured over at least
// MIN_FLICK_MS: one move just before the lift would otherwise read a slow pull as a flick.
export function releaseVelocity(from: { t: number; x: number; y: number }, to: { t: number; x: number; y: number }) {
  const dt = Math.max(MIN_FLICK_MS, to.t - from.t)
  return { vx: (to.x - from.x) / dt, vy: (to.y - from.y) / dt }
}

// The desktop's keys: arrows act as the swipes do, Enter opens the thread, z undoes the last one.
export function keyAction(key: string): SwipeAction | 'open' | 'undo' | null {
  return ({ ArrowLeft: 'archive', ArrowRight: 'leave', ArrowUp: 'defer', Enter: 'open', z: 'undo', Z: 'undo' } as Record<string, SwipeAction | 'open' | 'undo'>)[key] ?? null
}

// Where a card that fires flies to, as a transform: off the side, or off the top, it went.
export const flyTo = (a: SwipeAction) => (a === 'archive' ? 'translate(-150%, 0)' : a === 'leave' ? 'translate(150%, 0)' : 'translate(0, -150%)')
// A dragged card's transform: it tracks the pointer 1:1, tilting a little with a sideways pull.
export const dragTransform = (dx: number, dy: number) => `translate(${dx}px, ${dy}px) rotate(${Math.max(-6, Math.min(6, dx / 24))}deg)`

export interface DragHandlers {
  // While the card moves: where it is, and what lifting it now would point at.
  onPull: (dx: number, dy: number) => void
  // The finger lifted after a drag: the action to fire, or null to spring back.
  onRelease: (action: SwipeAction | null, dx: number, dy: number) => void
}

// Lets a card be dragged by touch, pen, or mouse. The card moves itself through `onPull`; this
// only reads the pointer. After a drag the click the release makes is swallowed, so a swipe
// never also opens the thread.
export function dragCard(card: HTMLElement, h: DragHandlers): () => void {
  const down = (e: PointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest?.('button, a, input, textarea')) return
    const x0 = e.clientX
    const y0 = e.clientY
    let dragging = false
    // The last few positions, for the release velocity.
    let samples: { t: number; x: number; y: number }[] = [{ t: e.timeStamp, x: x0, y: y0 }]
    const end = () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      removeEventListener('pointercancel', cancel)
    }
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return
      const dx = ev.clientX - x0
      const dy = ev.clientY - y0
      if (!dragging && Math.hypot(dx, dy) < TAP_SLOP) return
      dragging = true
      ev.preventDefault()
      samples = [...samples.filter((s) => ev.timeStamp - s.t < 100), { t: ev.timeStamp, x: ev.clientX, y: ev.clientY }]
      h.onPull(dx, dy)
    }
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return
      end()
      if (!dragging) return
      const dx = ev.clientX - x0
      const dy = ev.clientY - y0
      const v = releaseVelocity(samples[0], { t: ev.timeStamp, x: ev.clientX, y: ev.clientY })
      const limit = threshold(card.getBoundingClientRect().width)
      const stop = (c: Event) => { c.stopPropagation(); c.preventDefault() }
      card.addEventListener('click', stop, { capture: true, once: true })
      setTimeout(() => card.removeEventListener('click', stop, true), 400)
      h.onRelease(releaseAction(dx, dy, v.vx, v.vy, limit), dx, dy)
    }
    const cancel = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return
      end()
      if (dragging) h.onRelease(null, 0, 0)
    }
    addEventListener('pointermove', move, { passive: false })
    addEventListener('pointerup', up)
    addEventListener('pointercancel', cancel)
  }
  card.addEventListener('pointerdown', down)
  return () => card.removeEventListener('pointerdown', down)
}

// The stack's order: the inbox's threads newest first, the ones left (swiped right) at the back
// in the order they were left. A thread left before is back in line once new mail reaches it:
// `left` maps each thread to its latest mail id when it was left. `last` gives a thread's latest mail: a whole
// thread's own by default, or what an index row says of it (S-4616).
type Last = { id: string; created_at: string }
const lastMail = (t: unknown): Last => (t as { mails: Last[] }).mails.at(-1)!
export function stackOrder<T extends { thread_id: string }>(threads: T[], left: Map<string, string>, last: (t: T) => Last = lastMail): T[] {
  const isLeft = (t: T) => left.get(t.thread_id) === last(t).id
  const newest = [...threads].sort((a, b) => last(b).created_at.localeCompare(last(a).created_at))
  const back = [...left.keys()].map((id) => newest.find((t) => t.thread_id === id)).filter((t): t is T => !!t && isLeft(t))
  return [...newest.filter((t) => !isLeft(t)), ...back]
}

// The card being read stays on top until it is acted on: new mail goes under it, not over it,
// so a key press or tap never acts on a thread you haven't seen.
export function pinFront<T extends { thread_id: string }>(order: T[], id: string | null): T[] {
  const i = id ? order.findIndex((t) => t.thread_id === id) : -1
  return i > 0 ? [order[i], ...order.slice(0, i), ...order.slice(i + 1)] : order
}
