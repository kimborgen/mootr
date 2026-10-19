// The Work header's menu (S-1513): sort for the column, then its filter editor, in the popover
// (ui/menu.tsx). The popover lives in the menu layer, outside the page, so the page publishes what
// the menu reads (the layout, the rows, an edit function) and the menu follows it: an edit applies
// at once and the menu shows the result.
import { useState, useSyncExternalStore } from 'react'
import type { CellContext, WorkColumn } from './columns'
import type { WorkRow } from './model'
import { hideMenu } from '../ui/menu'
import { setFilter, setSort, type Layout } from './views'
import { FilterEditor, KIND_LABEL } from './filter-editors'
import { kindsOf, type ColFilter, type FilterKind, type FilterValue } from './sortfilter'

export interface HeaderLive {
  layout: Layout
  col(id: string): WorkColumn | undefined
  // The rows a column's checklist counts: the page's rows with every other column's filter applied.
  rows(excluding: string): WorkRow[]
  cx: CellContext
  edit(fn: (l: Layout) => Layout): void
}

let live: HeaderLive | null = null
const subs = new Set<() => void>()
let ver = 0
export function publishHeader(next: HeaderLive) { live = next; ver++; for (const f of subs) f() }
const useLive = () => { useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => ver); return live }

// The values a column's checklist offers.
export const optionsFor = (h: HeaderLive, id: string): FilterValue[] => h.col(id)?.filter?.values?.(h.rows(id), h.cx) ?? []

// A column's filter: the switch between its kinds when it has several, the editor, and Clear filter.
// The header menu and the phone's filter sheet (Glance.tsx) both show it.
export function ColumnFilter({ col, filter, options, onChange }: { col: WorkColumn; filter: ColFilter | null; options: (kind: FilterKind) => FilterValue[]; onChange: (f: ColFilter | null) => void }) {
  const kinds = kindsOf(col)
  const [picked, setPicked] = useState<FilterKind | null>(null)
  const kind = kinds.find((k) => k === (filter?.kind ?? picked)) ?? kinds[0]
  if (!kind) return null
  return <>
    {kinds.length > 1
      ? <div className="fm-kinds seg" role="radiogroup" aria-label="Filter by">
          {kinds.map((k) => <button key={k} type="button" role="radio" aria-checked={k === kind} className={k === kind ? 'on' : ''} data-kind={k}
            onClick={() => { setPicked(k); if (filter && filter.kind !== k) onChange(null) }}>{KIND_LABEL[k]}</button>)}
        </div>
      : null}
    <FilterEditor kind={kind} filter={filter?.kind === kind ? filter : null} options={options(kind)} onChange={onChange} />
    <button type="button" className="fm-clear" disabled={!filter} onClick={() => onChange(null)}>Clear filter</button>
  </>
}

export function HeaderMenuBody({ colId }: { colId: string }) {
  const h = useLive()
  const col = h?.col(colId)
  if (!h || !col) return null
  const filter = h.layout.filters?.[colId] ?? null
  const hasFilter = kindsOf(col).length > 0
  const dir = h.layout.sort?.find((k) => k.col === colId)?.dir
  const sort = (to: 'asc' | 'desc' | null) => (e: React.MouseEvent) => { h.edit((l) => setSort(l, colId, to, e.shiftKey)); hideMenu(true) }
  return <div className="rm fm" data-col={colId}>
    {col.sortValue ? <>
      <button type="button" role="menuitemradio" aria-checked={dir === 'asc'} className="fm-sort" data-sort="asc" onClick={sort('asc')}>Sort A→Z</button>
      <button type="button" role="menuitemradio" aria-checked={dir === 'desc'} className="fm-sort" data-sort="desc" onClick={sort('desc')}>Sort Z→A</button>
      <button type="button" className="fm-sort" data-sort="off" disabled={!dir} onClick={sort(null)}>Clear sort</button>
    </> : null}
    {col.sortValue && hasFilter ? <hr /> : null}
    <ColumnFilter col={col} filter={filter} options={(k) => (k === 'values' ? optionsFor(h, colId) : [])} onChange={(f) => h.edit((l) => setFilter(l, colId, f))} />
  </div>
}
