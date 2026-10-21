// The "While you were away" card at the top of the Inbox (S-2822, S-20): what happened while the human was away, what
// needs them, and what runs next. Each line opens its ITSA or agent. Needs you is a summary that scrolls to the Inbox's
// own Needs you group, not a second list. It collapses to one line and dismisses for the window it shows.
import { useState } from 'react'
import { Icon } from '../Icon'
import { ago } from '../format'
import type { Digest } from './digest'

// The lines a list shows before its `more` count takes over.
const LIMIT = 3

type Props = {
  digest: Digest
  onDismiss: () => void
  onNeeds: () => void
  onItsa: (key: string) => void
  // The agent's id for a name the server sent, or undefined when it resolves to no agent: such a name is shown, not linked.
  agentId: (name: string) => string | undefined
  onAgent: (id: string) => void
  // Open at the start (the card opens; the human collapses it).
  startOpen?: boolean
}

export function DigestCard({ digest: d, onDismiss, onNeeds, onItsa, agentId, onAgent, startOpen = true }: Props) {
  const [open, setOpen] = useState(startOpen)
  const agent = (name: string) => {
    const id = agentId(name)
    return id ? <button type="button" className="dc-link" onClick={() => onAgent(id)}>{name}</button> : <span className="dc-text">{name}</span>
  }
  const { merged, closed, spawned, archived, spend } = d.happened
  // A list's whole count (what the server sent plus its `more`), and the part past LIMIT that the card leaves out.
  const hm = d.happened.more ?? {}
  const nm = d.next.more ?? {}
  const total = (extra: number | undefined, n: number) => n + (extra ?? 0)
  const hidden = (extra: number | undefined, n: number) => total(extra, n) - Math.min(n, LIMIT)
  const happenedN = total(hm.merged, merged.length) + total(hm.closed, closed.length) + total(hm.spawned, spawned.length) + total(hm.archived, archived.length)
  const happenedMore = hidden(hm.merged, merged.length) + hidden(hm.closed, closed.length) + hidden(hm.spawned, spawned.length) + hidden(hm.archived, archived.length)
  const nextMore = hidden(nm.itsas, d.next.itsas.length) + hidden(nm.working, d.next.working.length)
  const needsN = total(d.needsMore, d.needs.length)
  const newN = d.needs.filter((n) => n.new).length
  const since = d.window ? ago(d.window.since) : ''

  // The collapsed line: the counts, in the order the sections take.
  const counts = [
    total(hm.merged, merged.length) ? `${total(hm.merged, merged.length)} merged` : '',
    total(hm.closed, closed.length) ? `${total(hm.closed, closed.length)} closed` : '',
    needsN ? `${needsN} need${needsN === 1 ? 's' : ''} you${newN ? `, ${newN} new` : ''}` : '',
  ].filter(Boolean)
  const summary = counts.length ? counts.join(' · ') : 'nothing new'

  return (
    <section className="digest-card" aria-label="While you were away" data-digest>
      <div className="dc-head">
        <h2 className="dc-title">While you were away</h2>
        {open ? <span className="dc-since">{since ? `since ${since}` : ''}</span> : <span className="dc-summary" data-digest-summary>{summary}</span>}
        <button type="button" className="dc-btn" aria-expanded={open} aria-label={open ? 'Collapse' : 'Expand'} data-digest-toggle onClick={() => setOpen(!open)}>
          <Icon name={open ? 'chevron-up' : 'chevron-down'} size="xs" />
        </button>
        <button type="button" className="dc-btn" aria-label="Dismiss" data-digest-dismiss onClick={onDismiss}>
          <Icon name="x" size="xs" />
        </button>
      </div>
      {open ? <div className="dc-body">
        <div className="dc-sec" data-digest-section="happened">
          <h3 className="dc-sec-h">What happened</h3>
          {happenedN ? null : <div className="dc-muted">Nothing merged, closed, spawned or archived.</div>}
          <ul className="dc-list">
            {merged.slice(0, LIMIT).map((m) => (
              <li key={'m' + m.pr}>
                <span className="dc-kind">Merged</span>
                {m.itsa ? <button type="button" className="dc-link" onClick={() => onItsa(m.itsa!)}>{m.itsa}</button> : null}
                <span className="dc-text">{m.title} <span className="dc-muted">#{m.pr}</span></span>
              </li>))}
            {closed.slice(0, LIMIT).map((c) => (
              <li key={'c' + c.itsa}>
                <span className="dc-kind">Closed</span>
                <button type="button" className="dc-link" onClick={() => onItsa(c.itsa)}>{c.itsa}</button>
                <span className="dc-text">{c.title}</span>
              </li>))}
            {spawned.slice(0, LIMIT).map((s) => (
              <li key={'s' + s.agent + s.at}>
                <span className="dc-kind">Spawned</span>
                {agent(s.agent)}
              </li>))}
            {archived.slice(0, LIMIT).map((a) => (
              <li key={'a' + a.agent + a.at}>
                <span className="dc-kind">Archived</span>
                {agent(a.agent)}
              </li>))}
          </ul>
          {happenedMore ? <div className="dc-more">+{happenedMore} more</div> : null}
          <div className="dc-muted" data-digest-spend>${spend.usd.toFixed(2)} spent</div>
        </div>
        <div className="dc-sec" data-digest-section="needs">
          <h3 className="dc-sec-h">Needs you</h3>
          {needsN ? <button type="button" className="dc-link dc-needs" data-digest-needs onClick={onNeeds}>
            {needsN} {needsN === 1 ? 'thing needs' : 'things need'} you{newN ? <span className="dc-new"> · {newN} new</span> : null}
          </button> : <div className="dc-muted">Nothing needs you.</div>}
        </div>
        <div className="dc-sec" data-digest-section="next">
          <h3 className="dc-sec-h">What's next</h3>
          <ul className="dc-list">
            {d.next.itsas.slice(0, LIMIT).map((i) => (
              <li key={'i' + i.key}>
                <button type="button" className="dc-link" onClick={() => onItsa(i.key)}>{i.key}</button>
                <span className="dc-text">{i.title} <span className="dc-muted">{i.status.replace(/_/g, ' ')}</span></span>
              </li>))}
            {d.next.working.slice(0, LIMIT).map((w) => (
              <li key={'w' + w.agent}>
                {agent(w.agent)}
                {w.detail ? <span className="dc-text">{w.detail}</span> : null}
              </li>))}
          </ul>
          {nextMore ? <div className="dc-more">+{nextMore} more</div> : null}
        </div>
      </div> : null}
    </section>
  )
}
