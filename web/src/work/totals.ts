// The Work table's footer (S-1521): a summary of the rows shown, free of the store so it can be
// tested alone. It counts each non-context ITSA once, whatever the grouping lists, so a row
// listed under several agents still adds once. Cost and time sum each ITSA's own figures, not the
// roll-up with its children: a child shown as its own row would count twice, and one the filters
// hide drops out of the sum with its row.
import { CATEGORIES, CATEGORY_LABEL } from '../itsa/itsa'
import { fieldColId, type Field } from '../itsa/fields'
import type { ItsaCategory } from '../types'
import type { WorkGroup } from './model'
import { activityOf, costOf, fmtDuration, fmtUsd } from './links'
import type { WorkExtras } from './data'

export interface WorkTotals {
  count: number
  // Rows per status category, in category order; categories with none are left out.
  byCategory: { category: ItsaCategory; n: number }[]
  costUsd: number
  workingS: number
  // Sums of the number fields, by column id (`field:<id>`); a field no shown row has a value for is left out.
  numbers: Record<string, number>
}

export function workTotals(groups: WorkGroup[], extras: Pick<WorkExtras, 'costs' | 'activity'>, fields: Field[], category: (status: string) => string): WorkTotals {
  const seen = new Set<string>()
  const cats = new Map<string, number>()
  const numbers: Record<string, number> = {}
  const numberFields = fields.filter((f) => f.type === 'number')
  let costUsd = 0
  let workingS = 0
  for (const g of groups) for (const r of g.rows) {
    if (r.context || seen.has(r.it.id)) continue
    seen.add(r.it.id)
    const c = category(r.it.status)
    cats.set(c, (cats.get(c) ?? 0) + 1)
    costUsd += costOf(extras.costs, r.it.key)?.own.cost_usd ?? 0
    workingS += activityOf(extras.activity, r.it.key)?.own.working_s ?? 0
    for (const f of numberFields) {
      const v = r.it.fields?.[f.key]
      if (v === undefined || v === null || v === '' || Number.isNaN(Number(v))) continue
      const id = fieldColId(f)
      numbers[id] = (numbers[id] ?? 0) + Number(v)
    }
  }
  return { count: seen.size, byCategory: CATEGORIES.filter((c) => cats.has(c)).map((category) => ({ category, n: cats.get(category)! })), costUsd, workingS, numbers }
}

const noun = (n: number) => `${n} ${n === 1 ? 'issue' : 'issues'}`
const statusText = (t: WorkTotals) => t.byCategory.map(({ category, n }) => `${n} ${CATEGORY_LABEL[category].toLowerCase()}`).join(' · ')
const numText = (n: number) => String(Math.round(n * 100) / 100)

// What a column's footer cell says: blank for a column with nothing to sum or count, and for a sum of nothing.
export function totalCell(col: string, t: WorkTotals): string {
  if (col === 'work') return noun(t.count)
  if (col === 'status') return statusText(t)
  if (col === 'cost') return t.costUsd > 0 ? fmtUsd(t.costUsd) : ''
  if (col === 'time') return t.workingS > 0 ? fmtDuration(t.workingS) : ''
  return col in t.numbers ? numText(t.numbers[col]) : ''
}

// The phone's one line under the filtered list: the count, then what is known of status, cost, and time.
export function totalLine(t: WorkTotals): string {
  return [noun(t.count), statusText(t), totalCell('cost', t), totalCell('time', t) && `${totalCell('time', t)} working`].filter(Boolean).join(' · ')
}
