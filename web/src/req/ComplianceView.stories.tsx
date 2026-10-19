import { itsaData, QUEUE, TREE, clickWhen } from '../stories/itsaFixtures'
import { OnMount } from '../stories/helpers'
import { loadReqs, REQ_OFF, REQ_ON, req } from '../stories/reqFixtures'
import { ds, type Story } from '../stories/types'
import { ComplianceView } from './ComplianceView'

const pane = () => <div style={{ height: 720, overflow: 'auto' }}><ComplianceView /></div>
const queued = itsaData(TREE, { queue: QUEUE })
// Twenty requirements, three subjects each checked: the matrix at a realistic scale.
const MANY = Array.from({ length: 24 }, (_, i) => req(200 + i, i < 4 ? null : 200 + (i % 4), `A fixture requirement with a long title that has to be cut, number ${i}`, {
  latest: [{ id: 700 + i, subject: 'itsa:S-911', verdict: (['conforms', 'violates', 'unsure', 'na', 'conforms'] as const)[i % 5], p_violates: 0.6, waived: i % 7 === 0 ? 'false_positive' : null, ts: new Date().toISOString() }],
}))

export const stories: Story[] = [{
  name: 'Compliance matrix',
  group: 'ITSA and work',
  what: 'Requirements as rows, subjects as columns, and in each cell the latest check of that requirement on that subject, at the requirement\'s current version. Subjects are the branches in the merge queue, or the ITSAs of an issue tree picked from a selector. A cell opens the requirement at that verdict. Every mark is an indication, never proof. On a phone each requirement is a card with a wrapping strip of verdict chips, one per subject.',
  when: 'The `w:compliance` world, opened from the matrix button in the Requirements list\'s header. It exists only while requirements are on. The choice between the merge queue and an issue tree is remembered on this device.',
  code: ['web/src/req/ComplianceView.tsx#ComplianceView', 'web/src/req/matrix.ts#buildMatrix', 'web/src/req/matrix.ts#queueSubjects', 'web/src/req/matrix.ts#subtreeSubjects'],
  rules: [
    'A cell is the requirement state glyph (`--rq-*`): likely conforms, likely violates, unsure; "n/a" for not applicable; nothing where it was not checked at this version. Each cell has a full sentence as its label ("R-2 on fixture/settings-cleanup: likely violates 91%") (' + ds('State vocabulary') + ').',
    'A waived verdict, or one checked at an older commit of a branch, keeps its shape, muted, with a stroke through it, and the label says which.',
    'The first column sticks while the table scrolls sideways; rows are `--size-row-table` tall and cells at least that wide, with `--table-border` rules and `--table-header-bg` headers (' + ds('Tables, tree, and empty states') + '). Requirements show in tree order with children indented; obsolete ones are left out.',
    'A subject\'s heading is a button that opens its ITSA and, under it, the ITSA\'s title; when it has likely violations that are not waived, "N likely violate(s)" shows in `--rq-violates`.',
    'On a phone a chip is at least `--size-hit-touch` tall, the strip wraps instead of scrolling sideways, and an unchecked chip is disabled.',
    'Off, no requirements, or no subjects each say what to do in one line ("Turn them on in Settings › Requirements", "Nothing is in the merge queue.").',
  ],
  states: [
    { name: 'Branches in the merge queue', data: queued, routes: REQ_ON, setup: loadReqs, render: pane },
    { name: 'An issue tree', data: queued, routes: REQ_ON, setup: loadReqs, render: () => <OnMount run={clickWhen('[data-subjects="itsa"]')}>{pane()}</OnMount> },
    { name: 'Twenty-four requirements', data: itsaData(TREE), routes: { ...REQ_ON, 'GET /api/requirements?verdicts=latest': MANY }, setup: loadReqs, render: () => <OnMount run={clickWhen('[data-subjects="itsa"]')}>{pane()}</OnMount> },
    { name: 'Nothing in the merge queue', data: itsaData(TREE), routes: REQ_ON, setup: loadReqs, render: () => <OnMount run={clickWhen('[data-subjects="queue"]')}>{pane()}</OnMount> },
    { name: 'No requirements yet', data: queued, routes: { ...REQ_ON, 'GET /api/requirements?verdicts=latest': [] }, setup: loadReqs, render: pane },
    { name: 'Requirements off', data: queued, routes: REQ_OFF, setup: loadReqs, render: pane },
  ],
}]
