import { LinkedMail } from './LinkedMail'
import { ds, type Story } from '../stories/types'
import type { LinkedThread } from '../types'

const ROWS: LinkedThread[] = [
  { thread_id: 'fx-t-1', subject: 'Re: Which token lifetime for the login fix?', from_id: 'fx-dev', from_name: 'fixture-dev', last_at: new Date(Date.now() - 600_000).toISOString(), mails: 3, source: 'named' },
  { thread_id: 'fx-t-2', subject: 'Review of the branch with a long subject that has to cut at the edge of a narrow phone', from_id: 'fx-review', from_name: 'fixture-review', last_at: new Date(Date.now() - 86_400_000).toISOString(), mails: 1, source: 'itsa' },
]

export const stories: Story[] = [{
  name: 'Linked mail',
  group: 'ITSA and work',
  what: 'The Linked mail section of an ITSA view (S-986): one row per mail thread linked to the ITSA that the Mail section above does not already list, newest first, with the subject, the newest sender, how many of its mails link here, and when. Links come from a sender naming the ITSA, a key in the text, or the ITSA\'s thread; a viewer sees only the mail it may read.',
  when: 'In the ITSA view (`web/src/views/ItsaView.tsx`), after Mail, before the thread or activity, once `GET /api/mail/linked/ID` answers with threads the Mail section lacks; with none, the section is left out.',
  code: ['web/src/mail/LinkedMail.tsx#LinkedMail'],
  rules: [
    'A row is a button the height of a table row, `--size-row-table`, and a tap opens the thread; the subject cuts with an ellipsis rather than wrapping (' + ds('Density') + ').',
    'The times use tabular numerals and `--text-muted`. A link adds no unread count.',
  ],
  states: [
    { name: 'Two threads', render: () => <LinkedMail rows={ROWS} /> },
    { name: 'One thread', render: () => <LinkedMail rows={ROWS.slice(0, 1)} /> },
  ],
}]
