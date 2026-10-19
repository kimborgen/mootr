// What the zoom sets on each card (S-462): the far chip is drawn at screen size, counter-scaled by
// the zoom, and grows to fit its name; the stacks are drawn at screen size too. These were CSS reading the zoom as a variable set on the world, which restyled every row,
// glyph and wire under it on each frame of a zoom. Written here, inline, on the few elements that
// show it, a frame restyles only those. The sizes come from the tokens (SystemView's readPx).

// The most a Cards stack is drawn larger than its card's own size, zoomed out: the cards stay full, so a stack
// held at screen size would dwarf them (S-705).
const STACK_MAX = 2

export interface ZoomPx {
  card: number; cardH: number; gapX: number
  // How wide a chip may grow, how far short of its neighbour's place it stops, how far a stack
  // overhangs a card's corner, and how far Cards puts it out past the corner (system.css).
  chipMax: number; chipClear: number; stackOver: number; stackOut: number
}

// A far chip's width on screen: the card's place at this zoom, grown to fit its name (`fit`), up
// to the cap or the room to its right (`room`, in the world: up to the next card level with it,
// less the clearance and the stack's overhang, so the stack stays clear of that card's chip),
// never under the card's place. Cards puts its stack further out (`out`).
export function chipWidth(k: number, fit: number, room: number, p: ZoomPx, out = 0): number {
  const min = p.card * k
  return Math.max(min, Math.min(fit, Math.max(min, Math.min(p.chipMax, (p.card + room) * k - p.chipClear - p.stackOver - out))))
}

// The room to each card's right, in the world: the gap to the nearest card level with it, or with
// its stack, which rests a card's height above (S-462). The Tree's siblings are a gap apart, but
// a team's last card has its cousin's gap too, and Cards' orbits leave far more than a gap; a
// chip with no card to its right grows to the cap.
export function roomsRight(pos: ReadonlyMap<string, { x: number; y: number; w: number }>, h: number): Map<string, number> {
  const ps = [...pos].sort((a, b) => a[1].x - b[1].x)
  const room = new Map<string, number>()
  ps.forEach(([id, p], i) => {
    let r = Infinity
    for (let j = i + 1; j < ps.length; j++) {
      const q = ps[j][1]
      if (q.x - p.x - p.w >= r) break
      if (q.y < p.y + h && q.y + h > p.y - h && q.x > p.x) r = Math.max(0, q.x - p.x - p.w)
    }
    room.set(id, r)
  })
  return room
}

// The measured fit a card carries (SystemView sets it as --sv-chip-fit), or 0.
const fitOf = (el: HTMLElement, v: string) => parseFloat(el.style.getPropertyValue(v)) || 0
const px = (n: number) => n.toFixed(2) + 'px'
// What was last written, per element, so a frame that changes nothing writes nothing, without
// reading the inline style back.
type Prop = 'width' | 'height' | 'transform'
const written = new WeakMap<HTMLElement, Partial<Record<Prop, string>>>()
function set(el: HTMLElement | null, prop: Prop, v: string) {
  if (!el) return
  let w = written.get(el)
  if (!w) written.set(el, (w = {}))
  if ((w[prop] ?? '') === v) return
  w[prop] = v
  el.style[prop] = v
}

// One card at zoom `k`: `far` below the far zoom, in the Tree or in Cards, which both draw the far
// chip (Stars and the outline take nothing, and lose what they had).
export function zoomCard(el: HTMLElement, k: number, far: boolean, shape: string, p: ZoomPx, room = p.gapX): void {
  let chip: HTMLElement | null = null, stack: HTMLElement | null = null
  for (const c of el.children) {
    const l = c.classList
    if (l.contains('sv-chip')) chip = c as HTMLElement
    else if (l.contains('sv-stack')) stack = c as HTMLElement
  }
  const cards = shape === 'cards'
  // How far a grown chip moves its corner, and the stack on it, right.
  let grow = 0
  if (far && (cards || shape === 'tree')) {
    const w = chipWidth(k, fitOf(el, '--sv-chip-fit'), room, p, cards ? p.stackOut : 0)
    grow = (w - p.card * k) / k
    set(chip, 'width', px(w))
    set(chip, 'height', px(p.cardH * k))
    set(chip, 'transform', `scale(${1 / k})`)
  }
  // Cards draws its stacks at screen size, out past the card's corner, at every zoom; the Tree
  // only zoomed out, on the chip's corner.
  if (cards) set(stack, 'transform', `translate(${px(p.stackOut / k + grow)}, ${px(-p.stackOut / k)}) scale(${Math.min(STACK_MAX, Math.max(1, 1 / k))})`)
  else if (far && shape === 'tree') set(stack, 'transform', `translateX(${px(grow)}) scale(${1 / k})`)
  else set(stack, 'transform', '')
}

// Every card in the world, with the room to its right (roomsRight).
export function zoomCards(world: HTMLElement, k: number, far: boolean, shape: string, p: ZoomPx, rooms?: ReadonlyMap<string, number>): void {
  for (const el of world.children) if (el.classList.contains('sv-card')) zoomCard(el as HTMLElement, k, far, shape, p, roomOf(el as HTMLElement, p, rooms))
}
export const roomOf = (el: HTMLElement, p: ZoomPx, rooms?: ReadonlyMap<string, number>) => rooms?.get(el.dataset.card ?? '') ?? p.gapX

// Stars (S-462): below zoom 1 each label is drawn at screen size, counter-scaled from the orb's
// foot, so a name never draws smaller than its type. A label that would then cover an orb, or a
// label placed before it (the hub first, then ring by ring out), is hidden instead, and shows on
// hover, focus or selection (system.css). What each label measures is read once per name.
interface Box { x0: number; y0: number; x1: number; y1: number }
export interface StarLabel { id: string; x: number; y: number; w: number; depth: number; lw: number; lh: number }
// Which labels show at zoom `k`: each label's box in the world, from its orb's square (x, y, w) and
// its size on screen (lw, lh), `gap` below the orb.
export function shownLabels(stars: StarLabel[], k: number, gap: number): Set<string> {
  const s = Math.min(1, k)
  const cell = 128 / s
  const grid = new Map<string, Box[]>()
  const cells = (b: Box) => { const out: string[] = []; for (let i = Math.floor(b.x0 / cell); i <= Math.floor(b.x1 / cell); i++) for (let j = Math.floor(b.y0 / cell); j <= Math.floor(b.y1 / cell); j++) out.push(i + ',' + j); return out }
  const add = (b: Box) => { for (const c of cells(b)) { let l = grid.get(c); if (!l) grid.set(c, (l = [])); l.push(b) } }
  const hits = (b: Box) => cells(b).some((c) => grid.get(c)?.some((o) => b.x0 < o.x1 && o.x0 < b.x1 && b.y0 < o.y1 && o.y0 < b.y1))
  for (const t of stars) add({ x0: t.x, y0: t.y, x1: t.x + t.w, y1: t.y + t.w })
  const shown = new Set<string>()
  for (const t of [...stars].sort((a, b) => a.depth - b.depth)) {
    const cx = t.x + t.w / 2, y0 = t.y + t.w + gap
    const b = { x0: cx - t.lw / 2 / s, y0, x1: cx + t.lw / 2 / s, y1: y0 + t.lh / s }
    if (hits(b)) continue
    add(b)
    shown.add(t.id)
  }
  return shown
}

const labelSize = new WeakMap<HTMLElement, { name: string; nw: number; nh: number; w: number; h: number }>()
export function zoomStars(world: HTMLElement, k: number, far: boolean, pos: ReadonlyMap<string, { x: number; y: number; w: number; depth: number }>, gap: number): void {
  const stars: StarLabel[] = [], els = new Map<string, [HTMLElement, HTMLElement]>()
  for (const c of world.children) {
    const el = c as HTMLElement, id = el.dataset.card
    if (!id || !el.classList.contains('sv-star')) continue
    const p = pos.get(id), sl = el.querySelector<HTMLElement>(':scope > .sv-sl'), nm = sl?.querySelector<HTMLElement>('.sv-nm')
    if (!p || !sl || !nm) continue
    const name = nm.textContent ?? ''
    let z = labelSize.get(sl)
    if (!z || z.name !== name) {
      z = { name, nw: nm.offsetWidth, nh: nm.offsetHeight, w: sl.scrollWidth, h: sl.offsetHeight }
      // A label not laid out yet (its star hidden for now) is measured again next time.
      if (z.nw) labelSize.set(sl, z)
    }
    stars.push({ id, x: p.x, y: p.y, w: p.w, depth: p.depth, lw: far ? z.nw : z.w, lh: far ? z.nh : z.h })
    els.set(id, [el, sl])
  }
  const shown = shownLabels(stars, k, gap)
  const sc = k < 1 ? String(1 / k) : ''
  for (const [id, [el, sl]] of els) {
    if (sl.style.scale !== sc) sl.style.scale = sc
    const hide = !shown.has(id)
    if (el.hasAttribute('data-hide') !== hide) el.toggleAttribute('data-hide', hide)
  }
}
