import { defaultCardLayout, type CardLayout } from '../card-layout'
import { TREE, itsaData } from '../stories/itsaFixtures'
import { ACTIVITY, COSTS } from '../stories/workFixtures'
import { ds, type Story } from '../stories/types'
import type { WorkExtras } from '../work/data'
import { IssueCard, cardItemMap, type IssueCardState } from './IssueCard'

// A card in a board column, at the width a board column gives it.
const extras: WorkExtras = { costs: COSTS, activity: ACTIVITY, watch: {}, fields: null, fieldsFailed: false, fieldsStart: 0 }
const cx = { now: Date.parse('2026-10-20T12:00:00Z'), extras }
const state: IssueCardState = { column: 'active', mode: 'category', parentKey: null, dragging: false, items: cardItemMap([]), fields: [], cx }
const actions = { onOpen: () => {}, onPointerDown: () => {}, onKeyDown: () => {}, onMenu: () => {} }
const card = (layout: CardLayout, s: IssueCardState = state) => (
  <div style={{ width: 280 }}>
    <IssueCard itsa={TREE[0]} layout={layout} size="board" state={s} actions={actions} />
  </div>
)
// The nested card inside an agent card's ISSUE row: its width is the agent card's inner width (216 px less the padding).
const nested = (layout: CardLayout, s: IssueCardState = state) => (
  <div style={{ width: 'var(--size-card)', padding: 'var(--space-2)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-sm)', background: 'var(--surface-page)' }}>
    <IssueCard itsa={TREE[0]} layout={layout} size="nested" state={s} actions={actions} />
  </div>
)

export const stories: Story[] = [{
  name: 'Issue card',
  group: 'ITSA and work',
  what: 'The issue card: one ITSA on a board. Its key and title are fixed; its TOP, META, BADGES and FOOT slots take the items the issue card layout (cardLayouts.issue) gives them, in order. A slot the layout leaves empty takes no height. The needs-you mark and the ⋯ menu are drawn in every layout.',
  when: 'On a board (the `board:ID` tab, or the all-issues board), one card per ITSA in its column. In a system-view agent card (its `nested` size) it is the ITSA\'s rows, with no box of its own: the status, key and title, then the BADGES and FOOT rows the layout gives (S-1438 PR 4).',
  code: ['web/src/itsa/IssueCard.tsx#IssueCard', 'web/src/card-layout.ts#defaultCardLayout'],
  rules: [
    'The phone Work page\'s Glance draws this same `board` card from the same layout, read-only: with no move action the card has no ⋯ button and no hold menu (a long-press on a value opens the Work cell menu instead), and each item sits in a `data-cell` span for that menu. A link there is the table chip as an icon (a PR tap opens the diff, a long-press names it in the menu), in a 44 px square.',
    'A card is a `--surface-page` box with a `--border-subtle` hairline and `--radius-sm`; hover takes `--border-default`, and the ⋯ menu shows on hover.',
    'The title is `--type-chrome-md`, clamped to the layout\'s title lines (one to three). A closed ITSA\'s title is `--text-secondary`.',
    'The health dot, the needs-you mark and the owner sit at the right end of their row: a spacer goes before the first of them, so they push right as the board always drew them.',
    'A badge in BADGES uses the badge spec; an item in META or FOOT is inline text, or a dot and icon with its label for screen readers, so no state is colour alone (' + ds('State vocabulary') + ').',
    'On a phone (360-430 px) the card is full width, and a long press opens its menu; the ⋯ button is `--size-hit-touch` square.',
  ],
  states: [
    { name: 'Default layout: status in META', data: itsaData(TREE), render: () => card(defaultCardLayout('issue')) },
    { name: 'Status moved to BADGES, title on one line', data: itsaData(TREE), render: () => card({ slots: { TOP: ['parent', 'kind', 'health'], META: ['rollup', 'links', 'owner'], BADGES: ['status'], FOOT: [] }, titleLines: 1, seen: [] }) },
    { name: 'Status not repeated in its own column', data: itsaData(TREE), render: () => card(defaultCardLayout('issue'), { ...state, column: 'in_progress', mode: 'status' }) },
    { name: 'A layout with a foot line', data: itsaData(TREE), render: () => card({ slots: { TOP: ['kind'], META: ['status'], BADGES: ['cost'], FOOT: ['updated'] }, titleLines: 2, seen: [] }) },
    { name: 'Nested in an agent card, default layout', data: itsaData(TREE), render: () => nested(defaultCardLayout('issue')) },
    { name: 'Nested, status moved to BADGES with a foot row', data: itsaData(TREE), render: () => nested({ slots: { TOP: ['parent', 'kind', 'health'], META: ['rollup', 'links', 'owner'], BADGES: ['status'], FOOT: ['updated'] }, titleLines: 3, seen: [] }) },
  ],
}]
