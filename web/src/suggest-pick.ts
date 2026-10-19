// What the Alt+A prompt (S-1461) does with its text: when it asks the daemon for suggestions,
// and where a message goes once the human has picked one, or picked none.
import { useEffect, useRef } from 'react'
import { selectAgent, selectThread, sendToAgentByMail, topTarget, type TopTarget } from './actions'
import { api } from './api'
import { recentIds } from './nav-history'
import { byId, getData, refreshSlow, type Data } from './store'
import type { Agent, Mail, SearchResult } from './types'
import { recipients } from './views/ThreadView'
import { handoffDraft, type SendPayload } from './Composer'
import * as shell from './shell/layout'

// The pause after the last keystroke before it asks; a space asks at once.
export const IDLE_MS = 300
export const SUGGEST_LIMIT = 6
// The pause after the last keystroke before the Decision Model rescores what was shown (S-1465).
export const RESCORE_IDLE_MS = 800

// The query a text asks about: its words, trimmed. Empty asks nothing.
export const queryOf = (text: string) => text.trim().replace(/\s+/g, ' ')
// A space (or a new line) just typed after a word asks at once, without the idle pause.
export const asksNow = (text: string) => /\S\s$/.test(text)

export const suggestPath = (q: string, recent: string[], limit = SUGGEST_LIMIT) =>
  `/api/suggest?${new URLSearchParams({ q, recent: recent.join(','), limit: String(limit) })}`
export const rescorePath = (q: string, recent: string[]) =>
  `/api/suggest/rescore?${new URLSearchParams({ q, recent: recent.join(',') })}`

// The rescoring pass (S-1465): once the text has been still for RESCORE_IDLE_MS, asks the daemon to
// rescore the suggestions for it, and hands `apply` the rescored list with the query it is for. A
// newer text aborts the ask. Nothing is handed over when the setting is off or the model fails (null).
export function useRescore(text: string, on: boolean, apply: (q: string, rs: SearchResult[]) => void): void {
  const applyRef = useRef(apply)
  useEffect(() => { applyRef.current = apply })
  useEffect(() => {
    const q = on ? queryOf(text) : ''
    if (!q) return
    const ctl = new AbortController()
    const t = window.setTimeout(() => {
      api<SearchResult[] | null>('GET', rescorePath(q, recentIds()), undefined, ctl.signal).then(
        (rs) => { if (!ctl.signal.aborted && Array.isArray(rs)) applyRef.current(q, rs) },
        () => {})
    }, RESCORE_IDLE_MS)
    return () => { clearTimeout(t); ctl.abort() }
  }, [text, on])
}

// Where a send goes. `fallback` is no pick: the top target, marked as routed by default.
export type Route =
  | { kind: 'agent'; agent: Agent }
  | { kind: 'thread'; thread: string; title: string }
  | { kind: 'itsa'; owner: Agent; itsa: string }
  // `target` is the top target as it was when Send was pressed, so a retry goes where the first try did.
  | { kind: 'fallback'; target?: TopTarget }

// The route for a pick; a string says why it can't be sent there.
export function routeFor(pick: SearchResult | null, d: Data = getData()): Route | string {
  if (!pick) return { kind: 'fallback' }
  if (pick.kind === 'agent') {
    // An agent on a peer the list hasn't loaded yet is mailed by its id and name all the same.
    const a = byId(pick.id) ?? ({ id: pick.id, name: pick.title } as Agent)
    return { kind: 'agent', agent: a }
  }
  if (pick.kind === 'thread') return { kind: 'thread', thread: pick.id, title: pick.title }
  if (pick.kind === 'itsa') {
    const x = d.itsas.find((i) => i.id === pick.id)
    if (!x) return `${pick.title} isn't loaded yet`
    if (!x.owner || x.owner === 'human') return `${x.key} has no agent owner to mail`
    const owner = byId(x.owner) ?? ({ id: x.owner, name: x.owner } as Agent)
    return { kind: 'itsa', owner, itsa: x.key }
  }
  return `A ${pick.kind} can't be written to`
}

// Who a send goes to, for the box's label and the outbox's notice.
export function routeName(r: Route): string {
  if (r.kind === 'agent') return r.agent.name
  if (r.kind === 'thread') return r.title
  if (r.kind === 'itsa') return `${r.owner.name}, about ${r.itsa}`
  return (r.target ?? topTarget()).name
}

// Sends a message on its route. A thread reply goes to the people who wrote in it, as the
// thread's own reply box does; an ITSA mails its owner, filed on the ITSA; no pick mails the
// top target with `routing_uncertain`, so the server notes it was routed by default (S-1462).
// `extra`: more fields for the mail, such as the bottom bar's `looking_at` (S-1474).
export async function sendOn(r: Route, p: SendPayload, extra?: Record<string, unknown>): Promise<string> {
  if (r.kind === 'agent') return sendToAgentByMail(r.agent, p, undefined, extra)
  if (r.kind === 'itsa') return sendToAgentByMail(r.owner, p, r.itsa, extra)
  if (r.kind === 'thread') {
    const mails = await api<Mail[]>('GET', `/api/threads/${encodeURIComponent(r.thread)}`)
    const last = mails.at(-1)
    if (!last) throw new Error(`${r.title} has no mail to reply to`)
    const to = [...new Set([...recipients(mails), ...(p.cc ?? [])])]
    if (!to.length) throw new Error(`Nobody in ${r.title} can get a reply`)
    await api('POST', '/api/mail', { from: 'human', to, inferred: recipients(mails), reply_to: last.id, body: p.text, ...extra,
      attachments: p.files.map((f) => ({ name: f.name, content_b64: f.content_b64 })), client_id: p.client_id })
    refreshSlow()
    return `Replied in ${r.title}`
  }
  const t = r.target ?? topTarget()
  // The assistant before it has started has no mailbox: its own send starts it with the message.
  if (!t.agent) return t.send(p, { routing_uncertain: true, ...extra })
  return sendToAgentByMail(t.agent, p, undefined, { routing_uncertain: true, ...extra })
}

// Go to (S-1463): opens the item's world and hands the prompt's text and files to the prompt input
// there, as a draft added after the one it already holds. Returns the draft key it wrote to.
export function goTo(r: SearchResult, text: string, files: Parameters<typeof handoffDraft>[2]): string | null {
  let key: string
  if (r.kind === 'agent') {
    selectAgent(r.id)
    // The agent's pane is its terminal or its conversation view, whichever it opened.
    const shown = shell.activeIn('main')
    key = shown === 'agent:' + r.id || shown === 'view:' + r.id ? shown : 'view:' + r.id
  } else if (r.kind === 'thread') { selectThread(r.id); key = 'thread:' + r.id }
  else if (r.kind === 'itsa') { shell.showAgentWorld('w:itsa:' + r.id); key = 'itsa:' + r.id }
  else return null
  handoffDraft(key, text, files)
  return key
}
