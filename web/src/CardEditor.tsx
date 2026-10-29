// The card layout editor on a desktop (S-1438 PRs 6 and 8), generic over a card kind: the issue card's and the agent card's.
// A live preview (the card's own rendering, handed in by the kind's wrapper), then the slot rows, each listing its items with
// a + to add one from the Available list and a ⋯ to move or hide it, and the Available list with its search. Every change
// goes through the kind's model (card-model.ts) and is handed up as a new layout; the editor keeps no layout of its own. A
// drag (pointer) and the keys (Space lifts, arrows move, Space drops, Escape cancels, Delete hides) only aim a move: the
// drop is the one write, and the model decides each move. The kind's rows around the slots (the title and its lines, the
// agent's hairline) come from the wrapper, and so does a slot drawn as a switch (the agent's ISSUE).
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKey, type PointerEvent as ReactPointer, type ReactNode } from 'react'
import { Icon } from './Icon'
import type { CardLayout } from './card-layout'
import type { CardItem } from './work/card-items'
import { cardModel, type Destination, type Refusal, type Step } from './card-model'

// What an editor needs from its card kind: the model's functions (as cardModel returns them), the slots and their names,
// the items it locks in a row (the key, the mark and name), and whether an item is locked.
export interface CardEditorKind {
  m: ReturnType<typeof cardModel>
  slots: readonly string[]
  names: Record<string, string>
  // The locked chips each slot's row starts with (the issue's Key in TOP; the agent's Mark and Name in HEAD), by label.
  lockedRows: Record<string, string[]>
  isLocked: (item: string) => boolean
}

// The rows the wrapper draws around the slots, with the layout and the editor's way to write one.
export interface EditorRowCtx { layout: CardLayout; apply: (next: CardLayout, what: string) => void }

// A slot drawn as a switch, not chips: its label, whether it is on, and how it is set.
export interface SwitchSlot { slot: string; label: string; on: boolean; set: (on: boolean) => void }

export interface CardEditorProps {
  kind: CardEditorKind
  layout: CardLayout
  // The items the card may show (cardItemsFor), in registry order.
  items: CardItem[]
  // The slots an editor's status line and its aria name read, e.g. "Issue card slots".
  label: string
  // The preview: its picker's choices, the one picked and how it is picked, and the card drawn for the one picked.
  preview: { picks: { id: string; label: string }[]; picked: string; pickLabel: string; none: string; onPick: (id: string) => void; render: (picked: string) => ReactNode }
  above?: (ctx: EditorRowCtx) => ReactNode
  below?: (ctx: EditorRowCtx) => ReactNode
  switchSlot?: SwitchSlot
  onChange: (layout: CardLayout) => void
  onReset: () => void
}

const STEP: Record<string, Step> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }
// How far a pointer must travel before a press is a drag, so a click on a chip's menu stays a click.
const DRAG_PX = 4

// What a menu is open for: an add into a slot, a chip's options, or an Available row's targets.
type Menu = { kind: 'add'; slot: string } | { kind: 'chip'; item: string } | { kind: 'avail'; item: string }
// A move in progress: the item, whether the keys lifted it (else a pointer drags it), and where it would land now.
type Drag = { item: string; key: boolean; at: Destination | null }
// A refusal the editor shows inline in the slot it was for, until the next move that is accepted.
type Notice = { slot: string; text: string }
// A pointer press on a chip, until it is a drag or lets go.
type Press = { item: string; x: number; y: number; ox: number; oy: number; started: boolean; move: (e: PointerEvent) => void; up: (e: PointerEvent) => void; cancel: () => void }

// The words a refusal shows, for the slot it was for.
export const reasonOf = (r: Refusal, item: string, slot: string, label: (id: string) => string, kind: CardEditorKind): string => {
  if (r === 'locked') return `${label(item)} is locked`
  if (r === 'links') return "Links and a link kind can't both be on the card"
  if (r === 'full') return `${kind.names[slot] ?? slot} is full: it holds at most ${kind.m.slotCap(slot)}`
  return `${label(item)} doesn't go in ${kind.names[slot] ?? slot}`
}

export function CardEditor({ kind, layout, items, label: aria, preview, above, below, switchSlot, onChange, onReset }: CardEditorProps) {
  const { m, slots, names: SLOT_NAMES } = kind
  const [menu, setMenu] = useState<Menu | null>(null)
  // The button that opened the open menu: Escape gives it focus back.
  const trigger = useRef<HTMLElement | null>(null)
  const [query, setQuery] = useState('')
  const [addQuery, setAddQuery] = useState('')
  const [said, setSaid] = useState('')
  const [drag, setDrag] = useState<Drag | null>(null)
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  // The chip the grid's one tab stop is on (a roving tabindex); until a chip is focused, the first one.
  const [stop, setStop] = useState<string | null>(null)
  const label = useMemo(() => new Map(items.map((i) => [i.id, i.label])), [items])
  const itemIds = useMemo(() => items.map((i) => i.id), [items])
  const name = (id: string) => label.get(id) ?? id
  // What the rows draw: the layout, with a keyboard-lifted item already at its candidate place (no gap; the chip moves).
  const view = drag?.key && drag.at ? m.moveTo(layout, drag.item, drag.at) : layout
  const available = m.availableItems(view, itemIds).filter((i) => label.get(i)?.toLowerCase().includes(query.trim().toLowerCase()))
  const hiddenAll = m.availableItems(view, itemIds)
  const tabStop = stop ?? [...slots.flatMap((s) => layout.slots[s] ?? []), ...hiddenAll][0] ?? null

  // The latest layout and handler, for the window listeners a pointer press adds (they outlive a render).
  const cur = useRef(layout)
  cur.current = layout
  const changed = useRef(onChange)
  changed.current = onChange
  const press = useRef<Press | null>(null)
  // A drag that moved swallows the click its release makes, so it doesn't open the chip's menu.
  const swallow = useRef(false)
  // A key lift cancelled when focus leaves the editor: the check runs after the task, so a chip that remounts and is
  // focused again in the same render is not a leave.
  const lifted = useRef<() => void>(() => {})
  lifted.current = () => { if (drag?.key) cancel(drag.item) }
  // The item to focus once its new layout is drawn (a drop or a hide moves its chip to another row).
  const refocus = useRef<string | null>(null)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const id = refocus.current
    if (!id) return
    refocus.current = null
    const chip = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-item]') ?? []).find((el) => el.dataset.item === id)
    chip?.focus()
  }, [layout])

  // A key-lifted chip moves to another row when a step lands it there, which remounts it: the focus follows it, so the
  // next key still reaches the lift.
  useEffect(() => {
    if (!drag?.key) return
    const chip = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-item]') ?? []).find((el) => el.dataset.item === drag.item)
    if (chip && document.activeElement !== chip) chip.focus()
  }, [drag])

  // One menu at a time, and Escape cancels a lift. Escape is taken in the capture phase and stopped, so the pane or
  // overlay under the editor does not also close on the same key.
  const escape = useRef<() => void>(() => {})
  escape.current = () => {
    // A pointer press in progress is cancelled with its window listeners, so its release writes nothing.
    if (press.current) { press.current.cancel(); return }
    if (drag) { cancel(drag.item); return }
    if (menu) { setMenu(null); trigger.current?.focus() }
  }
  useEffect(() => {
    if (!menu && !drag) return
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); escape.current() } }
    const press = (e: MouseEvent) => { if (menu && !(e.target as Element).closest('.ice-menu, .ice-menu-trigger')) setMenu(null) }
    window.addEventListener('keydown', key, true)
    document.addEventListener('mousedown', press)
    return () => { window.removeEventListener('keydown', key, true); document.removeEventListener('mousedown', press) }
  }, [menu, drag])
  // Opens a menu (or shuts the open one), remembering the button that opened it, for Escape to return focus to.
  const openMenu = (from: HTMLElement, mm: Menu | null) => {
    trigger.current = from
    setMenu(mm)
  }

  // Saves a changed layout and says what changed, for the status line under the editor.
  const apply = (next: CardLayout, what: string) => {
    setMenu(null)
    if (next === layout) return
    onChange(next)
    setSaid(what)
  }

  // Why an item may not go into a slot, in words, or null when it may. A menu's disabled item says this.
  const why = (lay: CardLayout, item: string, slot: string) => {
    const r = m.refusal(lay, item, slot)
    return r === null ? null : reasonOf(r, item, slot, name, kind)
  }
  // Where an item is, in words: its slot and position, or Available.
  const where = (lay: CardLayout, item: string) => {
    const s = m.slotOf(lay, item)
    return s === null ? 'Available' : `${SLOT_NAMES[s]}, position ${(lay.slots[s] ?? []).indexOf(item) + 1}`
  }
  const spot = (dest: Destination) => (dest === 'hide' ? 'Available' : `${SLOT_NAMES[dest.slot]}, position ${dest.index + 1}`)

  // A lift: the item is held, and nothing is written until it is dropped.
  const lift = (item: string) => {
    if (kind.isLocked(item)) return
    setNotice(null)
    setDrag({ item, key: true, at: null })
    setSaid(`${name(item)} lifted, ${where(cur.current, item)}. Arrows move it, Space drops, Escape cancels.`)
  }
  // One key step of a lifted item: the candidate moves to the step's destination, or the refusal shows and it stays.
  const step = (d: Drag, dir: Step) => {
    const base = d.at ? m.moveTo(cur.current, d.item, d.at) : cur.current
    const dest = m.destination(base, d.item, dir)
    if (dest === null) return
    if (dest !== 'hide') {
      const r = m.refusal(base, d.item, dest.slot)
      if (r) {
        const text = reasonOf(r, d.item, dest.slot, name, kind)
        setNotice({ slot: dest.slot, text })
        setSaid(`${name(d.item)} can't go to ${SLOT_NAMES[dest.slot]}: ${text}`)
        return
      }
    }
    setNotice(null)
    setDrag({ ...d, at: dest })
    setSaid(dest === 'hide' ? `${name(d.item)}, Available` : `${name(d.item)}, ${spot(dest)}`)
  }
  // The drop: one write, when the move changes the layout. No destination, or a move that changes nothing, writes nothing.
  const drop = (item: string, dest: Destination | null) => {
    setDrag(null)
    setGhost(null)
    const lay = cur.current
    const next = dest === null ? lay : m.moveTo(lay, item, dest)
    if (dest === null || m.sameSlots(next, lay)) { setSaid(`${name(item)} stays in ${where(lay, item)}`); return }
    setNotice(null)
    refocus.current = item
    changed.current(next)
    setSaid(dest === 'hide' ? `${name(item)} hidden` : `${name(item)} moved to ${spot(dest)}`)
  }
  const cancel = (item: string) => {
    setDrag(null)
    setGhost(null)
    setNotice(null)
    setSaid(`${name(item)} back in ${where(cur.current, item)}`)
  }

  // Where a pointer over the card would drop an item: a slot row at the index its pointer falls at, Available
  // (which hides it), or nowhere. A slot the model refuses gives the reason instead.
  const pointerDest = (item: string, x: number, y: number): { dest: Destination | null; refused: Notice | null } => {
    const row = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drop]')
    const target = row?.dataset.drop
    if (!row || !target) return { dest: null, refused: null }
    if (target === 'AVAILABLE') return { dest: 'hide', refused: null }
    const r = m.refusal(cur.current, item, target)
    if (r) return { dest: null, refused: { slot: target, text: reasonOf(r, item, target, name, kind) } }
    let index = 0
    for (const chip of row.querySelectorAll<HTMLElement>('[data-item]')) {
      if (chip.dataset.item === item) continue
      const b = chip.getBoundingClientRect()
      if (y < b.top || (y <= b.bottom && x < b.left + b.width / 2)) break
      index++
    }
    return { dest: { slot: target, index }, refused: null }
  }

  // A pointer press on a chip (not its ⋯): a drag once it travels DRAG_PX, else a plain click that opens nothing new.
  const pressDown = (e: ReactPointer<HTMLElement>, item: string) => {
    if (e.button !== 0 || kind.isLocked(item) || (e.target as Element).closest('button')?.classList.contains('icon-btn')) return
    swallow.current = false
    const move = (ev: PointerEvent) => {
      const p = press.current
      if (!p) return
      if (!p.started) {
        if (Math.hypot(ev.clientX - p.x, ev.clientY - p.y) < DRAG_PX) return
        p.started = true
        swallow.current = true
        setNotice(null)
        setDrag({ item: p.item, key: false, at: null })
        // The page's text is not selected by a drag: clear what the press selected, and hold the selection off while it lasts.
        window.getSelection()?.removeAllRanges()
      }
      // The ghost keeps the grab offset, so the point the pointer grabbed the chip at stays under the pointer.
      setGhost({ x: ev.clientX - p.ox, y: ev.clientY - p.oy })
      const { dest, refused } = pointerDest(p.item, ev.clientX, ev.clientY)
      setNotice(refused)
      setDrag((d) => (d ? { ...d, at: dest } : d))
    }
    const detach = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancelPress)
    }
    // The click a release makes comes in the same task, so the swallow is cleared on the next one, not left for a later click.
    const settle = () => { window.setTimeout(() => { swallow.current = false }, 0) }
    const up = (ev: PointerEvent) => {
      const p = press.current
      detach()
      press.current = null
      if (!p?.started) return
      settle()
      drop(p.item, pointerDest(p.item, ev.clientX, ev.clientY).dest)
    }
    const cancelPress = () => {
      const p = press.current
      detach()
      press.current = null
      if (p?.started) { settle(); cancel(p.item) }
      else { setDrag(null); setGhost(null) }
    }
    const r = e.currentTarget.getBoundingClientRect()
    press.current = { item, x: e.clientX, y: e.clientY, ox: e.clientX - r.left, oy: e.clientY - r.top, started: false, move, up, cancel: cancelPress }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancelPress)
  }

  // The keys on a chip or an Available item. While an item is lifted, the arrows step it and Space drops it; otherwise
  // Space lifts it, Delete hides it, and the arrows move the focus through the grid.
  const onItemKey = (e: ReactKey<HTMLElement>, item: string) => {
    if (e.target !== e.currentTarget) return
    if (drag?.key && drag.item === item) {
      if (e.key === ' ') { e.preventDefault(); drop(item, drag.at); return }
      const dir = STEP[e.key]
      if (dir) { e.preventDefault(); step(drag, dir) }
      return
    }
    if (e.key === ' ') { e.preventDefault(); lift(item); return }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      const lay = cur.current
      const next = m.hideItem(lay, item)
      if (next === lay) return
      refocus.current = item
      changed.current(next)
      setSaid(`${name(item)} hidden`)
      return
    }
    if (STEP[e.key]) { e.preventDefault(); navigate(e.currentTarget, e.key) }
  }
  // Moves the focus one chip along its row (left, right), or to the same column of the row above or below (up, down).
  const navigate = (from: HTMLElement, key: string) => {
    const rowOf = from.closest<HTMLElement>('[data-nav]')
    if (!rowOf || !root.current) return
    const chips = Array.from(rowOf.querySelectorAll<HTMLElement>('[data-item]'))
    const i = chips.indexOf(from)
    if (key === 'ArrowLeft' || key === 'ArrowRight') { chips[i + (key === 'ArrowLeft' ? -1 : 1)]?.focus(); return }
    const rows = Array.from(root.current.querySelectorAll<HTMLElement>('[data-nav]'))
    for (let r = rows.indexOf(rowOf) + (key === 'ArrowUp' ? -1 : 1); r >= 0 && r < rows.length; r += key === 'ArrowUp' ? -1 : 1) {
      const next = Array.from(rows[r].querySelectorAll<HTMLElement>('[data-item]'))
      if (next.length) { next[Math.min(i, next.length - 1)].focus(); return }
    }
  }

  // A chip, drawn with its ⋯ menu. A pointer-dragged chip stays in its place at half opacity, with a gap where it would land;
  // a keyboard-lifted chip is raised at full opacity and has already moved to its candidate place in the view.
  const chip = (item: string, className = 'ice-chip') => (
    <span key={item} className={className + (drag?.item === item ? (drag.key ? ' raised' : ' dragging') : '')} data-item={item} tabIndex={tabStop === item ? 0 : -1}
      aria-description="Space lifts it, then arrows move it and Space drops it"
      onFocus={() => setStop(item)} onPointerDown={(e) => pressDown(e, item)} onKeyDown={(e) => onItemKey(e, item)}
      onKeyUp={(e) => { if (e.key === ' ') e.preventDefault() }}>
      {name(item)}
      <button type="button" className="icon-btn ice-menu-trigger" aria-label={`Options for ${name(item)}`} aria-expanded={menu?.kind === 'chip' && menu.item === item}
        onClick={(e) => openMenu(e.currentTarget, menu?.kind === 'chip' && menu.item === item ? null : { kind: 'chip', item })}><Icon name="ellipsis" size="xs" /></button>
      {menu?.kind === 'chip' && menu.item === item ? (
        <ItemMenu label={name(item)}>
          {slots.filter((s) => s !== m.slotOf(layout, item)).map((s) => (
            <button key={s} type="button" role="menuitem" disabled={why(layout, item, s) !== null} title={why(layout, item, s) ?? undefined}
              onClick={() => apply(m.placeItem(layout, item, s), `${name(item)} moved to ${SLOT_NAMES[s]}`)}>Move to {SLOT_NAMES[s]}</button>
          ))}
          <button type="button" role="menuitem" onClick={() => apply(m.hideItem(layout, item), `${name(item)} hidden`)}>Hide</button>
        </ItemMenu>
      ) : null}
    </span>
  )

  // The chips of a slot row, with the drop gap where a pointer drag would land, and any refusal (drawn over the row, so
  // the rows keep their places).
  const rowNodes = (slot: string): ReactNode[] => {
    const held = view.slots[slot] ?? []
    const at = !drag?.key && drag?.at && drag.at !== 'hide' && drag.at.slot === slot ? drag.at.index : -1
    const out: ReactNode[] = []
    let others = 0
    for (const item of held) {
      if (item !== drag?.item) {
        if (others === at) out.push(<span key="gap" className="ice-gap" aria-hidden="true" />)
        others++
      }
      out.push(chip(item))
    }
    if (at >= others && at >= 0) out.push(<span key="gap" className="ice-gap" aria-hidden="true" />)
    if (notice?.slot === slot) out.push(<span key="refusal" className="ice-refusal" role="note">{notice.text}</span>)
    return out
  }

  const ctx: EditorRowCtx = { layout, apply }
  return (
    <div className={'ice' + (drag && !drag.key ? ' dragging' : '')} ref={root} onBlur={() => { window.setTimeout(() => { if (!root.current?.contains(document.activeElement)) lifted.current() }, 0) }} onClickCapture={(e) => { if (swallow.current) { swallow.current = false; e.stopPropagation(); e.preventDefault() } }}>
      <section className="ice-preview" aria-label="Preview">
        <div className="ice-preview-bar">
          <label className="ice-pick">
            <span className="muted">{preview.pickLabel}</span>
            <select value={preview.picked} onChange={(e) => preview.onPick(e.target.value)} disabled={!preview.picks.length}>
              {preview.picks.length ? preview.picks.map((p) => <option key={p.id} value={p.id}>{p.label}</option>) : <option value={preview.picked}>{preview.none}</option>}
            </select>
          </label>
        </div>
        <div className="ice-preview-card">{preview.render(preview.picked)}</div>
      </section>

      <div className="ice-slots" role="list" aria-label={aria}>
        {above ? above(ctx) : null}
        {slots.map((slot) => {
          const held = view.slots[slot] ?? []
          const full = held.length >= m.slotCap(slot)
          if (switchSlot?.slot === slot) return <div key={slot} className="ice-row" role="listitem" data-slot={slot}>
            <span className="ice-slot-name">{SLOT_NAMES[slot]}</span>
            <div className="ice-chips">
              <label className="ice-switch"><input type="checkbox" role="switch" checked={switchSlot.on} aria-label={switchSlot.label} onChange={(e) => switchSlot.set(e.target.checked)} />{switchSlot.label}</label>
            </div>
          </div>
          return (
            <div key={slot} className="ice-row" role="listitem" data-slot={slot} data-drop={slot} data-nav="">
              <span className="ice-slot-name">{SLOT_NAMES[slot]}</span>
              <div className="ice-chips">
                {(kind.lockedRows[slot] ?? []).map((text) => <span key={text} className="ice-chip locked"><Icon name="lock" size="xs" />{text}</span>)}
                {rowNodes(slot)}
                <button type="button" className="icon-btn ice-add ice-menu-trigger" aria-label={full ? `Add to ${SLOT_NAMES[slot]}: ${SLOT_NAMES[slot]} holds at most ${m.slotCap(slot)}` : `Add to ${SLOT_NAMES[slot]}`}
                  title={full ? `${SLOT_NAMES[slot]} holds at most ${m.slotCap(slot)}` : `Add to ${SLOT_NAMES[slot]}`}
                  disabled={full || !hiddenAll.length} aria-expanded={menu?.kind === 'add' && menu.slot === slot}
                  onClick={(e) => { setAddQuery(''); openMenu(e.currentTarget, menu?.kind === 'add' && menu.slot === slot ? null : { kind: 'add', slot }) }}><Icon name="plus" size="xs" /></button>
                {menu?.kind === 'add' && menu.slot === slot ? (
                  <ItemMenu label={`Add to ${SLOT_NAMES[slot]}`}>
                    <input type="search" name="ice-add-search" aria-label={`Find a field for ${SLOT_NAMES[slot]}`} placeholder="Find a field…" value={addQuery} autoComplete="off"
                      onChange={(e) => setAddQuery(e.target.value)} />
                    {hiddenAll.filter((i) => (label.get(i) ?? '').toLowerCase().includes(addQuery.trim().toLowerCase())).map((i) => (
                      <button key={i} type="button" role="menuitem" onClick={() => apply(m.placeItem(layout, i, slot), `${name(i)} added to ${SLOT_NAMES[slot]}`)}>{name(i)}</button>
                    ))}
                    {!hiddenAll.length ? <p className="muted ice-none">Every field is on the card.</p> : null}
                  </ItemMenu>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>

      <section className={'ice-available' + (!drag?.key && drag?.at === 'hide' ? ' drop' : '')} aria-label="Available" data-drop="AVAILABLE" data-nav="">
        <h3>Available</h3>
        <input type="search" name="ice-search" aria-label="Search available items" placeholder="Search fields…" value={query} autoComplete="off"
          onChange={(e) => setQuery(e.target.value)} />
        {available.length ? (
          <ul className="ice-avail-list">
            {available.map((i) => (
              <li key={i}>
                <button type="button" className={'ice-avail ice-menu-trigger' + (drag?.item === i ? (drag.key ? ' raised' : ' dragging') : '')} data-item={i} tabIndex={tabStop === i ? 0 : -1}
                  aria-expanded={menu?.kind === 'avail' && menu.item === i} aria-description="Space lifts it, then arrows move it and Space drops it"
                  onFocus={() => setStop(i)} onPointerDown={(e) => pressDown(e, i)} onKeyDown={(e) => onItemKey(e, i)} onKeyUp={(e) => { if (e.key === ' ') e.preventDefault() }}
                  onClick={(e) => openMenu(e.currentTarget, menu?.kind === 'avail' && menu.item === i ? null : { kind: 'avail', item: i })}>{name(i)}</button>
                {menu?.kind === 'avail' && menu.item === i ? (
                  <ItemMenu label={name(i)}>
                    {slots.map((s) => (
                      <button key={s} type="button" role="menuitem" disabled={why(layout, i, s) !== null} title={why(layout, i, s) ?? undefined}
                        onClick={() => apply(m.placeItem(layout, i, s), `${name(i)} added to ${SLOT_NAMES[s]}`)}>Add to {SLOT_NAMES[s]}</button>
                    ))}
                  </ItemMenu>
                ) : null}
              </li>
            ))}
          </ul>
        ) : <p className="muted ice-none">{hiddenAll.length ? 'No field matches.' : 'Every field is on the card.'}</p>}
        {notice?.slot === 'AVAILABLE' ? <span className="ice-refusal" role="note">{notice.text}</span> : null}
      </section>

      {below ? below(ctx) : null}
      {ghost && drag && !drag.key ? (
        <div className="ice-ghost" aria-hidden="true" style={{ transform: `translate(${ghost.x}px, ${ghost.y}px)` }}>{name(drag.item)}</div>
      ) : null}
      <p className="muted ice-said" aria-live="polite">{said}</p>
      <div className="ice-foot">
        <button type="button" className="btn" onClick={() => { setMenu(null); setSaid('Reset to the default card'); onReset() }}><Icon name="rotate-ccw" />Reset to default</button>
      </div>
    </div>
  )
}

// A small menu under its trigger: its buttons are the choices.
function ItemMenu({ label, children }: { label: string; children: ReactNode }) {
  return <div className="ice-menu" role="menu" aria-label={label}>{children}</div>
}
