import { ds, type Story } from '../stories/types'
import type { Ask } from '../types'
import { OpenAskLink } from './OpenAskLink'

// Invented fixtures only: the agent, thread and ITSA are made up for the story.
const PERMISSION: Ask = {
  key: 'request:fx-1', kind: 'request', state: 'open', outcome: null, what: 'Permission request',
  agent_id: 'fx-agent', agent_name: 'fixture-dev', machine: 'fixture-home', thread_id: 'fx-thread', itsa_id: null,
  since: '2026-10-24T11:00:00.000Z', settled_at: null,
}
const ITSA: Ask = { ...PERMISSION, key: 'itsa:fx-itsa', kind: 'itsa', what: 'Hold the release until the fixture settles', itsa_id: 'fx-itsa' }

export const stories: Story[] = [{
  name: 'Open ask link',
  group: 'Mail',
  what: 'The link from a blocked agent to the open ask it waits on (S-3977): "Open ask", in the waiting tone with the user mark. It goes straight to the ask\'s card: a permission or mail ask to its home thread, an ITSA ask to its ITSA, where the Waiting-on-you card answers it.',
  when: 'An agent waits on an ask the human owes (a permission, a dialog, a settings change, a suggested input, a decision mail, or an ITSA a wait_for is tied to), on the phone Agents row and the Agents table. The ITSA page shows it only for an ask its owner holds elsewhere. It is shown only while that ask is open: once it settles it goes away.',
  code: ['web/src/mail/OpenAskLink.tsx#OpenAskLink', 'web/src/mail/OpenAskLink.tsx#openAskRow'],
  rules: [
    'The link is a button in the warning colour, underlined, with the user mark; on the phone agent row it is a sibling of the row, at a 44 px touch target (' + ds('Density') + ').',
    'The link names the kind of ask, never its text: the ask card holds the text.',
    'A link whose ask isn\'t in the list shows nothing, rather than pointing at a row that isn\'t there.',
  ],
  states: [
    { name: 'Permission, to its thread', render: () => <OpenAskLink row={PERMISSION} /> },
    { name: 'ITSA, to its page', render: () => <OpenAskLink row={ITSA} /> },
  ],
}]
