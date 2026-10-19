import { ItsaChips } from './ItsaChips'
import { ds, type Story } from '../stories/types'
import type { MailItsa } from '../types'

const A: MailItsa = { id: 'fx-i-1', key: 'S-986', title: 'Mail linked ITSA chips', status: 'in_progress', source: 'itsa' }
const B: MailItsa = { id: 'fx-i-2', key: 'S-12', title: 'A long ITSA title that has to cut at the edge of a narrow phone', status: 'needs_review', source: 'named' }
const MANY: MailItsa[] = Array.from({ length: 60 }, (_, i) => ({ id: `fx-m-${i}`, key: `S-${462 + i * 8}`, title: 'Linked work item ' + i, status: i % 3 ? 'in_progress' : 'done', source: 'thread' }))
const C: MailItsa = { id: 'fx-i-3', key: 'S-30', title: 'Closed work', status: 'done', source: 'thread' }

export const stories: Story[] = [{
  name: 'ITSA chips',
  group: 'Mail',
  what: 'The ITSAs a mail or thread is linked to (S-986): a sender named one, a key such as `S-12` sits in the text outside code, or the mail is in the ITSA\'s own thread. Each header chip is the ITSA\'s status glyph, key and title; on a message it is a small inline key, shown only for an ITSA that message names; a tap opens the ITSA. A link is not mail: it adds no message and no unread count.',
  when: 'In the thread header (`.th-itsas`, key and title) and on a message\'s sender line (`.msg-itsas`, key only) in the thread panel.',
  code: ['web/src/mail/ItsaChips.tsx#ItsaChips'],
  rules: [
    'Colour is the status glyph, always beside the key and a title attribute, never alone (' + ds('Status') + ').',
    'The thread header chips sit in one row, one chip high, that scrolls sideways when they overflow, so a thread with dozens of ITSAs takes one line; a title cuts with an ellipsis.',
    'Message chips on a sender line still wrap and fold to +N.',
    'A header chip is `--size-control` high on a desktop and `--size-hit-touch` on a phone; a message chip has no box, and on a phone it is `--size-hit-touch` high with negative margins (' + ds('Density') + ').',
  ],
  states: [
    { name: 'Thread header, with titles', render: () => <ItsaChips items={[A, B, C]} className="th-itsas" label="Linked ITSAs" /> },
    { name: 'On a sender line, key only', render: () => <div className="msg"><header><span className="who">fixture-dev</span><ItsaChips items={[A, B]} compact className="msg-itsas" label="Linked ITSAs" /><time>3 h ago</time></header></div> },
    { name: 'Folded to +N', render: () => <div className="msg"><header><span className="who">fixture-dev</span><span className="to">to you</span><ItsaChips items={[A, B, C]} compact max={2} className="msg-itsas" label="Linked ITSAs" /><time>3 h ago</time></header></div> },
    { name: 'Thread header, 60 ITSAs', render: () => <ItsaChips items={MANY} className="th-itsas" label="Linked ITSAs" /> },
    { name: 'One ITSA', render: () => <ItsaChips items={[A]} className="th-itsas" label="Linked ITSAs" /> },
    { name: 'None', render: () => <div><ItsaChips items={[]} className="th-itsas" label="Linked ITSAs" /><p className="muted">Nothing renders.</p></div> },
  ],
}]
