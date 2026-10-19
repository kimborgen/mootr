// S-86: tap or click any image in mail to see it alone, full screen, with pinch-zoom and pan,
// so a phone never has to zoom the whole page. A backdrop tap, the ✕, a swipe down, Escape,
// or the phone's Back button (through nav-history) closes it.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { setUi, useUi } from './ui/state'

export const openImage = (src: string, alt = ''): void => { if (src) setUi({ viewer: { src, alt } }) }
export const closeImage = (): void => setUi({ viewer: null })

// A click on an image in a mail body or the attachment strip opens it. A compare block's
// slider covers its images, so a tap there is told from a drag by where the gesture started
// and whether it moved the slider; only a tap opens the viewer.
export function installImageViewer(): () => void {
  let down: { x: number; y: number } | null = null
  let moved = false
  const onDown = (e: PointerEvent) => {
    down = (e.target as Element | null)?.closest?.('.mb-cmp-stage') ? { x: e.clientX, y: e.clientY } : null
    moved = false
  }
  const onMove = (e: PointerEvent) => {
    if (down && (Math.abs(e.clientX - down.x) > 6 || Math.abs(e.clientY - down.y) > 6)) moved = true
  }
  // A touch tap on a compare block's slider doesn't fire a click, so its tap is taken here,
  // on pointerup; a drag moved the slider and never opens the viewer.
  const onUp = (e: PointerEvent) => {
    if (!down) return
    const wasMoved = moved
    down = null
    moved = false
    if (wasMoved) return
    const stage = (e.target as Element | null)?.closest?.<HTMLElement>('.mb-cmp-stage')
    const img = stage?.closest('.mb-compare')?.querySelector<HTMLImageElement>('img.after')
    if (img?.src) { e.preventDefault(); openImage(img.src, img.alt) }
  }
  const onClick = (e: MouseEvent) => {
    const img = (e.target as Element | null)?.closest?.<HTMLImageElement>('img')
    if (!img?.src || !img.closest('.md, .att-imgs') || img.closest('.mb-cmp-stage')) return
    e.preventDefault()
    e.stopPropagation()
    openImage(img.src, img.alt)
  }
  document.addEventListener('pointerdown', onDown, true)
  document.addEventListener('pointermove', onMove, true)
  document.addEventListener('pointerup', onUp, true)
  document.addEventListener('click', onClick, true)
  return () => { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('pointermove', onMove, true); document.removeEventListener('pointerup', onUp, true); document.removeEventListener('click', onClick, true) }
}

const clamp = (v: number) => Math.max(0.5, Math.min(8, v))

// The picture with its zoom and pan, shared by the full-screen viewer and an image tab. `onDismiss`
// is a swipe down on the unzoomed picture.
export function ZoomImage({ src, alt, onDismiss }: { src: string; alt: string; onDismiss?: () => void }) {
  const [tf, setTf] = useState({ s: 1, x: 0, y: 0 })
  const tfRef = useRef(tf)
  tfRef.current = tf
  const img = useRef<HTMLImageElement>(null)
  const pts = useRef(new Map<number, { x: number; y: number }>())
  const pan = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
  const pinch = useRef<{ dist: number; s: number } | null>(null)
  const tap = useRef<{ t: number; x: number; y: number } | null>(null)
  const moved = useRef(false)

  // Reset on a new image.
  useLayoutEffect(() => { setTf({ s: 1, x: 0, y: 0 }) }, [src])

  // Zoom about a screen point, keeping it put (transform-origin is 0 0).
  const zoomAt = (ns: number, cx: number, cy: number) => {
    setTf((v) => {
      const el = img.current
      if (!el) return { ...v, s: clamp(ns) }
      const r = el.getBoundingClientRect(), k = clamp(ns) / v.s
      return { s: clamp(ns), x: v.x + (cx - r.left) * (1 - k), y: v.y + (cy - r.top) * (1 - k) }
    })
  }

  const onDown = (e: React.PointerEvent<HTMLImageElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    moved.current = false
    if (pts.current.size === 1) pan.current = { x: e.clientX, y: e.clientY, tx: tfRef.current.x, ty: tfRef.current.y }
    else if (pts.current.size === 2) {
      const [a, b] = [...pts.current.values()]
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: tfRef.current.s }
      pan.current = null
    }
  }
  const onMove = (e: React.PointerEvent<HTMLImageElement>) => {
    const p = pts.current.get(e.pointerId)
    if (!p) return
    if (Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y) > 2) moved.current = true
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pts.current.size >= 2 && pinch.current) {
      const [a, b] = [...pts.current.values()]
      zoomAt(pinch.current.s * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.current.dist), (a.x + b.x) / 2, (a.y + b.y) / 2)
      return
    }
    if (pts.current.size === 1 && pan.current) {
      const q = pan.current
      setTf((v) => ({ ...v, x: q.tx + (e.clientX - q.x), y: q.ty + (e.clientY - q.y) }))
    }
  }
  const onUp = (e: React.PointerEvent<HTMLImageElement>) => {
    if (!pts.current.has(e.pointerId)) return
    const start = pan.current
    pts.current.delete(e.pointerId)
    if (pts.current.size >= 1) {
      // A finger lifted from a pinch: the one still down takes over panning.
      pinch.current = null
      const [a] = [...pts.current.values()]
      pan.current = { x: a.x, y: a.y, tx: tfRef.current.x, ty: tfRef.current.y }
      return
    }
    pan.current = null
    pinch.current = null
    const cur = tfRef.current
    if (moved.current) {
      // A downward drag on an unzoomed image dismisses the viewer, like a sheet.
      const dy = start ? e.clientY - start.y : 0, dx = start ? e.clientX - start.x : 0
      if (cur.s < 1.02 && dy > 90 && Math.abs(dy) > Math.abs(dx) * 1.5) onDismiss?.()
      return
    }
    // A double-tap toggles between fit and a zoom in on the point tapped.
    const now = performance.now()
    if (tap.current && now - tap.current.t < 320 && Math.hypot(e.clientX - tap.current.x, e.clientY - tap.current.y) < 40) {
      tap.current = null
      zoomAt(cur.s > 1.02 ? 1 : 2.5, e.clientX, e.clientY)
    } else tap.current = { t: now, x: e.clientX, y: e.clientY }
  }

  // On a desktop the wheel zooms; the viewer is over everything, so the page never scrolls.
  useEffect(() => {
    const el = img.current
    if (!el) return
    const onWheel = (e: WheelEvent) => { e.preventDefault(); zoomAt(tfRef.current.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY) }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [src])

  return (
    <img className="iv-img" ref={img} src={src} alt={alt} draggable={false}
      style={{ transform: `translate(${tf.x}px, ${tf.y}px) scale(${tf.s})` }}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
      onClick={(e) => e.stopPropagation()} />
  )
}

export function ImageViewer() {
  const { viewer } = useUi()
  // A trailing click from the gesture that opened the viewer (a compare tap) must not close it.
  const openedAt = useRef(0)
  useLayoutEffect(() => { openedAt.current = performance.now() }, [viewer?.src])
  if (!viewer) return null
  return (
    <div id="img-view" role="dialog" aria-modal="true" aria-label={viewer.alt || 'Image'} onClick={() => { if (performance.now() - openedAt.current > 300) closeImage() }}>
      <button className="icon-btn iv-close" type="button" title="Close (Esc)" aria-label="Close the image"
        onClick={(e) => { e.stopPropagation(); closeImage() }}><Icon name="x" /></button>
      <ZoomImage src={viewer.src} alt={viewer.alt} onDismiss={closeImage} />
    </div>
  )
}
