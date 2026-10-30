// The Work page's columns, as data: the table draws whatever this list holds, in its order,
// so showing, hiding, ordering, and sizing columns (and adding new ones) never touch the
// table. A column's `width` is a CSS grid track. A phone shows Glance.tsx instead of columns.
import type { ReactNode } from 'react'
import { selectAgent } from '../actions'
import { Glyph } from '../Glyph'
import { RestBadge } from '../waits'
import { Icon, type IconName } from '../Icon'
import { HEALTH, StatusGlyph, statusInfo, statusLabel, toneOf, toneVar } from '../itsa/itsa'
import { TONE_CLASS, type FieldTone } from '../itsa/fields'
import { byId, getData } from '../store'
import { agentIdsOf, since, type WorkRow } from './model'
import { pausedEpic, PAUSED_STATUS, PAUSED_TITLE } from './paused'
import { activityOf, costOf, fmtDuration, fmtIssueCost, fmtReviews, fmtTimeShare, fmtWindow, githubSubject, issueCostTitle, LINK_KINDS, linkKind, linkLabel, linkTitle, prState, reviewOf, testsOf, waitColor, waitingKinds, type ItsaActivity, type IssueCost, type WatchState, type LinkKind } from './links'
import type { WorkExtras } from './data'
import type { Agent, CostMode, Itsa, ItsaLink } from '../types'
import { prUrlTarget, useDiffRepos } from '../diff/diffRepos'
import { openDiff } from '../files/open'
import { takePress } from './press-flag'
import { showPopover } from '../ui/menu'
import { COLUMN_VALUES } from './column-values'
import type { SortFilterCol } from './sortfilter'
import type { CardCtx, CardSpec } from './card-items'
import { ownCost } from '../system/SystemCard'
import { costShort } from '../format'

export interface CellContext { now: number; extras: WorkExtras }

// Below this pane width (px) the Work page shows cards instead of the table: the pane is measured,
// not the window, so a sidebar or a split narrows it too.
export const CARD_BELOW = 900
// A column also says what its value is for sorting, filtering and searching (SortFilterCol).
export interface WorkColumn extends SortFilterCol {
  id: string
  label: string
  // Shown as the header's tooltip: what the column's numbers are. A cost column's depends on the unit.
  hint?: string | ((mode: CostMode) => string)
  // A grid track on the space tokens, such as `minmax(calc(var(--space-12) * 5), 3fr)`.
  width: string
  align?: 'start' | 'end'
  // Hidden (and its track dropped) when the window is narrower than this many px.
  hideBelow?: number
  render: (row: WorkRow, cx: CellContext) => ReactNode
  // The item's form on an issue card or an agent card (card-items.tsx).
  card: CardSpec
}

// The status a cell shows: a paused epic (paused.ts) as waiting, with a title that says why; else the stored one.
function shownStatus(it: Itsa, now: number): { status: string; title?: string } {
  const owner = it.owner ? byId(it.owner) : undefined
  return pausedEpic(it, getData().itsas, owner, now, (s) => statusInfo(s).category) ? { status: PAUSED_STATUS, title: PAUSED_TITLE } : { status: it.status }
}

export const agentsOf = (row: WorkRow) => agentIdsOf(row.it).map(byId).filter((a) => !!a)

const AGENTS_INLINE = 2
// `list` is the row's agents already resolved (the phone's glance passes them from its index).
export function Agents({ row, list }: { row: WorkRow; list?: Agent[] }) {
  const agents = list ?? agentsOf(row)
  if (!agents.length) return <span className="muted" aria-label="No agents">–</span>
  const rest = agents.slice(AGENTS_INLINE)
  return <span className="w-agents" data-cell="agents">{agents.slice(0, AGENTS_INLINE).map((a) => (
    <button key={a.id} type="button" className="w-agent" data-agent={a.id} title={`Open ${a.name}`}
      onClick={(e) => { e.stopPropagation(); selectAgent(a.id) }}><Glyph agent={a} /><span>{a.name}</span>{a.resting ? <RestBadge a={a} mode="compact" /> : null}</button>))}
    {rest.length ? <span className="w-link-more" title={rest.map((a) => a.name).join(', ')}>+{rest.length}</span> : null}</span>
}

const LINK_ICON: Record<LinkKind, IconName> = { branch: 'git-branch', github: 'git-pull-request', linear: 'kanban', test: 'flask-conical', link: 'link' }
const INLINE_LINKS = 2
// The cost column's tooltip, in the unit the cost is shown in (cost.display.mode).
const costHint = (m: CostMode): string => ({
  api: 'Claude and Codex dollars are API-equivalent estimates, not what a subscription bills.',
  subscription: 'Subscription dollars: the Claude and Codex estimates of what this work cost the plan.',
  five_hour: 'An estimate: the share of the current 5-hour subscription window this work used.',
  seven_day: 'An estimate: the share of the current 7-day subscription window this work used.',
})[m]
// The mode a cost cell shows: an agent's, or the issue's from the costs report.
const modeOf = ({ it, agent, cx }: CardCtx): CostMode => (agent ? agent.cost?.mode : it ? costOf(cx.extras.costs, it.key)?.cost?.mode : undefined) ?? 'api'
const WINDOW_HINT = 'An estimate: the issue’s share of the 7-day subscription window.'
const TIME_HINT = 'Working and waiting time over the ITSA and its children, from the activity timeline. Tap for the split.'

// The Time cell: a bar of working (accent) and waiting by kind, the roll-up working time, and
// the review rounds when there are any. Tapping opens the split as a popover.
function TimeCell({ a, c }: { a: ItsaActivity; c: IssueCost | null }) {
  const t = a.total
  const all = t.working_s + t.waiting_s
  const pct = (n: number) => `${(n / all) * 100}%`
  const kinds = waitingKinds(t)
  const detail = <TimeDetail a={a} c={c} />
  return <button type="button" className="w-time-cell" title={`${TIME_HINT} Working ${fmtDuration(t.working_s)}, waiting ${fmtDuration(t.waiting_s)}.`}
    onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); showPopover(r.left, r.bottom + 4, `${a.key} time`, detail, e.currentTarget) }}>
    {all > 0 ? <span className="w-bar" aria-hidden="true"><i style={{ width: pct(t.working_s), background: 'var(--accent)' }} />
      {kinds.map(([k, v]) => <i key={k} style={{ width: pct(v), background: waitColor(k) }} />)}</span> : null}
    <span className="w-time-work">{fmtTimeShare(t)}</span>
    {a.review_rounds > 0 ? <span className="w-rounds" title={`${fmtReviews(a.review_rounds)} (review rounds)`}>{fmtReviews(a.review_rounds)}</span> : null}
  </button>
}

// The popover's split: working and waiting, waiting by kind with its swatch, and the cost.
// The cost with its period, when it is a dollar figure over the 7 days the costs report covers.
// A window share is of the current window, not a period, and a dash has no period.
const costLine = (c: IssueCost | null): string => {
  const t = fmtIssueCost(c, 'total')
  const dollars = c?.cost?.mode === 'api' || c?.cost?.mode === 'subscription'
  return t && t !== '–' ? `${t}${dollars ? ' over 7 days' : ''} · ` : ''
}

function TimeDetail({ a, c }: { a: ItsaActivity; c: IssueCost | null }) {
  const t = a.total
  return <div className="w-time-detail">
    <p><b>Working</b> {fmtDuration(t.working_s)} <span className="muted">· own {fmtDuration(a.own.working_s)}</span></p>
    <p><b>Waiting</b> {fmtDuration(t.waiting_s)} <span className="muted">· own {fmtDuration(a.own.waiting_s)}</span></p>
    <ul className="w-time-kinds">{waitingKinds(t).map(([k, v]) => <li key={k}><i style={{ background: waitColor(k) }} aria-hidden="true" />{k} <span className="muted">{fmtDuration(v)}</span></li>)}</ul>
    <p className="muted">{costLine(c)}{a.review_rounds} review {a.review_rounds === 1 ? 'round' : 'rounds'}</p>
  </div>
}

// The branch link, with its recorded facts; review and tests read from it.
const branchOf = (row: WorkRow): ItsaLink | undefined => row.it.links?.find((l) => linkKind(l) === 'branch')

// One PR's state word, read from the watch when the link is a GitHub PR or issue.
function prWord(l: ItsaLink, watch: Record<string, WatchState>): ReactNode {
  const subject = githubSubject(l.url)
  const st = subject ? prState(watch[subject]) : null
  if (!st) return null
  return <span className="w-pr" style={st.tone ? { color: st.tone } : undefined}>{st.word}</span>
}

// One link: its kind's icon and its label, opening in a new tab; a branch has no URL of its
// own, so it is only named. The table and the phone's glance both draw links with it.
// `cell` is the column id a card's long-press filters by (S-1518).
// A PR of a repo the diff API serves opens its diff view on a plain click or tap (S-1533); the GitHub page stays one
// modifier-click away (Ctrl, Cmd or Shift, or the middle button) and in the cell menu (right-click, or a long-press on the phone).
// `iconOnly` draws the kind's icon alone (a phone card's links, named by the long-press menu and the label for a screen reader).
export function LinkChip({ l, className, cell, iconOnly }: { l: ItsaLink; className: string; cell?: string; iconOnly?: boolean }) {
  const kind = linkKind(l)
  const repos = useDiffRepos()
  const diff = kind === 'github' ? prUrlTarget(repos, l.url) : null
  const body = <><Icon name={LINK_ICON[kind]} size="xs" />{iconOnly ? null : <span className="w-link-label">{linkLabel(l)}</span>}</>
  const name = iconOnly ? linkLabel(l) : undefined
  return kind === 'branch'
    ? <span className={className} title={linkTitle(l)} aria-label={name} data-cell={cell}>{body}</span>
    : <a className={className} aria-label={name} href={l.url} target="_blank" rel="noreferrer noopener" title={diff ? `${linkTitle(l)}\nOpens the diff; Ctrl-click for GitHub` : linkTitle(l)} data-link={l.n} data-cell={cell}
        data-diff={diff ? `${diff.repo}#${diff.pr}` : undefined}
        onClick={(e) => {
          e.stopPropagation()
          // The finger lifting after a long-press that opened the cell menu: the click must not open the link under it.
          if (takePress()) { e.preventDefault(); return }
          if (diff && e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) { e.preventDefault(); openDiff(diff.repo, diff.pr) }
        }}>{body}</a>
}

// One kind of link, each kind in its own column, and past two, +N with the rest in its tooltip.
function Links({ row, kind, cx }: { row: WorkRow; kind: LinkKind; cx: CellContext }) {
  const all = (row.it.links ?? []).filter((l) => linkKind(l) === kind)
  if (!all.length) return null
  const shown = all.slice(0, INLINE_LINKS)
  const rest = all.slice(INLINE_LINKS)
  return <span className="w-links">{shown.map((l) => (
    <span key={l.n} className={`w-link k-${kind}`}><LinkChip l={l} className="w-link-body" />{prWord(l, cx.extras.watch)}</span>))}{rest.length ? <span className="w-link-more" title={rest.map(linkTitle).join('\n')}>+{rest.length}</span> : null}</span>
}

// The link columns, one per kind; the column id is the kind and LINK_KINDS orders them. The
// branch and its PR stay on a narrow table; the rest drop out first.
const LINK_COLUMNS: Record<LinkKind, Omit<WorkColumn, 'id' | 'render' | 'card'>> = {
  branch: { label: 'Branch', width: 'minmax(calc(var(--space-12) * 2), 1fr)', hideBelow: 948 },
  github: { label: 'GitHub', width: 'calc(var(--space-12) * 2 + var(--space-4))', hideBelow: 948 },
  test: { label: 'Test env', width: 'minmax(calc(var(--space-12) * 2), 1fr)', hideBelow: 1060 },
  linear: { label: 'Linear', width: 'calc(var(--space-12) * 2)', hideBelow: 1240 },
  link: { label: 'Other links', width: 'minmax(calc(var(--space-12) * 2), 1fr)', hideBelow: 1240 },
}

const rowOf = (it: WorkRow['it']): WorkRow => ({ it, depth: 0, context: false })

// A badge in a card's BADGES slot: the `.badge` class, with a tone's colour when it has one.
export const badge = (node: ReactNode, title?: string, tone = '') => <span className={('badge ' + tone).trim()} title={title}>{node}</span>

// The badge tone (TONE_CLASS) of each value a chip shows: a status by its tone, health, a review
// verdict, and a test run. A tone a value has none for draws the neutral badge.
const STATUS_TONE: Record<string, FieldTone> = { waiting: 'warn', active: 'accent', review: 'accent', done: 'ok' }
const HEALTH_TONE: Record<string, FieldTone> = { on_track: 'ok', at_risk: 'warn', off_track: 'bad' }
const VERDICT_TONE: Record<string, FieldTone> = { approve: 'ok', request_changes: 'bad', comment: 'warn' }
const toneClass = (tone: FieldTone | undefined): string => (tone ? TONE_CLASS[tone] : '')

// A link kind's card form: on an issue card, its links as icons (the board's META line), and as a badge in BADGES.
const linkCard = (kind: LinkKind): CardSpec => ({
  where: ['issue'],
  inline: ({ it, touch }) => {
    const all = it ? (it.links ?? []).filter((l) => linkKind(l) === kind) : []
    if (!all.length) return null
    // On the phone's card a link is the table's chip with the icon only: a branch is only named, a PR tap opens the diff, and a
    // long-press opens the cell menu, which names the link (S-1533, S-3560).
    if (touch) return <span className="bc-links">{all.map((l) => <LinkChip key={l.n} l={l} className="bc-link" cell={kind} iconOnly />)}</span>
    return <span className="bc-links">{all.map((l) => (
      <a key={l.n} href={l.url} target="_blank" rel="noreferrer noopener" title={linkTitle(l)} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}><Icon name={LINK_ICON[kind]} size="xs" /></a>))}</span>
  },
  // A badge with the kind's icon, its first link's label, and +N for the rest.
  chip: ({ it }) => {
    const all = it ? (it.links ?? []).filter((l) => linkKind(l) === kind) : []
    if (!all.length) return null
    return badge(<><Icon name={LINK_ICON[kind]} size="xs" />{linkLabel(all[0])}{all.length > 1 ? ` +${all.length - 1}` : ''}</>, all.map(linkTitle).join('\n'))
  },
})

// The cost an issue card or an agent card shows: the issue's cost, or on an agent card the agent's own.
// Nothing when it is zero or unknown.
const costText = ({ it, agent, cx }: CardCtx): string | null => {
  if (agent) {
    const v = ownCost(agent)
    return v == null ? null : costShort(v, agent.cost?.mode ?? 'api')
  }
  const c = it ? costOf(cx.extras.costs, it.key) : null
  return fmtIssueCost(c, 'total') || null
}

// The Work page shows; it doesn't act (S-363): no column holds a button that changes anything.
// A row opens its ITSA, an agent opens the agent, and a link opens in a new tab.
export const WORK_COLUMNS: WorkColumn[] = ([
  {
    id: 'work', label: 'Work', width: 'minmax(calc(var(--space-12) * 5), 3fr)',
    card: {
      where: ['issue'], locked: true,
      inline: ({ it }) => (it ? <span className="w-line"><span className="ikey">{it.key}</span><span className="w-title" title={it.title}>{it.title}</span></span> : null),
    },
    render: ({ it }) => (<>
      <span className="w-line"><span className="ikey">{it.key}</span><span className="w-title" title={it.title}>{it.title}</span></span>
      {it.summary ? <span className="w-summary">{it.summary}</span> : null}
    </>),
  },
  {
    id: 'status', label: 'Status', width: 'minmax(calc(var(--space-12) * 2 + var(--space-8)), 1fr)',
    card: {
      where: ['issue'],
      inline: ({ it, cx }) => { if (!it) return null; const s = shownStatus(it, cx.now); return <span className="bc-status" style={{ color: toneVar(s.status) }} title={s.title} data-paused={s.title ? '' : undefined}><StatusGlyph status={s.status} />{statusLabel(s.status)}</span> },
      chip: ({ it, cx }) => { if (!it) return null; const s = shownStatus(it, cx.now); return badge(statusLabel(s.status), s.title, toneClass(STATUS_TONE[toneOf(statusInfo(s.status))])) },
    },
    render: ({ it }, cx) => { const s = shownStatus(it, cx.now); return <span className="w-status" style={{ color: toneVar(s.status) }} title={s.title} data-paused={s.title ? '' : undefined}><StatusGlyph status={s.status} />{statusLabel(s.status)}</span> },
  },
  {
    id: 'agents', label: 'Agents', width: 'minmax(calc(var(--space-12) * 2), 1.5fr)',
    card: {
      where: ['issue'],
      inline: ({ it }) => (it ? <Agents row={rowOf(it)} /> : null),
      chip: ({ it }) => {
        const n = it ? agentsOf(rowOf(it)).length : 0
        return n ? badge(`${n} ${n === 1 ? 'agent' : 'agents'}`, 'Agents on this ITSA') : null
      },
    },
    render: (row) => <Agents row={row} />,
  },
  ...LINK_KINDS.map((kind): WorkColumn => ({ id: kind, ...LINK_COLUMNS[kind], card: linkCard(kind), render: (row, cx) => <Links row={row} kind={kind} cx={cx} /> })),
  {
    id: 'time', label: 'Time', hint: TIME_HINT, width: 'calc(var(--space-12) * 4 + var(--space-4))', hideBelow: 1400,
    card: {
      where: ['issue'],
      inline: ({ it, cx }) => { const a = it ? activityOf(cx.extras.activity, it.key) : null; return a ? <span className="muted">{fmtTimeShare(a.total)}</span> : null },
      chip: ({ it, cx }) => { const a = it ? activityOf(cx.extras.activity, it.key) : null; return a ? badge(fmtTimeShare(a.total), TIME_HINT) : null },
    },
    render: ({ it }, cx) => { const a = activityOf(cx.extras.activity, it.key); return a ? <TimeCell a={a} c={costOf(cx.extras.costs, it.key)} /> : null },
  },
  {
    id: 'cost', label: 'Cost', hint: costHint, width: 'calc(var(--space-12) + var(--space-2))', align: 'end',
    // On an agent card the same item shows the agent's own cost (costText).
    card: {
      where: ['issue', 'agent'],
      inline: (c) => { const t = costText(c); return t ? <span className="w-cost">{t}</span> : null },
      chip: (c) => { const t = costText(c); return t ? badge(t, costHint(modeOf(c))) : null },
    },
    render: ({ it }, cx) => {
      const c = costOf(cx.extras.costs, it.key)
      const t = c ? fmtIssueCost(c, 'total') : ''
      if (!c || !t) return null
      return <span className="w-cost" title={issueCostTitle(c)}>{t}</span>
    },
  },
  {
    id: 'window', label: 'Window', hint: WINDOW_HINT, width: 'calc(var(--space-12))', align: 'end', hideBelow: 1320,
    card: {
      where: ['issue'],
      inline: ({ it, cx }) => { const w = it ? fmtWindow(costOf(cx.extras.costs, it.key)) : null; return w ? <span className="muted">{w}</span> : null },
      chip: ({ it, cx }) => { const w = it ? fmtWindow(costOf(cx.extras.costs, it.key)) : null; return w ? badge(w, WINDOW_HINT) : null },
    },
    render: ({ it }, cx) => {
      const w = fmtWindow(costOf(cx.extras.costs, it.key))
      return w ? <span className="w-window" title={WINDOW_HINT}>{w}</span> : null
    },
  },
  {
    id: 'health', label: 'Health', width: 'calc(var(--space-12) + var(--space-6))', hideBelow: 1116,
    card: {
      where: ['issue', 'agent'],
      // A dot on the card's TOP line, with the label as its name; the chip keeps the words.
      inline: ({ it }) => { const h = it?.health ? HEALTH[it.health] : null; return h ? <span className="hdot" style={{ color: h.tone }} title={`${h.label}, from the owner's latest update`} role="img" aria-label={h.label}><i /></span> : null },
      chip: ({ it }) => { const h = it?.health ? HEALTH[it.health] : null; return h ? badge(h.label, undefined, toneClass(HEALTH_TONE[it?.health ?? ''])) : null },
    },
    render: ({ it }) => {
      const h = it.health ? HEALTH[it.health] : null
      return h ? <span className="w-health" style={{ color: h.tone }}><span className="w-dot" aria-hidden="true" />{h.label}</span> : null
    },
  },
  {
    id: 'review', label: 'Review', width: 'calc(var(--space-12) + var(--space-3))', hideBelow: 1260,
    card: {
      where: ['issue', 'agent'],
      inline: ({ it }) => { const r = it ? reviewOf(branchOf(rowOf(it))?.meta) : null; return r ? <span className="w-review" style={r.tone ? { color: r.tone } : undefined}>{r.word}</span> : null },
      chip: ({ it }) => {
        const meta = it ? branchOf(rowOf(it))?.meta : null
        const r = reviewOf(meta)
        return r ? badge(r.word, undefined, toneClass(VERDICT_TONE[meta?.review?.verdict ?? ''])) : null
      },
    },
    render: (row) => {
      const r = reviewOf(branchOf(row)?.meta)
      return r ? <span className="w-review" style={r.tone ? { color: r.tone } : undefined}>{r.word}</span> : null
    },
  },
  {
    id: 'tests', label: 'Tests', width: 'calc(var(--space-12) + var(--space-3))', hideBelow: 1190,
    card: {
      where: ['issue', 'agent'],
      inline: ({ it }) => { const t = it ? testsOf(branchOf(rowOf(it))?.meta) : null; return t ? <span className="w-tests" style={t.tone ? { color: t.tone } : undefined}>{t.word}</span> : null },
      chip: ({ it }) => { const t = it ? testsOf(branchOf(rowOf(it))?.meta) : null; return t ? badge(t.word, undefined, toneClass(t.severe ? 'bad' : 'ok')) : null },
    },
    render: (row) => {
      const t = testsOf(branchOf(row)?.meta)
      return t ? <span className="w-tests" style={t.tone ? { color: t.tone } : undefined}>{t.word}</span> : null
    },
  },
  {
    id: 'updated', label: 'Updated', width: 'calc(var(--space-12) + var(--space-6))', align: 'end', hideBelow: 1032,
    card: {
      where: ['issue'],
      inline: ({ it, cx }) => (it ? <time className="w-time" dateTime={it.updated_at} title={new Date(it.updated_at).toLocaleString()}>{since(it.updated_at, cx.now)}</time> : null),
      chip: ({ it, cx }) => (it ? badge(since(it.updated_at, cx.now), new Date(it.updated_at).toLocaleString()) : null),
    },
    render: ({ it }, { now }) => <time className="w-time" dateTime={it.updated_at} title={new Date(it.updated_at).toLocaleString()}>{since(it.updated_at, now)}</time>,
  },
] as WorkColumn[]).map((c) => ({ ...c, ...COLUMN_VALUES[c.id] }))
