import { AgentsBulk } from './AgentsBulk'
import { OnMount } from './stories/helpers'
import { agent } from './stories/fixtures'
import { ds, type Story } from './stories/types'
import { setUi } from './ui/state'
import type { Agent } from './types'

// The bar's own folds, reset by every state so one state's folds never reach the next.
const quiet = () => setUi({ collapsed: {}, stoppedOpen: false, filter: '', treeFocus: null })

// Three checked agents with mixed eligibility: one live, one paused, one stopped. Pause applies to the live one, Resume
// to the paused and the stopped, Archive to all three, and a mode change to the live one.
const MIXED: Agent[] = [
  agent({ id: 'bk-live', name: 'fixture-live', lifecycle: 'active', activity: 'idle', activity_detail: null, machine: 'fixture-box-one' }),
  agent({ id: 'bk-paused', name: 'fixture-paused', lifecycle: 'paused', activity: 'idle', activity_detail: null, machine: 'fixture-box-one' }),
  agent({ id: 'bk-stopped', name: 'fixture-stopped', lifecycle: 'shut_down', activity: 'idle', activity_detail: null, machine: 'fixture-box-two' }),
]
// Seven checked live agents, so the archive confirm names five and says how many more.
const MANY: Agent[] = Array.from({ length: 7 }, (_, i) => agent({ id: `bk-many-${i}`, name: `fixture-batch-${i + 1}`, lifecycle: 'active', activity: 'idle', activity_detail: null, machine: 'fixture-box-one' }))

// The bar under a table of the checked agents, the way the page draws it.
function bar(agents: Agent[]) {
  return <div className="story-pad" style={{ width: 720 }}>
    <div className="agents-main">
      <div className="agents-table-wrap">
        <table className="data agents-table">
          <tbody>{agents.map((a) => <tr key={a.id} className="at-row chk" data-agent-row={a.id}><td className="ac-check"><input type="checkbox" className="agents-check" checked readOnly tabIndex={-1} aria-label={`Select ${a.name}`} /></td><td className="ac-name"><span className="at-name"><span className="name">{a.name}</span></span></td></tr>)}</tbody>
        </table>
      </div>
      <AgentsBulk agents={agents} onClear={() => {}} />
    </div>
  </div>
}

// Opens the archive confirm from its button, as a click does.
const openArchive = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('[data-bulk="archive"]')?.click()

export const stories: Story[] = [{
  name: 'Agents bulk bar',
  group: 'Tree and shell',
  what: 'The bulk bar under the Agents table (S-3117): "N selected" and the actions for the checked agents, Pause, Resume, Archive… and Mode, with Clear. Each button shows how many agents it applies to, and a button that applies to none is disabled. Pause and Resume run at once; Archive and a mode change ask first and name the count.',
  when: 'On the desktop Agents page, once one or more rows are checked. It sits at the foot of the table, and the phone has none.',
  code: ['web/src/AgentsBulk.tsx#AgentsBulk'],
  rules: [
    'The bar is one row at `--size-row-table`, on `--surface-pane` with a `--table-border` top hairline. Its buttons are `.btn` at `--size-control`; the count sits at the left in `--text-muted`.',
    'An action skips the agents it does not apply to: Pause only the active ones, Resume the paused and the stopped, Archive every agent that is not archived. The button says how many it applies to ("Pause 3"), and a button that applies to none is disabled.',
    'Archive… and a mode change open a confirm above the bar. It names the count and up to five names, then how many more, and nothing runs until its button is pressed. A partial failure is named per agent in the one toast the action ends with.',
    'The confirm is the popover of the menu layer (' + ds('Menus, overlays, and inputs') + '), at `--size-agents-confirm` wide.',
    'On a phone (`compact`) the bar is one row at 360 px: each action is four equal columns of its icon over its name and count, at a 44 px target. A disabled action keeps its tap and says why in the summary line. Clear goes, since the header says how many are selected and Done leaves select mode (S-3282).',
  ],
  states: [
    { name: 'Three selected, mixed eligibility', data: { agents: MIXED, itsas: [] }, setup: quiet, render: () => bar(MIXED) },
    { name: 'Phone, three selected, one row', data: { agents: MIXED, itsas: [] }, setup: quiet, render: () => <div className="story-pad" style={{ width: 360 }}><AgentsBulk agents={MIXED} onClear={() => {}} compact /></div> },
    { name: 'Archive confirm, seven agents', height: 400, overlay: '.menu.popover', data: { agents: MANY, itsas: [] }, setup: quiet, render: () => <OnMount run={openArchive}>{bar(MANY)}</OnMount> },
  ],
}]
