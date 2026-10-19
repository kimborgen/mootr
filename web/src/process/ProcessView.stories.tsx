// The process view's story (S-873): the pane is a fixed-height surface, so each state draws into
// a frame of its own. Every route is stubbed from the invented fixture.
import type { ReactNode } from 'react'
import { ds, pending, reply, type Story } from '../stories/types'
import { DEV_CHANGE, PROCESSES } from './fixture'
import { OnMount } from '../stories/helpers'
import { addEdge, addNode, deleteLane, diffLines, draftFrom, toYaml, updateEdge, updateNode, validate, type Draft } from './edit'
import { EditBar, EditPanel, IssueList, type PanelMode, type SaveState } from './ProcessEditor'
import { ProcessView, Sheet } from './ProcessView'

const click = (sel: string) => (el: HTMLElement) => { (el.querySelector(sel) as HTMLElement | null)?.click() }
const STATUSES = ['in_progress', 'in_review', 'needs_approval', 'ready_to_merge', 'merging', 'deploying', 'todo', 'blocked']
const base = draftFrom(DEV_CHANGE)
const edited: Draft = (() => {
  const a = addNode(base, 'script', 'manager', 'Notify the channel')
  return updateEdge(addEdge(a.draft, 'merge', a.id), 0, { label: 'start' })
})()
const broken: Draft = updateNode(deleteLane(edited, 'reviewer'), 'code', { statuses: ['nope'] })
const idle: SaveState = { blocked: null, busy: false, error: null, saved: null, onSave: () => {}, onOpen: () => {}, onDone: () => {} }
const panelOf = (mode: PanelMode, draft: Draft, narrow = false, save: Partial<SaveState> = {}) => (
  <EditPanel mode={mode} draft={draft} issues={validate(draft, STATUSES)} narrow={narrow} statuses={STATUSES} types={['developer', 'reviewer', 'manager']} processIds={['dev-change', 'retro-loop']}
    diff={diffLines(toYaml(base), toYaml(draft))} onChange={() => {}} onMode={() => {}} onAdd={() => {}} save={{ ...idle, ...save }} />
)
const pane = (children: ReactNode) => <div className="proc" style={{ height: 660 }}>{children}</div>

export const stories: Story[] = [{
  name: 'Process view',
  group: 'ITSA and work',
  what: 'A process drawn read-only from the daemon: its lanes as labelled bands, its nodes auto-laid out left to right (a pane under 600 px shows one vertical column of full-width rows instead, with no bands: each row names its lane, and an edge between non-neighbours loops through a gutter on the right) with a shape per kind (start, end and wait circles, agent, human and script rectangles with a kind glyph, exclusive and parallel diamonds with × and +), a count badge per node that holds ITSAs, a boundary dot on a task with a boundary event, a ⊞ on a sub-process call, chips for a start node\'s triggers, and edge labels. Tapping a node lists its ITSAs in a side sheet (a bottom sheet on a narrow pane) whose rows open the ITSA as the Work page does. A process picker shows when the files hold more than one process, and failed files are listed above the canvas.',
  when: 'The Process view (`w:process`), opened from the agent tree\'s footer, the global menu, or a `#view=process` link. It loads `GET /api/processes` on mount, refetches when the ITSA list changes, and at most every 15 s while the pane is on screen (it pauses when hidden).',
  code: ['web/src/process/ProcessView.tsx#ProcessView', 'web/src/process/ProcessView.tsx#Sheet', 'web/src/process/layout.ts#layoutProcess', 'web/src/process/badge.ts#badgeFor'],
  rules: [
    'Read-only: nodes never drag and edges never draw (`nodesDraggable={false}`, `nodesConnectable={false}`); pan and pinch-zoom stay on.',
    'Only tokens are used; the node boxes and the layout spacing come from `web/src/process/process.css`, built from the token scale and read back by the layout, so no size is written in code (' + ds('In stam') + ').',
    'A node is a target of at least a finger\'s size (`--size-hit-touch`) on a phone; its badge and chips are small, drawn inside it.',
    'On the wide drawing a back edge (an answer or a change loops to an earlier node) leaves and enters by the node bottoms and runs under the row, clear of node labels. In the column, loops through the gutter carry no label (the gutter is too narrow), and a start node\'s trigger chips truncate with an ellipsis inside the card.',
    'Under 600 px the flow is one column fitted to the pane\'s width (pan down only), its text at the body size, and the sheet becomes a bottom sheet, as the system view\'s tree becomes an outline (' + ds('Density') + ').',
    'A wide drawing opens at its top left and never smaller than 80%, so its text stays legible; the user pans for the rest.',
    'Nothing animates: the drawing is at rest, and a layout change is a fresh placement, not a transition.',
  ],
  states: [
    { name: 'Dev change', routes: { 'GET /api/processes': PROCESSES }, render: () => pane(<ProcessView viewKey="process" />) },
    { name: 'One process', routes: { 'GET /api/processes': { processes: [DEV_CHANGE], errors: [] } }, render: () => pane(<ProcessView viewKey="process" />) },
    { name: 'A node\'s ITSAs', routes: { 'GET /api/processes': PROCESSES }, render: () => pane(<Sheet nid="code" self={DEV_CHANGE} node={DEV_CHANGE.nodes.code} narrow={false} onClose={() => {}} />) },
    { name: 'The bottom sheet', routes: { 'GET /api/processes': PROCESSES }, render: () => pane(<Sheet nid="code" self={DEV_CHANGE} node={DEV_CHANGE.nodes.code} narrow onClose={() => {}} />) },
    {
      name: 'Errors', routes: { 'GET /api/processes': { processes: [], errors: [{ file: 'processes/bad.yaml', message: 'unknown node kind "gate" on node "check"' }] } },
      render: () => pane(<ProcessView viewKey="process" />),
    },
    { name: 'Editing', routes: { 'GET /api/processes': PROCESSES }, render: () => pane(<OnMount run={click('[data-act=edit]')}><ProcessView viewKey="process" /></OnMount>) },
    { name: 'Editing a node', routes: { 'GET /api/processes': PROCESSES }, render: () => pane(<OnMount run={(el) => { click('[data-act=edit]')(el); setTimeout(() => click('[data-node=code] .proc-hit')(el), 50) }}><ProcessView viewKey="process" /></OnMount>) },
    { name: 'Loading', routes: { 'GET /api/processes': pending() }, render: () => pane(<ProcessView viewKey="process" />) },
    { name: 'No processes', routes: { 'GET /api/processes': { processes: [], errors: [] } }, render: () => pane(<ProcessView viewKey="process" />) },
    { name: 'The route fails', routes: { 'GET /api/processes': reply(503, { error: 'fixture: unreachable' }) }, render: () => pane(<ProcessView viewKey="process" />) },
  ],
}, {
  name: 'Process editor',
  group: 'ITSA and work',
  what: 'The Edit mode of the Process view: a working copy of the process that changes in the browser and saves nowhere. **Edit** in the header opens it; the bar adds a node, edits the lanes, and opens the review. A node is added from the Add panel (kind, lane, label), and on a desktop also dragged from the palette onto a lane. A node\'s panel edits its label, kind, lane, id, statuses, brief and the fields its kind carries, lists the edges that leave it (each with a `when` and a `label`, and a delete) and those that arrive, and has **Connect to…**, a list of nodes; on a desktop an edge is also dragged from one node\'s handle to another. Deleting a node removes its edges. The drawing re-lays out after each change (Dagre; no positions are stored). The validator is the loader\'s own (`src/process-validate.ts`): a problem marks its node or edge in red and is listed under the bar. Review shows the YAML diff against the file as loaded. **Discard** leaves the edit. **Save as proposal** (in the header, and in the review panel with a summary field) sends the file to the daemon, which checks it, commits it to a branch, opens a pull request and files a proposal ITSA waiting for your approval; the panel then names the ITSA and links it and the PR.',
  when: 'In the Process view, after **Edit**. Nothing is read from or written to the daemon beyond the processes the view already loads.',
  code: ['web/src/process/ProcessEditor.tsx#EditBar', 'web/src/process/ProcessEditor.tsx#EditPanel', 'web/src/process/ProcessEditor.tsx#IssueList', 'web/src/process/edit.ts#validate', 'web/src/process/edit.ts#toYaml'],
  rules: [
    'Nothing is changed by editing: **Discard** drops the working copy (a second tap confirms when something changed), and **Save as proposal** only proposes: it needs a summary, is disabled while a problem is listed or nothing changed (and says why), and changes no file until the proposal is approved and the PR merges.',
    'The panel is a side panel on a desktop and a bottom sheet under 600 px; on a phone drag-to-connect is off (a touch drag is unreliable at 360 px) and **Connect to…** in the node\'s sheet is the way to join nodes.',
    'Controls are `--size-hit-touch` tall on a phone; every colour, size and space is a token (' + ds('In stam') + ').',
    'Errors use the status error tokens, on the node border, the edge stroke, the field list and the bar pill; a problem is never shown by colour alone: it is also listed as text.',
    'The diff marks an added line with `+` and a removed one with `−`, besides the success and error tints.',
    'Nothing animates: a change is a fresh placement.',
  ],
  states: [
    { name: 'Bar', render: () => <div className="proc" style={{ height: 120 }}><EditBar narrow={false} mode={null} changes={2} errors={0} onMode={() => {}} /></div> },
    { name: 'Bar with errors', render: () => <div className="proc" style={{ height: 120 }}><EditBar narrow mode={{ k: 'review' }} changes={3} errors={2} onMode={() => {}} /></div> },
    { name: 'Problems', render: () => <div className="proc" style={{ height: 160 }}><IssueList issues={validate(broken, STATUSES)} onPick={() => {}} /></div> },
    { name: 'Node panel', render: () => pane(panelOf({ k: 'node', id: 'code' }, base)) },
    { name: 'Node panel, narrow', render: () => pane(panelOf({ k: 'node', id: 'code' }, base, true)) },
    { name: 'Start node', render: () => pane(panelOf({ k: 'node', id: 'request' }, base)) },
    { name: 'Node with a problem', render: () => pane(panelOf({ k: 'node', id: 'code' }, broken)) },
    { name: 'Add a node', render: () => pane(panelOf({ k: 'add' }, base)) },
    { name: 'Lanes', render: () => pane(panelOf({ k: 'lanes' }, base)) },
    { name: 'Review', render: () => pane(panelOf({ k: 'review' }, edited)) },
    { name: 'Review, no change', render: () => pane(panelOf({ k: 'review' }, base, false, { blocked: 'There is no change to save.' })) },
    { name: 'Review, with problems', render: () => pane(panelOf({ k: 'review' }, broken, false, { blocked: 'Fix the 2 problems first.' })) },
    { name: 'Saving', render: () => pane(panelOf({ k: 'review' }, edited, false, { busy: true })) },
    { name: 'Save refused', render: () => pane(panelOf({ k: 'review' }, edited, true, { error: 'dev-change.yaml doesn\'t validate: node "code": unknown lane "ghost"' })) },
    { name: 'Saved', render: () => pane(panelOf({ k: 'review' }, edited, false, { saved: { key: 'S-1201', id: 'fixture-s-1201', pr: { number: 412, url: 'https://github.com/example/stam2/pull/412' } } })) },
    { name: 'Saved, narrow', render: () => pane(panelOf({ k: 'review' }, edited, true, { saved: { key: 'S-1201', id: 'fixture-s-1201', pr: { number: 412, url: 'https://github.com/example/stam2/pull/412' } } })) },
  ],
}]
