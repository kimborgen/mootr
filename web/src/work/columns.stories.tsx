import type { CSSProperties } from 'react'
import { link as makeLink, itsa, TREE } from '../stories/itsaFixtures'
import { AGENTS } from '../stories/fixtures'
import { ACTIVITY, COSTS } from '../stories/workFixtures'
import { OnMount, Row } from '../stories/helpers'
import { ds, type Story } from '../stories/types'
import type { Itsa } from '../types'
import { resetDiffRepos } from '../diff/diffRepos'
import { Agents, LinkChip, WORK_COLUMNS, type CellContext } from './columns'
import type { WatchState } from './links'

const ago = (min: number) => new Date(Date.now() - min * 60000).toISOString()
const pr = (n: number, num: number) => makeLink(n, 'github', `fixture/repo#${num}`, `https://github.com/fixture/repo/pull/${num}`)
const watchKey = (num: number) => `github:fixture/repo#${num}`
const W: Record<string, WatchState> = {
  [watchKey(311)]: { state: 'open', checks: 'pending' }, [watchKey(312)]: { state: 'open', checks: 'success', review: 'approved' },
  [watchKey(313)]: { state: 'merged' }, [watchKey(314)]: { state: 'closed' }, [watchKey(315)]: { state: 'open', draft: true },
  [watchKey(316)]: { state: 'open', review: 'changes_requested' }, [watchKey(317)]: { state: 'open', checks: 'failure' },
  [watchKey(318)]: { state: 'open', checks: 'success' }, [watchKey(319)]: { state: 'open' },
}
const cx: CellContext = { now: Date.now(), extras: { costs: COSTS, activity: ACTIVITY, watch: W, fields: null, fieldsFailed: false, fieldsStart: 0 } }
// One ITSA with a link of every kind, a review, tests, a cost, and activity: S-911 in the costs and activity fixtures.
const FULL: Itsa = {
  ...TREE.find((x) => x.id === 'fx-i-911')!, summary: 'Replace the three index files with one segment store.', health: 'at_risk', owner: 'fx-dev', participants: ['fx-review', 'human'],
  links: [
    makeLink(1, 'branch', 'fixture/index-builder', 'https://example.com/fixture/repo/tree/fixture/index-builder', { repo: 'fixture/repo', review: { verdict: 'approve', by: 'fixture-review', summary: null, at: ago(20) }, tests: { passed: 212, failed: 0, skipped: 1, command: 'npm test', at: ago(25) } }),
    pr(2, 311), pr(3, 312), pr(4, 313),
    makeLink(5, 'preview', 'staging', 'https://staging.example.com/fixture'),
    makeLink(6, 'linear', 'FIX-12', 'https://linear.app/fixture/issue/FIX-12'),
    makeLink(7, 'url', null, 'https://docs.example.com/fixture/index'),
  ],
}
const row = (it: Itsa) => ({ it, depth: 0, context: false })
const cell = (id: string, it: Itsa = FULL) => WORK_COLUMNS.find((c) => c.id === id)!.render(row(it), cx)
const withLinks = (links: Itsa['links']): Itsa => ({ ...FULL, links })
const agentsOf = (...ids: string[]) => AGENTS.filter((a) => ids.includes(a.id))
const dl: CSSProperties = { display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: 'var(--space-2) var(--space-4)', alignItems: 'center', margin: 0, padding: 'var(--space-4)' }
const list = (items: [string, React.ReactNode][]) => <dl style={dl}>{items.flatMap(([k, v], i) => [<dt key={'k' + i} className="muted">{k}</dt>, <dd key={'v' + i} style={{ margin: 0, minWidth: 0 }}>{v}</dd>])}</dl>
const popTime = (el: HTMLElement) => el.querySelector<HTMLElement>('.w-time-cell')?.click()

export const stories: Story[] = [{
  name: 'Work table cells',
  group: 'ITSA and work',
  what: 'What each column of the Work table draws for one ITSA. The columns are data (`WORK_COLUMNS`): the table draws whichever the layout shows, in its order. Work (key, title, summary), Status, Agents, one column for each kind of link (Branch, GitHub, Test env, Linear, Other links), Time, Cost, Window, Health, Review, Tests, and Updated. Nothing in a cell changes anything: it opens something.',
  when: 'In every row of the Work table (`w:work`) at 900 px and wider, and in the Needs-you group above it. The agents and links also appear on the glance\'s cards.',
  code: ['web/src/work/columns.tsx#WORK_COLUMNS', 'web/src/work/columns.tsx#Agents', 'web/src/work/columns.tsx#LinkChip'],
  rules: [
    'Agents shows the first two as mark and name, each a button that opens the agent, then "+N" with the rest named in its title; none shows a muted dash. The mark is the agent mark, so its ring carries the state.',
    'Links are split by kind, each its own column, two inline then "+N". A link is an icon and a label: a branch\'s name (a branch has no URL, so it is not a link), "PR #14" or "#14" for GitHub, a test or preview link\'s id, else the host. A test link is one whose system or id names test, staging, or preview. A PR adds a word from the watch, most telling first: merged, closed, draft, changes asked, checks failing, checks running, approved, checks passing, open.',
    'A PR of a repo the diff API serves (S-1533) opens the diff view in a pane on a click or tap, and its title says so; the GitHub page stays one Ctrl-, Cmd- or Shift-click away, and in the cell menu (a right-click on the cell, a long-press on a phone card\'s chip) beside "View diff". Any other PR, an issue or another link opens its URL in a new tab as before. The chip keeps its size, so the row does not move when the served repos arrive.',
    'Review reads the branch link\'s recorded verdict (approved, changes requested, commented) and Tests its result ("212 passed", or "2 failed of 14" in the error tone); the words carry the meaning, and the tone is only a second channel (' + ds('State vocabulary') + ').',
    'Time is a bar of working time (`--accent`) and waiting time by kind, then the share working and the review rounds; a tap opens the split. Waiting kinds keep a fixed colour: human `--series-2`, agent `--series-3`, job `--series-4`, tool `--series-5`, throttle `--series-6`, any other `--border-strong`.',
    'Cost is the issue and its sub-issues in API-equivalent dollars (a sub-cent amount reads "<$0.01"), Window the issue\'s share of the 7-day subscription window; both are estimates and their headers say so.',
    'Health is a dot and a word in the success, warning, or error tone; Updated is the age, with the date in its title (' + ds('Tables, tree, and empty states') + ').',
  ],
  states: [
    { name: 'Every column, one ITSA', render: () => list(WORK_COLUMNS.map((c) => [c.label + (c.hideBelow ? ` (from ${c.hideBelow} px)` : ''), c.render(row(FULL), cx)])) },
    { name: 'Agents: none, one, two, and four', render: () => (
      <Row items={[
        { label: 'none', node: <Agents row={row(FULL)} list={[]} /> },
        { label: 'one', node: <Agents row={row(FULL)} list={agentsOf('fx-dev')} /> },
        { label: 'two', node: <Agents row={row(FULL)} list={agentsOf('fx-dev', 'fx-review')} /> },
        { label: 'four, two more named in the title', node: <Agents row={row(FULL)} list={agentsOf('fx-dev', 'fx-review', 'fx-ops', 'fx-wait')} /> },
      ]} />) },
    { name: 'Each kind of link', render: () => (
      <Row items={FULL.links!.map((l) => ({ label: l.system, node: <LinkChip l={l} className="w-link-body" /> }))} />) },
    { name: 'A PR in each state', render: () => list([311, 312, 313, 314, 315, 316, 317, 318, 319].map((n) => [`#${n}`, cell('github', withLinks([pr(1, n)]))])) },
    { name: 'A PR that opens the diff', setup: () => resetDiffRepos([{ name: 'fixture', github: 'fixture/repo' }], true), render: () => list([['served repo: click opens the diff', cell('github', withLinks([pr(1, 312)]))], ['other repo: GitHub', cell('github', withLinks([makeLink(1, 'github', 'other/repo#5', 'https://github.com/other/repo/pull/5')]))]]) },
    { name: 'Review and tests', render: () => list([['approved, passing', 'approve', 212, 0], ['changes requested, failing', 'request_changes', 12, 2], ['commented', 'comment', 40, 0]].map(([label, verdict, passed, failed]) => {
      const it = withLinks([makeLink(1, 'branch', 'fixture/b', 'https://example.com/b', { review: { verdict: verdict as string, by: 'fixture-review', summary: null, at: ago(5) }, tests: { passed: passed as number, failed: failed as number, skipped: 0, command: null, at: ago(5) } })])
      return [label as string, <span style={{ display: 'flex', gap: 'var(--space-4)' }}>{cell('review', it)}{cell('tests', it)}</span>]
    })) },
    { name: 'Time, opened', height: 320, render: () => <OnMount run={popTime}><div style={{ width: 'calc(var(--space-12) * 4 + var(--space-4))' }}>{cell('time')}</div></OnMount> },
    { name: 'Nothing known: empty cells', render: () => list(WORK_COLUMNS.filter((c) => !['work', 'status', 'updated'].includes(c.id)).map((c) => [c.label, c.render(row(itsa(997, null, 'Fixture bare ITSA', 'backlog', { owner: null })), cx) ?? <span className="muted">(empty)</span>])) },
  ],
}]
