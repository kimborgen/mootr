import { ConvMailCard } from './ConvMailCard'
import { NoticeLine, TurnFrame } from './TurnFrame'
import { ToolGroup } from './ToolGroup'
import { Rendered } from './Rendered'
import { type Story } from '../stories/types'

const NOW = Date.now()
const reply = <div className="ov-msg ov-assistant"><ToolGroup tools={[{ id: 't1', name: 'Read', input: { file_path: 'web/src/Tree.tsx' }, result: '120 lines', status: 'done' }, { id: 't2', name: 'Bash', input: { command: 'npx vitest run' }, result: '12 passed', status: 'done' }]} /><Rendered text="The filter dropped the third row; fixed, and the test passes." className="ov-text" /></div>
const human = <div className="ov-msg ov-user"><div className="ov-mail-head"><span className="who">You</span></div><Rendered text="Add a fixture test for the tree, then run it." className="ov-text" /></div>
const mail = (from: string) => <div className="ov-msg ov-mail"><ConvMailCard m={{ id: 'fx-m', from_id: from, subject: 'Fixture: check the phone too', body: 'Run the phone check once the test passes.', recipients: [{ id: 'fx-dev', read_at: NOW }], created_at: NOW - 60_000, thread_id: 'fx-th' }} self="fx-dev" /></div>
const NOTICE = 'Child fixture-review finished.\n\nThe review found nothing blocking; two nits are in its mail.'

export const stories: Story[] = [{
  name: 'Conversation turn',
  group: 'Mail',
  what: "One turn of a conversation, drawn like a message in a mail thread (S-1483): the input that opened it (the human's message, a mail, or a stam notice) as a card on top, then the agent's response full width below, until the next input. Turns are separated by a hairline, like a thread's messages. A notice line folds a stam notice to one line; a tap or click opens the rest.",
  when: "In an agent's own view (`web/src/views/OwnView.tsx`), one per turn from `turns()`; what came before the first input is a turn with no card. The mail notice that follows a mail folds into that mail's turn as its line.",
  code: ['web/src/mail/TurnFrame.tsx#TurnFrame', 'web/src/mail/TurnFrame.tsx#NoticeLine'],
  rules: [
    'Turns stack at `--space-4` with a `--border-subtle` hairline and `--space-4` above each after the first; inside a turn the rows keep the same `--space-4` rhythm.',
    "The human's message is raised (`--surface-raised`, `--border-default`); mail between agents is a page sheet on a subtle hairline; a notice is a muted line. The looks are one block in `web/style.css` (`.ov-turn`).",
    'A notice line is `--size-control` high, `--size-hit-touch` on a phone, and cuts its first line with an ellipsis rather than wrapping.',
  ],
  states: [
    { name: "The human's message", render: () => <div className="ov-col"><TurnFrame id="u" kind="human" input={human}>{reply}</TurnFrame></div> },
    { name: 'A mail from an agent', render: () => <div className="ov-col"><TurnFrame id="m" kind="mail" input={mail('fx-cos')}>{reply}</TurnFrame></div> },
    { name: 'A mail from the human', render: () => <div className="ov-col"><TurnFrame id="k" kind="human-mail" input={mail('human')}>{reply}</TurnFrame></div> },
    { name: 'A stam notice', render: () => <div className="ov-col"><TurnFrame id="n" kind="notice" input={<div className="ov-msg ov-system"><NoticeLine text={NOTICE} /></div>}>{reply}</TurnFrame></div> },
    { name: 'Before the first input', render: () => <div className="ov-col"><TurnFrame id="s" kind="start">{reply}</TurnFrame></div> },
  ],
}]
