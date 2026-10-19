import { Icon } from '../Icon'
import { ACTIONS } from '../stories/itsaFixtures'
import { ds, type Story } from '../stories/types'
import { ItsaActions } from './ItsaActions'

const BATCH_ACTIONS = ACTIONS.slice(0, 2)
// The ITSA view's "Waiting on you" box, which holds the buttons in place.
const asking = (node: React.ReactNode) => (
  <div className="itsa-ask" role="group" aria-label="Waiting on you">
    <span className="ask-label"><Icon name="user" size="xs" />Waiting on you</span>{node}
  </div>)

export const stories: Story[] = [{
  name: 'ITSA actions',
  group: 'ITSA and work',
  what: 'The buttons for what you can do to an ITSA that waits on you: by default Approve, Request changes, and Answer. A button moves the ITSA to the status its action names. Pressing one only stages it; the comment box\'s Send applies it, with the text you typed, which is posted as a comment that interrupts the owner.',
  when: 'In the "Waiting on you" box of an ITSA in a human status (the ITSA view, `w:itsa:ID`), and on the asking mail in a thread. The actions come from the ITSA\'s `actions`, which the daemon takes from settings (`itsa.actions`, per human status); an ITSA with none shows no buttons.',
  code: ['web/src/itsa/ItsaActions.tsx#ItsaActions', 'web/src/itsa/ItsaActions.tsx#actItsa'],
  rules: [
    'Each button is a `.btn` with an icon (check for Approve, rotate for Request changes, reply for Answer) and its label; the staged one is `aria-pressed` and takes `--accent-subtle` with an `--accent` border, and pressing it again unstages it.',
    'The title says where it goes: "Request changes: moves it to in progress; write what you want, then send". An action whose text is required needs words in the comment box before Send works.',
    'On a batch approval (kind `requirement-approval`) Approve reads "Approve all", because it puts every draft left in the batch in force.',
    'The status change shows at once and rolls back with the reason if the daemon refuses; the typed text stays in the box (' + ds('Empty, loading, and error') + ').',
  ],
  states: [
    { name: 'The three actions', render: () => asking(<ItsaActions itsa={{ id: 'fx-i-913', actions: ACTIONS }} />) },
    { name: 'One staged', render: () => asking(<ItsaActions itsa={{ id: 'fx-i-913', actions: ACTIONS }} staged="changes" onPick={() => {}} />) },
    { name: 'Batch approval', render: () => asking(<ItsaActions itsa={{ id: 'fx-i-950', kind: 'requirement-approval', actions: BATCH_ACTIONS }} />) },
    { name: 'No actions, so no buttons', render: () => <p className="muted">Nothing between the lines:<ItsaActions itsa={{ id: 'fx-i-910' }} /></p> },
  ],
}]
