// The phone's sort and filter sheet (S-1514): the Work table's header menu for a screen with no
// header. A full-height sheet: Sort by (a column and a direction per key, several keys), then one
// 44 px row for each column that sorts or filters, which opens that column's filter editor in
// place (the header menu's, so a filter reads the same on both). It edits the one shared layout, so
// what is set here shows on the desktop too. Clear all and "Show N" stay pinned at the bottom.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../Icon'
import type { WorkColumn } from './columns'
import { describeFilter } from './filter-editors'
import { ColumnFilter, optionsFor, type HeaderLive } from './header-menu'
import { kindsOf, type SortKey } from './sortfilter'
import { clearFilters, setFilter, setGroup, setSortKeys } from './views'

// How many filters (column and quick) and sort keys are set: what the Filter button shows.
export const activeCount = (l: { sort?: SortKey[]; filters?: object; quick?: unknown[] }) => (l.sort?.length ?? 0) + Object.keys(l.filters ?? {}).length + (l.quick?.length ?? 0)

export const clearAll = (l: Parameters<typeof clearFilters>[0]) => setSortKeys(clearFilters(l), [])

// One sort key: the column, the direction, and a way to drop it.
function SortKeyRow({ k, i, cols, taken, set }: { k: SortKey; i: number; cols: WorkColumn[]; taken: string[]; set: (next: SortKey | null) => void }) {
  return <div className="fs-key" data-key={k.col}>
    <select className="fs-select" aria-label={`Sort key ${i + 1}`} value={k.col} onChange={(e) => set({ col: e.target.value, dir: k.dir })}>
      {cols.filter((c) => c.id === k.col || !taken.includes(c.id)).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
    </select>
    <button type="button" className="fs-dir" data-dir={k.dir} aria-label={`Direction: ${k.dir === 'asc' ? 'ascending' : 'descending'}. Tap to flip`}
      onClick={() => set({ col: k.col, dir: k.dir === 'asc' ? 'desc' : 'asc' })}>
      <Icon name={k.dir === 'asc' ? 'arrow-up' : 'arrow-down'} size="xs" />{k.dir === 'asc' ? 'A→Z' : 'Z→A'}</button>
    <button type="button" className="fs-x" aria-label={`Remove sort key ${i + 1}`} onClick={() => set(null)}><Icon name="x" size="xs" /></button>
  </div>
}

export function FilterSheet({ live, cols, count, groupCols, onClose }: { live: HeaderLive; cols: WorkColumn[]; count: number; groupCols?: WorkColumn[]; onClose: () => void }) {
  const [open, setOpen] = useState<string | null>(null)
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => { dialog.current?.focus() }, [])
  const { layout, edit } = live
  const sort = layout.sort ?? []
  const sortable = cols.filter((c) => !!c.sortValue)
  const taken = sort.map((k) => k.col)
  const rows = cols.filter((c) => kindsOf(c).length > 0)
  const setKey = (i: number, next: SortKey | null) => edit((l) => setSortKeys(l, (l.sort ?? []).flatMap((k, j) => (j === i ? (next ? [next] : []) : [k]))))
  const addable = sortable.filter((c) => !taken.includes(c.id))
  const active = activeCount(layout)
  return createPortal(
    <div ref={dialog} className="fsheet" role="dialog" aria-modal="true" aria-label="Sort and filter" data-fsheet tabIndex={-1}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}>
      <div className="fs-head"><h3>Sort and filter</h3>
        <button type="button" className="fs-close" aria-label="Close" onClick={onClose}><Icon name="x" /></button></div>
      <div className="fs-body">
        <section className="fs-sort" aria-label="Sort by">
          <div className="fs-label">Sort by</div>
          {sort.map((k, i) => <SortKeyRow key={k.col} k={k} i={i} cols={sortable} taken={taken} set={(n) => setKey(i, n)} />)}
          {addable.length ? <select className="fs-select fs-add" aria-label="Add a sort key" value="" onChange={(e) => { if (e.target.value) edit((l) => setSortKeys(l, [...(l.sort ?? []), { col: e.target.value, dir: 'asc' }])) }}>
            <option value="">{sort.length ? 'Then by…' : 'Choose a column…'}</option>
            {addable.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select> : null}
        </section>
        {groupCols?.length ? <section className="fs-group" aria-label="Group by">
          <div className="fs-label">Group by</div>
          <select className="fs-select" aria-label="Group by column" value={layout.group === 'column' ? layout.groupBy ?? '' : ''}
            onChange={(e) => edit((l) => (e.target.value ? setGroup(l, 'column', e.target.value) : setGroup(l, 'issues')))}>
            <option value="">None</option>
            {groupCols.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </section> : null}
        <section className="fs-filters" aria-label="Filter by">
          <div className="fs-label">Filter</div>
          {rows.map((c) => {
            const f = layout.filters?.[c.id] ?? null
            const on = open === c.id
            const said = f ? describeFilter(f, f.kind === 'values' ? optionsFor(live, c.id) : []) : 'Any'
            return <div key={c.id} className="fs-col" data-col={c.id}>
              <button type="button" className="fs-row" aria-expanded={on} onClick={() => setOpen(on ? null : c.id)}>
                <span className="fs-name">{c.label}</span>
                <span className={'fs-val' + (f ? ' set' : '')}>{said}</span>
                <span className={'chev' + (on ? ' open' : '')}><Icon name="chevron-right" size="xs" /></span>
              </button>
              {on ? <div className="fs-edit menu popover"><div className="rm fm"><ColumnFilter col={c} filter={f} options={(k) => (k === 'values' ? optionsFor(live, c.id) : [])} onChange={(n) => edit((l) => setFilter(l, c.id, n))} /></div></div> : null}
            </div>
          })}
        </section>
      </div>
      <div className="fs-foot">
        <button type="button" className="btn" data-fs="clear" disabled={!active} onClick={() => edit(clearAll)}>Clear all</button>
        <button type="button" className="btn primary" data-fs="show" onClick={onClose}>Show {count}</button>
      </div>
    </div>, document.body)
}
