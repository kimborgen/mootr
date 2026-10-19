import { itsaData, TREE } from '../stories/itsaFixtures'
import { loadReqs, REQ_OFF, REQ_ON, req } from '../stories/reqFixtures'
import { ds, reply, type Story } from '../stories/types'
import { getUi } from '../ui/state'
import type { UiState } from '../ui/state'
import { ReqSide } from './ReqSide'

// The sidebar's UI state is set on the store's object directly, as the Issues list story does.
const withUi = (p: Partial<UiState>, node: () => React.ReactNode) => () => { Object.assign(getUi(), { reqOpen: {}, reqFolded: false, obsoleteReqOpen: false, ...p }); return node() }
const side = (height?: number) => () => <div className="tree-side" style={{ width: '100%', height, display: 'flex', flexDirection: 'column' }}><ReqSide /></div>
const data = itsaData(TREE)
const routesWith = (reqs: unknown) => ({ ...REQ_ON, 'GET /api/requirements?verdicts=latest': reqs })
// Sixty requirements under six roots, with long titles: the tree at a realistic scale.
const MANY = Array.from({ length: 60 }, (_, i) => req(100 + i, i < 6 ? null : 100 + (i % 6), i < 6 ? `Fixture area ${i}` : `A fixture requirement whose title runs on past the width of the list, number ${i}`, { status: i % 17 === 0 ? 'draft' : 'in_force', latest: [{ id: 500 + i, subject: 'itsa:S-911', verdict: (['conforms', 'conforms', 'violates', 'unsure'] as const)[i % 4], p_violates: 0.5, waived: null, ts: new Date().toISOString() }] }))
const openAll = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`fx-r-${100 + i}`, true]))

export const stories: Story[] = [{
  name: 'Requirements list',
  group: 'ITSA and work',
  what: 'The Requirements section of the left sidebar, under Issues, shown only while requirements are on: the requirement tree as rows (state glyph, key, title, a roll-up bar of everything below it), each expandable into its children to any depth. Draft requirements carry a "draft" tag, and obsolete roots fold into one row at the end. The header counts all requirements, says how many likely violate, and opens the compliance matrix.',
  when: 'The sidebar on a desktop, below the Issues list; on a phone it follows the issues in the Issues tab as full-width rows. It does not exist while requirements are off (Settings › Requirements). A row opens the requirement\'s world (`w:req:KEY`).',
  code: ['web/src/req/ReqSide.tsx#ReqSide'],
  rules: [
    'It is the Issues list\'s layout: rows `--size-row-tree` tall, `--size-hit-touch` on a phone, each level indented by `--space-3`; the header folds it on a desktop only (' + ds('Density') + ').',
    'The glyph is the requirement state in its `--rq-*` tone; a draft, suspended, or obsolete row is muted (see the Requirement state glyph story). Every verdict is worded "likely" because a check is an indication, not proof.',
    'The flagged count, "N likely violate(s)", is `--rq-violates` text with the reason in its title; the matrix button is an icon button with the label "Compliance matrix".',
    'The roll-up bar counts only requirements in force; the row\'s title lists the counts below it.',
    'While the first read is out the list shows the Loading badge; an unreachable daemon shows its error in the list; none yet says "Requirements you and agents keep show here." (' + ds('Empty, loading, and error') + ').',
  ],
  states: [
    { name: 'Roots, collapsed', data, routes: REQ_ON, setup: loadReqs, render: withUi({}, side()) },
    { name: 'A tree expanded, with a draft', data, routes: REQ_ON, setup: loadReqs, render: withUi({ reqOpen: { 'fx-r-1': true } }, side()) },
    { name: 'Obsolete roots shown', data, routes: REQ_ON, setup: loadReqs, render: withUi({ obsoleteReqOpen: true }, side()) },
    { name: 'Folded', data, routes: REQ_ON, setup: loadReqs, render: withUi({ reqFolded: true }, side()) },
    { name: 'Sixty requirements, long titles', data, routes: routesWith(MANY), setup: loadReqs, render: withUi({ reqOpen: openAll }, side(420)) },
    { name: 'Empty', data, routes: routesWith([]), setup: loadReqs, render: withUi({}, side()) },
    { name: 'Error', data, routes: { 'GET /api/req-enabled': reply(503, { error: 'fixture: the daemon is unreachable' }) }, setup: loadReqs, render: withUi({}, side()) },
    { name: 'Requirements off, so nothing shows', data, routes: REQ_OFF, setup: loadReqs, render: withUi({}, () => <div><p className="muted">Nothing between the lines:</p><ReqSide /></div>) },
  ],
}]
