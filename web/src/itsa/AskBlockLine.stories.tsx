import { Fragment } from 'react'
import { humanRowsOf } from '../mail/thread-index'
import { AGENTS_STOPPED, ASK_ITSA, PERM_DONE, STATUSES, T_ASK, T_DIALOG } from '../stories/mailFixtures'
import { AGENTS } from '../stories/fixtures'
import { ds, type Story } from '../stories/types'
import { Row } from '../stories/helpers'
import { Icon } from '../Icon'
import { AskBlockLine } from './AskBlockLine'
import { ItsaActions } from './ItsaActions'

const base = { itsaStatuses: STATUSES, humanRows: humanRowsOf([T_ASK, T_DIALOG]) }
const holds = { ...base, attention: [ASK_ITSA] }
const stops = { ...base, agents: AGENTS_STOPPED, attention: [ASK_ITSA] }
const dialog = { ...base, perms: [{ ...PERM_DONE, id: 'fx-perm-2', status: 'pending', dialog: 1, agent_id: 'fx-ops' }], agents: AGENTS }

export const stories: Story[] = [{
  name: 'Ask blocking line',
  group: 'Mail',
  what: 'The one line that says what an ask on you holds up: the ITSAs in a human status whose ask is this thread ("Holds S-901") and the agents it stops ("@fixture-ops is stopped until you answer"). It names only what the waits say, so it never claims more. It renders nothing when the ask holds and stops nothing.',
  when: 'Under the ask bar of a thread where an ITSA or a permission request waits on you (the ThreadPanel card), and as a short suffix ("@name stopped") on that thread\'s row in the Mail list (MailSide). Both come from the same `askBlock` definition, so they agree with the ITSA header.',
  code: ['web/src/itsa/AskBlockLine.tsx#AskBlockLine', 'web/src/itsa/askBlock.ts#askBlock', 'web/src/itsa/askBlock.ts#askBlockText', 'web/src/itsa/ItsaActions.tsx#ItsaActions'],
  rules: [
    'Text in `--text-muted` at `--type-chrome-sm` (`--type-chrome-xs` on a Mail row, where it truncates with an ellipsis), with no icon and no fill: a status line, not a badge (`.ask-block` in `web/style.css`).',
    'It counts only what the data ties to the thread: an ITSA whose `ask_thread_id` is the thread, an agent with a human `wait_for` on the thread, or a pending dialog in it. A plain permission request leaves its agent working, so it never counts.',
    'Colour is never the only channel: the words carry the meaning (' + ds('State vocabulary') + ').',
    'The Mail row shows the short form, because the row already shows the ITSA\'s key.',
    'The ask card\'s buttons (`.itsa-ask .acts`) wrap onto a new line rather than run past the card\'s edge, so at 360 px every button stays inside the card and at least `--size-hit-touch` tall (' + ds('Density') + '). On desktop they sit on one line.',
  ],
  states: [
    { name: 'Holds an ITSA', data: holds, render: () => <AskBlockLine thread="fx-t-ask" /> },
    { name: 'Holds an ITSA and stops an agent', data: stops, render: () => <AskBlockLine thread="fx-t-ask" /> },
    { name: 'Ask card with its three buttons', data: holds, render: () => (
      <div className="story-pad">
        <div className="perm pending itsa-ask" data-itsa-ask>
          <span className="perm-label"><Icon name="user" size="xs" />Waiting on you</span><span className="spacer" />
          <AskBlockLine thread="fx-t-ask" />
          <ItsaActions itsa={ASK_ITSA} />
        </div>
      </div>) },
    { name: 'Stopped by a dialog', data: dialog, render: () => <AskBlockLine thread="fx-t-dialog" /> },
    { name: 'Short form, as on a Mail row', data: stops, render: () => <AskBlockLine thread="fx-t-ask" short /> },
    { name: 'Holds nothing, so nothing shows', data: base, render: () => <Fragment><p className="muted">Nothing between the lines:</p><AskBlockLine thread="fx-t-ask" /></Fragment> },
    { name: 'No thread', data: base, render: () => <Row items={[{ label: 'null', node: <AskBlockLine thread={null} /> }, { label: 'undefined', node: <AskBlockLine thread={undefined} /> }]} /> },
  ],
}]
