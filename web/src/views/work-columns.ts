// Settings › Work columns, the pure part: the one list of built-in and custom columns as the
// Work layout orders it, where a moved or dropped row lands, the field order that follows, and
// the edit form's state and the payload it sends to the fields API.
import { fullOrder, loadStore, LOCKED, moveTo, saveStore, type Layout, type ViewStore } from '../work/views'
import { fieldColId, fieldIdOf, type Field, type FieldTone, type FieldType } from '../itsa/fields'
import type { CardLayout } from '../card-layout'

export interface ColumnRow {
  id: string
  label: string
  shown: boolean
  locked: boolean
  // The field behind a custom column; null for a built-in.
  field: Field | null
  canUp: boolean
  canDown: boolean
}

// Every column, shown or hidden, in the order the Work page would list it.
export function columnRows(layout: Layout, ids: string[], labels: Record<string, string>, fields: Field[]): ColumnRow[] {
  const byCol = new Map(fields.map((f) => [fieldColId(f), f]))
  const last = layout.cols.length - 1
  return fullOrder(layout.cols, ids).filter((id) => ids.includes(id)).map((id) => {
    const at = layout.cols.indexOf(id)
    const locked = LOCKED.includes(id)
    const field = byCol.get(id) ?? null
    const movable = at >= 0 && !locked
    return {
      id, locked, field, shown: at >= 0,
      label: field?.label ?? labels[id] ?? id,
      canUp: movable && at > 1,
      canDown: movable && at < last - (LOCKED.includes(layout.cols[last]) ? 1 : 0),
    }
  })
}

// Drops a shown column on another row: it lands just above that row, or just below it when
// dropped on the row's lower half, where the drop line shows. A hidden row's place is where it
// would show.
export function dropOn(layout: Layout, ids: string[], id: string, target: string, below = false): Layout {
  if (id === target) return layout
  const full = fullOrder(layout.cols, ids)
  const at = full.indexOf(target) + (below ? 1 : 0)
  const index = full.slice(0, at).filter((x) => x !== id && layout.cols.includes(x)).length
  return moveTo(layout, ids, id, index)
}

// Applies a change to the working layout as settings hold it now, not as this page first read
// them, so a view saved or picked on the Work page since then (and its current view and filter)
// stays. `ids` is the registry Settings has. An ordinary change saves unsettled (S-369): that list
// may be stale, so a field it doesn't know passes through as stored. `settled` is for a save right
// after a fresh fields fetch (an add or a remove): a new field then shows and is marked seen, a
// removed one leaves cols, seen and widths.
export function writeLayout(ids: string[], fn: (l: Layout, ids: string[]) => Layout, settled = false): ViewStore {
  const now = loadStore(ids)
  const next = { ...now, layout: fn(now.layout, ids) }
  saveStore(next, ids, settled)
  return next
}

// The fields' order the layout shows, or null when it is the order they have.
export function fieldOrder(layout: Layout, ids: string[], fields: Field[]): string[] | null {
  const order = fullOrder(layout.cols, ids).map(fieldIdOf).filter((x): x is string => !!x && fields.some((f) => f.id === x))
  const now = [...fields].sort((a, b) => a.position - b.position).map((f) => f.id)
  return order.length === now.length && order.every((x, i) => x === now[i]) ? null : order
}

// A slug from a label: lowercase letters, digits and dashes, starting with a letter, up to 32
// characters, and none of `taken`.
export function keyFrom(label: string, taken: string[] = []): string {
  let base = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (!/^[a-z]/.test(base)) base = base ? 'c-' + base : 'column'
  base = base.slice(0, 32).replace(/-+$/, '')
  let key = base
  for (let n = 2; taken.includes(key); n++) key = base.slice(0, 32 - String(n).length - 1).replace(/-+$/, '') + '-' + n
  return key
}

export interface OptionForm { value: string; label: string; tone: FieldTone | null }
export interface FieldForm {
  label: string
  // Empty: derived from the label.
  key: string
  type: FieldType
  options: OptionForm[]
  description: string
  hint: string
  width: Field['width']
  align: Field['align']
  // The kinds the field applies to; empty is every kind (S-3180).
  kinds: string[]
  // The phone card's slot, chip or detail line, until the card editor (S-1438 PR 6) replaces it.
  card: Field['card']
}

// Where a field shows: the Work table (its layout's columns) and the issue card's slots (cardLayouts), e.g. "Table · Card: badges".
export function shownIn(f: Field, cols: string[], issue: CardLayout): string {
  const id = fieldColId(f)
  const where = cols.includes(id) ? ['Table'] : []
  const slot = Object.keys(issue.slots).find((s) => issue.slots[s]?.includes(id))
  if (slot) where.push(`Card: ${slot.toLowerCase()}`)
  return where.length ? where.join(' · ') : 'Hidden'
}

export const appliesTo = (f: Pick<Field, 'kinds'>) => (f.kinds?.length ? f.kinds.join(', ') : 'All kinds')


export function formOf(f?: Field | null): FieldForm {
  return {
    label: f?.label ?? '', key: f?.key ?? '', type: f?.type ?? 'text',
    options: f?.options?.map((o) => ({ ...o })) ?? [],
    description: f?.description ?? '', hint: f?.hint ?? '',
    width: f?.width ?? 'm', align: f?.align ?? 'start', kinds: f?.kinds ? [...f.kinds] : [], card: f?.card ?? 'meta',
  }
}

export const newOption = (): OptionForm => ({ value: '', label: '', tone: 'muted' })

export function moveItem<T>(list: T[], i: number, delta: number): T[] {
  const j = i + delta
  if (j < 0 || j >= list.length) return list
  const out = list.slice()
  ;[out[i], out[j]] = [out[j], out[i]]
  return out
}

// What the form sends to POST or PATCH /api/itsas/fields. `taken` are the other fields' keys;
// `current` is the edited field's key, which an emptied Key keeps (only a new field derives one).
// A blank option value comes from its label, made unique among the options.
export function payloadOf(form: FieldForm, taken: string[], current?: string) {
  const label = form.label.trim()
  const text = (s: string) => (s.trim() ? s.trim() : null)
  const values = form.options.map((o) => o.value.trim()).filter(Boolean)
  const options = form.options.map((o) => {
    let value = o.value.trim()
    if (!value && o.label.trim()) values.push(value = keyFrom(o.label, values))
    return { value, label: o.label.trim() || value, tone: o.tone }
  })
  return {
    key: form.key.trim() || current || keyFrom(label, taken),
    label,
    type: form.type,
    options: form.type === 'choice' ? options : null,
    description: text(form.description),
    hint: text(form.hint),
    width: form.width,
    align: form.align,
    // Null is every kind, which the daemon stores as no kinds.
    kinds: form.kinds.length ? form.kinds : null,
    card: form.card,
  }
}
