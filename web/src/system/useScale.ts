// The system view's hooks for scale (S-540), over the pure parts in scale.ts: which managers are
// folded (the focus, and the human's own toggles, kept per viewer), and which cards are mounted
// (culling to the viewport). SystemView owns the pan and zoom; these only read it.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Laid, TreeIn } from './layout'
import { admit, ancestors, CULL_MARGIN, focusFolds, inView, loadFolds, sameSet, saveFolds, shownFolds, subtree, type View } from './scale'

// Nothing is folded to start with, at any size and any number of agents (S-705): folding is the
// human's own action, or the focus. Shared, since shownFolds copies it.
const NO_FOLDS: ReadonlySet<string> = new Set()

export interface Folds {
  folded: Set<string>
  toggle: (id: string) => void
  // The manager in focus, or null: its subtree open, every other manager folded.
  focus: string | null
  setFocus: (id: string | null) => void
  // Unfold a card's ancestors, so it shows, leaving a focus it lies outside: whether the folds change.
  reveal: (id: string) => boolean
}

// `nodesSig` changes exactly when `nodes` does in shape.
export function useFolds(nodes: TreeIn[], nodesSig: string, narrow: boolean): Folds {
  // The human's own folds are the only ones at rest, and outlive the page (per viewer, per size).
  const [toggles, setToggles] = useState<Record<string, boolean>>(() => loadFolds(narrow))
  useEffect(() => setToggles(loadFolds(narrow)), [narrow])
  const [focus, setFocusRaw] = useState<string | null>(null)
  // In focus, folds outside the focused subtree last only as long as the focus.
  const [focusToggles, setFocusToggles] = useState<Record<string, boolean>>({})
  const setFocus = useCallback((id: string | null) => { setFocusRaw(id); setFocusToggles({}) }, [])
  useEffect(() => { if (focus && !nodes.some((n) => n.id === focus)) setFocus(null) }, [nodesSig, focus]) // eslint-disable-line react-hooks/exhaustive-deps
  const within = useMemo(() => (focus ? new Set([focus, ...subtree(nodes, focus)]) : null), [nodesSig, focus]) // eslint-disable-line react-hooks/exhaustive-deps
  const folded = useMemo(() => {
    const base = focus ? focusFolds(nodes, focus) : NO_FOLDS
    return shownFolds(shownFolds(base, toggles, within ?? undefined), focusToggles)
  }, [nodesSig, narrow, focus, within, toggles, focusToggles]) // eslint-disable-line react-hooks/exhaustive-deps
  const ids = useRef(new Set<string>())
  ids.current = new Set(nodes.map((n) => n.id))
  // Toggles for agents no longer in the tree are dropped as the human folds.
  const keep = (t: Record<string, boolean>, set: Record<string, boolean>) => {
    const next: Record<string, boolean> = {}
    for (const [k, v] of Object.entries({ ...t, ...set })) if (ids.current.has(k)) next[k] = v
    return next
  }
  const own = (set: Record<string, boolean>) => setToggles((t) => { const next = keep(t, set); saveFolds(narrow, next); return next })
  const toggle = (id: string) => {
    const set = { [id]: !folded.has(id) }
    if (within && !within.has(id)) setFocusToggles((t) => ({ ...t, ...set }))
    else own(set)
  }
  const reveal = (id: string) => {
    const up = ancestors(nodes, id).filter((a) => folded.has(a))
    if (focus && within && !within.has(id) && id !== focus) {
      // Outside the focus: leave it, and unfold the path under the human's own folds.
      setFocus(null)
      const plain = shownFolds(NO_FOLDS, toggles)
      own(Object.fromEntries(ancestors(nodes, id).filter((a) => plain.has(a)).map((a) => [a, false])))
      return true
    }
    if (up.length) own(Object.fromEntries(up.map((a) => [a, false])))
    return up.length > 0
  }
  return { folded, toggle, focus, setFocus, reveal }
}

// The cards to mount: those within the viewport and CULL_MARGIN around it, worked out as the view
// moves (`now`, so what comes into view mounts in the same frame) and whenever the layout or stage
// changes; the margin's cards past the cap follow over the next frames. Null until the first
// measure, when no card mounts: the first paint draws only those in view.
export function useCull(laid: Laid | null, stage: React.RefObject<HTMLElement | null>, view: React.RefObject<View>, cardH: number, size: { w: number; h: number }) {
  const [mounted, setMounted] = useState<Set<string> | null>(null)
  const cur = useRef<Set<string> | null>(null)
  const frame = useRef(0)
  // The stage's size as last observed: reading it from the element would force a style recalc
  // and layout on every frame of a zoom, right after the zoom was written (S-462).
  const box = useRef(size)
  box.current = size
  const measure = useCallback(() => {
    cancelAnimationFrame(frame.current)
    frame.current = 0
    const el = stage.current
    if (!laid || !el || !cardH) return
    const v = view.current
    const W = box.current.w || el.clientWidth, H = box.current.h || el.clientHeight, m = cur.current
    const { ids, more } = admit(inView(laid.pos, v, W, H, cardH, CULL_MARGIN, m), inView(laid.pos, v, W, H, cardH, 0), m)
    if (!m || !sameSet(m, ids)) { cur.current = ids; setMounted(ids) }
    // The rest mount over the next frames.
    if (more) frame.current = requestAnimationFrame(() => measureRef.current())
  }, [laid, stage, view, cardH])
  const measureRef = useRef(measure)
  measureRef.current = measure
  useLayoutEffect(() => { measure() }, [measure, size.w, size.h])
  useEffect(() => () => cancelAnimationFrame(frame.current), [])
  return { mounted, now: measure }
}
