// Opens the cell menu (S-1518) in the shared menu layer at a point: a right-click on a table cell,
// or a long-press on a phone card's value. The entries come from cell-actions.ts; a choice edits
// the layout through the page's edit, so the table and the header marks follow at once.
import { menuOpen, showMenu, type MenuItem } from '../ui/menu'
import { currentDiffRepos } from '../diff/diffRepos'
import { openDiff } from '../files/open'
import { cellActions } from './cell-actions'
import { prEntries } from './pr-actions'
import { optionsFor, type HeaderLive } from './header-menu'
import type { WorkRow } from './model'

// How long (ms) a touch rests on a value before it is a long-press.
export const LONG_PRESS_MS = 500
// How far (px) it may drift and still be a press, not a scroll.
export const LONG_PRESS_SLOP = 8

// The cell's menu items: empty when the column has nothing to offer.
// `restore`: after an edit the layout may re-render, so focus goes back to this element (not after an entry that opens something).
function cellItems(h: HeaderLive, colId: string, row: WorkRow, restore?: Element | null): MenuItem[] {
  const col = h.col(colId)
  if (!col) return []
  const back = (): void => { if (restore) setTimeout(() => { if (restore.isConnected) (restore as HTMLElement).focus?.() }) }
  const entries = cellActions(col, row, h.cx, h.layout, optionsFor(h, colId))
  // The GitHub column's PR chip opens the diff on a click, so its menu is where the GitHub page and the diff are both named (S-1533).
  const prs: MenuItem[] = colId === 'github' ? prEntries(row.it.links, currentDiffRepos()).map((p) => ({
    label: p.label, hint: p.hint, icon: p.diff ? 'git-pull-request' : 'external-link',
    action: () => { if (p.diff) openDiff(p.diff.repo, p.diff.pr); else window.open(p.url, '_blank', 'noopener') },
  })) : []
  return [...prs, ...(prs.length && entries.length ? ['sep' as const] : []), ...entries.map((e): MenuItem => (e === 'sep' ? 'sep' : { label: e.label, hint: e.hint, action: () => { h.edit(e.apply); back() } }))]
}

// Returns whether a menu opened: a column with nothing to offer leaves the browser's own menu alone.
// `restore` is where Escape puts focus back (the row, for the keyboard path).
export function showCellMenu(x: number, y: number, h: HeaderLive, colId: string, row: WorkRow, restore?: Element | null): boolean {
  const items = cellItems(h, colId, row, restore)
  if (!items.length) return false
  showMenu(x, y, items, null, restore)
  return true
}

// The keyboard path (S-1683): the context-menu key or Shift+F10 on a focused row lists its columns that have
// cell actions; choosing one opens that column's cell menu at the same place. Escape from either returns to the row.
export function showRowMenu(x: number, y: number, h: HeaderLive, colIds: string[], row: WorkRow, rowEl: Element): boolean {
  const items: MenuItem[] = colIds.filter((id) => cellItems(h, id, row).length).map((id) => ({
    label: h.col(id)?.label ?? id, popup: true,
    action: () => { showCellMenu(x, y, h, id, row, rowEl) },
  }))
  if (!items.length) return false
  // Already open (the keydown's menu, then the contextmenu event the same key fires): leave it be.
  if (!menuOpen()) showMenu(x, y, items, null, rowEl)
  return true
}

// Whether a key press asks for the context menu.
export const isMenuKey = (e: { key: string; shiftKey: boolean }) => e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)
