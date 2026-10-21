// What a mail thread's tab shows in its chips slot (S-2311, S-1471 §2a): the wait mark, the linked
// ITSAs and the agents in the thread. Plain data from the store, so the tab and its thin bar read
// one set and the tests can drive it without a view.
import { plainSubject, threadTitle } from '../format'
import { hasPendingPermission, threadWaitsOnHuman, type Data } from '../store'
import type { Itsa, Mail, MailItsa, Thread } from '../types'

// The one wait mark a thread's tab shows, by priority: a pending permission, a wait on the human's
// answer, the unread count, deferred, archived. `count` is the unread mails and is 0 otherwise.
export type WaitMark = { kind: 'perm' | 'human' | 'unread' | 'deferred' | 'archived'; count: number }
export function threadWaitMark(s: { perm: boolean; onHuman: boolean; unread: number; deferred: boolean; archived: boolean }): WaitMark | null {
  if (s.perm) return { kind: 'perm', count: 0 }
  if (s.onHuman) return { kind: 'human', count: 0 }
  if (s.unread) return { kind: 'unread', count: s.unread }
  if (s.deferred) return { kind: 'deferred', count: 0 }
  if (s.archived) return { kind: 'archived', count: 0 }
  return null
}

// The ITSAs the thread's mail links to (`m.itsas`) or is about (`about_itsa`), once each, in the
// order they first appear. The store's ITSA is used when it holds one; a link the store lacks is
// built from the link's own key, title and status, as the thread head builds its chip. An `about_itsa`
// the store lacks has no link data, so it has no chip.
export function threadItsas(mails: Mail[], itsas: Itsa[]): Itsa[] {
  const links = new Map<string, MailItsa>()
  for (const m of mails) for (const l of m.itsas ?? []) if (!links.has(l.id)) links.set(l.id, l)
  const ids = new Set<string>(links.keys())
  for (const m of mails) if (m.about_itsa) ids.add(m.about_itsa)
  return [...ids].flatMap((id) => {
    const x = itsas.find((i) => i.id === id)
    if (x) return [x]
    const l = links.get(id)
    return l ? [{ id: l.id, key: l.key, title: l.title, status: l.status, parent_id: null, owner: null } as unknown as Itsa] : []
  })
}

// The agents in the thread, the human left out: the ones attached to its mail first (S-1305), then
// its senders and recipients, each by their latest mail. `known` says which ids are agents.
export function threadAgents(mails: Mail[], known: (id: string) => boolean): string[] {
  const out: string[] = []
  const add = (id: string | null | undefined) => { if (id && id !== 'human' && known(id) && !out.includes(id)) out.push(id) }
  mails.flatMap((m) => m.agents ?? []).forEach(add)
  const latest = [...mails].reverse()
  latest.forEach((m) => add(m.from_id))
  latest.forEach((m) => m.recipients.forEach((r) => add(r.id)))
  return out
}

// The thread as the store holds it: the loaded copy when a view has it open, else the list's.
export function threadOf(tid: string, d: Data): Thread | undefined {
  return [...d.openThreads, ...d.humanThreads, ...d.humanArchived, ...d.humanDeferred].find((x) => x.thread_id === tid)
}

// The tab's title is the thread's short title, else its subject; the tooltip names the subject,
// the people and the count.
export function threadHead(mails: Mail[], agents: { id: string; name: string }[]): { title: string; tooltip: string } {
  const subject = plainSubject(mails[0]?.subject)
  const people = [...new Set(mails.flatMap((m) => [m.from_id, ...m.recipients.map((r) => r.id)]))]
  const names = people.map((id) => (id === 'human' ? 'you' : agents.find((a) => a.id === id)?.name ?? id))
  const n = mails.length
  return {
    title: threadTitle(mails) ?? subject,
    tooltip: [subject, names.join(', '), `${n} message${n === 1 ? '' : 's'}`].filter(Boolean).join(' · '),
  }
}

// Everything the chips slot of a thread's tab shows, read from the store.
export function threadChips(tid: string, d: Data) {
  const t = threadOf(tid, d)
  const mails = t?.mails ?? []
  const unread = mails.filter((m) => m.recipients.some((r) => r.id === 'human' && !r.read_at)).length
  const mark = threadWaitMark({
    perm: !!t && hasPendingPermission(t),
    onHuman: threadWaitsOnHuman(tid, d),
    unread,
    deferred: d.humanDeferred.some((x) => x.thread_id === tid),
    archived: d.humanArchived.some((x) => x.thread_id === tid),
  })
  return { mark, itsas: threadItsas(mails, d.itsas), agents: threadAgents(mails, (id) => d.agents.some((a) => a.id === id)) }
}
