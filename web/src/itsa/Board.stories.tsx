import { OnMount } from '../stories/helpers'
import { DEEP, itsaData, LONG, TREE } from '../stories/itsaFixtures'
import { ds, type Story } from '../stories/types'
import { Board } from './Board'

// The board fills its pane, so a state gives it a pane of a fixed height.
const pane = (node: React.ReactNode, height = 600) => <div style={{ height }}>{node}</div>
const board = (id: string | null, height?: number) => pane(<Board id={id} viewKey={`board:${id ?? 'all'}`} />, height)
// The saved view of a board, as settings hold it (`boardViews`, board-views.ts).
const view = (key: string, v: { mode?: 'category' | 'status'; scope?: 'children' | 'subtree'; closedAll?: boolean }) => ({ 'GET /api/config/settings': { text: JSON.stringify({ boardViews: { [key]: { mode: 'category', scope: 'children', closedAll: false, ...v } } }) } })
const menuOf = (id: string) => (el: HTMLElement) => el.querySelector<HTMLElement>(`.bcard[data-card="${id}"] .bc-menu`)?.click()
// The issue card layout as settings hold it (`cardLayouts`, card-layout.ts), with the board's view.
const withLayout = (layout: object, key = 'fx-i-910') => ({ 'GET /api/config/settings': { text: JSON.stringify({ boardViews: { [key]: { mode: 'category', scope: 'children', closedAll: false } }, cardLayouts: { issue: { ...layout, seen: [] } } }) } })

export const stories: Story[] = [{
  name: 'Board',
  group: 'ITSA and work',
  what: 'A kanban board of ITSAs: one column per status category (or per status), a card for each ITSA. A card shows its key, kind, health dot, a mark when it waits on you, its title, its status (when the column does not already say it), a roll-up bar of its children, its links, and its owner. Dragging a card to another column sets its status as you; dragging within a column orders it. Scope is the ITSA\'s direct children, or its whole subtree flattened with each card naming its parent. The board of all issues shows the roots, or everything.',
  when: 'The `board:ID` tab in an ITSA\'s world, opened from the Children heading\'s Board button; and the all-issues board (`w:board:all`), opened from the board button in the sidebar\'s Issues header, or from "Browse every issue" on a desktop Work glance. On a phone it shows one column at a time.',
  code: ['web/src/itsa/Board.tsx#Board', 'web/src/itsa/Board.tsx#rankOf', 'web/src/itsa/board-views.ts#prefsFor'],
  rules: [
    'A column is a `--radius-md` panel on `--surface-app`; a card is `--surface-page` with a `--border-subtle` hairline and `--radius-sm`, and its border darkens to `--border-default` on hover over `--duration-fast`. Titles are `--type-chrome-md`, clamped to three lines.',
    'A card is drawn from the issue card layout (`cardLayouts.issue`): its TOP, META, BADGES and FOOT slots take their items in order, and an empty slot takes no height. The status shows in META in its `--is-*` tone with its glyph and words, unless the column already says it. A waiting-on-you ITSA also carries a warning badge in TOP with the user icon, and health is a dot in the success, warning or error tone with its label for screen readers, so neither is colour alone (' + ds('State vocabulary') + ').',
    'Mouse and pen drag: the card dims in place, a ghost follows at `--shadow-float` and `--z-drag`, the target column takes `--drop-fill` with a `--drop-border` outline, and a line marks where it lands. Touch never drags: it scrolls, and a long press or the card\'s menu opens "Move to…".',
    'Keyboard: arrows move focus, Shift and the arrows move the card, M, the menu key or Shift+F10 opens "Move to…", Enter or Space opens the ITSA.',
    'The closed column shows the 10 most recently closed, newest first, with "Show all N" for the rest; it folds to a vertical strip (remembered on this device) and a drop on it sets the status only, since it orders by close time.',
    'A phone shows a strip of column chips, each at least `--size-hit-touch` tall with its count, and one full-width column; a sideways swipe of more than 48 px moves to the next column. The card\'s menu button is `--size-hit-touch` square there.',
    'Grouping (Categories or Statuses), scope, and "show all closed" are saved per board in settings (`boardViews`), so they follow you between devices.',
  ],
  states: [
    { name: 'Children of one ITSA, by category', data: itsaData(TREE), routes: view('fx-i-910', {}), render: () => board('fx-i-910') },
    { name: 'Whole subtree, with parent keys and a card waiting on you', data: itsaData(TREE), routes: view('fx-i-910', { scope: 'subtree' }), render: () => board('fx-i-910') },
    { name: 'By status', data: itsaData(TREE), routes: view('fx-i-910', { mode: 'status', scope: 'subtree' }), render: () => board('fx-i-910') },
    { name: 'All issues, the roots', data: itsaData(TREE), routes: view('all', {}), render: () => board(null) },
    { name: 'A deep chain, whole subtree', data: itsaData(DEEP), routes: view('fx-i-960', { scope: 'subtree' }), render: () => board('fx-i-960') },
    { name: 'Long board: 64 children, more than 10 closed', data: itsaData(LONG), routes: view('fx-i-970', {}), render: () => board('fx-i-970', 720) },
    { name: 'Long board with every closed card', data: itsaData(LONG), routes: view('fx-i-970', { closedAll: true }), render: () => board('fx-i-970', 720) },
    { name: 'Long board by status', data: itsaData(LONG), routes: view('fx-i-970', { mode: 'status' }), render: () => board('fx-i-970', 720) },
    { name: '"Move to…" menu', data: itsaData(TREE), routes: view('fx-i-910', {}), height: 620, render: () => <OnMount run={menuOf('fx-i-911')}>{board('fx-i-910', 580)}</OnMount> },
    { name: 'Status moved to BADGES, title on one line', data: itsaData(TREE), routes: withLayout({ slots: { TOP: ['parent', 'kind', 'health'], META: ['rollup', 'links', 'owner'], BADGES: ['status'], FOOT: [] }, titleLines: 1 }), render: () => board('fx-i-910') },
    { name: 'Empty', data: itsaData([]), routes: view('all', {}), render: () => board(null, 360) },
  ],
}]
