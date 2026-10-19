// A suggested harness input (S-422) on the attention card and in a mail thread: the agent,
// the reason, the exact text it would type (shown as written), when it expires, and Approve or
// Deny. Only the human approves one; the page hashes the text it shows and sends that hash.
import { useEffect, useState, type ReactNode } from 'react'
import { agentAction, archiveThreadAndAdvance } from '../actions'
import { byId, refresh, refreshSlow } from '../store'
import { ago } from '../format'
import { Icon } from '../Icon'
import type { Permission } from '../types'
import { answerInputFull, heldBox, inputStatus, timeLeft } from './input'

// The clock the expiry line reads, redrawn every 15 s.
function useNow(ms = 15000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t) }, [ms])
  return now
}

// `note` shows under the card until it is answered.
// `thread` is the mail thread carrying the card: an answer archives it and opens the next mail, as a reply does.
export function InputSuggestion({ p, canAnswer, note, thread }: { p: Permission; canAnswer: boolean; note?: ReactNode; thread?: string }) {
  const now = useNow()
  const [outcome, setOutcome] = useState<string | null>(null)
  // The daemon's reason for a held answer (a draft in the box), until the server's own record shows it.
  const [why, setWhy] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState(false)
  const text = p.text ?? ''
  // Once answered, here or by the server, the card drops Approve, Deny, and the expiry (S-500).
  const answered = p.status !== 'pending' || !!outcome
  const left = answered ? '' : timeLeft(p.expires_at, now)
  const open = !answered && left !== 'expired'
  // The local answer shows only while the server says pending; once it moves on (held, approved,
  // expired, withdrawn...), the server's status wins. A typed answer names itself on approval.
  const shownOutcome = p.status === 'approved' && outcome === 'typed' ? outcome : null
  const box = heldBox(p)
  const draft = box !== undefined || (p.status === 'pending' && outcome === 'held' && why === 'draft')
  const heldLine = `Held: ${p.agent_name ? `@${p.agent_name}` : 'the agent'}'s box isn't empty`
  const status = p.status === 'pending' ? (outcome ? (outcome === 'held' && draft ? heldLine : inputStatus(p, outcome)) : '') : p.status === 'held' && draft ? heldLine : inputStatus(p, shownOutcome)
  // Who answered and when: the server's record, or this page's own answer until it shows.
  const by = p.decided_by ? (p.decided_by === 'human' ? 'you' : `@${byId(p.decided_by)?.name ?? p.decided_by}`) : outcome ? 'you' : ''
  const when = p.decided_at ? ago(p.decided_at) : outcome ? 'just now' : ''
  const answeredBy = status && by && !['expired', 'withdrawn'].includes(p.status) ? ` · by ${by}${when ? ` · ${when}` : ''}` : ''

  async function answer(approve: boolean) {
    setBusy(true); setErr('')
    try {
      const r = await answerInputFull(p, text, approve)
      const done = r.outcome || (approve ? 'typed' : 'denied')
      setOutcome(done)
      setWhy(r.why ?? '')
      refresh(); refreshSlow()
      // The mail stays open when the answer threw (S-509), the input didn't go in (failed, cancelled, expired),
      // or text in the agent's box holds it: the card then offers a restart (S-534).
      if (thread && (!approve || done === 'typed' || (done === 'held' && r.why !== 'draft'))) void archiveThreadAndAdvance(thread)
    } catch (e) {
      // A 409 names the other machine, a 403 says who may answer: shown as the daemon words them.
      setErr((e as Error).message)
    } finally { setBusy(false) }
  }

  // Text in the agent's input box holds the approval: shown, with a restart that clears it and keeps the conversation.
  const agent = byId(p.agent_id)
  const who = p.agent_name ? `@${p.agent_name}` : 'the agent'
  async function restart() {
    if (!agent) return
    setBusy(true)
    try { await agentAction(agent, 'restart') } finally { setBusy(false) }
  }

  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { setErr("Couldn't copy: select the text instead") }
  }

  return (<>
    <div className={`input-sug ${p.status === 'pending' ? 'pending' : p.status}`} data-input-perm={p.id} data-status={p.status}>
      <div className="input-head">
        <span className="input-to">→ @{p.agent_name ?? 'agent'} on {p.machine}</span>
        {left ? <time className="input-left muted">{left}</time> : null}
      </div>
      {p.reason ? <p className="input-reason">{p.reason}</p> : null}
      <div className="input-text">
        <pre className="code" data-input-text>{text}</pre>
        <button type="button" className="btn" data-input-copy onClick={copy} aria-label="Copy the suggested text">
          <Icon name={copied ? 'check' : 'copy'} size="xs" />{copied ? 'Copied' : 'Copy'}</button>
      </div>
      {open && canAnswer
        ? <div className="input-actions">
          <button type="button" className="btn" data-input-approve disabled={busy} onClick={() => answer(true)}><Icon name="check" />Approve</button>
          <button type="button" className="btn" data-input-deny disabled={busy} onClick={() => answer(false)}>Deny</button>
        </div>
        : open ? <span className="muted input-open">Open the thread to answer.</span> : null}
      {box !== undefined
        ? <div className="input-box" data-input-box>
          <p className="input-box-text">{who}'s box holds text: <code>{box || '(unreadable)'}</code></p>
          {canAnswer && agent && (agent.activity === 'idle' || agent.activity === 'waiting') ? <button type="button" className="btn" data-input-restart disabled={busy} onClick={restart}><Icon name="rotate-ccw" />Restart {who}</button> : null}
        </div>
        : null}
      {status ? <p className="input-status" data-input-status>{status}{answeredBy ? <span className="muted">{answeredBy}</span> : null}</p> : null}
      {err ? <p className="input-err" role="alert">{err}</p> : null}
    </div>
    {answered ? null : note}
  </>)
}
