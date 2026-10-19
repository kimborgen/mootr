// The model behind the sidebar's Cost tab (S-1423): one entry per account, with only the figures the
// account has. A subscription (it has windows) shows its 5-hour and 7-day meters; an account with no
// windows is API-only and shows its paid spend and budget. Pure, so which fields show is tested.
import { budgetState, forecast, paidKnown, tone, type BudgetState } from './usage/Limits'
import type { Account } from './usage/types'

// The windows a line shows, in order; any other window an account reports is left to the hover.
export const LINE_WINDOWS = ['five_hour', 'seven_day'] as const

export interface CostWindow {
  key: string
  used: number
  atReset: number | null
  hitAt: string | null
  resetsAt: number | null
  rate: number | null
  tone: '' | 'warn' | 'over'
}
export interface CostBudget { spent: number | null; usd: number; per: string; pct: number | null; state: BudgetState }
export interface CostEntry {
  name: string
  harness: string
  subscription: boolean
  stale: boolean
  windows: CostWindow[]
  // The API-equivalent dollars of use in the subscription's 7-day (else 5-hour) window; null when unknown.
  worth: number | null
  // Actual paid spend this month (extra credits, or an API account's spend); null when unknown.
  paid: number | null
  paidEstimate: boolean
  budget: CostBudget | null
  // The tone that sets the entry's accent: the worst of its windows, or the budget state.
  level: '' | 'warn' | 'over'
}

export function costEntry(a: Account, now = Date.now()): CostEntry {
  const ws = Object.entries(a.windows)
  const subscription = ws.length > 0
  const windows: CostWindow[] = ws.map(([key, win]) => {
    const f = forecast(win, a.shares?.[key], a.stale, now)
    return { key, used: f.used, atReset: f.atReset, hitAt: f.hitAt, resetsAt: win.resets_at ?? null, rate: f.rate, tone: tone(f) }
  })
  windows.sort((x, y) => idx(x.key) - idx(y.key))
  const wk = a.shares?.seven_day?.worth ?? a.shares?.five_hour?.worth ?? Object.values(a.shares ?? {})[0]?.worth
  const paid = paidKnown(a.paid.month, subscription)
  const b = a.budget
  const spent = b ? (b.spent ?? paid) : null
  const bs = budgetState(b, spent)
  const budget: CostBudget | null = b ? { spent, usd: b.usd, per: b.per, pct: bs.pct, state: bs.state } : null
  const worst = windows.some((w) => w.tone === 'over') || bs.state === 'spent' ? 'over' : windows.some((w) => w.tone === 'warn') || bs.state === 'low' ? 'warn' : ''
  return {
    name: a.account, harness: a.match.harness, subscription, stale: a.stale, windows,
    worth: wk?.used_usd ?? null,
    paid, paidEstimate: a.paid.month.source === 'estimate', budget, level: worst,
  }
}
const idx = (k: string) => { const i = (LINE_WINDOWS as readonly string[]).indexOf(k); return i < 0 ? LINE_WINDOWS.length : i }

// The entries for the tab, in the account order the API gives. An account with nothing to show (no
// windows, no paid spend, no budget) is left out: a line of only a name is noise in a quick overview.
export function costEntries(accounts: Account[] | undefined, now = Date.now()): CostEntry[] {
  return (accounts ?? []).map((a) => costEntry(a, now)).filter((e) => e.subscription || e.paid != null || e.budget != null)
}
