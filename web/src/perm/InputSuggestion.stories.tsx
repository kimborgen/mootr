import { InputSuggestion } from './InputSuggestion'
import { AGENTS } from '../stories/fixtures'
import { INPUT, inputWith } from '../stories/mailFixtures'
import { ds, type Story } from '../stories/types'

const inMin = (m: number) => new Date(Date.now() + m * 60000).toISOString()
const ago = (m: number) => new Date(Date.now() - m * 60000).toISOString()
const NOTE = <p className="muted input-note">Only you can approve it, from stam's web UI on fixture-machine. An agent reviewing it can only deny it.</p>
const card = (o = {}, canAnswer = true, thread?: string) => <InputSuggestion p={inputWith(o)} canAnswer={canAnswer} note={NOTE} thread={thread} />
const LONG = '/compact keep the open questions, the failing test names, and the branch name; drop the file listings and the earlier tool output, but keep every decision the human made in this conversation'

export const stories: Story[] = [{
  name: 'Suggested input',
  group: 'Mail',
  what: 'A card for text an agent wants typed into another agent\'s harness input: who it is for and on which machine, the reason, the exact text in a code block (shown as written, with a Copy button), when the suggestion expires, and Approve or Deny. Only the human approves one, and the page sends the hash of the text it showed, so an approval can only type what was on screen. After an answer the card says what came of it (typed, held until the agent is idle, failed, cancelled, expired, denied, withdrawn) and who answered.',
  when: 'In a mail thread, on the mail that carries the suggestion (`permission.kind` is `input`; the mail body is hidden and the card shows instead). It answers from the thread world; in a read-only view (an agent\'s inbox, `MailView`) it says "Open the thread to answer."',
  code: ['web/src/perm/InputSuggestion.tsx#InputSuggestion', 'web/src/perm/input.ts#inputStatus', 'web/src/perm/input.ts#timeLeft', 'web/src/perm/input.ts#heldBox', 'web/src/mail/ThreadPanel.tsx#Card'],
  rules: [
    'A pending card takes the warning fill and border (`--status-warning-bg`, `--status-warning-fg`) like a pending approval, and neutral tokens once answered (' + ds('State vocabulary') + '). The status is always words as well, so colour is never the only channel.',
    'Approve, Deny and Copy are buttons at `--size-hit-touch` tall, so a thumb hits them at 360 px (' + ds('Density') + ').',
    'The text is monospace in a `code-bg` block that wraps (`white-space: pre-wrap`), never scrolls sideways, and is shown as the daemon holds it: what is approved is what is read.',
    'The expiry line is redrawn every 15 s and never animates; Approve and Deny leave when it expires or is answered (S-500).',
    'No toast: the outcome shows on the card itself (' + ds('Persona rules') + ').',
  ],
  states: [
    { name: 'Pending', render: () => card() },
    { name: 'Pending, read only', render: () => card({}, false) },
    { name: 'Long text and reason', render: () => card({ text: LONG, reason: 'The context is 85% full, and the last compaction dropped a decision. This keeps the decisions and drops the noise, so the work goes on without a restart. It can wait a few minutes but not past the next large file read.' }) },
    { name: 'Expires within a minute', render: () => card({ expires_at: inMin(0.5) }) },
    { name: 'Expired', render: () => card({ status: 'expired', expires_at: ago(2) }) },
    { name: 'Typed', render: () => card({ status: 'approved', decided_by: 'human', decided_at: ago(1) }) },
    { name: 'Held until the agent is idle', render: () => card({ status: 'held', decided_by: 'human', decided_at: ago(1) }) },
    { name: 'Held: text in the agent\'s box', render: () => card({ agent_id: 'fx-review', agent_name: 'fixture-review', status: 'held', decided_by: 'human', decided_at: ago(1), note: 'box:draft of a half-written reply' }) },
    { name: 'Failed', render: () => card({ status: 'failed', decided_by: 'human', decided_at: ago(1) }) },
    { name: 'Denied by a reviewer', render: () => card({ status: 'denied', decided_by: 'fx-review', decided_at: ago(3) }) },
    { name: 'Withdrawn', render: () => card({ status: 'withdrawn' }) },
    { name: 'Each harness', render: () => <>{AGENTS.filter((a) => ['fx-dev', 'fx-review', 'fx-ops'].includes(a.id)).map((a) => <InputSuggestion key={a.id} p={inputWith({ id: 'fx-p-' + a.id, agent_id: a.id, agent_name: a.name })} canAnswer note={null} />)}</> },
    { name: 'Unknown agent', render: () => <InputSuggestion p={{ ...INPUT, agent_id: 'fx-gone', agent_name: null }} canAnswer note={null} /> },
  ],
}]
