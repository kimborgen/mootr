// What the Inbox page lists (S-2054): the filter chips, the three groups, and a search's hits,
// as plain functions over the store's lists, so the page and its tests agree. The human's mail only:
// the lists are the human's inbox, archive and deferred threads.
import type { WaitingRow } from '../itsa/WaitingList'
import { isUnreadForHuman, hasPendingPermission } from '../store'
import type { Thread } from '../types'

export type InboxFilter = 'toanswer' | 'unread' | 'all' | 'awaiting' | 'deferred' | 'archived'
export const FILTERS: { id: InboxFilter; label: string; tip: string }[] = [
  { id: 'toanswer', label: 'To answer', tip: 'Everything still waiting on your answer, archived or deferred too' },
  { id: 'unread', label: 'Unread', tip: 'Threads with mail you have not read' },
  { id: 'all', label: 'All', tip: 'Your inbox' },
  { id: 'awaiting', label: 'Awaiting', tip: 'Threads whose last message is yours and not yet answered' },
  { id: 'deferred', label: 'Deferred', tip: 'Threads you saved for later' },
  { id: 'archived', label: 'Archived', tip: 'Threads you archived' },
]

export interface Lists { humanThreads: Thread[]; humanArchived: Thread[]; humanDeferred: Thread[] }
export type GroupKey = 'needs' | 'today' | 'earlier' | 'results'
export interface Group { key: GroupKey; label: string; threads: Thread[] }

const LABEL: Record<GroupKey, string> = { needs: 'Needs you', today: 'Today', earlier: 'Earlier', results: 'Results' }
export const lastAt = (t: Thread) => t.mails.at(-1)!.created_at
// Awaiting: the human sent the last message, and nobody has answered it.
export const isAwaiting = (t: Thread) => t.mails.at(-1)?.from_id === 'human'
const all = (d: Lists) => [...d.humanThreads, ...d.humanArchived, ...d.humanDeferred]

// The thread a waiting row is about, when it has one.
export const waitThread = (w: WaitingRow) => (w.itsa ? w.itsa.ask_thread_id : w.threadId) ?? null

// The threads that wait on you: `useWaiting`'s rows with a thread, and a pending permission request's thread.
export function needsIds(waiting: WaitingRow[], d: Lists): Set<string> {
  const ids = new Set<string>()
  for (const w of waiting) { const tid = waitThread(w); if (tid) ids.add(tid) }
  for (const t of d.humanThreads) if (hasPendingPermission(t)) ids.add(t.thread_id)
  return ids
}

export interface Shown {
  threads: Thread[]
  // To answer: the waiting rows that have no thread of yours (a plain wait for your reply, say).
  loose: WaitingRow[]
}

// The threads a chip lists. To answer is the same set as the sidebar's To answer list: the waiting rows
// and the deferred ones, archived threads too.
export function filtered(filter: InboxFilter, d: Lists, waiting: WaitingRow[], deferred: WaitingRow[]): Shown {
  const byId = new Map(all(d).map((t) => [t.thread_id, t]))
  // A deferred ask's thread is Deferred's, not the inbox's, while the human's own deferring reply is its last message.
  // A new mail after that brings the thread back to the inbox, as a deferred thread's new mail does.
  // The last mail that involves the human (from them or to them): mail between two agents doesn't bring it back.
  const parked = (tid: string) => byId.get(tid)?.mails.filter((m) => m.from_id === 'human' || m.recipients.some((r) => r.id === 'human')).at(-1)?.from_id === 'human'
  const askIds = new Set(deferred.map(waitThread).filter((x): x is string => !!x && parked(x)))
  const deferredAsks = all(d).filter((t) => askIds.has(t.thread_id) && !d.humanDeferred.some((x) => x.thread_id === t.thread_id))
  switch (filter) {
    case 'toanswer': {
      const threads: Thread[] = []
      const loose: WaitingRow[] = []
      const seen = new Set<string>()
      for (const w of [...waiting, ...deferred]) {
        const t = byId.get(waitThread(w) ?? '')
        if (!t) loose.push(w)
        else if (!seen.has(t.thread_id)) { seen.add(t.thread_id); threads.push(t) }
      }
      for (const t of d.humanThreads) if (hasPendingPermission(t) && !seen.has(t.thread_id)) { seen.add(t.thread_id); threads.push(t) }
      return { threads, loose }
    }
    case 'unread': return { threads: d.humanThreads.filter((t) => isUnreadForHuman(t) && !askIds.has(t.thread_id)), loose: [] }
    case 'awaiting': return { threads: all(d).filter(isAwaiting), loose: [] }
    case 'deferred': return { threads: [...d.humanDeferred, ...deferredAsks], loose: [] }
    case 'archived': return { threads: d.humanArchived, loose: [] }
    default: return { threads: d.humanThreads.filter((t) => !askIds.has(t.thread_id)), loose: [] }
  }
}

// The unread threads the Unread chip lists. The page's count, the bottom bar's and the sidebar's are its length, so they agree.
export const unreadThreads = (d: Lists, waiting: WaitingRow[], deferred: WaitingRow[]): Thread[] => filtered('unread', d, waiting, deferred).threads
export const unreadCount = (d: Lists, waiting: WaitingRow[], deferred: WaitingRow[]) => unreadThreads(d, waiting, deferred).length

// Needs you first (oldest first, as the sidebar's attention list), then today's threads and the earlier
// ones, newest first. A group with no thread isn't returned.
export function grouped(threads: Thread[], needs: Set<string>, now = new Date()): Group[] {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const g: Record<'needs' | 'today' | 'earlier', Thread[]> = { needs: [], today: [], earlier: [] }
  for (const t of threads) g[needs.has(t.thread_id) ? 'needs' : new Date(lastAt(t)).getTime() >= midnight ? 'today' : 'earlier'].push(t)
  g.needs.sort((a, b) => lastAt(a).localeCompare(lastAt(b)))
  g.today.sort((a, b) => lastAt(b).localeCompare(lastAt(a)))
  g.earlier.sort((a, b) => lastAt(b).localeCompare(lastAt(a)))
  return (['needs', 'today', 'earlier'] as const).filter((k) => g[k].length).map((k) => ({ key: k, label: LABEL[k], threads: g[k] }))
}

// A search hit as the API describes it (`MailHit`, src/mail-search.ts).
export interface SearchHit { thread_id: string; subject?: string; latest?: string; people?: string[]; last?: string; excerpt?: string }

// A thread the store doesn't hold (the lists keep the newest 60 each): drawn from the hit's own words, read, and
// from the first person in it other than you. Opening it fetches the thread itself.
export function hitThread(h: SearchHit): Thread {
  return { thread_id: h.thread_id, mails: [{ id: h.latest ?? h.thread_id, from_id: h.people?.find((p) => p !== 'human') ?? 'human', from_name: h.people?.find((p) => p !== 'human') ?? null, subject: h.subject ?? '', body: h.excerpt ?? '', created_at: h.last ?? new Date(0).toISOString(), recipients: [] }] } as unknown as Thread
}

// A search's hits as one group, in the search's order. A hit the store holds is its thread; an older one is drawn from the hit.
export function hitGroup(hits: SearchHit[], d: Lists): Group[] {
  const byId = new Map(all(d).map((t) => [t.thread_id, t]))
  const threads = hits.map((h) => byId.get(h.thread_id) ?? hitThread(h))
  return threads.length ? [{ key: 'results', label: LABEL.results, threads }] : []
}
