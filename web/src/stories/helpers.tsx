// What states share: running a step once the state has drawn (opening a menu needs its
// trigger on screen), and keeping a transient surface up for the frame to show.
import { useEffect, useRef, type ReactNode } from 'react'

// Renders children, then runs `run` with the element they drew into, once. A step that needs
// something a fetch draws throws until it exists (`querySelector(..)!` is null), so a throw
// waits for the next change inside the element and tries again, for up to WAIT_MS, then
// rethrows. It waits on the DOM, not a delay, so a loaded machine only takes longer. A step
// must throw before any side effect, or be idempotent: it can run again.
const WAIT_MS = 5000
// Steps that have not succeeded yet, so the stories test can wait for them and fail on the
// last error of one that never does (an unmounted state's step is dropped).
const pending = new Set<{ err: unknown }>()
export function pendingStepError(): { err: unknown } | undefined { return pending.values().next().value }
export function OnMount({ run, children }: { run: (el: HTMLElement) => void; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current!
    const step = { err: new Error('the OnMount step has not run yet') as unknown }
    pending.add(step)
    let mo: MutationObserver | undefined
    let giveUp: ReturnType<typeof setTimeout> | undefined
    const stop = () => { mo?.disconnect(); clearTimeout(giveUp); pending.delete(step) }
    const attempt = (): boolean => {
      try { run(el); stop(); return true } catch (e) { step.err = e; return false }
    }
    const t = setTimeout(() => {
      if (attempt()) return
      // A failed step's own changes are not a reason to try again (that would never end).
      mo = new MutationObserver(() => { if (!attempt()) mo!.takeRecords() })
      mo.observe(el, { childList: true, subtree: true, attributes: true })
      mo.takeRecords()
      giveUp = setTimeout(() => { stop(); throw step.err }, WAIT_MS)
    })
    return () => { clearTimeout(t); stop() }
  }, [])
  return <div ref={ref} className="story-pad">{children}</div>
}

// Runs fn with setTimeout stubbed, so a notice it starts never times out of the frame.
export function holdTimers(fn: () => void) {
  const st = window.setTimeout
  window.setTimeout = (() => 0) as unknown as typeof window.setTimeout
  try { fn() } finally { window.setTimeout = st }
}

// A row of examples with a label under each, for a component shown several ways at once.
export function Row({ items }: { items: { label: string; node: ReactNode }[] }) {
  return <div className="story-row">{items.map((x) => <div key={x.label} className="story-cell">{x.node}<span className="muted">{x.label}</span></div>)}</div>
}

// The left sidebar's column: the whole width on a phone, and the sidebar's default 300 px
// (shell/layout.ts DEFAULTS) on a desktop, so a list draws at the width it has in the app.
export function Side({ children }: { children: ReactNode }) {
  return <div className="story-side">{children}</div>
}
