import { Row } from '../stories/helpers'
import { ds, type Story } from '../stories/types'
import { ProbBar, ReqGlyph, ReqRollupBar } from './parts'
import type { ReqRollup, ReqState } from './model'

const STATES: ReqState[] = ['conforms', 'violates', 'unsure', 'unverified']
const roll = (r: Partial<ReqRollup>): ReqRollup => ({ conforms: 0, violates: 0, unsure: 0, unverified: 0, ...r })

export const stories: Story[] = [{
  name: 'Requirement state glyph',
  group: 'ITSA and work',
  what: 'The mark of how a requirement stands, from its latest checks: a ring with a tick (likely conforms), a bar and a dot (likely violates), a ring with a filled dot (unsure), or a dashed ring (unverified). A check is a model\'s indication, never proof, so the words say "likely". A requirement that is not in force, and a waived verdict, draw muted.',
  when: 'Before every requirement row and in every requirement list: the Requirements section of the sidebar, a requirement\'s own header, the ITSA view\'s Requirements panel, the compliance matrix\'s cells and headings.',
  code: ['web/src/req/parts.tsx#ReqGlyph', 'web/src/req/model.ts#stateOf'],
  rules: [
    'The glyph is `--icon-xs` (14 px) square. Its tone is `--rq-*` from `web/tokens-stam.css`: `--rq-conforms` success, `--rq-violates` error, `--rq-unsure` warning, `--rq-unverified` muted (' + ds('In stam') + '). The shape says the state too, so tone is never the only channel.',
    'A requirement that is a draft, suspended, or obsolete is drawn in `--text-muted`, because it is not checked as in force. A waived verdict keeps its shape, muted, with a stroke through it.',
    'The accessible label and title name the state ("likely violates") and, when not in force, the status ("draft").',
    'The state comes from the latest verdict per subject at the current version, waived ones left out: any likely violation wins, then unsure, then likely conforms; none, or only not applicable, is unverified.',
  ],
  states: [
    { name: 'Each state, in force', render: () => <Row items={STATES.map((s) => ({ label: s, node: <ReqGlyph state={s} status="in_force" /> }))} /> },
    { name: 'Not in force: draft, suspended, obsolete', render: () => <Row items={(['draft', 'suspended', 'obsolete'] as const).map((s) => ({ label: s, node: <ReqGlyph state="conforms" status={s} /> }))} /> },
    { name: 'Waived', render: () => <Row items={STATES.slice(0, 3).map((s) => ({ label: s, node: <ReqGlyph state={s} waived /> }))} /> },
  ],
}, {
  name: 'Requirement roll-up bar',
  group: 'ITSA and work',
  what: 'A thin bar for a requirement\'s subtree: the requirements in force under it, split into likely conforms, likely violates, unsure, and unverified. Its title spells the counts out ("1 likely conforms · 2 likely violate"). A subtree with nothing in force draws nothing.',
  when: 'At the end of each row in the sidebar\'s Requirements section, counting the requirement and everything below it.',
  code: ['web/src/req/parts.tsx#ReqRollupBar', 'web/src/req/model.ts#rollups'],
  rules: [
    'It is the ITSA roll-up\'s bar: 28 px wide (96 px when wide) and 4 px tall, on a `--radius-xs` track. Segments are `--rq-conforms`, `--rq-violates`, `--rq-unsure`, and `--border-strong` for unverified, in that order.',
    'Only requirements in force count; a draft, a suspended one, and an obsolete one are in the tree but not in the bar.',
    'Words, not just colour: the title and label say "likely" for every verdict (' + ds('State vocabulary') + ').',
  ],
  states: [
    { name: 'A mix', render: () => <ReqRollupBar r={roll({ conforms: 3, violates: 1, unsure: 1, unverified: 2 })} /> },
    { name: 'Wide', render: () => <ReqRollupBar r={roll({ conforms: 3, violates: 1, unsure: 1, unverified: 2 })} wide /> },
    { name: 'All likely conform', render: () => <ReqRollupBar r={roll({ conforms: 5 })} /> },
    { name: 'Nothing in force, so nothing shows', render: () => <p className="muted">Nothing between the lines:<ReqRollupBar r={roll({})} /></p> },
  ],
}, {
  name: 'Probability bar',
  group: 'ITSA and work',
  what: 'A model\'s probability that a subject violates a requirement, P(violates), as a thin bar with its percentage. A tick marks the threshold at which the requirement acts. It is the check\'s own uncertainty, not a measure of how bad a violation is.',
  when: 'On each verdict in a requirement\'s Recent verdicts, and in the Preview sheet that runs a requirement on recent subjects.',
  code: ['web/src/req/parts.tsx#ProbBar'],
  rules: [
    'The track is 4 px tall on `--status-neutral-bg` with `--radius-xs`; the fill is `--rq-violates` at or above the threshold, `--rq-unsure` from 50%, else `--rq-conforms`. The threshold is a 1 px tick in `--text-secondary` that stands taller than the track.',
    'The number is `--type-chrome-sm`, right-aligned in at least four characters, so a column of bars lines up; the label says "P(violates) 91%" and the title adds "acts at 80%".',
    'A check without a probability draws an empty track and no number.',
  ],
  states: [
    { name: 'Below 50%, unsure, and over the threshold', render: () => <Row items={[{ label: '8%', node: <ProbBar p={0.08} threshold={0.8} /> }, { label: '55%', node: <ProbBar p={0.55} threshold={0.8} /> }, { label: '91%', node: <ProbBar p={0.91} threshold={0.8} /> }]} /> },
    { name: 'No threshold', render: () => <ProbBar p={0.4} /> },
    { name: 'No probability', render: () => <ProbBar p={null} /> },
  ],
}]
