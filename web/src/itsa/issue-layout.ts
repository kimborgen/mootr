// The issue card layout's model (S-1438 PR 6): the issue card's rules over the generic card model (card-model.ts). The
// editor's buttons, drag and keys call these, and each returns a new layout, or the same one when the move is refused, so
// no caller can break a cap or a lock.
import { LOCKED, SLOTS, SLOT_CAPS, seedIssueLayout, type CardLayout } from '../card-layout'
import { cardModel, type CardKind, type Destination, type Refusal, type Step } from '../card-model'
import { WORK_COLUMNS } from '../work/columns'
import { CARD_ONLY } from '../work/card-items'
import { LINK_KINDS } from '../work/links'
import type { Field } from './fields'

export type { Destination, Refusal, Step }

// The slots an item can sit in: TOP, META, BADGES and FOOT. TITLE is the locked title, not a slot.
export const ISSUE_SLOTS: readonly string[] = SLOTS.issue

// The items a card marks locked (CardItem.locked), read from the registry, so the editor never offers them.
const MARKED_LOCKED = new Set([...WORK_COLUMNS.filter((c) => c.card?.locked).map((c) => c.id), ...CARD_ONLY.filter((i) => i.locked).map((i) => i.id)])
export const isLocked = (item: string) => LOCKED.issue.includes(item) || MARKED_LOCKED.has(item)

// Links and the five link kinds are one choice, not both: `links` stands for every kind (the card draws them
// all in its slot, and it counts as one item), so placing one blocks the other. A kind can't go in while `links`
// is placed, and `links` can't go in while any kind is.
const isKind = (item: string) => (LINK_KINDS as string[]).includes(item)
const issueKind: CardKind = {
  slots: ISSUE_SLOTS,
  caps: SLOT_CAPS,
  isLocked,
  blocked: (layout, item) => {
    const placed = new Set(ISSUE_SLOTS.flatMap((s) => layout.slots[s] ?? []))
    if (item === 'links') return [...placed].some(isKind)
    return isKind(item) && placed.has('links')
  },
  accepts: () => true,
}

const M = cardModel(issueKind)
// The model's functions as one object, for the generic editor (CardEditor).
export const issueModel = M
export const slotCap = M.slotCap
export const slotOf = M.slotOf
export const placedItems = M.placedItems
export const availableItems = M.availableItems
export const refusal = M.refusal
export const canPlace = M.canPlace
export const placeItem = M.placeItem
export const destination = M.destination
export const moveTo = M.moveTo
export const sameSlots = M.sameSlots
export const hideItem = M.hideItem

export const setTitleLines = (layout: CardLayout, lines: 1 | 2 | 3): CardLayout => ({ ...layout, titleLines: lines, chosen: true })

// Reset to default: the seed the first load writes (seedIssueLayout, with the same arguments as the migration), marked
// chosen, since a human wrote it, so a later migration never refills over it.
export const resetIssueLayout = (fields: Pick<Field, 'id' | 'card' | 'position'>[]): CardLayout => ({ ...seedIssueLayout(fields), chosen: true })
