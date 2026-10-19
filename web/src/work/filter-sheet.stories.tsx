import { useState } from 'react'
import { itsaData, TREE } from '../stories/itsaFixtures'
import { ds, type Story } from '../stories/types'
import { WORK_COLUMNS } from './columns'
import { groupable } from './model'
import { FilterSheet } from './filter-sheet'
import type { HeaderLive } from './header-menu'
import type { WorkRow } from './model'
import type { ColFilter, SortKey } from './sortfilter'
import { defaultLayout, type Layout } from './views'

const COLS = WORK_COLUMNS.filter((c) => ['work', 'status', 'agents', 'github', 'cost', 'health', 'updated'].includes(c.id))
const ROWS: WorkRow[] = TREE.map((it) => ({ it, depth: 0, context: false }))
const EXTRAS = { costs: null, activity: null, watch: {}, fields: null, fieldsFailed: false, fieldsStart: 0 }

// The sheet with its own layout, as WorkView holds it: an edit changes the layout and the sheet shows it.
function Live({ sort, filters }: { sort?: SortKey[]; filters?: Record<string, ColFilter> }) {
  const [layout, setLayout] = useState<Layout>({ ...defaultLayout(COLS.map((c) => c.id)), ...(sort ? { sort } : {}), ...(filters ? { filters } : {}) })
  const live: HeaderLive = { layout, col: (id) => COLS.find((c) => c.id === id), rows: () => ROWS, cx: { now: Date.now(), extras: EXTRAS }, edit: (fn) => setLayout(fn) }
  return <div style={{ position: 'relative', height: 640, transform: 'translateZ(0)' }}><FilterSheet live={live} cols={COLS} groupCols={COLS.filter(groupable)} count={ROWS.length} onClose={() => {}} /></div>
}

export const stories: Story[] = [{
  name: 'Work filter sheet',
  group: 'ITSA and work',
  what: 'The Work table\'s sort and filter for a phone, which has no column headers: a full-height sheet with Sort by (a column and a direction for each key, several keys), Group by (None or a column that can group) and one row for every column that filters, each opening that column\'s filter editor in place. Clear all and "Show N" stay pinned at the bottom.',
  when: 'The Filter button in the Work glance header (a phone, or a pane under 900 px). It edits the same layout as the desktop header, so a filter set here shows on the desktop and the reverse.',
  code: ['web/src/work/filter-sheet.tsx#FilterSheet', 'web/src/work/filter-sheet.tsx#activeCount', 'web/src/work/header-menu.tsx#ColumnFilter', 'web/src/work/views.ts#setSortKeys', 'web/src/work/sheet-state.ts#workSheetOpen'],
  rules: [
    'Every row, button and field is at least `--size-hit-touch` (44 px) tall, and the sort column is a native select so the phone\'s own picker opens (' + ds('Touch targets') + ').',
    'A column row reads its name, then what it filters to in `--accent-text` ("Any" in `--text-muted` when it is not filtered), then a chevron that turns when the editor is open. One editor is open at a time; the editors are the header menu\'s.',
    'Group by is one native select (44 px) between Sort by and Filter: None, or a column that can group (Status, Agents, GitHub, Health, Review, Tests, and the choice and check fields). It writes the layout\'s column grouping like the table\'s Group, By column… menu, so it shows there too; None returns to the issue tree. Clear all leaves it alone.',
    'A column with a standing exclude rule reads `≠ Blocked` in `--accent-text`; its editor shows the excluded values unticked and every other value ticked.',
    'Edits apply at once. Clear all removes every filter (quick ones too) and the sort and is off when none is set; "Show N" closes the sheet and says how many ITSAs the list will hold.',
    'It is an overlay: Escape or a phone back press closes it, focus moves into it on open and returns to the Filter button on close. A column hidden from the table that still filters or sorts keeps its row, so each filter can be cleared. With nothing set, Show N is the count of every open ITSA.',
    'Only design tokens; the sheet is the menu\'s surface colour and covers the visual viewport, so the keyboard does not hide the Show button.',
  ],
  states: [
    { name: 'Nothing set', data: itsaData(TREE), render: () => <Live /> },
    { name: 'A filter and two sort keys', data: itsaData(TREE), render: () => <Live sort={[{ col: 'cost', dir: 'desc' }, { col: 'updated', dir: 'asc' }]} filters={{ status: { kind: 'values', values: ['in_review', 'testing'] }, cost: { kind: 'range', min: 2 } }} /> },
    { name: 'An exclude rule', data: itsaData(TREE), render: () => <Live filters={{ status: { kind: 'values', not: ['done', 'canceled'] } }} /> },
  ],
}]
