// Everything waiting on the human, as one list: ITSAs in a human status (the attention list,
// S-39) and agents blocked on you (a permission request, or a `wait_for` human). Each row
// says who waits and why, and opens that ITSA or agent. `useWaiting` is the one definition:
// every count of what waits on you (the phone tabs, the Mail and Issues headers, this list)
// is its length, so they always agree; the list opens from the Issues count. Each thing shows
// once: an agent's wait for your reply folds into the row of the ask its thread is (S-351),
// and a wait with no thread, or another thread, keeps its own row. An agent's mail that holds
// a decision (S-352) is the row of its thread, unless an ITSA's ask or a request already is. An
// agent's wait_for tied to its request (S-609) is that request's one row, and leaves with it.
import { selectAgent, selectThread } from '../actions'
import { Icon } from '../Icon'
import { ago } from '../format'
import { byId, getData, permThread, useData, type Data } from '../store'
import { Loading } from '../Loading'
import { hideMenu, showPopover } from '../ui/menu'
import { isClosed, openItsa, personName, StatusGlyph, statusLabel } from './itsa'
import type { Agent, DecisionMail, ItsaAttention, Permission } from '../types'

export interface WaitingRow {
  key: string
  // Who waits: the owner of the ITSA, or the blocked agent.
  who: string
  // The ITSA's key and title, or what the agent asks.
  what: string
  why: string
  since: string
  icon: 'itsa' | 'perm' | 'user' | 'mail'
  status?: string
  open: () => void
  // What the row is about, for a view that needs more than the text (the Work page's
  // Needs-you group): the ITSA in a human status, the permission request, the agent, and
  // the mail thread to open.
  itsa?: ItsaAttention
  perm?: Permission
  agent?: Agent
  threadId?: string | null
  // The human deferred the ask or decision (S-353): it stays open, but it isn't waiting on them.
  deferred?: boolean
}

// A plain wait for the human's reply: no ask, request or decision behind it, so it only opens the chat (S-984).
export const isPlainWait = (r: WaitingRow) => r.icon === 'user' && !r.itsa && !r.threadId

// A wait's thread can be a raw mail id the daemon couldn't resolve (mail held on a peer); opening it
// would show an empty thread, so a thread the human doesn't hold opens the agent instead.
const holds = (tid: string) => { const d = getData(); return [...d.humanThreads, ...d.humanArchived, ...d.humanDeferred].some((t) => t.thread_id === tid) }
const openThreadOrAgent = (tid: string | undefined, agent?: Agent) => (tid && (holds(tid) || !agent) ? selectThread(tid) : agent && selectAgent(agent.id))

const REQUEST_ID = /^p[0-9a-f]{6}$/

// What a permission request asks: a suggested input says so (its text is the human's to read).
const permWhat = (p: Permission) => (p.kind === 'input' ? 'Suggested input' : p.action ?? 'A permission request')

export function useWaiting(): WaitingRow[] {
  return waitingRows(useData())
}

export function useDeferred(): WaitingRow[] {
  return deferredRows(useData())
}

// What the To answer list holds: everything waiting on the human plus the deferred asks (S-984).
// The list's toggle and its header both show this count.
export function useToAnswerCount(): number {
  const data = useData()
  return waitingRows(data).length + deferredRows(data).length
}

// The rows that wait on the human: every count of them is their length (S-353: deferred rows leave).
export function waitingRows(data: Pick<Data, 'attention' | 'agents' | 'perms' | 'decisions'> & Partial<Pick<Data, 'humanDeferred'>>): WaitingRow[] {
  return allRows(data).filter((r) => !r.deferred)
}

// The asks and decisions the human deferred (S-353): open, listed under the mail list's Deferred group.
export function deferredRows(data: Pick<Data, 'attention' | 'agents' | 'perms' | 'decisions'> & Partial<Pick<Data, 'humanDeferred'>>): WaitingRow[] {
  return allRows(data).filter((r) => r.deferred)
}

// The rows themselves, from the store's data, so they can be tested without rendering.
function allRows({ attention, agents, perms, decisions, humanDeferred = [] }: Pick<Data, 'attention' | 'agents' | 'perms' | 'decisions'> & Partial<Pick<Data, 'humanDeferred'>>): WaitingRow[] {
  // A thread the human deferred with Defer (S-1068) parks its asks too: they leave the counts and stay in To answer.
  const parked = new Set(humanDeferred.map((t) => t.thread_id))
  const rows: WaitingRow[] = attention.filter((x) => !isClosed(x)).map((x) => ({
    key: `i:${x.id}`, who: personName(x.owner), what: `${x.key} ${x.title}`, why: `${statusLabel(x.status)}: waits on you`, since: x.since, icon: 'itsa', status: x.status, open: () => openItsa(x.id), itsa: x, deferred: x.deferred || parked.has(x.ask_thread_id ?? ''),
  }))
  // A reply wait tied to an ask's thread is the answer to that ask: the ITSA's row or the
  // permission request's row (below) stands for it. An untied wait keeps its own row.
  const asks = new Set(rows.map((r) => r.itsa!.ask_thread_id).filter(Boolean))
  const pendingThreads = new Set(perms.filter((p) => p.status === 'pending').map((p) => permThread(p.id)).filter(Boolean))
  // A decision mail is its thread's row. The latest one stands for a thread with several.
  const decided = new Map<string, DecisionMail>()
  for (const d of decisions) {
    if (asks.has(d.thread_id) || pendingThreads.has(d.thread_id)) continue
    const prev = decided.get(d.thread_id)
    if (!prev || d.created_at >= prev.created_at) decided.set(d.thread_id, d)
  }
  for (const d of decided.values()) {
    rows.push({ key: `d:${d.mail_id}`, who: byId(d.from_id)?.name ?? d.from_name ?? d.from_id, what: d.subject, why: 'waits for your decision', since: d.created_at, icon: 'mail', open: () => selectThread(d.thread_id), threadId: d.thread_id, deferred: d.deferred || parked.has(d.thread_id) })
  }
  const asked = new Set<string>()
  for (const a of agents) {
    for (const w of a.waits ?? []) {
      if (w.kind !== 'human') continue
      const perm = w.target ? perms.find((p) => p.id === w.target) : undefined
      // A request is one row (S-609): stam's wait for it and the agent's own wait_for about it fold
      // together, and the agent's wait on a request no longer pending is settled with it.
      if (perm) { if (asked.has(perm.id)) continue; asked.add(perm.id) }
      else if (w.source === 'declared' && REQUEST_ID.test(w.target ?? '')) continue
      else if (w.thread && (asks.has(w.thread) || pendingThreads.has(w.thread) || decided.has(w.thread))) continue
      // A wait tied to a mail thread opens that thread, not the chat (S-984).
      const tid = (perm ? permThread(perm.id) : undefined) ?? w.thread ?? undefined
      rows.push({
        key: `w:${w.id}`, who: a.name, what: perm ? permWhat(perm) : w.detail ?? 'Your reply', why: perm ? 'asks your approval' : 'waits for your reply', since: w.since, icon: perm ? 'perm' : 'user',
        open: () => openThreadOrAgent(tid, a), perm, agent: a, threadId: tid, deferred: !!tid && parked.has(tid),
      })
    }
  }
  // A pending request whose agent has no wait row (the wait is cleared once it is answered).
  for (const p of perms) {
    if (p.status !== 'pending' || asked.has(p.id)) continue
    const a = byId(p.agent_id), tid = permThread(p.id)
    rows.push({ key: `p:${p.id}`, who: a?.name ?? p.agent_id, what: permWhat(p), why: 'asks your approval', since: p.created_at ?? '', icon: 'perm', open: () => openThreadOrAgent(tid, a), perm: p, agent: a, threadId: tid, deferred: !!tid && parked.has(tid) })
  }
  return rows.sort((a, b) => a.since.localeCompare(b.since))
}

function WaitingList() {
  const rows = useWaiting()
  const { loaded } = useData()
  return <>
    <div className="lg-head"><span className="eyebrow">Waiting on you <span className="count">{rows.length || ''}</span></span>
      <button className="icon-btn" data-waiting-close aria-label="Close" onClick={() => hideMenu(true)}><Icon name="x" size="xs" /></button></div>
    {rows.length
      ? <ul className="waiting-list" data-waiting-list>{rows.map((r) => (
        <li key={r.key}><button type="button" className="wrow" data-waiting={r.key} onClick={() => { hideMenu(); r.open() }}>
          <span className="wmark">{r.icon === 'itsa' ? <StatusGlyph status={r.status!} /> : <Icon name={r.icon === 'perm' ? 'shield-alert' : r.icon === 'mail' ? 'mail' : 'user'} size="xs" />}</span>
          <span className="wtext"><span className="wwhat">{r.what}</span><span className="wwhy muted">{r.who} · {r.why}</span></span>
          <span className="wago muted">{r.since ? ago(r.since) : ''}</span></button></li>))}</ul>
      : !loaded.mail || !loaded.itsas || !loaded.agents ? <Loading className="muted" /> : <p className="muted">Nothing waits on you.</p>}
  </>
}

export function showWaiting(trigger: HTMLElement) {
  const r = trigger.getBoundingClientRect()
  showPopover(r.left, r.bottom + 4, 'Waiting on you', <WaitingList />, trigger)
}
