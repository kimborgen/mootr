// Rolling numbers on the system view (S-463): a card's cost, the day's spend, the window meters,
// and the counts, in tabular figures. Pure, so it tests without a browser; Roll.tsx drives it
// with a Motion value.

// One frame at 60 Hz: a roll with less left than this snaps to its value.
export const FRAME_MS = 16

// A roll's deadline. A new value that arrives while a roll runs keeps the running roll's end, so
// the shown number skips the frames between and never lags the data by more than one roll
// (system-view-motion: skip frames rather than queue them).
export interface RollRun { end: number }
export function rollSpan(run: RollRun | null, now: number, dur: number): { ms: number; run: RollRun | null } {
  if (dur <= 0) return { ms: 0, run: null }
  if (run && run.end > now) {
    const ms = run.end - now
    return ms < FRAME_MS ? { ms: 0, run: null } : { ms, run }
  }
  return { ms: dur, run: { end: now + dur } }
}

// The text a frame writes, or null when it would write what is already shown: most frames of a
// cent-wide roll draw nothing.
export const frameText = (shown: string | null, v: number, fmt: (v: number) => string): string | null => {
  const t = fmt(v)
  return t === shown ? null : t
}

// The "+$" that rises over a cost when it grows. A rise that starts within `merge` ms of the last
// one adds to it rather than starting another, so a busy agent shows one rising sum, not a
// stream. Growth under `min` waits until it adds up to `min`; a drop resets the base.
export interface Rise { key: number; amount: number; t0: number; base: number | null }
export const NO_RISE: Rise = { key: 0, amount: 0, t0: -Infinity, base: null }
export function riseNext(r: Rise, next: number | null | undefined, now: number, merge: number, min = 0.01): Rise {
  if (next == null) return r
  if (r.base == null) return { ...r, base: next }
  const d = next - r.base
  if (d < 0) return { ...r, base: next }
  if (d < min) return r
  if (r.key && now - r.t0 < merge) return { ...r, amount: r.amount + d, base: next }
  return { key: r.key + 1, amount: d, t0: now, base: next }
}
