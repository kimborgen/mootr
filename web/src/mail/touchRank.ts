// Ranking by touch. HTML drag and drop doesn't follow a finger, so on a touch screen a
// rank row's number is its grip: pressing it and moving drags the row, and lifting stages
// the order, as a drop does with a mouse. The up and down buttons work as well.
export function touchRank(root: HTMLElement, onDrop: (row: HTMLElement) => void): () => void {
  const down = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') return
    const grip = (e.target as Element).closest?.<HTMLElement>('.mb-rnum')
    const row = grip?.closest<HTMLElement>('.mb-rrow')
    if (!grip || !row || !row.draggable) return
    e.preventDefault()
    row.classList.add('dragging')
    let moved = false
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return
      const o = [...row.parentElement!.children].find((c) => { const b = c.getBoundingClientRect(); return c !== row && ev.clientY >= b.top && ev.clientY <= b.bottom })
      if (!o) return
      const b = o.getBoundingClientRect()
      const others = [...row.parentElement!.children].filter((c) => c !== row)
      const at = others.indexOf(o) + (ev.clientY < b.top + b.height / 2 ? 0 : 1)
      // The others move around the row: a row taken out of the page mid-drag loses the touch.
      for (const c of others.slice(0, at)) row.before(c)
      for (const c of others.slice(at)) row.parentElement!.append(c)
      moved = true
    }
    const up = () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      removeEventListener('pointercancel', up)
      row.classList.remove('dragging')
      if (moved) onDrop(row)
    }
    // The finger leaves the grip as the row moves, so the window follows it.
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    addEventListener('pointercancel', up)
  }
  root.addEventListener('pointerdown', down)
  return () => root.removeEventListener('pointerdown', down)
}
