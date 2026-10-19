// A mail as a card inside a conversation (S-1483): an agent's own view draws each mail to or
// from it this way, and an ITSA thread can too, since it takes a plain mail-like object. The
// header has the sender and recipients, whether they read it, and when; then the subject and
// body. A long body starts as a three-line plain preview (unless `full`); Open thread opens its thread.
// Mail from or to the human reads apart from mail between agents (`kim`); the variants'
// look is one block in web/style.css (`.conv-mail`).
import { useState, type ReactNode } from 'react'
import { selectThread } from '../actions'
import { Icon } from '../Icon'
import { agentBase } from '../files/fileBase'
import { byId } from '../store'
import { HEALTH } from '../itsa/itsa'
import { clock } from '../waits'
import { Rendered } from './Rendered'
import { Avatar, nameFor } from './ThreadPanel'

type At = string | number
export interface ConvMail {
  id: string
  from_id: string
  from_name?: string | null
  subject?: string | null
  body: string
  recipients: { id: string; name?: string | null; read_at?: At | null }[]
  created_at: At
  thread_id?: string | null
  superseded_by?: string | null
  kind?: string | null
  health?: string | null
}

const LONG_MAIL = 320
const ms = (t: At) => (typeof t === 'number' ? t : Date.parse(t))
const who = (id: string, name?: string | null) => byId(id) ? <a key={id} href="#" data-open-agent={id}>{nameFor(id)}</a> : <span key={id}>{nameFor(id, name)}</span>
const names = (rs: ConvMail['recipients']) => rs.flatMap((r, i) => [i ? ', ' : null, who(r.id, r.name)])

// A mail to or from the human, as against mail between agents.
export const withHuman = (m: ConvMail) => m.from_id === 'human' || m.recipients.some((r) => r.id === 'human')

// Which way a mail to or from the human goes, for the rail and the chip.
export const youDir = (m: ConvMail): 'from' | 'to' | null => m.from_id === 'human' ? 'from' : m.recipients.some((r) => r.id === 'human') ? 'to' : null

export function YouChip({ dir }: { dir: 'from' | 'to' | null }) {
  return dir ? <span className={'chip you-chip you-' + dir}><Icon name="user" size="xs" />{dir === 'from' ? 'From you' : 'To you'}</span> : null
}

// The mail's type: an update with its health, or an ask.
export function MailKind({ m }: { m: Pick<ConvMail, 'kind' | 'health'> }) {
  if (m.kind === 'update') {
    const h = m.health ? HEALTH[m.health] : null
    return <div className="itsa-health"><span className="badge">Update</span>{h ? <span className="health" style={{ color: h.tone }}><i />{h.label}</span> : null}</div>
  }
  return m.kind === 'ask' ? <div className="itsa-health"><span className="badge warn">Asks you</span></div> : null
}

// Read once every recipient has read it, at the last one's time.
function ReadChip({ rs }: { rs: ConvMail['recipients'] }) {
  const read = rs.filter((r) => r.read_at)
  if (rs.length && read.length === rs.length) {
    const at = Math.max(...read.map((r) => ms(r.read_at!)))
    return <span className="chip ov-mail-read" title={new Date(at).toLocaleString()}><Icon name="check" size="xs" />Read {clock(at)}</span>
  }
  return <span className="chip ov-mail-read unread">{read.length ? `Read by ${read.length} of ${rs.length}` : 'Unread'}</span>
}

// self: whose conversation this is; a mail it sent heads with who it went to.
// full: the whole body, no preview cut and no Show all (an ITSA thread reads every mail).
// The You chip hides on a mail the viewer's agent sent to the human alone: its header already reads "To you".
// chip: a slot after the You chip in the header row, before the read chip, for the caller's own marker.
// noThread: no Open thread button, for a caller already inside the thread.
// resolve: finishes the body's embedded attachments, for a caller whose mail has them.
// before, after: slots above the subject and under the body, for the caller's own parts (a superseded line, attachments).
export function ConvMailCard({ m, self, full, chip, noThread, before, after, resolve }: { m: ConvMail; self?: string; full?: boolean; chip?: ReactNode; noThread?: boolean; before?: ReactNode; after?: ReactNode; resolve?: (el: HTMLElement) => void }) {
  const [open, setOpen] = useState(false)
  const long = !full && (m.body.length > LONG_MAIL || m.body.split('\n').length > 5)
  const sent = !!self && m.from_id === self
  const at = ms(m.created_at)
  const dir = youDir(m)
  return (
    <article className={'conv-mail' + (sent ? ' out' : '') + (withHuman(m) ? ' kim' : '') + (dir ? ` ${dir}-you` : '') + (m.superseded_by ? ' superseded' : '')} data-mail={m.id} data-id={m.id}>
      <div className="ov-mail-head">
        <Icon name={sent ? 'send' : 'mail'} size="xs" /><Avatar id={sent ? (m.recipients[0]?.id ?? m.from_id) : m.from_id} />
        {sent ? <span className="who">To {names(m.recipients)}</span>
          : <><span className="who">{who(m.from_id, m.from_name)}</span>{m.recipients.length && !(self && m.recipients.length === 1 && m.recipients[0].id === self) ? <span className="to">to {names(m.recipients)}</span> : null}</>}
        <YouChip dir={sent && m.recipients.length === 1 && m.recipients[0].id === 'human' ? null : dir} />{chip}
        <ReadChip rs={m.recipients} />
        <time title={new Date(at).toLocaleString()}>{clock(at)}</time>
      </div>
      <MailKind m={m} />
      {before}
      {m.subject ? <div className="ov-mail-subj">{m.subject}</div> : null}
      {long && !open ? <p className="ov-mail-snip">{m.body.replace(/\s+/g, ' ')}</p>
        : m.body ? <div className="ov-mail-body"><Rendered text={m.body} className="ov-text" base={agentBase(m.from_id)} resolve={resolve} /></div> : null}
      {after}
      <div className="ov-mail-foot">
        {long ? <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name={open ? 'chevron-down' : 'chevron-right'} size="xs" />{open ? 'Show less' : 'Show all'}</button> : null}
        {m.thread_id && !noThread ? <button type="button" onClick={() => selectThread(m.thread_id!)}><Icon name="external-link" size="xs" />Open thread</button> : null}
      </div>
    </article>
  )
}
