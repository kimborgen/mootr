// The card layouts (S-2776, S-1438 PR 1): which items the issue card and the agent card show, and in
// which slot. They are one record in stam settings, `cardLayouts`, keyed `issue` and `agent`, written
// as the human, so a layout made on one device follows the user to the others. Nothing draws from it
// yet; the defaults are today's hard-coded cards, so drawing from it later changes nothing.
import { useEffect, useMemo, useReducer, useRef } from 'react'
import type { Field } from './itsa/fields'
import { settingsRecord } from './settings-views'

export const CARD_IDS = ['issue', 'agent'] as const
export type CardId = (typeof CARD_IDS)[number]
export type Slots = Record<string, string[]>
export interface CardLayout {
  // The item ids in each slot, in order. A slot the layout leaves out is empty.
  slots: Slots
  // The issue card's title lines (the clamp); absent on the agent card.
  titleLines?: 1 | 2 | 3
  // The agent card's context hairline; absent on the issue card.
  hairline?: boolean
  // The field items this layout has been offered (`field:<id>`): a field not listed is new and lands
  // in BADGES once; a listed one the human hid stays hidden.
  seen: string[]
  // Set once the human has saved the layout in the editor: the seed and the legacy migration never overwrite it.
  chosen?: boolean
}

export const SLOTS: Record<CardId, readonly string[]> = {
  issue: ['TOP', 'META', 'BADGES', 'FOOT'],
  agent: ['HEAD', 'ISSUE', 'BADGES', 'FOOT'],
}
// The most items a slot holds. BADGES has no cap: it clips.
export const SLOT_CAPS: Record<string, number> = { TOP: 3, META: 5, FOOT: 3, ISSUE: 1 }
// Items the card draws itself, never placed in a slot: the issue key, title and needs-you mark, the agent mark and name.
// The editor shows them as fixed, and the model refuses to place them.
export const LOCKED: Record<CardId, string[]> = { issue: ['key', 'title', 'needs'], agent: ['mark', 'name'] }
const MAX_ITEM = 64

// Today's cards: the board card (Board.tsx Card) and the system view's agent card (SystemCard.tsx).
// The needs-you badge is a fact the card always draws in TOP, so it is not an item.
const DEFAULTS: Record<CardId, CardLayout> = {
  issue: {
    slots: { TOP: ['parent', 'kind', 'health'], META: ['status', 'rollup', 'links', 'owner'], BADGES: [], FOOT: [] },
    titleLines: 3,
    seen: [],
  },
  agent: {
    slots: { HEAD: ['model', 'cost'], ISSUE: ['issue'], BADGES: ['health', 'review', 'tests'], FOOT: ['activity'] },
    hairline: true,
    seen: [],
  },
}

// A card's layout as the defaults have it: a fresh copy, so no caller can change the defaults.
export const defaultCardLayout = (id: CardId): CardLayout => structuredClone(DEFAULTS[id])

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isItem = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= MAX_ITEM

// A stored layout as the page uses it. Anything it can't read takes the defaults, and a layout that
// breaks the rules is brought within them: a locked item or a repeat is dropped, a slot is clipped to
// its cap. So a bad record can't break a card.
export function cleanCardLayout(x: unknown, id: CardId): CardLayout {
  if (!isRec(x) || !isRec(x.slots)) return defaultCardLayout(id)
  const seen = new Set<string>()
  const slots: Slots = {}
  for (const slot of SLOTS[id]) {
    const raw = Array.isArray(x.slots[slot]) ? (x.slots[slot] as unknown[]) : []
    const items: string[] = []
    for (const item of raw) {
      if (!isItem(item) || LOCKED[id].includes(item) || seen.has(item)) continue
      seen.add(item)
      items.push(item)
    }
    slots[slot] = items.slice(0, SLOT_CAPS[slot] ?? items.length)
  }
  const offered = Array.isArray(x.seen) ? [...new Set(x.seen.filter(isItem))] : []
  const chosen = x.chosen === true ? { chosen: true } : {}
  if (id === 'agent') return { slots, hairline: typeof x.hairline === 'boolean' ? x.hairline : true, seen: offered, ...chosen }
  const lines = x.titleLines
  return { slots, titleLines: lines === 1 || lines === 2 || lines === 3 ? lines : 3, seen: offered, ...chosen }
}

// The issue layout with the fields it hasn't been offered (the seen rule, as workViews has it): each
// new one is offered once, and one that isn't already in a slot lands at the end of BADGES. Returns the
// layout as it was when nothing is new.
export function settleIssueFields(layout: CardLayout, fields: string[]): CardLayout {
  const known = new Set(layout.seen)
  const fresh = fields.filter((f) => !known.has(f))
  if (!fresh.length) return layout
  const placed = new Set(Object.values(layout.slots).flat())
  const badges = fresh.filter((f) => !placed.has(f))
  return { ...layout, slots: { ...layout.slots, BADGES: [...(layout.slots.BADGES ?? []), ...badges] }, seen: [...layout.seen, ...fresh] }
}

// The issue layout the first load seeds from the cards as they are: today's defaults, with each field
// the old cards showed moved into the slot it had. A `chip` field goes into BADGES; a `meta` field goes
// into META up to its cap, and any past it goes into BADGES (no cap), so none is dropped. `order` is the
// Work columns' field ids in the order the human sees them; a field not in it follows, by position.
// Every field counts as seen, so only a field added later lands new.
export function seedIssueLayout(fields: Pick<Field, 'id' | 'card' | 'position'>[], order: string[] = []): CardLayout {
  const sorted = byOrder(fields, order)
  const base = defaultCardLayout('issue')
  const ids = (card: Field['card']) => sorted.filter((f) => f.card === card).map((f) => `field:${f.id}`)
  const metaRoom = Math.max(0, (SLOT_CAPS.META ?? 0) - base.slots.META.length)
  const meta = ids('meta')
  return cleanCardLayout({
    ...base,
    slots: { ...base.slots, META: [...base.slots.META, ...meta.slice(0, metaRoom)], BADGES: [...ids('chip'), ...meta.slice(metaRoom)] },
    seen: sorted.map((f) => `field:${f.id}`),
  }, 'issue')
}

// The agent layout the first load seeds: today's defaults, with each field the system view showed as a chip
// (`card: 'chip'`) after the word badges, in the Work columns' order. Only the first load seeds it.
export function seedAgentLayout(fields: Pick<Field, 'id' | 'card' | 'position'>[], order: string[] = []): CardLayout {
  const base = defaultCardLayout('agent')
  const sorted = byOrder(fields, order)
  const chips = sorted.filter((f) => f.card === 'chip').map((f) => `field:${f.id}`)
  return cleanCardLayout({ ...base, slots: { ...base.slots, BADGES: [...base.slots.BADGES, ...chips] }, seen: sorted.map((f) => `field:${f.id}`) }, 'agent')
}

// The agent record main wrote before the system view read it (Board.tsx): no BADGES and nothing seen. It is the
// old empty default, not a choice, so the first load replaces it with the seed, and the card keeps its badges.
const isLegacyAgent = (l: CardLayout) => !l.chosen && l.seen.length === 0 && (l.slots.BADGES ?? []).length === 0

// The agent layout with the chip fields it hasn't been offered: each new chip lands at the end of BADGES,
// once, as settleIssueFields does for the issue card. Other fields are marked seen and stay out of the card.
export function settleAgentFields(layout: CardLayout, fields: Pick<Field, 'id'>[]): CardLayout {
  const known = new Set(layout.seen)
  const fresh = fields.filter((f) => !known.has(`field:${f.id}`))
  if (!fresh.length) return layout
  const placed = new Set(Object.values(layout.slots).flat())
  const badges = fresh.filter((f) => !placed.has(`field:${f.id}`)).map((f) => `field:${f.id}`)
  return { ...layout, slots: { ...layout.slots, BADGES: [...(layout.slots.BADGES ?? []), ...badges] }, seen: [...layout.seen, ...fresh.map((f) => `field:${f.id}`)] }
}

// The fields in the order the human sees them: the Work columns' order first, then the rest by position.
function byOrder<F extends Pick<Field, 'id' | 'position'>>(fields: F[], order: string[]): F[] {
  const rank = (f: F) => { const i = order.indexOf(`field:${f.id}`); return i < 0 ? order.length + f.position : i }
  return [...fields].sort((a, b) => rank(a) - rank(b))
}

export const CARD_LAYOUT_EVENT = 'stam:card-layout'

// The record in settings: each card id's layout, read through the settings record like the views are.
const records = settingsRecord<CardLayout>({
  field: 'cardLayouts',
  legacy: 'stam/card-layouts',
  clean: (x, id) => cleanCardLayout(x, id === 'agent' ? 'agent' : 'issue'),
})

// Every card's layout the record holds, read through the settings record (a card with no entry is absent).
export async function loadCardLayouts(): Promise<Partial<Record<CardId, CardLayout>>> {
  await records.load()
  return records.all()
}

// Saves one card's layout, and tells the open pages (the editor, the boards) it changed.
export function saveCardLayout(id: CardId, layout: CardLayout): void {
  records.save(id, layout)
  window.dispatchEvent(new Event(CARD_LAYOUT_EVENT))
}

// The first load: a record with no issue layout is seeded from the cards as they are, once. An agent
// layout with no record takes the defaults. Each seed is a fill, so an id another page wrote since this
// one loaded is kept, not overwritten. `order`: see seedIssueLayout.
export async function migrateCardLayouts(fields: Pick<Field, 'id' | 'card' | 'position'>[], order: string[] = []): Promise<void> {
  const have = await records.load()
  if (!have.issue) await records.fill('issue', seedIssueLayout(fields, order))
  if (!have.agent) await records.fill('agent', seedAgentLayout(fields, order))
  else if (isLegacyAgent(have.agent)) records.save('agent', seedAgentLayout(fields, order))
  window.dispatchEvent(new Event(CARD_LAYOUT_EVENT))
}

// How often an open page reads the record again, so a layout another page saved shows here (while visible).
export const CARD_LAYOUT_POLL_MS = 5000

// A card's layout as the page shows it. Until the record has loaded, each layout is the migration's seed for
// the fields this page knows, so a page never draws a layout the record would not (a field with `card: 'meta'`
// sits in META, a chip in the agent's BADGES). `fields` are the fields the card may show: a stored issue layout
// takes any it hasn't seen.
export function useCardLayout(id: CardId, fields: Pick<Field, 'id' | 'card' | 'position'>[] = []): CardLayout {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    const on = () => bump()
    window.addEventListener(CARD_LAYOUT_EVENT, on)
    void records.load().then(bump, () => {})
    // Reads the record again and re-renders only when it changed.
    const poll = setInterval(() => {
      if (document.hidden) return
      const before = JSON.stringify(records.all())
      void records.refresh().then(() => { if (JSON.stringify(records.all()) !== before) bump() }, () => {})
    }, CARD_LAYOUT_POLL_MS)
    return () => { clearInterval(poll); window.removeEventListener(CARD_LAYOUT_EVENT, on) }
  }, [])
  // Kept by content: a settings refresh builds new record objects each poll, and a caller may build its fields each render.
  // Either would change the layout's identity, and with it every card's, though nothing a card draws has changed.
  const stored = useByContent(records.cached(id))
  const known = useByContent(fields)
  const seeded = useMemo(() => (id === 'agent' ? seedAgentLayout(known) : seedIssueLayout(known)), [id, known])
  return useMemo(() => {
    if (!stored || (id === 'agent' && isLegacyAgent(stored))) return seeded
    return id === 'agent' ? settleAgentFields(stored, known) : settleIssueFields(stored, known.map((f) => `field:${f.id}`))
  }, [id, stored, seeded, known])
}

// The value as it was while its JSON holds: the same object for the same content, so a memo on it doesn't churn.
function useByContent<T>(v: T): T {
  const kept = useRef<{ json: string; v: T } | null>(null)
  const json = JSON.stringify(v) ?? 'null'
  if (!kept.current || kept.current.json !== json) kept.current = { json, v }
  return kept.current.v
}
