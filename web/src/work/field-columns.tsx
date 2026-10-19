// ITSA fields as Work columns (S-369): one WorkColumn per field, after the built-ins, drawn by the
// field's type, and the same values on the phone's card. The pure parts (value emptiness, the
// link's host, the date) are exported for tests.
import type { ReactNode } from 'react'
import { Icon } from '../Icon'
import { fieldColId, fieldIdOf, TONE_CLASS, type Field } from '../itsa/fields'
import type { Itsa } from '../types'
import type { WorkColumn } from './columns'
import { BLANK, countValues, type FilterKind, type SortFilterCol } from './sortfilter'

// The registry track per field width, on the space tokens like the built-in columns.
export const FIELD_WIDTH: Record<Field['width'], string> = {
  s: 'calc(var(--space-12))',
  m: 'minmax(calc(var(--space-12) * 2), 1fr)',
  l: 'minmax(calc(var(--space-12) * 3), 2fr)',
}

// The room (px) each field width adds to the pane width a field column needs (withFieldFit).
const FIELD_PX: Record<Field['width'], number> = { s: 80, m: 130, l: 200 }

// A field's value on an ITSA, or undefined: values are held by the field's key.
export const valueOf = (it: Pick<Itsa, 'fields'>, f: Pick<Field, 'key'>): unknown => it.fields?.[f.key]

// No value to show: unset, an empty string, or a check that is off.
export const isEmpty = (v: unknown): boolean => v === undefined || v === null || v === '' || v === false

// A link's label: its host, without a leading www.
export function linkHost(url: string): string {
  try { return new URL(url).host.replace(/^www\./, '') } catch { return url }
}

// A date field's ISO day (YYYY-MM-DD) as the page writes dates: month and day, with the year when
// it isn't this one. The day is read as a calendar date, so no time zone moves it.
export function fmtDay(iso: string, now = new Date()): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  const when = new Date(y, m - 1, d)
  return when.toLocaleDateString(undefined, y === now.getFullYear() ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' })
}

// The cell for one value of a field, null when there is nothing to show.
export function FieldValue({ f, v }: { f: Field; v: unknown }): ReactNode {
  if (isEmpty(v)) return null
  switch (f.type) {
    case 'text': return <span className="w-ftext" title={String(v)}>{String(v)}</span>
    case 'number': return <span className="w-fnum">{String(v)}</span>
    case 'choice': {
      const o = f.options?.find((x) => x.value === v)
      const tone = o?.tone ? TONE_CLASS[o.tone] : ''
      return <span className={('badge ' + tone).trim()} title={o?.label ?? String(v)}>{o?.label ?? String(v)}</span>
    }
    case 'link': {
      const url = String(v)
      return <a className="w-flink" href={url} target="_blank" rel="noreferrer noopener" title={url} onClick={(e) => e.stopPropagation()}>
        <Icon name="link" size="xs" /><span className="w-link-label">{linkHost(url)}</span></a>
    }
    case 'date': return <time className="w-time" dateTime={String(v)}>{fmtDay(String(v))}</time>
    case 'check': return <span className="w-fcheck" role="img" aria-label="Yes"><Icon name="check" size="xs" /></span>
  }
}

// The text a field value stands for in a search, a values list, and a text filter: a choice's label.
const textOf = (f: Field, v: unknown): string => {
  if (isEmpty(v)) return ''
  if (f.type === 'choice') return f.options?.find((o) => o.value === v)?.label ?? String(v)
  if (f.type === 'link') return linkHost(String(v))
  return String(v)
}

// What a field's value is for sorting, filtering and searching, by its type (S-1504).
export function fieldValues(f: Field): Omit<SortFilterCol, 'id'> {
  const raw = (r: { it: Pick<Itsa, 'fields'> }) => valueOf(r.it, f)
  const base = { text: (r: { it: Pick<Itsa, 'fields'> }) => textOf(f, raw(r)) }
  switch (f.type) {
    case 'choice': {
      const order = (f.options ?? []).map((o) => o.value)
      return { ...base,
        sortValue: (r) => { const v = raw(r); return isEmpty(v) ? null : String(order.indexOf(String(v)) < 0 ? order.length : order.indexOf(String(v))).padStart(6, '0') + ' ' + String(v) },
        filter: { kind: 'values', valueOf: (r) => (isEmpty(raw(r)) ? BLANK : String(raw(r))),
          values: (rows) => countValues(rows, (r) => (isEmpty(raw(r)) ? [] : [String(raw(r))]), (v) => textOf(f, v), order) } }
    }
    case 'text': return { ...base, sortValue: (r) => textOf(f, raw(r)).toLowerCase() || null, filter: { kind: 'text', valueOf: (r) => textOf(f, raw(r)) } }
    case 'number': return { ...base,
      sortValue: (r) => { const v = raw(r); return isEmpty(v) || Number.isNaN(Number(v)) ? null : Number(v) },
      filter: { kind: 'range', valueOf: (r) => { const v = raw(r); return isEmpty(v) || Number.isNaN(Number(v)) ? null : Number(v) } } }
    case 'date': return { ...base, sortValue: (r) => (isEmpty(raw(r)) ? null : String(raw(r))), filter: { kind: 'date', valueOf: (r) => (isEmpty(raw(r)) ? null : String(raw(r))) } }
    case 'link': return { ...base, sortValue: (r) => textOf(f, raw(r)).toLowerCase() || null,
      filter: { kind: ['has', 'text'] as FilterKind[], valueOf: (r, _cx, k) => (k === 'has' ? !isEmpty(raw(r)) : textOf(f, raw(r))) } }
    case 'check': return { ...base, sortValue: (r) => (raw(r) === true ? 1 : 0), filter: { kind: 'check', valueOf: (r) => raw(r) === true } }
  }
}

// The column for a field: id `field:<id>`, so a saved layout keeps it through a key change.
export function fieldColumn(f: Field): WorkColumn {
  return {
    id: fieldColId(f), label: f.label, hint: f.hint ?? undefined, width: FIELD_WIDTH[f.width],
    align: f.align === 'end' || f.type === 'number' ? 'end' : undefined,
    render: (row) => <FieldValue f={f} v={valueOf(row.it, f)} />,
    ...fieldValues(f),
  }
}

// One column per field, by position.
export const fieldColumns = (fields: Field[]): WorkColumn[] => [...fields].sort((a, b) => a.position - b.position).map(fieldColumn)

// The shown columns with each field column given a pane width, by its place in the layout: a field
// never drops before a column to its right, so its threshold is the smallest among the columns after
// it (one that never drops counts as 0, and the field never drops either). A field with none after
// it needs the largest built-in threshold before it plus its own room, so the rightmost fields drop
// first. The built-ins keep their own `hideBelow`.
export function withFieldFit(cols: WorkColumn[], fields: Field[]): WorkColumn[] {
  const fieldOf = (c: WorkColumn) => fields.find((x) => x.id === fieldIdOf(c.id))
  const out = cols.slice()
  let after = Infinity
  let widest = cols.reduce((n, c) => (fieldOf(c) ? n : Math.max(n, c.hideBelow ?? 0)), 0)
  for (let i = cols.length - 1; i >= 0; i--) {
    const f = fieldOf(cols[i])
    if (f) {
      const need = after === Infinity ? widest + FIELD_PX[f.width] : after
      if (need > 0) out[i] = { ...cols[i], hideBelow: need }
      after = Math.min(after, need)
    } else after = Math.min(after, cols[i].hideBelow ?? 0)
  }
  return out
}

// What the phone's card shows of the shown fields: only the ones with a value, as chips or as
// labelled meta, in the layout's order.
export function cardFields(it: Itsa, fields: Field[]): { chips: { f: Field; v: unknown }[]; meta: { f: Field; v: unknown }[] } {
  const set = fields.map((f) => ({ f, v: valueOf(it, f) })).filter((x) => !isEmpty(x.v))
  return { chips: set.filter((x) => x.f.card === 'chip'), meta: set.filter((x) => x.f.card !== 'chip') }
}
