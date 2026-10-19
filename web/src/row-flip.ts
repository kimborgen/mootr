// The pure parts of the sidebar's spawn and archive motion (S-700, sidebar-flip.tsx): which agents
// have a real spawn or archive event pending, and the FLIP arithmetic for the rows around them.

// How long an event waits for its row to show up (the list refetches after the event) before it is
// dropped. A spawn into a collapsed parent, or one the filter hides, never shows a row.
export const PENDING_MS = 15000
// The start of a growing row and the end of a collapsing one: a slight scale, as the stamp's.
export const ROW_SCALE = 0.96
// A row more than this far outside the list's viewport doesn't animate.
export const BAND_ROWS = 1

// Events from the live stream, keyed by agent id. A bulk load, a poll, or a refresh adds nothing
// here, so only a real spawn or archive can animate. An entry older than PENDING_MS is dropped
// whenever the list is read or written, so a row that never shows can't animate much later.
export class Pending {
  private m = new Map<string, number>()
  private prune(now: number) { for (const [id, at] of this.m) if (now - at > PENDING_MS) this.m.delete(id) }
  add(id: string, now = Date.now()) { this.prune(now); this.m.set(id, now) }
  // Whether an event for `id` is waiting; taking it consumes it.
  take(id: string, now = Date.now()): boolean {
    this.prune(now)
    return this.m.delete(id)
  }
  has(id: string, now = Date.now()): boolean {
    this.prune(now)
    return this.m.has(id)
  }
  get size() { return this.m.size }
  clear() { this.m.clear() }
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
// A grow or collapse covers at most this many rows, so a far parent doesn't fling the row across
// the list.
export const MAX_TRAVEL_ROWS = 4
export const clampTravel = (dy: number, rowHeight: number) => Math.max(-MAX_TRAVEL_ROWS * rowHeight, Math.min(MAX_TRAVEL_ROWS * rowHeight, dy))

// How far each row that stays has to be pushed back to look as it did: its old top (plus the offset
// it was still drawn at when interrupted) less its new top. Rows that didn't move are left out.
export function flipDeltas(prev: Map<string, number>, next: Map<string, number>, carried: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>()
  for (const [key, top] of next) {
    const was = prev.get(key)
    if (was === undefined) continue
    const d = was + (carried.get(key) ?? 0) - top
    if (Math.abs(d) >= 1) out.set(key, d)
  }
  return out
}

// Whether a span [top, top + height] lies within `rows` row-heights of the list's viewport.
export function nearViewport(top: number, height: number, scrollTop: number, view: number, rows = BAND_ROWS): boolean {
  return top + height >= scrollTop - rows * height && top <= scrollTop + view + rows * height
}
