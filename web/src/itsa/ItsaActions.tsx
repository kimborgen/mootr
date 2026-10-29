// What the human can do to an ITSA that waits on them: the action buttons (Approve, Request
// changes, Answer, from settings.itsa.actions) and the plain API call that applies one. Used
// by the ITSA world's header and by the asking mail in a thread; any view can use it with an
// ITSA from GET /api/itsas/:id (its `actions`) or GET /api/itsas/attention.
//
// A click only stages the action (`onPick`, or the delegated click on `data-itsa-act`); the
// reply box's Send calls `actItsa` with the typed text. Fields it reads: `id` and `actions`
// ({ id, label, to, text }) of the ITSA; `staged` is the id of the staged action.
import { api } from '../api'
import { Icon } from '../Icon'
import { optimistic } from '../optimistic'
import { refreshItsas, refreshSlow } from '../store'
import type { ItsaAction } from '../types'

export const ACTION_ICON: Record<string, string> = { approve: 'check', changes: 'rotate-ccw', answer: 'reply' }

const label = (status: string) => status.replace(/_/g, ' ')

// POST /api/itsas/:id/act { action, text, if_rev, shown_mail }: the human only. The text (a comment
// that interrupts the owner) is posted, then the status moves to the action's target `to`, which
// shows at once (pending) until the daemon has it. `shown` says what the human saw when they staged
// it (S-2998): the ITSA view sends `if_rev`, the revision of the text it showed, and a mail thread
// `shown_mail`, the newest mail it showed. Approve without either, or after the text changed, is
// refused with "the text changed, review again". Throws the daemon's reason, so a caller can keep the draft.
export async function actItsa(id: string, action: string, text: string, to?: string, client_id?: string, shown: { if_rev?: string; shown_mail?: string } = {}): Promise<void> {
  const send = async () => {
    await api('POST', `/api/itsas/${id}/act`, { action, text, client_id, ...shown })
    await Promise.all([refreshItsas(), refreshSlow()])
  }
  if (!to) return send()
  let reason: unknown
  const ok = await optimistic({
    apply: (d) => ({ ...d, itsas: d.itsas.map((x) => (x.id === id ? { ...x, status: to, pending: true } : x)) }),
    send: () => send().catch((e: unknown) => { reason = e; throw e }),
    settled: (p) => p.itsas.some((x) => x.id === id && x.status === to),
    failed: '',
  })
  if (!ok) throw reason
}

// Approve on a batch approval (kind requirement-approval) puts the drafts left in the batch in force.
// `wait`, when set, says why Approve can't be staged yet (what is shown is still loading); Approve is
// disabled with it as its title (S-2998).
export function ItsaActions({ itsa, staged = null, onPick, wait }: { itsa: { id: string; kind?: string | null; actions?: ItsaAction[] }; staged?: string | null; onPick?: (a: ItsaAction) => void; wait?: string }) {
  return <div className="acts">{(itsa.actions ?? []).map((a) => {
    const text = itsa.kind === 'requirement-approval' && a.id === 'approve' ? 'Approve all' : a.label
    return (
    <button key={a.id} type="button" className={'btn' + (a.id === staged ? ' staged' : '')} data-act={a.id} data-itsa-act={a.id} data-itsa={itsa.id} data-label={text} aria-pressed={a.id === staged}
      disabled={!!wait && a.id === 'approve'}
      title={wait && a.id === 'approve' ? wait : `${text}: moves it to ${label(a.to)}${a.text === 'required' ? '; write what you want, then send' : ''}`} onClick={onPick ? () => onPick(a) : undefined}>
      <Icon name={ACTION_ICON[a.id] ?? 'check'} size="xs" />{text}</button>)})}</div>
}
