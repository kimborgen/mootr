// The card layout editor on a phone (S-1438 PRs 7 and 8), generic over a card kind: the issue card's and the agent card's, at
// 360-430 px, touch. The same model as the desktop editor (card-model.ts through the kind): every write is a moveTo, a
// placeItem or a wrapper's own setting, handed up as a new layout, and every refusal is the model's own. Under a sticky live
// preview, one list per slot: each row has its handle ⠿ (a long press lifts it, and a drop between rows or across slots
// writes once), ↑ and ↓ (which cross slot boundaries, as destination() says), and ⋯ (a bottom sheet: Move to a slot, Hide).
// + Add to card opens a sheet of the hidden items. The kind's rows around the slots and a switch slot come from the wrapper.
import { useEffect, useRef, useState, type PointerEvent as ReactPointer, type ReactNode } from 'react'
import { Icon } from './Icon'
import { buzz, holdMs, HOLD_SLOP } from './ui/longpress'
import { hideMenu, showPopover } from './ui/menu'
import type { CardLayout } from './card-layout'
import { reasonOf, type CardEditorProps, type EditorRowCtx, type SwitchSlot } from './CardEditor'
import type { Destination, Step } from './card-model'

// A move in progress: the lifted item, and where a drop would land now.
type Drag = { item: string; at: Destination | null }
// A refusal the editor shows under the slot it was for, until the next move that is accepted.
type Notice = { slot: string; text: string }
// A press on a handle, until it lifts, lets go, or is cancelled.
type Press = { item: string; x: number; y: number; ox: number; oy: number; width: number; lifted: boolean; cancel: () => void }
// The row drawn under the finger while it is lifted: where its top-left sits, and its width.
type Ghost = { left: number; top: number; width: number }
// The ghost keeps the grab offset, so the point the finger grabbed the row at stays under it.
// It stays inside the window's width: a row grabbed at its right end would otherwise run off the left edge.
const ghostAt = (p: Press): Ghost => ({ left: Math.max(0, Math.min(p.x - p.ox, innerWidth - p.width)), top: p.y - p.oy, width: p.width })

// The nearest ancestor that scrolls, which the drag's edge scroll moves; the document when none does.
const scrollerOf = (el: HTMLElement | null): HTMLElement => {
  for (let n = el?.parentElement; n; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY
    if (o === 'auto' || o === 'scroll') return n
  }
  return document.documentElement
}
// How close to the bottom of the sticky preview (the top edge) or the window's bottom a lifted row's pointer must be before the
// list scrolls, and how far per frame.
const EDGE_PX = 64
const EDGE_STEP = 12

export interface CardPhoneEditorProps extends Omit<CardEditorProps, 'above' | 'below' | 'label'> {
  // The rows the wrapper draws above the slots (the issue's title and lines) and below them (the agent's hairline).
  above?: (ctx: EditorRowCtx) => ReactNode
  below?: (ctx: EditorRowCtx) => ReactNode
  // The section that holds the switch slot's row, when a kind draws one (the agent's ISSUE).
  switchSlot?: SwitchSlot
}

export function CardPhoneEditor({ kind, layout, items, preview, above, below, switchSlot, onChange, onReset }: CardPhoneEditorProps) {
  const { m, slots, names: SLOT_NAMES } = kind
  const label = new Map(items.map((i) => [i.id, i.label]))
  const itemIds = items.map((i) => i.id)
  const name = (id: string) => label.get(id) ?? id
  const [drag, setDrag] = useState<Drag | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [ghost, setGhost] = useState<Ghost | null>(null)
  const [said, setSaid] = useState('')
  const hidden = m.availableItems(layout, itemIds)

  // The latest layout and handler, for the listeners a press adds (they outlive a render), and the press in progress.
  const cur = useRef(layout)
  cur.current = layout
  const changed = useRef(onChange)
  changed.current = onChange
  const press = useRef<Press | null>(null)
  const scroll = useRef(0)
  const root = useRef<HTMLDivElement>(null)
  // The control to focus once its row is drawn in its new slot (a move remounts the row there).
  const refocus = useRef<{ item: string; act: Step } | null>(null)

  useEffect(() => {
    const r = refocus.current
    if (!r) return
    refocus.current = null
    root.current?.querySelector<HTMLElement>(`[data-item="${r.item}"] [data-act="${r.act}"]:not(:disabled)`)?.focus()
  }, [layout])
  // Unmounting ends a press in progress and the edge scroll, so neither outlives the editor.
  useEffect(() => () => { cancelAnimationFrame(scroll.current); press.current?.cancel() }, [])

  const spot = (dest: Destination) => (dest === 'hide' ? 'Available' : `${SLOT_NAMES[dest.slot]}, position ${dest.index + 1}`)
  const where = (lay: CardLayout, item: string) => {
    const s = m.slotOf(lay, item)
    return s === null ? 'Available' : `${SLOT_NAMES[s]}, position ${(lay.slots[s] ?? []).indexOf(item) + 1}`
  }
  // Why an item may not go into a slot, in words, or null when it may: a sheet's disabled choice says this.
  const reasonAt = (item: string, slot: string): string | null => {
    const r = m.refusal(cur.current, item, slot)
    return r === null ? null : reasonOf(r, item, slot, name, kind)
  }

  // The one write: the model's move, handed up once. A move that changes nothing writes nothing.
  const commit = (item: string, dest: Destination, what: string) => {
    const lay = cur.current
    const next = m.moveTo(lay, item, dest)
    if (m.sameSlots(next, lay)) { setSaid(`${name(item)} stays in ${where(lay, item)}`); return }
    setNotice(null)
    changed.current(next)
    setSaid(what)
  }
  // The one write of a wrapper's own setting (a title's lines, the hairline, the switch), handed up once.
  const apply = (next: CardLayout, what: string) => {
    if (next === cur.current) return
    setNotice(null)
    changed.current(next)
    setSaid(what)
  }

  // Where a ↑ or ↓ tap takes the item. Within its slot it swaps with its neighbour while it has one that way; at the
  // slot's edge the move crosses to the slot next to it, as destination() gives. The last slot's row has no ↓: Hide is in
  // the ⋯ sheet, not a step.
  const stepDest = (lay: CardLayout, item: string, dir: 'up' | 'down'): Destination | null => {
    const slot = m.slotOf(lay, item)
    if (slot === null) return null
    const list = lay.slots[slot] ?? []
    const at = list.indexOf(item)
    if (dir === 'up' && at > 0) return { slot, index: at - 1 }
    if (dir === 'down' && at < list.length - 1) return { slot, index: at + 1 }
    if (dir === 'down' && slot === slots[slots.length - 1]) return null
    return m.destination(lay, item, dir)
  }
  // A tap on ↑ or ↓: the model's destination for the step, or its refusal under that slot, and nothing written.
  const step = (item: string, dir: 'up' | 'down') => {
    const lay = cur.current
    const dest = stepDest(lay, item, dir)
    if (dest === null) return
    if (dest !== 'hide') {
      const r = m.refusal(lay, item, dest.slot)
      if (r) {
        const text = reasonOf(r, item, dest.slot, name, kind)
        setNotice({ slot: dest.slot, text })
        setSaid(`${name(item)} can't go to ${SLOT_NAMES[dest.slot]}: ${text}`)
        return
      }
    }
    refocus.current = { item, act: dir }
    commit(item, dest, dest === 'hide' ? `${name(item)} hidden` : `${name(item)} moved to ${spot(dest)}`)
  }

  // ⋯: a bottom sheet of the moves the model allows (a refused one is disabled and says why), and Hide.
  const options = (from: HTMLElement, item: string) => {
    const lay = cur.current
    showPopover(0, 0, `Options for ${name(item)}`, (
      <div className="ipe-sheet">
        <p className="eyebrow">{name(item)}</p>
        {slots.filter((s) => s !== m.slotOf(lay, item)).map((s) => {
          const why = reasonAt(item, s)
          return (
            <button key={s} type="button" role="menuitem" className="ipe-sheet-item" disabled={why !== null} title={why ?? undefined}
              onClick={() => { hideMenu(); commit(item, { slot: s, index: (cur.current.slots[s] ?? []).length }, `${name(item)} moved to ${SLOT_NAMES[s]}`) }}>
              Move to {SLOT_NAMES[s]}{why ? <span className="ipe-why">{why}</span> : null}
            </button>
          )
        })}
        <button type="button" role="menuitem" className="ipe-sheet-item danger" onClick={() => { hideMenu(); commit(item, 'hide', `${name(item)} hidden`) }}>Hide</button>
      </div>
    ), from)
  }

  // + Add to card: a sheet with a row per hidden item, its slot to choose and its Add.
  const addSheet = (from: HTMLElement) => {
    const hiddenNow = m.availableItems(cur.current, itemIds)
    showPopover(0, 0, 'Add to card', (
      <div className="ipe-sheet">
        {hiddenNow.length ? hiddenNow.map((i) => (
          <AddRow key={i} item={i} slots={slots} names={SLOT_NAMES} name={name} reason={reasonAt} onAdd={(slot) => { hideMenu(); commit(i, { slot, index: (cur.current.slots[slot] ?? []).length }, `${name(i)} added to ${SLOT_NAMES[slot]}`) }} />
        )) : <p className="muted">Every field is on the card.</p>}
      </div>
    ), from)
  }

  // The drop a pointer would make: a slot section and the index among its other rows, or the refusal the slot gives.
  const pointerDest = (item: string, x: number, y: number): { dest: Destination | null; refused: Notice | null } => {
    const section = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drop]')
    const slot = section?.dataset.drop
    if (!section || !slot) return { dest: null, refused: null }
    const r = m.refusal(cur.current, item, slot)
    if (r) return { dest: null, refused: { slot, text: reasonOf(r, item, slot, name, kind) } }
    let index = 0
    for (const row of section.querySelectorAll<HTMLElement>('[data-item]')) {
      if (row.dataset.item === item) continue
      const b = row.getBoundingClientRect()
      if (y < (b.top + b.bottom) / 2) break
      index++
    }
    return { dest: { slot, index }, refused: null }
  }

  // The list scrolls while a lifted row's pointer sits near the top or bottom of the window, a frame at a time.
  const edgeScroll = () => {
    const tick = () => {
      const p = press.current
      if (!p?.lifted) return
      // The top edge is the bottom of the sticky preview: it covers the window's top, so a pointer under it is the one to scroll on.
      const above = root.current?.querySelector<HTMLElement>('.ipe-preview')?.getBoundingClientRect().bottom ?? 0
      const dy = p.y < above + EDGE_PX ? -EDGE_STEP : p.y > innerHeight - EDGE_PX ? EDGE_STEP : 0
      if (dy) scrollerOf(root.current).scrollBy(0, dy)
      scroll.current = requestAnimationFrame(tick)
    }
    scroll.current = requestAnimationFrame(tick)
  }

  // A press on a handle. Before the hold ends, any travel past HOLD_SLOP is a scroll and cancels the press, so a scroll
  // never lifts a row. After it, the pointer moves the drop and the release makes the one write (drop); a cancel (a touch
  // cancel, Escape, or unmount) writes nothing.
  const pressHandle = (e: ReactPointer<HTMLElement>, item: string) => {
    if (e.button !== 0 || kind.isLocked(item) || press.current) return
    // Where the finger grabbed the row, so the ghost can keep that point under it.
    const row = e.currentTarget.closest<HTMLElement>('[data-item]')?.getBoundingClientRect()
    const p: Press = { item, x: e.clientX, y: e.clientY, ox: row ? e.clientX - row.left : 0, oy: row ? e.clientY - row.top : 0, width: row?.width ?? 0, lifted: false, cancel: () => {} }
    const timer = window.setTimeout(() => {
      p.lifted = true
      buzz()
      setNotice(null)
      setDrag({ item, at: null })
      setGhost(ghostAt(p))
      setSaid(`${name(item)} lifted. Drag it to a row and let go; Escape cancels.`)
      edgeScroll()
    }, holdMs())
    const detach = () => {
      window.clearTimeout(timer)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancelPress)
      window.removeEventListener('keydown', key, true)
    }
    const move = (ev: PointerEvent) => {
      if (!p.lifted) { if (Math.hypot(ev.clientX - p.x, ev.clientY - p.y) > HOLD_SLOP) cancelPress(); return }
      p.x = ev.clientX
      p.y = ev.clientY
      const { dest, refused } = pointerDest(item, ev.clientX, ev.clientY)
      setNotice(refused)
      setDrag({ item, at: dest })
      setGhost(ghostAt(p))
    }
    const up = (ev: PointerEvent) => {
      detach()
      press.current = null
      if (!p.lifted) return
      cancelAnimationFrame(scroll.current)
      setDrag(null)
      setGhost(null)
      const { dest } = pointerDest(item, ev.clientX, ev.clientY)
      if (dest === null) { setSaid(`${name(item)} stays in ${where(cur.current, item)}`); return }
      commit(item, dest, `${name(item)} moved to ${spot(dest)}`)
    }
    function cancelPress() {
      detach()
      press.current = null
      if (!p.lifted) return
      cancelAnimationFrame(scroll.current)
      setDrag(null)
      setGhost(null)
      setNotice(null)
      setSaid(`${name(item)} back in ${where(cur.current, item)}`)
    }
    const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cancelPress() } }
    p.cancel = cancelPress
    press.current = p
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancelPress)
    window.addEventListener('keydown', key, true)
  }

  // One row of a slot: its name, and its controls.
  const row = (slot: string, item: string) => (
    <li key={item} className={'ipe-row' + (drag?.item === item ? ' dragging' : '')} data-item={item} data-slot={slot}>
      <span className="ipe-name">{name(item)}</span>
      <span className="ipe-controls">
        <button type="button" className="ipe-handle" data-act="handle" aria-label={`Drag ${name(item)}: hold, then move`} onContextMenu={(e) => e.preventDefault()}
          onPointerDown={(e) => pressHandle(e, item)}>⠿</button>
        <button type="button" data-act="up" aria-label={`Move ${name(item)} up`} disabled={stepDest(layout, item, 'up') === null} onClick={() => step(item, 'up')}>
          <Icon name="arrow-up" size="xs" /></button>
        <button type="button" data-act="down" aria-label={`Move ${name(item)} down`} disabled={stepDest(layout, item, 'down') === null} onClick={() => step(item, 'down')}>
          <Icon name="arrow-down" size="xs" /></button>
        <button type="button" data-act="menu" aria-label={`Options for ${name(item)}`} onClick={(e) => options(e.currentTarget, item)}>
          <Icon name="ellipsis" size="xs" /></button>
      </span>
    </li>
  )
  // The rows of a slot, with the drop gap where a pointer drag would land. A dragged row stays in its place, dimmed.
  const rows = (slot: string): ReactNode[] => {
    const held = layout.slots[slot] ?? []
    const at = drag?.at && drag.at !== 'hide' && drag.at.slot === slot ? drag.at.index : -1
    const out: ReactNode[] = []
    let others = 0
    for (const item of held) {
      if (item !== drag?.item) {
        if (others === at) out.push(<li key="gap" className="ipe-gap" aria-hidden="true" />)
        others++
      }
      out.push(row(slot, item))
    }
    if (at >= others && at >= 0) out.push(<li key="gap" className="ipe-gap" aria-hidden="true" />)
    return out
  }
  const lockedRow = (text: string) => (
    <li key={text} className="ipe-row locked">
      <span className="ipe-name">{text}</span>
      <span className="ipe-controls"><span className="ipe-lock"><Icon name="lock" size="xs" /></span></span>
    </li>
  )

  const ctx: EditorRowCtx = { layout, apply }
  return (
    <div className={'ipe' + (drag ? ' dragging' : '')} ref={root}>
      <section className="ipe-preview" aria-label="Preview">
        <label className="ipe-pick">
          <span className="muted">{preview.pickLabel}</span>
          <select value={preview.picked} onChange={(e) => preview.onPick(e.target.value)} disabled={!preview.picks.length}>
            {preview.picks.length ? preview.picks.map((p) => <option key={p.id} value={p.id}>{p.label}</option>) : <option value={preview.picked}>{preview.none}</option>}
          </select>
        </label>
        <div className="ipe-preview-card">{preview.render(preview.picked)}</div>
      </section>

      {above ? above(ctx) : null}

      {slots.map((slot) => {
        if (switchSlot?.slot === slot) return (
          <section key={slot} className="ipe-slot" aria-label={SLOT_NAMES[slot]}>
            <h3 className="eyebrow">{SLOT_NAMES[slot]}</h3>
            <label className="ipe-switch"><input type="checkbox" role="switch" checked={switchSlot.on} aria-label={switchSlot.label} onChange={(e) => switchSlot.set(e.target.checked)} />{switchSlot.label}</label>
          </section>
        )
        const count = (layout.slots[slot] ?? []).length
        const cap = m.slotCap(slot)
        return (
          <section key={slot} className="ipe-slot" aria-label={SLOT_NAMES[slot]} data-drop={slot}>
            <h3 className="eyebrow">{SLOT_NAMES[slot]} <span className="muted">{count}{cap === Infinity ? '' : ` of ${cap}`}</span></h3>
            <ul className="ipe-list" role="list">{(kind.lockedRows[slot] ?? []).map((text) => lockedRow(text))}{rows(slot)}</ul>
            {notice?.slot === slot ? <p className="ipe-refusal" role="note">{notice.text}</p> : null}
          </section>
        )
      })}

      {below ? below(ctx) : null}
      <button type="button" className="btn ipe-add" disabled={!hidden.length} onClick={(e) => addSheet(e.currentTarget)}>
        <Icon name="plus" size="xs" />Add to card
      </button>
      {ghost && drag ? (
        <div className="ipe-ghost" aria-hidden="true" style={{ left: ghost.left, top: ghost.top, width: ghost.width }}>
          <Icon name="grip-vertical" size="xs" />{name(drag.item)}
        </div>
      ) : null}
      <p className="muted ipe-said" aria-live="polite">{said}</p>
      <div className="ipe-foot">
        <button type="button" className="btn" onClick={() => { setSaid('Reset to the default card'); onReset() }}><Icon name="rotate-ccw" />Reset to default</button>
      </div>
    </div>
  )
}

// One hidden item in the Add sheet, on one line: its name, the slot to take it to, and Add. A slot that refuses is
// disabled, and the reason shows under the row.
function AddRow({ item, slots, names, name, reason, onAdd }: {
  item: string; slots: readonly string[]; names: Record<string, string>; name: (id: string) => string; reason: (item: string, slot: string) => string | null; onAdd: (slot: string) => void
}) {
  const open = slots.find((s) => reason(item, s) === null) ?? slots[0]
  const [slot, setSlot] = useState(open)
  const why = reason(item, slot)
  return (
    <div className="ipe-add-row">
      <span className="ipe-add-name">{name(item)}</span>
      <select className="ipe-add-select" aria-label={`Slot for ${name(item)}`} value={slot} onChange={(e) => setSlot(e.target.value)}>
        {slots.map((s) => <option key={s} value={s}>{names[s]}</option>)}
      </select>
      <button type="button" className="btn primary ipe-add-btn" disabled={why !== null} onClick={() => onAdd(slot)}>Add</button>
      {why ? <span className="ipe-why ipe-add-why">{why}</span> : null}
    </div>
  )
}
