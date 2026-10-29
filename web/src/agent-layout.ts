// The agent card layout's model (S-1438 PR 8): the agent card's rules over the generic card model (card-model.ts). Its
// HEAD holds the agent's items, with the mark and the name locked; its ISSUE slot holds only the issue, so ISSUE is on or
// off and the nested issue card's contents are the issue layout's; BADGES and FOOT take the agent's items and the issue
// items a badge can show. The context hairline is a flag beside the slots, not an item.
import { defaultCardLayout, LOCKED, SLOT_CAPS, SLOTS, type CardLayout } from './card-layout'
import { cardModel, type CardKind, type Destination, type Refusal, type Step } from './card-model'
import { CARD_ONLY } from './work/card-items'
import type { Field } from './itsa/fields'

export const AGENT_SLOTS: readonly string[] = SLOTS.agent

// The item that turns the nested issue card on and off. Its contents are the issue layout, not this one.
export const ISSUE_ITEM = 'issue'

// The items the agent card draws itself, locked in HEAD: its mark and name (LOCKED.agent), and the registry's locked items.
const MARKED_LOCKED = new Set(CARD_ONLY.filter((i) => i.locked && i.where.includes('agent')).map((i) => i.id))
export const isAgentLocked = (item: string) => LOCKED.agent.includes(item) || MARKED_LOCKED.has(item)

const agentKind: CardKind = {
  slots: AGENT_SLOTS,
  caps: { ISSUE: 1, FOOT: SLOT_CAPS.FOOT ?? Infinity },
  isLocked: isAgentLocked,
  blocked: () => false,
  // The issue goes only in ISSUE, and ISSUE takes nothing else.
  accepts: (item, slot) => (item === ISSUE_ITEM) === (slot === 'ISSUE'),
}

const M = cardModel(agentKind)
// The model's functions as one object, for the generic editors (CardEditor, CardPhoneEditor).
export const agentModel = M
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
export type { Destination, Refusal, Step }

// Whether the nested issue card is on: the issue is in ISSUE.
export const issueOn = (layout: CardLayout): boolean => (layout.slots.ISSUE ?? []).includes(ISSUE_ITEM)
// The layout with the nested issue card on or off. Off is hiding the issue item, so ISSUE holds nothing.
export const setIssueOn = (layout: CardLayout, on: boolean): CardLayout => (on ? placeItem(layout, ISSUE_ITEM, 'ISSUE') : hideItem(layout, ISSUE_ITEM))
// The layout with the context hairline on or off. A human wrote it, so it is chosen.
export const setHairline = (layout: CardLayout, on: boolean): CardLayout => ({ ...layout, hairline: on, chosen: true })

// Reset to default: today's agent card, with every field offered already (seen), so none lands in BADGES. It is marked
// chosen, since a human wrote it. Field.card is not read here.
export const resetAgentLayout = (fields: Pick<Field, 'id'>[]): CardLayout => ({
  ...defaultCardLayout('agent'), seen: fields.map((f) => `field:${f.id}`), chosen: true,
})
