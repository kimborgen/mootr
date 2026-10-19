// Rapid-fire mode (S-1004): the conversation view of one agent as a column of mail cards, one per
// thread between you and it. Every send from the prompt input starts a new thread to the agent,
// unless a card is picked: then each send is a follow-up in that thread, until it's unpicked.
// The mode is remembered per agent on this device (ui state); the pick lasts until unpicked or reload.
import { useSyncExternalStore } from 'react'
import { api } from '../api'
import { sendToAgentByMail } from '../actions'
import { sentMail, sentText } from '../mail/MailCard'
import { refreshSlow, type Data } from '../store'
import type { Agent, Mail, Thread, UploadFile } from '../types'
import { getUi, setUi } from '../ui/state'
import { recipients } from './ThreadView'

export const isRapid = (id: string) => !!getUi().rapid?.[id]
export function setRapid(id: string, on: boolean) {
  setUi({ rapid: { ...getUi().rapid, [id]: on } })
  if (!on) setPick(id, null)
}

// The thread picked for follow-ups, per agent. A snapshot, so a send still goes to the thread
// when its card has left the list (archived past the page, say): any mail in a thread joins it.
export interface RapidPick { thread_id: string; reply_to: string; to: string[]; text: string }
let picks: Record<string, RapidPick | null> = {}
const ls = new Set<() => void>()
export const getPick = (id: string) => picks[id] ?? null
export function setPick(id: string, p: RapidPick | null) {
  if ((picks[id] ?? null) === p) return
  picks = { ...picks, [id]: p }
  for (const fn of ls) fn()
}
export const usePick = (id: string) => useSyncExternalStore((fn) => { ls.add(fn); return () => { ls.delete(fn) } }, () => getPick(id))

// A thread is between you and the agent when you mailed it there, or it mailed you there.
const between = (m: Mail, id: string) => (m.from_id === 'human' && m.recipients.some((r) => r.id === id)) || (m.from_id === id && m.recipients.some((r) => r.id === 'human'))
// Every thread between you and the agent in your mailbox (inbox, archived, deferred; the agent's own pages reach past the first 60), oldest
// first by when it started: a card keeps its place as answers arrive, and the newest sits at the
// bottom, next to the prompt input that made it.
export function rapidThreads(id: string, d: Pick<Data, 'humanThreads' | 'humanArchived' | 'humanDeferred'> & { rapidWith?: Data['rapidWith'] }): Thread[] {
  const seen = new Set<string>()
  return [...d.humanThreads, ...d.humanArchived, ...d.humanDeferred, ...d.rapidWith?.[id]?.threads ?? []]
    .filter((t) => !seen.has(t.thread_id) && seen.add(t.thread_id) && t.mails.some((m) => between(m, id)))
    .sort((a, b) => a.mails[0].created_at.localeCompare(b.mails[0].created_at))
}

// A follow-up goes to those who wrote in the thread, as the thread's reply box sends it, and always
// to this view's agent, even where only another agent answered.
const toOf = (t: Thread, id: string) => [...new Set([...recipients(t.mails), id])]
export function pickOf(t: Thread, id: string): RapidPick {
  return { thread_id: t.thread_id, reply_to: t.mails.at(-1)!.id, to: toOf(t, id), text: sentText(sentMail(t)).text }
}

// Where the next send goes: a new thread to the agent, or a follow-up in the picked thread, at its
// latest mail and to its writers now when the list has it, else as it was when picked.
export type RapidTarget = { kind: 'new'; to: string[] } | { kind: 'reply'; thread_id: string; reply_to: string; to: string[] }
export function rapidTarget(id: string, pick: RapidPick | null, threads: Thread[]): RapidTarget {
  if (!pick) return { kind: 'new', to: [id] }
  const t = threads.find((x) => x.thread_id === pick.thread_id)
  return { kind: 'reply', thread_id: pick.thread_id, reply_to: t?.mails.at(-1)?.id ?? pick.reply_to, to: t ? toOf(t, id) : pick.to }
}

// What a key does in the rapid-fire view of agent `id`, only while that view is the active tab:
// Esc unpicks the card; ↑ in an empty prompt input picks the newest card when none is picked.
export function rapidKey(key: string, o: { id: string; active: string | null; picked: boolean; emptyBox: boolean; cards: number }): 'unpick' | 'pick-newest' | null {
  if (o.active !== 'view:' + o.id) return null
  if (key === 'Escape' && o.picked) return 'unpick'
  if (key === 'ArrowUp' && !o.picked && o.emptyBox && o.cards > 0) return 'pick-newest'
  return null
}

export async function sendRapid(a: Agent, target: RapidTarget, { text, files, client_id }: { text: string; files: UploadFile[]; client_id?: string }): Promise<string> {
  if (target.kind === 'new') {
    await sendToAgentByMail(a, { text, files, client_id })
    return `New thread to ${a.name}`
  }
  await api('POST', '/api/mail', { from: 'human', to: target.to, inferred: target.to, reply_to: target.reply_to, body: text,
    attachments: files.map((f) => ({ name: f.name, content_b64: f.content_b64 })), client_id })
  refreshSlow()
  return 'Sent in the picked thread'
}
