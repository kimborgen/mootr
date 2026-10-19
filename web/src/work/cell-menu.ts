// Opens the cell menu (S-1518) in the shared menu layer at a point: a right-click on a table cell,
// or a long-press on a phone card's value. The entries come from cell-actions.ts; a choice edits
// the layout through the page's edit, so the table and the header marks follow at once.
import { showMenu, type MenuItem } from '../ui/menu'
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

// Returns whether a menu opened: a column with nothing to offer leaves the browser's own menu alone.
export function showCellMenu(x: number, y: number, h: HeaderLive, colId: string, row: WorkRow): boolean {
  const col = h.col(colId)
  if (!col) return false
  const entries = cellActions(col, row, h.cx, h.layout, optionsFor(h, colId))
  // The GitHub column's PR chip opens the diff on a click, so its menu is where the GitHub page and the diff are both named (S-1533).
  const prs: MenuItem[] = colId === 'github' ? prEntries(row.it.links, currentDiffRepos()).map((p) => ({
    label: p.label, hint: p.hint, icon: p.diff ? 'git-pull-request' : 'external-link',
    action: () => { if (p.diff) openDiff(p.diff.repo, p.diff.pr); else window.open(p.url, '_blank', 'noopener') },
  })) : []
  if (!entries.length && !prs.length) return false
  const items: MenuItem[] = [...prs, ...(prs.length && entries.length ? ['sep' as const] : []), ...entries.map((e): MenuItem => (e === 'sep' ? 'sep' : { label: e.label, hint: e.hint, action: () => h.edit(e.apply) }))]
  showMenu(x, y, items)
  return true
}
