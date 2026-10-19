// Spawn and archive motion in the agents sidebar (S-700), on the S-696 gate (kind 'spawn-archive').
// A new agent's row grows out of its parent's row: it starts at the parent's place, transparent and
// slightly small, and settles into its slot. An archived row collapses into its parent's row and
// fades out before it leaves. The rows around them move by FLIP: React renders the new list, each
// row is measured against where it was, and it is played from the old place to the new by
// `transform` alone. The tree is a flat list of rows, so a row is keyed by its agent id.
//
// Only an event from the live stream animates (store.ts onAgentEvent): the rows on screen at load,
// and the ones a poll or a refresh brings, appear at once. An archived row has already left the
// tree when this runs, so the detached node itself plays as a ghost in a layer of its own. When
// the gate says no (settings, reduced motion, scrolling, off screen), or any of this fails to
// measure, the rows jump to their places. A new event restarts every row from where it is drawn.
//
// The plays are native Web Animations on `composite: 'add'`, not Motion's: a row's issue nudge
// (sidebar-motion.tsx) is a Motion transform on the same element, and Motion stops whatever else
// it drives on a value, where a native effect adds to it and leaves no inline style behind. So a
// nudge during a grow stops neither, and a cancelled play leaves nothing to clean.
import { useEffect, useLayoutEffect, useRef } from 'react'
import { canAnimate } from './motion-gate'
import { clampTravel, flipDeltas, lerp, nearViewport, Pending, ROW_SCALE } from './row-flip'
import { onAgentEvent } from './store'
import { readTiming } from './system/springs'

const KIND = 'spawn-archive'

// A play in flight: the transform animation, the fade beside it, and the translate and opacity they
// run between, so where the row is drawn now is known without reading a node that may already have
// left the DOM.
interface Run { anim: Animation; fade: Animation | null; ty: [number, number]; o: [number, number] }
const progress = (a: Animation) => {
  const p = a.effect?.getComputedTiming().progress
  return typeof p === 'number' ? p : 1
}
const drawnTy = (r: Run) => lerp(r.ty[0], r.ty[1], progress(r.anim))
const drawnOpacity = (r: Run) => lerp(r.o[0], r.o[1], r.fade ? progress(r.fade) : 1)
const cancel = (r: Run) => { r.anim.cancel(); r.fade?.cancel() }

// A row's identity across renders. An agent shown more than once (several parents) keeps one key per
// appearance; the stopped list is its own section.
function keyed(rows: HTMLElement[]): Map<string, HTMLElement> {
  const out = new Map<string, HTMLElement>()
  for (const el of rows) {
    const base = (el.dataset.sec === 'stopped' ? 's:' : 'r:') + el.dataset.id
    let key = base
    for (let n = 1; out.has(key); n++) key = `${base}@${n}`
    out.set(key, el)
  }
  return out
}
const idOf = (key: string) => key.slice(2).replace(/@\d+$/, '')

// The layer ghosts play in, drawn inside the tree like the mail layer: it scrolls with the rows.
export function RowFlip() {
  const layer = useRef<HTMLDivElement>(null)
  const spawned = useRef(new Pending())
  const archived = useRef(new Pending())
  const prev = useRef<{ tops: Map<string, number>; els: Map<string, HTMLElement> } | null>(null)
  const runs = useRef(new Map<Element, Run>())
  const ghosts = useRef(new Set<HTMLElement>())

  useEffect(() => {
    const off = onAgentEvent((e) => {
      if (e.type === 'archived') return archived.current.add(e.id)
      // A spawn under a parent the list doesn't show, or shows collapsed, makes no row now: a
      // later expand by the user is not a spawn.
      const tree = layer.current?.parentElement
      if (e.parent) {
        const parent = [...(tree?.querySelectorAll<HTMLElement>('.node[data-id]') ?? [])].find((n) => n.dataset.id === e.parent)
        if (!parent || parent.getAttribute('aria-expanded') === 'false') return
      }
      spawned.current.add(e.id)
    })
    const live = runs.current
    const g = ghosts.current
    return () => {
      off()
      for (const r of live.values()) cancel(r)
      live.clear()
      for (const x of g) x.remove()
      g.clear()
    }
  }, [])

  // After every render of the tree. Nothing here sets state, so it never renders again.
  useLayoutEffect(() => {
    // The tree is the layer's parent: it is attached before this runs, where the tree's own ref
    // (set after its children's effects) is not yet on the first render.
    const el = layer.current?.parentElement
    if (!el) return
    const now = keyed([...el.querySelectorAll<HTMLElement>('.node[data-id]')])
    const tops = new Map([...now].map(([k, r]) => [k, r.offsetTop]))
    const before = prev.current
    prev.current = { tops, els: now }
    if (!before) return

    const grown = [...now.keys()].filter((k) => !before.tops.has(k) && spawned.current.has(idOf(k)))
    const gone = [...before.els.keys()].filter((k) => !now.has(k) && archived.current.has(idOf(k)))
    if (!grown.length && !gone.length) return
    for (const k of grown) spawned.current.take(idOf(k))
    for (const k of gone) archived.current.take(idOf(k))

    // Interrupted: read where each playing row is drawn, then cancel it, so this event starts from
    // there. A row that has just left (archived mid-play) is read the same way.
    const carried = new Map<string, number>()
    const fade = new Map<string, number>()
    const settle = (k: string, r: HTMLElement) => {
      const run = runs.current.get(r)
      if (!run) return
      carried.set(k, drawnTy(run))
      fade.set(k, drawnOpacity(run))
      cancel(run)
      runs.current.delete(r)
    }
    for (const [k, r] of now) settle(k, r)
    for (const k of gone) settle(k, before.els.get(k)!)

    // The gate decides once for the list: the settings, reduced motion, scrolling, and whether the
    // list is on screen. Rows outside its viewport are skipped one by one below.
    if (!canAnimate(KIND, el)) return
    const { slow, ease } = readTiming(el)
    if (!(slow > 0) || typeof Element.prototype.animate !== 'function') return
    const easing = ease ? `cubic-bezier(${ease.join(', ')})` : 'ease-out'
    const view = el.clientHeight
    const near = (top: number, r: HTMLElement) => nearViewport(top, r.offsetHeight || 1, el.scrollTop, view)
    const play = (r: HTMLElement, ty: [number, number], o: [number, number] | null, scale: [number, number] | null, ghost?: boolean) => {
      r.dataset.flip = String(Number(r.dataset.flip ?? '0') + 1)
      const frame = (i: 0 | 1): Keyframe => ({ transform: `translateY(${ty[i]}px)${scale ? ` scale(${scale[i]})` : ''}` })
      // The transform adds onto the row's own (its issue nudge); a fade can't add (it would clamp at
      // the underlying 1 and never show), so it is a play of its own that replaces.
      const anim = r.animate([frame(0), frame(1)], { duration: slow, easing, composite: ghost ? 'replace' : 'add', fill: ghost ? 'forwards' : 'none' })
      const fade = o ? r.animate([{ opacity: o[0] }, { opacity: o[1] }], { duration: slow, easing, composite: 'replace', fill: ghost ? 'forwards' : 'none' }) : null
      const run: Run = { anim, fade, ty, o: o ?? [1, 1] }
      runs.current.set(r, run)
      // A cancelled play (an interruption) never finishes, so it never reaches here.
      anim.onfinish = () => {
        if (runs.current.get(r) === run) runs.current.delete(r)
        if (ghost) { ghosts.current.delete(r); r.remove() }
      }
    }

    // The rows that stay move from their old places to their new ones.
    for (const [k, d] of flipDeltas(before.tops, tops, carried)) {
      const r = now.get(k)!
      if (!near(tops.get(k)!, r) && !near(tops.get(k)! + d, r)) continue
      play(r, [d, 0], null, null)
    }

    // A new row grows out of its parent's row, at most a few rows away.
    for (const k of grown) {
      const r = now.get(k)!
      const parent = r.dataset.parent ? now.get('r:' + r.dataset.parent) : undefined
      const top = tops.get(k)!
      const dy = parent ? clampTravel(parent.offsetTop - top, r.offsetHeight || 1) : 0
      if (!near(top, r) && !near(top + dy, r)) continue
      play(r, [dy, 0], [0, 1], [ROW_SCALE, 1])
    }

    // An archived row collapses into its parent's row and fades, then goes. It starts from where it
    // was drawn, so a row archived mid-play doesn't jump.
    const into = layer.current
    if (!into) return
    for (const k of gone) {
      const r = before.els.get(k)!
      const top = before.tops.get(k)!
      const parent = r.dataset.parent ? now.get('r:' + r.dataset.parent) : undefined
      const from = carried.get(k) ?? 0
      const dy = parent ? clampTravel(parent.offsetTop - top, r.offsetHeight || 1) : 0
      if (!near(top + from, r) && !near(top + dy, r)) continue
      r.removeAttribute('data-id')
      r.removeAttribute('role')
      r.removeAttribute('draggable')
      r.setAttribute('aria-hidden', 'true')
      r.classList.remove('sel', 'focus')
      r.style.position = 'absolute'
      r.style.left = '0'
      r.style.right = '0'
      r.style.top = `${top}px`
      r.style.pointerEvents = 'none'
      into.append(r)
      ghosts.current.add(r)
      play(r, [from, dy], [fade.get(k) ?? 1, 0], [1, ROW_SCALE], true)
    }
  })

  return <div className="row-ghosts" ref={layer} aria-hidden="true" />
}
