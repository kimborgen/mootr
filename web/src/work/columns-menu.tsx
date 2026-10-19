// The Columns popover (S-1522): a search box over the column checkboxes, which narrows them by label as you type.
// Keys: typing anywhere in the list moves to the search, Arrow Down/Up move between the columns (Down from
// the search lands on the first), and Space toggles the focused column. "Reset to default" stays below the list.
import { useEffect, useRef, useState } from 'react'
import { Icon } from '../Icon'

export interface ColumnChoice { id: string; label: string; on: boolean; locked: boolean }

// The columns whose label holds the query, case aside; an empty query keeps them all.
export const matchColumns = (cols: ColumnChoice[], q: string) => {
  const n = q.trim().toLowerCase()
  return n ? cols.filter((c) => c.label.toLowerCase().includes(n)) : cols
}

export function ColumnsPanel({ cols, onToggle, onReset }: { cols: ColumnChoice[]; onToggle: (id: string, on: boolean) => void; onReset: () => void }) {
  const [q, setQ] = useState('')
  const search = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  // The popover focuses itself when it opens; the search takes the focus after it.
  useEffect(() => { search.current?.focus() }, [])
  const shown = matchColumns(cols, q)
  const rows = () => [...list.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
  const searchKey = (e: React.KeyboardEvent) => {
    // Home and End edit the text here; the Menu would jump them to the first and last column.
    if (e.key === 'Home' || e.key === 'End') { e.stopPropagation(); return }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault(); e.stopPropagation()
    const bs = rows()
    ;(e.key === 'ArrowDown' ? bs[0] : bs[bs.length - 1])?.focus()
  }
  const listKey = (e: React.KeyboardEvent) => {
    // Up from the first column goes back to the search, not around to the last.
    if (e.key === 'ArrowUp' && document.activeElement === rows()[0]) { e.preventDefault(); e.stopPropagation(); search.current?.focus(); return }
    // A character typed on a column goes to the search: focus moves first, so the browser types it there.
    if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) search.current?.focus()
  }
  return <div className="cm">
    <input ref={search} className="rm-search" type="search" value={q} placeholder="Search columns" aria-label="Search columns" autoComplete="off"
      onChange={(e) => setQ(e.target.value)} onKeyDown={searchKey} />
    <div className="cm-list" role="menu" aria-label="Columns" ref={list} onKeyDown={listKey}>
      {shown.map((c) => (
        <button key={c.id} type="button" role="menuitemcheckbox" aria-checked={c.on} disabled={c.locked} onClick={() => onToggle(c.id, !c.on)}>
          <span className="ml">{c.label}</span>
          <span className={'tick' + (c.on ? '' : ' off')}><Icon name="check" /></span>
        </button>
      ))}
      {shown.length ? null : <p className="rm-none muted" role="status">No column matches “{q.trim()}”</p>}
    </div>
    <hr />
    <button type="button" onClick={onReset}><span className="ml">Reset to default</span></button>
  </div>
}
