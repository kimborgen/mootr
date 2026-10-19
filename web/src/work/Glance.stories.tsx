import { statusLabel } from '../itsa/itsa'
import { waitingRows } from '../itsa/WaitingList'
import { FIELDS, itsa, itsaData, LONG, QUEUE, TREE, TREE_FIELDS, WAITING_ITSAS } from '../stories/itsaFixtures'
import { T_PERM } from '../stories/mailFixtures'
import { ACTIVITY, COSTS } from '../stories/workFixtures'
import { ds, type Story } from '../stories/types'
import { getData } from '../store'
import type { Itsa, Permission } from '../types'
import type { WorkExtras } from './data'
import { Glance, type GlanceFilter } from './Glance'
import { WORK_COLUMNS } from './columns'
import { defaultLayout } from './views'
import { needsRows } from './needs'
import type { QuickId } from './quick'

const PERM = T_PERM.mails[0].permission as Permission
const extras: WorkExtras = { costs: COSTS, activity: ACTIVITY, watch: {}, fields: FIELDS, fieldsFailed: false, fieldsStart: 0 }
// The glance as WorkView holds it: in the table's scroller, with the needs rows built from the store.
const glance = (itsas: Itsa[], fields = false) => {
  const d = getData()
  const needs = needsRows(waitingRows(d), d.queue)
  return <div className="work-view" style={{ height: 760 }}><div className="w-table"><Glance itsas={itsas} needs={needs} extras={extras} now={Date.now()} fields={fields ? FIELDS.slice(0, 4) : []} /></div></div>
}
// The glance with a status filter and a cost sort on: the matches as one list, the Filter button counting both.
const filtered = (quick: QuickId[] = [], view?: GlanceFilter['view'], byStatus = false): React.ReactElement => {
  const d = getData()
  const needs = needsRows(waitingRows(d), d.queue)
  const matches = TREE.filter((i) => i.status === 'in_review' || i.status === 'in_progress')
  const layout = { ...defaultLayout(WORK_COLUMNS.map((c) => c.id)), ...(quick.length ? { quick } : { sort: [{ col: 'cost', dir: 'desc' as const }], filters: { status: { kind: 'values' as const, values: ['in_progress', 'in_review'] } } }) }
  const filter: GlanceFilter = { view, live: { layout, col: (id) => WORK_COLUMNS.find((c) => c.id === id), rows: () => [], cx: { now: Date.now(), extras }, edit: () => {} }, cols: WORK_COLUMNS, matches, of: TREE.length, line: `${matches.length} issues · ${matches.filter((i) => i.status === 'in_progress').length} active · ${matches.filter((i) => i.status === 'in_review').length} review`,
    groupLabel: byStatus ? 'Status' : undefined,
    groups: byStatus ? ['in_progress', 'in_review'].map((st) => ({ id: 'status:' + st, label: statusLabel(st), items: matches.filter((i) => i.status === st) })) : undefined }
  return <div className="work-view" style={{ height: 760 }}><div className="w-table"><Glance itsas={TREE} needs={needs} extras={extras} now={Date.now()} filter={filter} /></div></div>
}
const four = itsaData(TREE, { attention: WAITING_ITSAS, queue: QUEUE, perms: [PERM], humanThreads: [T_PERM] })
const quiet: Itsa[] = [itsa(996, null, 'Fixture backlog item', 'backlog'), itsa(997, null, 'Fixture finished item', 'done')]

export const stories: Story[] = [{
  name: 'Work glance',
  group: 'ITSA and work',
  what: 'The Work page for a phone, or a pane too narrow for the table: a glance at what needs you and what is moving, not a second issue list. Three sections in order: Needs you (the first three, the rest one tap away), Moving (work in flight, grouped by its root issue, with its agents and cost), and Ready to try (in review, or with somewhere to test it). It ends with a way to browse every issue instead of a backlog.',
  when: 'The Work world (`w:work`) on a phone, and on a desktop when the pane is under 900 px wide (a split or a narrow window). A card opens its ITSA, where the actions are; the page itself changes nothing.',
  code: ['web/src/work/Glance.tsx#Glance', 'web/src/work/glance.ts#glance', 'web/src/work/Glance.tsx#NEEDS_SHOWN', 'web/src/work/Glance.tsx#GlanceFilter', 'web/src/work/quick-bar.tsx#QuickBar'],
  rules: [
    'A card is at least `--size-hit-touch` tall with a hairline rule; its title is clamped to two lines at `--type-chrome-md`. A Needs-you card carries a 2 px waiting bar (`--is-waiting`) on its left edge, and its second line says the status, who asks, and the summary in the status tone.',
    'Moving is every open ITSA in the active category, or with an agent working on it, grouped under its root; the root leads its group when it moves itself, and the others indent one step. Backlog, ready, and closed ITSAs never show here, even with an agent on them.',
    'Ready to try is an ITSA in the review category, or any open one with a test or preview link. An ITSA already in Needs you is not listed again.',
    'Health shows only when it is not on track (a dot and a word in the warning or error tone); cost shows when above zero; the links sit under the card with their kind\'s icon (' + ds('State vocabulary') + ').',
    'Agents in a card keep a 44 px target that overlaps the row\'s padding instead of making the row taller; fields marked "chip" join the meta line, the others follow it labelled.',
    'The Filter button (44 px) sits in the header beside the lede and shows the count of filters (column and quick) and sort keys that are set; it opens the sort and filter sheet (Work filter sheet). With any set, Moving and Ready to try give way to one list of the matching ITSAs in the chosen order, under "N of M" and a Clear link; Needs you stays above it, unfiltered. Nothing matching says so in one line. One summary line sits under the matches on `--table-header-bg`: the count, the status categories, and the cost and working time when known (the table\'s totals footer, Work page story).',
    'With a column grouping set in the view (Group, By column…, on the desktop table), the list of matches shows even with no filter, and each group has a plain head (the value\'s label and a count) over its cards. The heads do not fold here, and an ITSA with several agents shows under each. While it is on, a chip in the result line, "Grouped by Status" (44 px, `--accent-subtle`), names the column (its label for a screen reader is "Grouped by Status, clear grouping", and a long column name is cut with an ellipsis); a tap on it clears the grouping and brings Moving and Ready to try back. Clear still clears the filters. The filter sheet\'s Group by sets or clears the same grouping.',
    'Under the header a row of six quick-filter chips (Waiting on Kim, Mine, Stale, Blocked, In review, Has PR) scrolls sideways; each chip is 44 px tall and a tap toggles it. A chip on counts in the Filter button and switches the list to the matches like any filter.',
    'A long-press (about half a second) on a card\'s value, such as its status, an agent, health, cost, a field or a link, opens the same menu as a right-click on a table cell: Filter to this value, Exclude this value and Sort by this column. A tap or the Enter key on the card still opens the ITSA; the click that ends a long-press does not, and a touch that drifts is a scroll.',
    'The view picker (S-1517) is the first control in the header: a 44 px button reading "View: Review queue" with a chevron, and a dot (`--accent`) when the view was edited after it was saved. It opens the View menu as a sheet (Default, the saved views, Save, Revert, Save as…, Delete); Escape closes it and focus returns to the button, and it sits in the browser history like the Filter sheet, so a back press closes it. The lede gives way to it.',
    'Empty sections say so in one line ("Nothing needs you.", "No work in flight.") rather than disappearing, except Ready to try, which is left out when it holds nothing (' + ds('Empty, loading, and error') + ').',
  ],
  states: [
    { name: 'Four need you, work in flight, and work to try', data: four, render: () => glance(TREE) },
    { name: 'With ITSA fields on the cards', data: itsaData(TREE_FIELDS, { attention: WAITING_ITSAS, queue: QUEUE }), render: () => glance(TREE_FIELDS, true) },
    { name: 'A long board\'s worth of work', data: itsaData([...LONG, ...TREE], { attention: WAITING_ITSAS, queue: QUEUE }), render: () => glance([...LONG, ...TREE]) },
    { name: 'Filtered: one sorted list under Needs you', data: four, render: () => filtered() },
    { name: 'Grouped by Status: a head and count over each group', data: four, render: () => filtered([], undefined, true) },
    { name: 'Quick filter on: Mine', data: four, render: () => filtered(['mine']) },
    { name: 'View picker: a saved view, edited', data: four, render: () => filtered(['mine'], { name: 'Review queue', dirty: true, open: () => {} }) },
    { name: 'Quiet: nothing needs you, nothing moves', data: itsaData(quiet), render: () => glance(quiet) },
  ],
}]
