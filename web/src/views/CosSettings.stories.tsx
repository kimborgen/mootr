import { CosSettings } from './CosSettings'
import { REGISTRY } from '../stories/settingsFixtures'
import { AGENTS } from '../stories/fixtures'
import { ds, type Story } from '../stories/types'
import type { Agent } from '../types'
import type { AgentType } from './TypesSettings'

const type: AgentType = { harness: 'claude', model: 'claude-opus-5-5', effort: 'medium', description: 'The chief of staff' }
const cos = { ...AGENTS[0], name: 'cos', harness: 'claude', model: 'claude-opus-5-5', effort: 'medium', chief_of_staff: 1, lifecycle: 'active' } as Agent
const show = (o: { cos?: Agent | null; type?: AgentType; readOnly?: boolean } = {}) => (
  <CosSettings cos={o.cos} type={o.type ?? type} reg={REGISTRY} readOnly={o.readOnly} why="Shared by all machines; change it on fixture-home." onChanged={async () => {}} openInstructions={() => {}} />
)

export const stories: Story[] = [{
  name: 'Chief of staff settings',
  group: 'Settings',
  what: 'Who the chief of staff is and its state, Start and Stop, the harness, model and effort of the `cos` agent type, and a button to its instructions. It sits above the tree check in Settings › Chief of staff.',
  when: 'Settings, Chief of staff section. Start and Stop call `POST /api/cos/start` and `/api/cos/stop`; a harness, model or effort change saves the `cos` type through `POST /api/types/cos` at once.',
  code: ['web/src/views/CosSettings.tsx#CosSettings'],
  rules: [
    'The status card is the Assistant\'s: the agent\'s glyph, name, state, model and effort, with Start when none runs and Stop when one does (' + ds('Buttons') + ').',
    'A running agent can\'t switch harness or model, so when the type differs from it a note says the change applies to the next chief of staff.',
    'Stop asks to confirm. On a phone the rows stack and controls are `--size-hit-touch` tall (' + ds('Density') + ').',
    'Read-only (a peer): the type controls and the buttons are disabled with the reason on hover.',
    'Only design-system tokens; the page adds no colour, size or duration.',
  ],
  states: [
    { name: 'Running', render: () => show({ cos }) },
    { name: 'None running', render: () => show({ cos: null }) },
    { name: 'Differs from the type', render: () => show({ cos, type: { ...type, model: 'claude-sonnet-5-5', effort: null } }) },
    { name: 'Read-only on a peer', render: () => show({ cos, readOnly: true }) },
  ],
}]
