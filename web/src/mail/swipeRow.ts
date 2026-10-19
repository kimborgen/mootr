// Archiving by swipe. A finger drags a mail row left; pulling it past half the reveal
// archives the thread (or unarchives it, in the archived list), and a shorter pull or a
// vertical drag snaps back. The row is translated directly, over the archive affordance
// the row markup draws behind it. HTML drag and drop doesn't follow a finger, so this is
// pointer events, as touchRank does for ranking.
// `onRight`, when given, takes a pull to the right past half the reveal the same way (the Inbox page defers with it).
export function swipeRow(root: HTMLElement, width: number, onSwipe: (row: HTMLElement) => void, onRight?: (row: HTMLElement) => void): () => void {
  const down = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') return
    const row = (e.target as Element).closest?.<HTMLElement>('.mrow')
    // Only a thread's row archives; an ITSA waiting on you has no thread row to swipe.
    if (!row?.dataset.thread) return
    const x0 = e.clientX
    const y0 = e.clientY
    let dx = 0
    let decided = false
    row.style.transition = 'none'
    // Resets the row and forgets the gesture, without archiving.
    const reset = () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      removeEventListener('pointercancel', reset)
      row.style.transition = ''
      row.style.transform = ''
    }
    const up = () => {
      reset()
      const far = decided && (dx <= -width / 2 ? onSwipe : onRight && dx >= width / 2 ? onRight : null)
      if (far) {
        // A swipe shouldn't also open the thread the finger lifted over.
        const stop = (ev: Event) => ev.stopPropagation()
        row.addEventListener('click', stop, { capture: true, once: true })
        setTimeout(() => row.removeEventListener('click', stop, true), 400)
        far(row)
      }
    }
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return
      const mx = ev.clientX - x0
      const my = ev.clientY - y0
      if (!decided) {
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return
        // A vertical drag scrolls the list; leave the gesture to the browser.
        if (Math.abs(my) >= Math.abs(mx)) return reset()
        decided = true
      }
      ev.preventDefault()
      dx = Math.max(-width, Math.min(onRight ? width : 0, mx))
      row.style.transform = `translateX(${dx}px)`
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    addEventListener('pointercancel', reset)
  }
  root.addEventListener('pointerdown', down)
  return () => root.removeEventListener('pointerdown', down)
}
