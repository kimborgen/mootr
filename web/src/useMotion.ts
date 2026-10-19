// useMotion(kind, ref?): whether that kind of animation may run now (motion-gate.ts). With a ref,
// the element's visibility and scrolling count too. Re-evaluates when the settings, the element's
// visibility, or its scrolling change. The value is a snapshot from the last render: a caller that
// starts an animation on an event calls canAnimate(kind, el) at that moment instead, so it never
// acts on a stale answer.
import { useEffect, useState, type RefObject } from 'react'
import { canAnimate, loadMotion, startMotionGate, subscribeMotion, watchVisible } from './motion-gate'

export function useMotion(kind: string, ref?: RefObject<Element | null>): boolean {
  const [ok, setOk] = useState(() => canAnimate(kind, ref?.current))
  useEffect(() => {
    startMotionGate()
    const el = ref?.current
    const stop = el ? watchVisible(el) : () => {}
    const update = () => setOk(canAnimate(kind, ref?.current))
    const off = subscribeMotion(update)
    void loadMotion().catch(() => {})
    update()
    return () => { off(); stop() }
  }, [kind, ref])
  return ok
}
