import { selectThread } from '../actions'
import { ago, baseSubject } from '../format'
import { nameFor } from './ThreadPanel'
import type { LinkedThread } from '../types'

// An ITSA's linked mail (S-986): one row per mail thread that names it, newest first. A tap opens the thread.
export function LinkedMail({ rows }: { rows: LinkedThread[] }) {
  return (
    <div className="itsa-mails" data-linked-mail>{rows.map((r) => (
      <button key={r.thread_id} type="button" className="imail" data-thread={r.thread_id} onClick={() => selectThread(r.thread_id)} title={baseSubject(r.subject)}>
        <span className="imail-subj">{baseSubject(r.subject)}</span>
        <span className="imail-people">{nameFor(r.from_id, r.from_name)}{r.mails > 1 ? ` · ${r.mails} mails` : ''}</span>
        <span className="imail-meta"><span className="t" title={new Date(r.last_at).toLocaleString()}>{ago(r.last_at)}</span></span>
      </button>))}</div>
  )
}
