// What the Work page reads beside the ITSAs, invented: the issue costs, the activity per ITSA,
// the PR state of each GitHub link, the ITSA fields, and a saved layout. Routes are by
// "METHOD /path" for the stories stub (fixtures.ts).
import type { ActivitySplit, IssueCosts, ItsaActivity, ItsaActivityReport, WatchState } from '../work/links'
import { FIELDS } from './itsaFixtures'

const ago = (min: number) => new Date(Date.now() - min * 60000).toISOString()

export const COSTS: IssueCosts = {
  note: 'Claude and Codex dollars are API-equivalent estimates, not what a subscription bills.',
  issues: [
    { key: 'S-910', own: { cost_usd: 1.2 }, total: { cost_usd: 18.4 }, weekly_percent: 3.2 },
    { key: 'S-911', own: { cost_usd: 6.1 }, total: { cost_usd: 11.7 }, weekly_percent: 1.8 },
    { key: 'S-912', own: { cost_usd: 3.9 }, total: { cost_usd: 3.9 }, weekly_percent: 0.7 },
    { key: 'S-915', own: { cost_usd: 0.004 }, total: { cost_usd: 0.004 }, weekly_percent: null },
    { key: 'S-920', own: { cost_usd: 2.3 }, total: { cost_usd: 2.3 }, weekly_percent: 0.4 },
  ],
}

const split = (working: number, waiting: number, cost: number, top: Record<string, number>): ActivitySplit => ({
  working_s: working, waiting_s: waiting, working_by_kind: {}, waiting_by_top: top, waiting_by_kind: Object.fromEntries(Object.entries(top).map(([k, v]) => [`${k}.wait`, v])), cost_usd: cost,
})
const row = (key: string, own: ActivitySplit, total: ActivitySplit, rounds: number): ItsaActivity => ({
  key, category: 'active', created_at: ago(7000), closed_at: null, lead_s: null, review_rounds: rounds, own, total, agents: [{ id: 'fx-dev', name: 'fixture-dev', working_s: own.working_s }],
})
export const ACTIVITY: ItsaActivityReport = {
  note: 'Fixture activity.', since: ago(20000), rows: [
    row('S-910', split(1800, 600, 1.2, { human: 600 }), split(21000, 9000, 18.4, { human: 5400, agent: 2400, job: 1200 }), 0),
    row('S-911', split(5400, 1800, 6.1, { human: 900, agent: 900 }), split(14400, 6300, 11.7, { human: 3600, agent: 1800, job: 900 }), 2),
    row('S-912', split(3600, 600, 3.9, { job: 600 }), split(3600, 600, 3.9, { job: 600 }), 1),
    row('S-920', split(4000, 2000, 2.3, { human: 1500, throttle: 500 }), split(4000, 2000, 2.3, { human: 1500, throttle: 500 }), 1),
  ],
}

// The PR state per subject (github:OWNER/REPO#N), as GET /api/watch/state answers.
const watch = (n: number, w: WatchState) => [`GET /api/watch/state?subject=${encodeURIComponent(`github:fixture/repo#${n}`)}`, w] as const
export const WATCH_ROUTES: Record<string, unknown> = Object.fromEntries([
  watch(311, { state: 'open', checks: 'pending', review: 'none', updated_at: ago(10) }),
  watch(312, { state: 'open', checks: 'success', review: 'approved', updated_at: ago(30) }),
  watch(320, { state: 'open', checks: 'success', review: 'none', updated_at: ago(60) }),
])

// Every built-in column id, in the registry's order.
export const BUILTIN = ['work', 'status', 'agents', 'branch', 'github', 'test', 'linear', 'link', 'time', 'cost', 'window', 'health', 'review', 'tests', 'updated']

// What the Work page asks beyond the ITSAs, answered. `extra` adds or replaces routes.
export const WORK_ROUTES: Record<string, unknown> = {
  'GET /api/usage/issues?days=7': COSTS,
  'GET /api/activity?by=itsa': ACTIVITY,
  ...WATCH_ROUTES,
}

// A saved Work layout in settings: which columns, grouped how, showing open or all.
export const layout = (o: { cols?: string[]; group?: 'issues' | 'agents' | 'flat' | 'column'; groupBy?: string; show?: 'open' | 'all'; sort?: unknown[]; filters?: Record<string, unknown>; quick?: string[] }) => ({
  'GET /api/config/settings': { text: JSON.stringify({ workViews: { work: { show: o.show ?? 'open', cols: o.cols ?? BUILTIN, group: o.group ?? 'issues', groupBy: o.groupBy, sort: o.sort, filters: o.filters, quick: o.quick } } }) },
})

// The ITSA field definitions, which add a column each (S-369); a state that shows them adds this route.
export const FIELD_ROUTE = { 'GET /api/itsas/fields': FIELDS }
