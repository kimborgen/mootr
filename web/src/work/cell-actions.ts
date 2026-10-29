// The menu a cell opens (S-1518): a right-click on a table cell, or a long-press on a card's value
// on the phone, offers the filters that value stands for and a sort by its column. Which entries
// there are follows the column's filter kinds; each one is a change to the layout, applied through
// the page's edit. Pure logic with no browser imports, so the unit tests run in node.
import type { CellContext } from './columns'
import type { WorkRow } from './model'
import { BLANK, dayOf, kindsOf, type FilterValue, type SortFilterCol } from './sortfilter'
import { setFilter, setSort, type Layout } from './views'

export interface CellAction {
  label: string
  // What the entry acts on, shown beside the label: the value, the number, the day.
  hint?: string
  apply(l: Layout): Layout
}
export type CellEntry = CellAction | 'sep'

// A row that lists many values (agents) offers the first few; the rest are a header menu away.
export const CELL_VALUES = 3

const blankLabel = '(Blank)'

// The values a row has for a column's values filter, as the filter reads them: none is blank.
function valuesOf(raw: unknown): string[] | null {
  if (raw === undefined) return null
  const list = Array.isArray(raw) ? raw.map(String) : [raw === null || raw === '' ? BLANK : String(raw)]
  return [...new Set(list.length ? list : [BLANK])].slice(0, CELL_VALUES)
}

// The entries for one cell. `options` are the column's checklist values (with the other filters
// applied), which gives each entry its label. How an entry
// meets a filter already on the column:
// - Filter to this value replaces any filter on the column.
// - Exclude this value takes the value off an include list, else adds it to the column's standing
//   `not` rule (made if there is none), so a value that appears later still shows.
// - At least / At most set one bound and keep the other when it still fits (a date drops its preset).
// - Has and Has not replace the filter.
export function cellActions(col: SortFilterCol & { label?: string }, row: WorkRow, cx: CellContext, layout: Layout, options: FilterValue[]): CellEntry[] {
  const out: CellEntry[] = []
  const group = (entries: CellAction[]) => { if (entries.length) { if (out.length) out.push('sep'); out.push(...entries) } }
  const id = col.id
  const name = col.label ?? id
  for (const kind of kindsOf(col)) {
    const raw = col.filter!.valueOf(row, cx, kind)
    switch (kind) {
      case 'values': {
        const vals = valuesOf(raw)
        // A cell that shows text holds no blank value: a GitHub cell with a commit link has no PR state, but it is not empty (S-3608).
        if (!vals || (vals.every((v) => v === BLANK) && col.text?.(row, cx))) break
        const label = (v: string) => options.find((o) => o.value === v)?.label ?? (v === BLANK ? blankLabel : v)
        group(vals.flatMap((v): CellAction[] => [
          { label: 'Filter to this value', hint: label(v), apply: (l) => setFilter(l, id, { kind: 'values', values: [v] }) },
          { label: 'Exclude this value', hint: label(v), apply: (l) => {
            const f = l.filters?.[id]
            if (f?.kind !== 'values') return setFilter(l, id, { kind: 'values', not: [v] })
            if (f.values) return setFilter(l, id, { kind: 'values', values: f.values.filter((x) => x !== v && !f.not?.includes(x)) })
            return setFilter(l, id, { kind: 'values', not: [...new Set([...(f.not ?? []), v])] })
          } },
        ]))
        break
      }
      case 'has': {
        if (raw === undefined) break
        group([
          { label: 'Has', hint: name, apply: (l) => setFilter(l, id, { kind: 'has', has: true }) },
          { label: 'Has not', hint: name, apply: (l) => setFilter(l, id, { kind: 'has', has: false }) },
        ])
        break
      }
      case 'check': {
        if (raw === undefined) break
        const on = Boolean(raw)
        group([
          { label: 'Filter to this value', hint: on ? 'Checked' : 'Unchecked', apply: (l) => setFilter(l, id, { kind: 'check', value: on }) },
          { label: 'Exclude this value', hint: on ? 'Checked' : 'Unchecked', apply: (l) => setFilter(l, id, { kind: 'check', value: !on }) },
        ])
        break
      }
      case 'range': {
        if (typeof raw !== 'number' || !Number.isFinite(raw)) break
        const bound = (l: Layout) => { const f = l.filters?.[id]; return f?.kind === 'range' ? f : null }
        const hint = col.text?.(row, cx) || String(raw)
        group([
          { label: 'At least this', hint, apply: (l) => { const f = bound(l); return setFilter(l, id, { kind: 'range', min: raw, ...(f?.max !== undefined && f.max >= raw ? { max: f.max } : {}) }) } },
          { label: 'At most this', hint, apply: (l) => { const f = bound(l); return setFilter(l, id, { kind: 'range', ...(f?.min !== undefined && f.min <= raw ? { min: f.min } : {}), max: raw }) } },
        ])
        break
      }
      case 'date': {
        const day = typeof raw === 'string' && raw ? dayOf(raw) : ''
        if (!day) break
        const bound = (l: Layout) => { const f = l.filters?.[id]; return f?.kind === 'date' ? f : null }
        group([
          { label: 'At least this', hint: day, apply: (l) => { const f = bound(l); return setFilter(l, id, { kind: 'date', from: day, ...(f?.to && f.to >= day ? { to: f.to } : {}) }) } },
          { label: 'At most this', hint: day, apply: (l) => { const f = bound(l); return setFilter(l, id, { kind: 'date', ...(f?.from && f.from <= day ? { from: f.from } : {}), to: day }) } },
        ])
        break
      }
      case 'text': break
    }
  }
  if (col.sortValue) {
    const dir = layout.sort?.find((k) => k.col === id)?.dir
    group([
      { label: 'Sort by this column, ascending', hint: dir === 'asc' ? 'Current' : undefined, apply: (l) => setSort(l, id, 'asc', false) },
      { label: 'Sort by this column, descending', hint: dir === 'desc' ? 'Current' : undefined, apply: (l) => setSort(l, id, 'desc', false) },
    ])
  }
  return out
}
