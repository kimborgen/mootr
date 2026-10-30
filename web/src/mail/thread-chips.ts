// What a mail thread's tab shows in its chips slot (S-2311, S-1471 §2a): the wait mark, the linked
// ITSAs and the agents in the thread. Plain data from the store, so the tab and its thin bar read
// one set and the tests can drive it without a view.
import { plainSubject, threadTitle } from '../format'
import { hasPendingPermission, humanIndex, humanRow, threadWaitsOnHuman, type Data } from '../store'
import type { IndexRow, Itsa, Mail } from '../types'
import { threadLinks, threadPeople } from './thread-index'

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
export const threadItsas = (mails: Mail[], itsas: Itsa[]): Itsa[] => linkedItsas(threadLinks(mails), itsas)
// The same from an index row's links (S-4579).
export function linkedItsas(row: Pick<Required<IndexRow>, 'itsa_links' | 'about_itsas'>, itsas: Itsa[]): Itsa[] {
  const links = new Map(row.itsa_links.map((l) => [l.id, l]))
  const ids = new Set<string>([...links.keys(), ...row.about_itsas])
  return [...ids].flatMap((id) => {
    const x = itsas.find((i) => i.id === id)
    if (x) return [x]
    const l = links.get(id)
    return l ? [{ id: l.id, key: l.key, title: l.title, status: l.status, parent_id: null, owner: null } as unknown as Itsa] : []
  })
}

// The agents in the thread, the human left out: the ones attached to its mail first (S-1305), then
// its senders and recipients, each by their latest mail. `known` says which ids are agents.
export const threadAgents = (mails: Mail[], known: (id: string) => boolean): string[] => threadPeople(mails, 'human').filter(known)

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
// A thread tab's head from the store: the loaded copy when a view has it open, else the thread's index row in the
// human's lists (S-4580), whose people are you and the row's agents.
export function threadTabHead(tid: string, d: Data): { title: string; tooltip: string } {
  const open = d.openThreads.find((x) => x.thread_id === tid)
  const row = open ? undefined : humanRow(tid, d)
  if (!row) return threadHead(open?.mails ?? [], d.agents)
  const subject = plainSubject(row.subject)
  const names = ['you', ...(row.agents ?? []).map((id) => d.agents.find((a) => a.id === id)?.name ?? id)]
  const n = row.mail_count
  return { title: row.title ?? subject, tooltip: [subject, names.join(', '), `${n} message${n === 1 ? '' : 's'}`].filter(Boolean).join(' · ') }
}

// Everything the chips slot of a thread's tab shows, read from the store: the copy a view has loaded, else the
// thread's index row in the human's lists (S-4579). A row without the links or people shows no such chips.
export function threadChips(tid: string, d: Data) {
  const known = (id: string) => d.agents.some((a) => a.id === id)
  const open = d.openThreads.find((x) => x.thread_id === tid)
  const row = humanRow(tid, d)
  const mails = open?.mails ?? []
  const mark = threadWaitMark({
    perm: open ? hasPendingPermission(open) : row?.ask === 'pending',
    onHuman: threadWaitsOnHuman(tid, d),
    unread: open ? mails.filter((m) => m.recipients.some((r) => r.id === 'human' && !r.read_at)).length : row?.unread ?? 0,
    deferred: humanIndex(d, 'deferred').some((x) => x.thread_id === tid),
    archived: humanIndex(d, 'archived').some((x) => x.thread_id === tid),
  })
  if (open || !row) return { mark, itsas: threadItsas(mails, d.itsas), agents: threadAgents(mails, known) }
  return { mark, itsas: linkedItsas({ itsa_links: row.itsa_links ?? [], about_itsas: row.about_itsas ?? [] }, d.itsas), agents: (row.agents ?? []).filter(known) }
}
