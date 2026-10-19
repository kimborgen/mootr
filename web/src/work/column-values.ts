// What each built-in Work column's value is, for sorting, filtering and searching (S-1504): the
// `sortValue`, `text` and `filter` that columns.tsx adds to its columns. Each reads the same facts
// the cell draws, so a sort or a filter always agrees with what the row shows.
import { HEALTH, statusInfo, statusLabel, CATEGORIES } from '../itsa/itsa'
import { byId } from '../store'
import type { Itsa, ItsaLink } from '../types'
import { activityOf, costOf, fmtTimeShare, fmtUsd, fmtWindow, githubSubject, linkKind, linkLabel, reviewOf, testsOf, type LinkKind, type WatchState } from './links'
import type { CellContext } from './columns'
import { agentIdsOf, type WorkRow } from './model'
import { BLANK, countValues, type SortFilterCol } from './sortfilter'

type Meta = Omit<SortFilterCol, 'id'>

const keyNumber = (key: string) => Number(key.match(/(\d+)\s*$/)?.[1] ?? NaN)
// An index in a known order; a value the order doesn't list (-1) sorts after the known ones, before blanks.
const known = (i: number, n: number) => (i < 0 ? n : i)
const agentName = (id: string) => byId(id)?.name ?? id
const linksOf = (it: Itsa, kind: LinkKind): ItsaLink[] => (it.links ?? []).filter((l) => linkKind(l) === kind)
const branchOf = (it: Itsa) => linksOf(it, 'branch')[0]

// The PR states: open covers checks and review states too, as the cell's state word does for them.
export const PR_STATES = ['open', 'draft', 'merged', 'closed']
const prStateOf = (w: WatchState | undefined): string | null => (!w?.state ? null : w.state === 'open' ? (w.draft ? 'draft' : 'open') : w.state)
// Undefined when the watch has no state for any of the ITSA's PRs: the source isn't loaded, which a filter ignores.
// A link with no PR or issue subject (a commit, a repo) has no state to wait for, so it doesn't count.
const prStatesLoaded = (it: Itsa, watch: Record<string, WatchState>) => {
  const subjects = linksOf(it, 'github').flatMap((l) => githubSubject(l.url) ?? [])
  return subjects.length === 0 || subjects.some((s) => watch[s])
}
const prStates = (it: Itsa, watch: Record<string, WatchState>): string[] =>
  linksOf(it, 'github').flatMap((l) => { const s = prStateOf(watch[githubSubject(l.url) ?? '']); return s ? [s] : [] })

const REVIEW_VERDICTS = ['approve', 'request_changes', 'comment']
const verdictOf = (it: Itsa) => branchOf(it)?.meta?.review?.verdict ?? BLANK
const testStateOf = (it: Itsa) => { const t = testsOf(branchOf(it)?.meta); return t ? (t.severe ? 'failed' : 'passed') : BLANK }
const HEALTH_ORDER = ['off_track', 'at_risk', 'on_track']

const textMeta = (read: (row: WorkRow) => string): Meta => ({ text: (r) => read(r), filter: { kind: 'text', valueOf: (r) => read(r) } })
// A link column: has any link of the kind, or text in their labels.
const linkMeta = (kind: LinkKind): Meta => {
  const labels = (r: WorkRow) => linksOf(r.it, kind).map(linkLabel)
  return {
    sortValue: (r) => labels(r)[0] ?? null,
    text: (r) => labels(r).join(' '),
    filter: { kind: ['has', 'text'], valueOf: (r, _cx, k) => (k === 'has' ? labels(r).length > 0 : labels(r).join(' ')) },
  }
}

export const COLUMN_VALUES: Record<string, Meta> = {
  work: {
    // Key number, then title.
    sortValue: ({ it }) => `${String(keyNumber(it.key) || 0).padStart(9, '0')} ${it.title.toLowerCase()}`,
    ...textMeta(({ it }) => `${it.key} ${it.title} ${it.summary ?? ''}`.trim()),
  },
  status: {
    // Category order, then the status.
    sortValue: ({ it }) => `${known(CATEGORIES.indexOf(statusInfo(it.status).category), CATEGORIES.length)} ${it.status}`,
    text: ({ it }) => statusLabel(it.status),
    filter: {
      kind: 'values',
      valueOf: ({ it }) => it.status,
      values: (rows) => countValues(rows, (r) => [r.it.status], statusLabel),
      // Grouped, the statuses follow the category order, then the status name.
      groupOrder: (a, b) => known(CATEGORIES.indexOf(statusInfo(a).category), CATEGORIES.length) - known(CATEGORIES.indexOf(statusInfo(b).category), CATEGORIES.length) || a.localeCompare(b),
    },
  },
  agents: {
    sortValue: ({ it }) => { const id = agentIdsOf(it)[0]; return id ? agentName(id).toLowerCase() : null },
    text: ({ it }) => agentIdsOf(it).map(agentName).join(' '),
    filter: {
      kind: 'values',
      valueOf: ({ it }) => agentIdsOf(it),
      values: (rows) => countValues(rows, (r) => agentIdsOf(r.it), agentName),
      groupOrder: (a, b) => agentName(a).localeCompare(agentName(b), undefined, { sensitivity: 'base' }) || a.localeCompare(b),
    },
  },
  ...Object.fromEntries((['branch', 'test', 'linear', 'link'] as const).map((k) => [k, linkMeta(k)])),
  github: {
    sortValue: (r, cx) => prStates(r.it, cx.extras.watch)[0] ?? null,
    text: (r) => linksOf(r.it, 'github').map(linkLabel).join(' '),
    filter: {
      kind: ['values', 'has'],
      valueOf: (r, cx, k) => (k === 'has' ? linksOf(r.it, 'github').length > 0 : prStatesLoaded(r.it, cx.extras.watch) ? prStates(r.it, cx.extras.watch) : undefined),
      values: (rows, cx) => countValues(rows, (r) => prStates(r.it, cx.extras.watch), (v) => v, PR_STATES),
    },
  },
  time: {
    sortValue: (r, cx) => activityOf(cx.extras.activity, r.it.key)?.total.working_s ?? null,
    text: (r, cx) => { const a = activityOf(cx.extras.activity, r.it.key); return a ? fmtTimeShare(a.total) : '' },
    filter: { kind: 'range', valueOf: (r, cx) => (cx.extras.activity ? activityOf(cx.extras.activity, r.it.key)?.total.working_s ?? null : undefined) },
  },
  cost: {
    // The cell shows nothing at 0, so it is blank here too.
    sortValue: (r, cx) => costValue(r, cx),
    text: (r, cx) => { const c = costValue(r, cx); return c === null ? '' : fmtUsd(c) },
    filter: { kind: 'range', valueOf: (r, cx) => (cx.extras.costs ? costValue(r, cx) : undefined) },
  },
  window: {
    sortValue: (r, cx) => costOf(cx.extras.costs, r.it.key)?.weekly_percent ?? null,
    text: (r, cx) => fmtWindow(costOf(cx.extras.costs, r.it.key)) ?? '',
    filter: { kind: 'range', valueOf: (r, cx) => (cx.extras.costs ? costOf(cx.extras.costs, r.it.key)?.weekly_percent ?? null : undefined) },
  },
  health: {
    sortValue: ({ it }) => (it.health ? known(HEALTH_ORDER.indexOf(it.health), HEALTH_ORDER.length) : null),
    text: ({ it }) => (it.health ? HEALTH[it.health]?.label ?? it.health : ''),
    filter: {
      kind: 'values',
      valueOf: ({ it }) => it.health ?? BLANK,
      values: (rows) => countValues(rows, (r) => (r.it.health ? [r.it.health] : []), (v) => HEALTH[v]?.label ?? v, Object.keys(HEALTH)),
    },
  },
  review: {
    sortValue: ({ it }) => { const v = verdictOf(it); return v ? known(REVIEW_VERDICTS.indexOf(v), REVIEW_VERDICTS.length) : null },
    text: ({ it }) => reviewOf(branchOf(it)?.meta)?.word ?? '',
    filter: {
      kind: 'values',
      valueOf: ({ it }) => verdictOf(it),
      values: (rows) => countValues(rows, (r) => [verdictOf(r.it)].filter(Boolean), (v) => reviewOf({ review: { verdict: v, by: '', summary: null, at: '' } })?.word ?? v, REVIEW_VERDICTS),
    },
  },
  tests: {
    // Failing first.
    sortValue: ({ it }) => { const v = testStateOf(it); return v ? known(['failed', 'passed'].indexOf(v), 2) : null },
    text: ({ it }) => testsOf(branchOf(it)?.meta)?.word ?? '',
    filter: {
      kind: 'values',
      valueOf: ({ it }) => testStateOf(it),
      values: (rows) => countValues(rows, (r) => [testStateOf(r.it)].filter(Boolean), (v) => (v === 'failed' ? 'Failed' : 'Passed'), ['failed', 'passed']),
    },
  },
  updated: {
    sortValue: ({ it }) => it.updated_at,
    // No search text: the cell shows a relative age that changes with the clock, and the raw ISO time
    // would let "2026" match nearly every row.
    text: () => '',
    filter: { kind: 'date', valueOf: ({ it }) => it.updated_at },
  },
}

function costValue(r: WorkRow, cx: CellContext): number | null {
  const c = costOf(cx.extras.costs, r.it.key)
  return c && c.total.cost_usd > 0 ? c.total.cost_usd : null
}
