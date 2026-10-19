import { ConvMailCard, type ConvMail } from './ConvMailCard'
import { ds, type Story } from '../stories/types'

const NOW = Date.now()
const LONG = Array.from({ length: 8 }, (_, k) => `Line ${k + 1} of the fixture brief: check the tree filter and the phone layout.`).join('\n')
const mail = (o: Partial<ConvMail>): ConvMail => ({ id: 'fx-m1', from_id: 'fx-cos', subject: 'Fixture: please also check the phone', body: 'Please run the phone check once the test passes.', recipients: [{ id: 'fx-dev', read_at: NOW - 240_000 }], created_at: NOW - 300_000, thread_id: 'fx-th-1', ...o })

export const stories: Story[] = [{
  name: 'Conversation mail card',
  group: 'Mail',
  what: "A mail as a card inside a conversation (S-1483): the sender and recipients, whether they read it, and when; the subject and body through the mail renderer; Show all for a long body, which starts as a three-line preview; and Open thread. Mail from or to the human reads raised with a coloured left rail and a chip, \"From you\" or \"To you\", apart from mail between agents; an update or ask shows its type badge. It takes a plain mail-like object, so an ITSA thread can draw it too.",
  when: "In an agent's own view (`web/src/views/OwnView.tsx`): a mail into the agent is the card on top of its turn, and a mail the agent sent is a card among its turn's rows, headed with who it went to.",
  code: ['web/src/mail/ConvMailCard.tsx#ConvMailCard', 'web/src/mail/ConvMailCard.tsx#withHuman', 'web/src/mail/ConvMailCard.tsx#youDir', 'web/src/mail/ConvMailCard.tsx#YouChip', 'web/src/mail/ConvMailCard.tsx#MailKind'],
  rules: [
    'Mail between agents is a `--surface-page` sheet on a `--border-subtle` hairline; mail from or to the human is `--surface-raised` on `--border-default`, like the human\'s own mail in a thread. Square, no tint. The variants are one block in `web/style.css` (`.conv-mail`).',
    'Mail from the human has a 2px `--accent` rail and a chip (`YouChip`, class `you-from` or `you-to`, also drawn above a permission card in the ITSA thread) in `--accent-text` on `--accent-subtle`; mail to the human a `--status-success-fg` rail and a chip in `--status-success-fg` on `--status-success-bg`. The card derives the direction (`youDir`), so the conversation and the ITSA thread (S-1508) share one look; the accent marks the human\'s own mail as selection does (' + ds('Accent, focus, and selection') + '). Mail between agents has neither.',
    'A mail with `kind` update shows an Update badge with its health, and `ask` an Asks you badge, above the subject (`MailKind`).',
    'Unread is a progress chip (`--status-progress-fg` on `--status-progress-bg`); read is a plain chip with the time in tabular numerals.',
    'An incoming mail drops "to NAME" when the only recipient is this agent: in its own view that is every mail, and at 360 px it crowds the sender. Other recipients still show.',
    '`full` renders the whole body with no preview and no Show all. `chip` is a slot in the header row, left of the read chip; the caller styles it, the card adds no look for the human\'s mail beyond the raised sheet.',
    '`noThread` hides Open thread, for a caller already inside the thread (the ITSA thread view, S-1508).',
    '`before` (above the subject) and `after` (under the body) are slots for the caller\'s own parts: the ITSA thread puts the superseded line and the attachments there. A mail with `superseded_by` is dimmed but its header.',
    '`resolve` finishes the body\'s embedded and compared attachments for a caller whose mail has them (the ITSA thread); the card carries `data-id` so a click on an attached PDF finds its mail.',
    'Phone: the header wraps and the recipients take their own line under the sender, so the read chip and time stay visible; on a desktop they ellipsize on the one row.',
    'A file path in the body is a link that opens the file view at its line (S-1529); a relative one resolves in the sender\'s cwd on its machine, and stays text when the sender is not in the registry.',
    'Show all and Open thread are text buttons in `--accent-text`, `--size-hit-touch` high on a phone.',
  ],
  states: [
    { name: 'From an agent, read', render: () => <ConvMailCard m={mail({})} self="fx-dev" /> },
    { name: 'From the human, unread', render: () => <ConvMailCard m={mail({ from_id: 'human', subject: 'Ship the tree fix today', recipients: [{ id: 'fx-dev', read_at: null }] })} self="fx-dev" /> },
    { name: 'Sent to the human and an agent, one read', render: () => <ConvMailCard m={mail({ from_id: 'fx-dev', subject: 'Branch ready', body: 'Two commits, tests green.', recipients: [{ id: 'human', read_at: NOW - 60_000 }, { id: 'fx-cos', read_at: null }] })} self="fx-dev" /> },
    { name: 'File path links', render: () => <ConvMailCard m={mail({ body: 'See `/home/fixture/projects/app/src/daemon.ts:3613` and /home/fixture/projects/app/notes/todo.md.' })} self="fx-dev" full /> },
    { name: 'Long body, preview', render: () => <ConvMailCard m={mail({ body: LONG })} self="fx-dev" /> },
    { name: 'Full: long body, no preview', render: () => <ConvMailCard m={mail({ body: LONG })} self="fx-dev" full /> },
    { name: 'To you, an update', render: () => <ConvMailCard m={mail({ from_id: 'fx-dev', kind: 'update', health: 'on_track', subject: 'Tree fix on track', recipients: [{ id: 'human', read_at: null }] })} self="fx-dev" /> },
    { name: 'Asks you', render: () => <ConvMailCard m={mail({ from_id: 'fx-dev', kind: 'ask', subject: 'Which branch?', recipients: [{ id: 'human', read_at: null }] })} self="fx-dev" /> },
    { name: 'Header chip slot', render: () => <ConvMailCard m={mail({ from_id: 'human', subject: 'Ship the tree fix today', recipients: [{ id: 'fx-dev', read_at: null }] })} chip={<span className="chip">Extra</span>} full /> },
    { name: 'No Open thread button', render: () => <ConvMailCard m={mail({ thread_id: 'fx-t-1' })} full noThread /> },
    { name: 'Many recipients, wraps on a phone', render: () => <ConvMailCard m={mail({ from_id: 'fx-cos', recipients: ['fx-developer-one', 'fx-developer-two', 'fx-reviewer-codex', 'fx-manager-main'].map((id) => ({ id, read_at: NOW })) })} /> },
    { name: 'In a thread: sender and recipients, no viewer', render: () => <ConvMailCard m={mail({ from_id: 'fx-dev', recipients: [{ id: 'fx-cos', read_at: NOW }, { id: 'fx-review', read_at: NOW }], thread_id: null })} /> },
  ],
}]
