// The card layout model, generic over a card kind (S-1438 PR 8): the one place that places, moves, hides and sizes a
// card's items, for the issue card and the agent card alike. Each kind names its slots, their caps, what is locked, and
// which placements conflict. Every function returns a new layout, or the same one when the move is refused, so no caller
// can break a cap, a lock or a conflict. The editors (desktop and phone) and their key steps call these only.
import type { CardLayout } from './card-layout'

// Why an item may not go into a slot, or null when it may: locked, a conflict the kind names, a slot that is not one of
// the card's (or one the item does not go in), or a slot at its cap.
export type Refusal = 'locked' | 'links' | 'slot' | 'full'

// The rules of one card kind. `blocked` names an item that may go nowhere with the layout as it stands (Links against a link
// kind): it also keeps the item off the Available list. `accepts` is the kind's own slot rule (the agent's ISSUE slot takes
// only the issue, and the issue goes in no other slot). Both are checked after the lock.
export interface CardKind {
  slots: readonly string[]
  // The most items a slot takes; a slot with no entry takes any number.
  caps: Record<string, number>
  isLocked: (item: string) => boolean
  blocked: (layout: CardLayout, item: string) => boolean
  accepts: (item: string, slot: string) => boolean
}

// Where a key step takes an item: a slot and the index it lands at (as placeItem takes it), or 'hide' for Available.
export type Destination = { slot: string; index: number } | 'hide'
export type Step = 'left' | 'right' | 'up' | 'down'

export function cardModel(kind: CardKind) {
  const slotCap = (slot: string): number => kind.caps[slot] ?? Infinity
  const isSlot = (slot: string) => kind.slots.includes(slot)
  const last = kind.slots[kind.slots.length - 1]

  // The slot an item sits in, or null when the layout hides it.
  const slotOf = (layout: CardLayout, item: string): string | null => kind.slots.find((s) => layout.slots[s]?.includes(item)) ?? null

  // The items the layout places (any slot), in no particular order.
  const placedItems = (layout: CardLayout): Set<string> => new Set(kind.slots.flatMap((s) => layout.slots[s] ?? []))

  // Why an item may not go into a slot now, or null when it may (an item already in the slot doesn't count against its cap).
  const refusal = (layout: CardLayout, item: string, slot: string): Refusal | null => {
    if (kind.isLocked(item)) return 'locked'
    if (kind.blocked(layout, item)) return 'links'
    if (!isSlot(slot) || !kind.accepts(item, slot)) return 'slot'
    const held = (layout.slots[slot] ?? []).filter((i) => i !== item).length
    return held < slotCap(slot) ? null : 'full'
  }
  const canPlace = (layout: CardLayout, item: string, slot: string): boolean => refusal(layout, item, slot) === null

  // The items a card may show that no slot holds: the hidden ones, in the order given.
  const availableItems = (layout: CardLayout, items: string[]): string[] => {
    const placed = placedItems(layout)
    return items.filter((i) => !kind.isLocked(i) && !placed.has(i) && !kind.blocked(layout, i))
  }

  // The layout with `item` in `slot`, at `index` (the end by default). A move between slots or within one goes through here
  // too: the item leaves wherever it was first. A refused move returns the layout as it was.
  const placeItem = (layout: CardLayout, item: string, slot: string, index?: number): CardLayout => {
    if (!canPlace(layout, item, slot)) return layout
    const slots = Object.fromEntries(kind.slots.map((s) => [s, (layout.slots[s] ?? []).filter((i) => i !== item)]))
    const list = slots[slot]
    const at = index === undefined ? list.length : Math.max(0, Math.min(index, list.length))
    list.splice(at, 0, item)
    return { ...layout, slots, chosen: true }
  }

  // The layout with `item` hidden (in no slot). It stays in `seen`, so a hidden field is not offered again.
  const hideItem = (layout: CardLayout, item: string): CardLayout => {
    if (slotOf(layout, item) === null) return layout
    const slots = Object.fromEntries(kind.slots.map((s) => [s, (layout.slots[s] ?? []).filter((i) => i !== item)]))
    return { ...layout, slots, chosen: true }
  }

  // The destination of one key step from where the item is now, or null when the step goes nowhere. Left and right move
  // within the slot; up and down move to the slot next to it, entering at its end going up and at its start going down.
  // Available sits after the last slot, so going down from it hides the item, and going up from Available enters the last slot at its end.
  const destination = (layout: CardLayout, item: string, step: Step): Destination | null => {
    const slot = slotOf(layout, item)
    if (slot === null) return step === 'up' ? { slot: last, index: (layout.slots[last] ?? []).length } : null
    const list = layout.slots[slot] ?? []
    const at = list.indexOf(item)
    const si = kind.slots.indexOf(slot)
    if (step === 'left') return at > 0 ? { slot, index: at - 1 } : null
    if (step === 'right') return at < list.length - 1 ? { slot, index: at + 1 } : null
    // Up and down skip a slot that won't take the item (at its cap, or not its kind: the agent's ISSUE takes only the issue), to the
    // next one that does: Available takes it going down past the last slot. When none takes it, the nearest slot is given, so the
    // move is refused with its reason.
    const dir = step === 'up' ? -1 : 1
    const next = kind.slots.map((_, k) => si + dir * (k + 1)).filter((k) => k >= 0 && k < kind.slots.length)
    const open = next.find((k) => { const why = refusal(layout, item, kind.slots[k]); return why !== 'full' && why !== 'slot' })
    if (open !== undefined) {
      const to = kind.slots[open]
      return { slot: to, index: dir < 0 ? (layout.slots[to] ?? []).length : 0 }
    }
    if (dir > 0) return 'hide'
    if (next.length === 0) return null
    const to = kind.slots[next[0]]
    return { slot: to, index: dir < 0 ? (layout.slots[to] ?? []).length : 0 }
  }

  // The layout with a destination applied: placeItem, or hideItem for 'hide'. Drag, keys and the menu all end here.
  const moveTo = (layout: CardLayout, item: string, dest: Destination): CardLayout =>
    dest === 'hide' ? hideItem(layout, item) : placeItem(layout, item, dest.slot, dest.index)

  // Whether two layouts put every item in the same slot, in the same order. A move that changes nothing is not saved.
  const sameSlots = (a: CardLayout, b: CardLayout): boolean => kind.slots.every((s) => (a.slots[s] ?? []).join('\n') === (b.slots[s] ?? []).join('\n'))

  return { slotCap, slotOf, placedItems, refusal, canPlace, availableItems, placeItem, hideItem, destination, moveTo, sameSlots }
}
