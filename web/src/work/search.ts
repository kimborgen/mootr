// The Work page's text search across every column (S-1519): one lowercase string per ITSA, built from
// each column's `text` value, so a search finds a row by its agents, branch, PR, field values and the
// rest, not only its key, title and summary. No browser imports, so the unit tests run in node.
import { getData } from '../store'
import type { Agent, Itsa } from '../types'
import type { CellContext } from './columns'
import type { SortFilterCol } from './sortfilter'

// The string is kept per ITSA object, and rebuilt when the ITSA is replaced by an update, when the
// extras it reads (cost, activity, watch, fields) change, when the store's agents list is replaced (the
// agents column reads agent names from it), or when the columns do. A few hundred rows
// are then read once per update rather than once per keystroke.
const memo = new WeakMap<Itsa, { cols: readonly SortFilterCol[]; extras: CellContext['extras']; agents: readonly Agent[]; s: string }>()

export function searchString(cols: readonly SortFilterCol[], it: Itsa, cx: CellContext): string {
  const agents = getData().agents
  const hit = memo.get(it)
  if (hit && hit.cols === cols && hit.extras === cx.extras && hit.agents === agents) return hit.s
  const row = { it, depth: 0, context: false }
  const s = cols.flatMap((c) => (c.text ? [c.text(row, cx)] : [])).filter(Boolean).join('\n').toLowerCase()
  memo.set(it, { cols, extras: cx.extras, agents, s })
  return s
}

// Whether the ITSA's search string has the (lowercase, trimmed) query.
export const searchHas = (cols: readonly SortFilterCol[], it: Itsa, cx: CellContext, q: string) => searchString(cols, it, cx).includes(q)
