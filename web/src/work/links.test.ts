import { describe, expect, it } from 'vitest'
import type { ItsaLink } from '../types'
import { activityOf, costOf, fmtDuration, fmtIssueCost, fmtReviews, fmtTimeShare, fmtWindow, issueCostTitle, githubSubject, isTestLink, linkKind, linkLabel, prState, reviewOf, testsOf, waitColor, waitingKinds, type IssueCosts } from './links'

const link = (over: Partial<ItsaLink>): ItsaLink => ({ n: 1, system: 'link', external_id: null, url: 'https://example.com/x', ...over })

describe('link labels', () => {
  it('labels a GitHub PR URL as PR #N and opens it as a PR', () => {
    const l = link({ system: 'github', external_id: 'stam2#14', url: 'https://github.com/example/stam2/pull/14' })
    expect(linkKind(l)).toBe('github')
    expect(linkLabel(l)).toBe('PR #14')
    expect(githubSubject(l.url)).toBe('github:example/stam2#14')
  })
  it('labels a GitHub issue as #N, with no watch subject for other hosts', () => {
    const l = link({ url: 'https://github.com/example/stam2/issues/9' })
    expect(linkLabel(l)).toBe('#9')
    expect(githubSubject('https://example.com/a/b/pull/1')).toBeNull()
  })
  it('shows a branch link as the branch name', () => {
    const l = link({ system: 'branch', external_id: 'stam/dash-data', url: 'https://github.com/example/stam2/tree/stam/dash-data' })
    expect(linkKind(l)).toBe('branch')
    expect(linkLabel(l)).toBe('stam/dash-data')
  })
  it('shows a test or staging link by its id, else its host', () => {
    const byLabel = link({ external_id: 'staging', url: 'https://app.example.com' })
    const bySystem = link({ system: 'preview', url: 'https://preview.example.com' })
    expect(isTestLink(byLabel)).toBe(true)
    expect(linkLabel(byLabel)).toBe('staging')
    expect(linkLabel(bySystem)).toBe('preview.example.com')
    expect(linkKind(bySystem)).toBe('test')
  })
  it('falls back to the host for other links, and Linear by host', () => {
    expect(linkLabel(link({ url: 'https://www.example.com/itsa-notes' }))).toBe('example.com')
    expect(linkKind(link({ url: 'https://linear.app/team/issue/ST-1' }))).toBe('linear')
  })
})

describe('PR state, review, tests', () => {
  it('reads the most telling PR state word', () => {
    expect(prState({ state: 'merged' })?.word).toBe('merged')
    expect(prState({ state: 'open', draft: true })?.word).toBe('draft')
    expect(prState({ state: 'open', checks: 'failure' })?.word).toBe('checks failing')
    expect(prState({ state: 'open', checks: 'success', review: 'approved' })?.word).toBe('approved')
    expect(prState({ updated_at: null })).toBeNull()
  })
  it('reads the recorded review and tests as severe only when failing', () => {
    expect(reviewOf({ review: { verdict: 'request_changes', by: 'a', summary: null, at: '' } })).toMatchObject({ word: 'changes requested', severe: true })
    expect(reviewOf(null)).toBeNull()
    expect(testsOf({ tests: { passed: 12, failed: 2, skipped: 0, command: null, at: '' } })).toMatchObject({ word: '2 failed of 14', severe: true })
    expect(testsOf({ tests: { passed: 14, failed: 0, skipped: 0, command: null, at: '' } })).toMatchObject({ word: '14 passed', severe: false })
  })
})

describe('cost lookup', () => {
  const report: IssueCosts = {
    note: 'API-equivalent',
    issues: [{ key: 'S-136', own: { cost_usd: 0.4 }, total: { cost_usd: 1.23 }, weekly_percent: 3.2,
      cost: { mode: 'api', own: { api: 0.4, five_hour: null, seven_day: null, subscription: null, paid_usd: 0 }, total: { api: 1.23, five_hour: null, seven_day: null, subscription: null, paid_usd: 0 } } }],
  }
  it('finds an issue by key and formats its total the way the sidebar does', () => {
    const c = costOf(report, 'S-136')!
    expect(fmtIssueCost(c, 'total')).toBe('$1.2')
    expect(issueCostTitle(c)).toBe('own: $0.40 API-equivalent · tree: $1.23 API-equivalent')
    expect(fmtWindow(c)).toBe('3%')
  })
  it('shows the Settings unit, a percent for a window', () => {
    const c = { ...report.issues[0], cost: { mode: 'five_hour' as const, own: { api: null, five_hour: 3.4, seven_day: null, subscription: null, paid_usd: 0 }, total: { api: null, five_hour: 7, seven_day: null, subscription: null, paid_usd: 0 } } }
    expect(fmtIssueCost(c, 'total')).toBe('7%')
    expect(issueCostTitle(c)).toBe('own: 3% of the 5h window · tree: 7% of the 5h window')
  })
  it('returns nothing for an unknown key, a null share, a zero, or a row with no figure in the unit', () => {
    expect(costOf(report, 'S-1')).toBeNull()
    expect(fmtWindow({ ...report.issues[0], weekly_percent: null })).toBeNull()
    expect(fmtIssueCost(null, 'total')).toBe('')
    expect(fmtIssueCost({ ...report.issues[0], cost: null }, 'total')).toBe('–')
    expect(fmtIssueCost({ ...report.issues[0], cost: { ...report.issues[0].cost!, total: { ...report.issues[0].cost!.total, api: 0 } } }, 'total')).toBe('')
    expect(issueCostTitle({ ...report.issues[0], cost: null })).toBeUndefined()
  })
})

describe('ITSA activity (S-226)', () => {
  const split = (over: Partial<import('./links').ActivitySplit> = {}): import('./links').ActivitySplit =>
    ({ working_s: 0, waiting_s: 0, working_by_kind: {}, waiting_by_top: {}, waiting_by_kind: {}, cost_usd: 0, ...over })
  const row = (key: string) => ({ key, category: 'closed', created_at: '2026-10-01T00:00:00Z', closed_at: null, lead_s: null, review_rounds: 0,
    own: split(), total: split(), agents: [] })
  const report = { note: '', since: '', rows: [row('S-1'), row('S-2')] }

  it('finds the activity row for an ITSA key, or null', () => {
    expect(activityOf(report, 'S-2')?.key).toBe('S-2')
    expect(activityOf(report, 'S-9')).toBeNull()
    expect(activityOf(null, 'S-1')).toBeNull()
  })
  it('formats durations in the two largest units', () => {
    expect(fmtDuration(45)).toBe('45s')
    expect(fmtDuration(720)).toBe('12m')
    expect(fmtDuration(3 * 3600 + 5 * 60)).toBe('3h 5m')
    expect(fmtDuration(2 * 86400 + 4 * 3600)).toBe('2d 4h')
    expect(fmtDuration(-3)).toBe('0s')
  })
  it('lists the waiting kinds with time, most first, leaving out zeros', () => {
    const s = split({ waiting_by_top: { human: 30, tool: 0, agent: 90 } })
    expect(waitingKinds(s)).toEqual([['agent', 90], ['human', 30]])
  })
  it('colours a known waiting kind and gives an unknown one the neutral border', () => {
    expect(waitColor('human')).toBe('var(--series-2)')
    expect(waitColor('gap')).toBe('var(--border-strong)')
  })
})

describe('activity cell reads the API row (S-226)', () => {
  // A row as GET /api/activity?by=itsa returns it (src/activity-stats.ts): the split is nested under own and total.
  const apiRow = {
    key: 'S-1', title: 'Check', status: 'in_progress', category: 'active', config: null, type: null,
    created_at: '2026-10-12T20:00:00.000Z', closed_at: null, lead_s: null, review_rounds: 2,
    own: { working_s: 4217, waiting_s: 1460, working_by_kind: { 'tool.test': 4217 }, waiting_by_top: { human: 1460 }, waiting_by_kind: { 'human.reply': 1460 }, cost_usd: 0.5 },
    total: { working_s: 4217, waiting_s: 1460, working_by_kind: { 'tool.test': 4217 }, waiting_by_top: { human: 1460 }, waiting_by_kind: { 'human.reply': 1460 }, cost_usd: 0.5 },
    agents: [{ id: 'a1', name: 'kid', working_s: 4217 }],
  } as import('./links').ItsaActivity

  it('finds the row by key and formats its working time, not zero', () => {
    const report = { note: '', since: '', rows: [apiRow] }
    const a = activityOf(report, 'S-1')!
    expect(a.total.working_s).toBe(4217)
    expect(fmtDuration(a.total.working_s)).toBe('1h 10m')
    expect(waitingKinds(a.total)).toEqual([['human', 1460]])
  })
})

describe('Time cell text (S-226)', () => {
  const t = (working_s: number, waiting_s: number) => ({ working_s, waiting_s, working_by_kind: {}, waiting_by_top: {}, waiting_by_kind: {}, cost_usd: 0 })
  it('shows the total and the working share, and 0s with no time', () => {
    expect(fmtTimeShare(t(1800, 5400))).toBe('2h 0m · 25% working')
    expect(fmtTimeShare(t(0, 0))).toBe('0s')
  })
  it('labels review rounds in the singular and plural', () => {
    expect(fmtReviews(1)).toBe('1 review')
    expect(fmtReviews(2)).toBe('2 reviews')
  })
})
