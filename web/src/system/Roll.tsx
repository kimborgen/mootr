// A number that rolls to each new value (S-463), and the "+$" that rises over a cost as it grows.
// The value lives in a Motion value and each frame writes the span's text directly, only when
// the text changes, so React renders once per new value, never per frame (roll.ts).
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { animate, useMotionValue } from 'motion/react'
import { frameText, NO_RISE, riseNext, rollSpan, type RollRun } from './roll'
import { tween, type Timing } from './springs'

// The motion tokens the view read last (SystemView), for every card and instrument under it.
export const TimingContext = createContext<Timing>({ slow: 0, tick: 0, keep: 0, ease: null })
export const useTiming = () => useContext(TimingContext)

export function Roll({ value, fmt, className }: { value: number; fmt: (v: number) => string; className?: string }) {
  const { tick, ease } = useTiming()
  const mv = useMotionValue(value)
  const el = useRef<HTMLSpanElement>(null)
  const run = useRef<RollRun | null>(null)
  const fmtRef = useRef(fmt)
  fmtRef.current = fmt
  // The text is ours, not React's: written on mount, on a format change, and per frame.
  useLayoutEffect(() => {
    const write = (v: number) => { const t = frameText(el.current?.textContent ?? null, v, fmtRef.current); if (t !== null && el.current) el.current.textContent = t }
    write(mv.get())
    return mv.on('change', write)
  }, [mv])
  useLayoutEffect(() => { if (el.current) el.current.textContent = fmt(mv.get()) }, [fmt]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (mv.get() === value) return
    const s = rollSpan(run.current, performance.now(), tick)
    run.current = s.run
    if (!s.ms) { mv.jump(value); return }
    const a = animate(mv, value, tween(s.ms, ease))
    return () => a.stop()
  }, [value, tick, ease, mv])
  return <span ref={el} className={className} data-roll={value} />
}

// The rise over a growing number: "+$0.42", drifting up and fading (system.css .sv-rise). Rises
// that come close together add up into one.
export function Rise({ value, fmt }: { value: number | null | undefined; fmt: (v: number) => string }) {
  const { slow } = useTiming()
  const [r, setR] = useState(NO_RISE)
  // The rise lasts --duration-focus (five slows); a growth in its first half joins it.
  useEffect(() => setR((x) => riseNext(x, value, performance.now(), slow * 2.5)), [value, slow])
  if (!r.key || !slow) return null
  return <span key={r.key} className="sv-rise" aria-hidden="true">+{fmt(r.amount)}</span>
}
