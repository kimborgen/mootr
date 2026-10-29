// The Needs you list in the mailbox (S-3831): one row per ask, open ones oldest first, then the asks settled in
// the last day, dimmed, with their outcome. A row is never answered from the list: tapping it opens the ITSA
// or the thread, where the ask card answers it in place.
import { selectAgent, selectThread } from '../actions'
import { holds } from '../itsa/WaitingList'
import { openItsa } from '../itsa/itsa'
import { ago } from '../format'
import type { Ask } from '../types'
import { askKindLabel, askOutcomeLabel, askRows } from './needsYou'

// Where a row opens: its ITSA when it is one, else its thread, else its agent. A thread the human doesn't hold
// opens the agent, as the waiting list does (`openThreadOrAgent`); a thread with no agent still opens the thread.
function openAsk(a: Ask) {
  if (a.itsa_id && a.kind === 'itsa') openItsa(a.itsa_id)
  else if (a.thread_id && (holds(a.thread_id) || !a.agent_id)) selectThread(a.thread_id)
  else if (a.agent_id) selectAgent(a.agent_id)
}

// The second line says what the ask is about only where the endpoint gives something beyond the kind: an ITSA's
// title, a decision's subject. A permission's what is its kind label, already on line one, so it gets no second line.
const hasWhat = (a: Ask) => a.kind === 'itsa' || a.kind === 'decision'

export function NeedsYouList({ asks }: { asks: Ask[] }) {
  const rows = askRows(asks)
  if (!rows.length) return <div className="mail-empty muted">Nothing waits on you, and nothing settled in the last day.</div>
  return (
    <>
      {rows.map((a) => (
        <div key={a.key} className={`mrow ask needs-row ${a.state}`} data-ask={a.key} data-ask-kind={a.kind} data-ask-state={a.state} role="button" tabIndex={0}
          title={`${askKindLabel(a)} · ${a.agent_name ?? 'no agent'} · ${a.what} · ${a.machine}`}
          onClick={() => openAsk(a)} onKeyDown={(e) => { if (e.key === 'Enter') openAsk(a) }}>
          <span className="needs-line">
            <span className="astat">{askKindLabel(a)}</span>
            <span className="ikey">{a.agent_name ?? '—'}</span>
            <span className="chip needs-home" title={a.machine}>{a.machine}</span>
            <span className="t" title={a.state === 'open' ? ago(a.since) : `${askOutcomeLabel(a)} · ${ago(a.settled_at ?? a.since)}`}>{a.state === 'open' ? ago(a.since) : `${askOutcomeLabel(a)} · ${ago(a.settled_at ?? a.since)}`}</span>
          </span>
          {hasWhat(a) ? <span className="s">{a.what}</span> : null}
        </div>
      ))}
    </>
  )
}
