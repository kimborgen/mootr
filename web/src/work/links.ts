// The Work page's link facts as plain functions: what a link is, how it is labelled, the PR
// state from the watch, the review and tests recorded on a branch link, and an issue's cost.
// No browser imports, so the unit tests run in node.
import { costShort, costTitle } from '../format'
import type { CostMode, CostModes, ItsaLink, LinkMeta } from '../types'

export type LinkKind = 'branch' | 'github' | 'linear' | 'test' | 'link'
// Each kind is its own Work column (S-363), in this order; the column id is the kind.
export const LINK_KINDS: LinkKind[] = ['branch', 'github', 'test', 'linear', 'link']

// A `WatchState` is GET /api/watch/state's answer for one subject (src/watch.ts). Only the
// fields the page reads are typed; an unknown subject answers `{ updated_at: null }`.
export interface WatchState {
  state?: 'open' | 'closed' | 'merged'
  draft?: boolean
  checks?: 'pending' | 'success' | 'failure' | 'none'
  review?: 'approved' | 'changes_requested' | 'none'
  updated_at?: string | null
}

// One issue's row from GET /api/usage/issues (src/issue-costs.ts). `cost` holds the own and total
// in every display unit; `mode` is the Settings unit (cost.display.mode) the Work page shows.
export interface IssueCost {
  key: string
  own: { cost_usd: number }
  total: { cost_usd: number }
  weekly_percent: number | null
  cost?: { mode: CostMode; own: CostModes; total: CostModes } | null
}
export interface IssueCosts { note: string; issues: IssueCost[] }

const TEST = /\b(test|staging|preview)\b/i

function host(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}

// A test link: its system or its label names a test, staging, or preview deploy.
export function isTestLink(link: ItsaLink): boolean {
  return TEST.test(link.system) || TEST.test(link.external_id ?? '')
}

export function linkKind(link: ItsaLink): LinkKind {
  if (link.system === 'branch') return 'branch'
  if (isTestLink(link)) return 'test'
  const h = host(link.url)
  if (link.system === 'github' || h === 'github.com') return 'github'
  if (link.system === 'linear' || h === 'linear.app') return 'linear'
  return 'link'
}

// The repo and number a GitHub PR or issue URL names: `github:OWNER/REPO#N`, or null.
export function githubSubject(url: string): string | null {
  let u: URL
  try { u = new URL(url) } catch { return null }
  if (u.hostname.replace(/^www\./, '') !== 'github.com') return null
  const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:pull|issues)\/(\d+)/)
  return m ? `github:${m[1]}/${m[2]}#${m[3]}` : null
}

// Whether a GitHub URL is a pull request (not an issue): the label says PR.
export const isPull = (url: string) => /\/pull\/\d+/.test(url)

// The short label a link shows: the branch name, `PR #14`, `#14`, a test link's id
// (`staging`), or the host.
export function linkLabel(link: ItsaLink): string {
  const kind = linkKind(link)
  if (kind === 'branch') return link.external_id ?? link.url
  if (kind === 'test' && link.external_id) return link.external_id
  if (kind === 'github') {
    const n = link.url.match(/\/(?:pull|issues)\/(\d+)/)?.[1]
    if (n) return isPull(link.url) ? `PR #${n}` : `#${n}`
  }
  return host(link.url) || link.url
}

// The link's tooltip: its label and its full URL (a branch has no URL of its own).
export function linkTitle(link: ItsaLink): string {
  return linkKind(link) === 'branch' ? `Branch ${link.external_id ?? ''}`.trim() : `${linkLabel(link)} · ${link.url}`
}

// The PR state word from the watch, most telling first: merged, closed, draft, changes asked,
// checks failing, checks running, approved or passing, open. Null without a known state.
export function prState(w: WatchState | undefined): { word: string; tone?: string } | null {
  if (!w?.state) return null
  if (w.state === 'merged') return { word: 'merged', tone: 'var(--status-success-fg)' }
  if (w.state === 'closed') return { word: 'closed' }
  if (w.draft) return { word: 'draft' }
  if (w.review === 'changes_requested') return { word: 'changes asked', tone: 'var(--status-error-fg)' }
  if (w.checks === 'failure') return { word: 'checks failing', tone: 'var(--status-error-fg)' }
  if (w.checks === 'pending') return { word: 'checks running', tone: 'var(--status-warning-fg)' }
  if (w.review === 'approved') return { word: 'approved', tone: 'var(--status-success-fg)' }
  if (w.checks === 'success') return { word: 'checks passing', tone: 'var(--status-success-fg)' }
  return { word: 'open' }
}

const VERDICT: Record<string, { word: string; tone?: string }> = {
  approve: { word: 'approved', tone: 'var(--status-success-fg)' },
  request_changes: { word: 'changes requested', tone: 'var(--status-error-fg)' },
  comment: { word: 'commented', tone: 'var(--status-warning-fg)' },
}

// The review verdict a branch link recorded, or null.
export function reviewOf(meta: LinkMeta | null | undefined): { word: string; tone?: string; severe: boolean } | null {
  const v = meta?.review?.verdict
  if (!v) return null
  const r = VERDICT[v] ?? { word: v }
  return { ...r, severe: v === 'request_changes' }
}

// The tests a branch link recorded: `2 failed of 14` on error, `14 passed` otherwise.
export function testsOf(meta: LinkMeta | null | undefined): { word: string; tone?: string; severe: boolean } | null {
  const t = meta?.tests
  if (!t) return null
  if (t.failed > 0) return { word: `${t.failed} failed of ${t.passed + t.failed}`, tone: 'var(--status-error-fg)', severe: true }
  return { word: `${t.passed} passed`, tone: 'var(--status-success-fg)', severe: false }
}

// An issue's cost row, or null when the report has none for this key.
export function costOf(report: IssueCosts | null | undefined, key: string): IssueCost | null {
  return report?.issues.find((i) => i.key === key) ?? null
}

// An issue's own or total cost in the Settings unit, or null when the report has none.
export function issueCost(c: IssueCost | null | undefined, part: 'own' | 'total'): number | null {
  return c?.cost?.[part][c.cost.mode] ?? null
}

// The cost as the sidebar writes it (costShort): `$1.2`, `14%`. `–` when the report has no figure in
// the unit (as the sidebar does); blank when there is no report row, or it is zero.
export function fmtIssueCost(c: IssueCost | null | undefined, part: 'own' | 'total'): string {
  if (!c) return ''
  const v = issueCost(c, part)
  if (v == null) return costShort(null, 'api')
  return v ? costShort(v, c.cost!.mode) : ''
}

// The cost's tooltip, as the sidebar's costTitle: own, and the tree (the issue with its sub-issues).
export function issueCostTitle(c: IssueCost): string | undefined {
  return c.cost ? costTitle({ mode: c.cost.mode, own: c.cost.own, tree: c.cost.total }, true) : undefined
}

// The window share, `3%`, or null when the share is not known.
export function fmtWindow(c: IssueCost | null): string | null {
  if (!c || c.weekly_percent == null) return null
  return `${Math.round(c.weekly_percent)}%`
}

// One ITSA's activity row from GET /api/activity?by=itsa (src/activity-stats.ts): working and
// waiting seconds, with waiting by top-level kind and by leaf, and the cost. `total` rolls up
// the children; `own` is this ITSA alone.
export interface ActivitySplit {
  working_s: number
  waiting_s: number
  working_by_kind: Record<string, number>
  waiting_by_top: Record<string, number>
  waiting_by_kind: Record<string, number>
  cost_usd: number
}
export interface ItsaActivity {
  key: string
  category: string
  created_at: string
  closed_at: string | null
  lead_s: number | null
  review_rounds: number
  own: ActivitySplit
  total: ActivitySplit
  agents: { id: string; name: string; working_s: number }[]
}
export interface ItsaActivityReport { note: string; since: string; rows: ItsaActivity[] }

// The activity row for one ITSA key, or null when the report has none.
export function activityOf(report: ItsaActivityReport | null | undefined, key: string): ItsaActivity | null {
  return report?.rows.find((r) => r.key === key) ?? null
}

// `45s`, `12m`, `3h 5m`, `2d 4h`: the largest two units of a duration in seconds.
export function fmtDuration(s: number): string {
  const x = Math.max(0, Math.round(s))
  if (x < 60) return `${x}s`
  if (x < 3600) return `${Math.floor(x / 60)}m`
  if (x < 86400) return `${Math.floor(x / 3600)}h ${Math.floor((x % 3600) / 60)}m`
  return `${Math.floor(x / 86400)}d ${Math.floor((x % 86400) / 3600)}h`
}

// The waiting kinds, most time first: `[kind, seconds]` pairs.
export function waitingKinds(split: ActivitySplit, by: 'waiting_by_top' | 'waiting_by_kind' = 'waiting_by_top'): [string, number][] {
  return Object.entries(split[by]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
}

// A waiting kind's segment colour, fixed per kind so a bar reads the same on every row; the
// working time is the accent. An unlisted kind takes the neutral border.
const WAIT_COLOR: Record<string, string> = { human: 'var(--series-2)', agent: 'var(--series-3)', job: 'var(--series-4)', tool: 'var(--series-5)', throttle: 'var(--series-6)' }
export const waitColor = (kind: string) => WAIT_COLOR[kind] ?? 'var(--border-strong)'

// The Time cell's text: the total and the working share, `2h 10m · 15% working`; `0s` when there is no time.
export function fmtTimeShare(t: ActivitySplit): string {
  const all = t.working_s + t.waiting_s
  if (all <= 0) return '0s'
  return `${fmtDuration(all)} · ${Math.round((t.working_s / all) * 100)}% working`
}

// A review-rounds count: `1 review`, `2 reviews`.
export const fmtReviews = (n: number) => `${n} ${n === 1 ? 'review' : 'reviews'}`
