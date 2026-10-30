// A mailbox's thread lists as index rows (S-4577): what a list shows of each thread, without the bodies, from
// GET /api/agents/:box/thread-index (S-4520). A daemon without that route answers 404; the rows then come from
// the whole threads of GET /api/agents/:box/threads, built here the way the daemon builds them.

import { api, ApiError } from '../api'
import { isPlacedAsk, threadTitle } from '../format'
import type { IndexPage, IndexRow, Mail, Thread, ThreadList } from '../types'

// The ITSAs a thread's mail links, once each in the order they first appear, and the ones it is about.
export function threadLinks(ms: Mail[]): Pick<Required<IndexRow>, 'itsa_links' | 'about_itsas'> {
  const links = new Map<string, Required<IndexRow>['itsa_links'][number]>()
  for (const m of ms) for (const l of m.itsas ?? []) if (!links.has(l.id)) links.set(l.id, { id: l.id, key: l.key, title: l.title, status: l.status })
  return { itsa_links: [...links.values()], about_itsas: [...new Set(ms.flatMap((m) => (m.about_itsa ? [m.about_itsa] : [])))] }
}

// The people in a thread other than the box: the ones attached to its mail first (S-1305), then its senders and
// recipients, each by their latest mail.
export function threadPeople(ms: Mail[], box: string): string[] {
  const out: string[] = []
  const add = (id: string | null | undefined) => { if (id && id !== box && !out.includes(id)) out.push(id) }
  ms.flatMap((m) => m.agents ?? []).forEach(add)
  const latest = [...ms].reverse()
  latest.forEach((m) => add(m.from_id))
  latest.forEach((m) => (m.recipients ?? []).forEach((r) => add(r.id)))
  return out
}

// The row's card text: the first CARD_CHARS characters (code points) of the card mail's summary, else its body.
export const CARD_CHARS = 300

// A thread's index row, as the daemon's indexRow (src/daemon.ts) makes it from the thread's mails, oldest first.
// The card fields follow MailCard's cardMail and cardFrom for the box: the latest mail to it from someone else,
// else the last mail; its sender, else the last other sender, else the last other recipient.
export function indexRow(box: string, t: Thread): IndexRow {
  const ms = t.mails
  const last = ms.at(-1)!
  const toBox = (m: Mail) => m.from_id !== box && (m.recipients ?? []).some((r) => r.id === box)
  const card = ms.findLast(toBox) ?? last
  const from = ms.findLast(toBox) ?? ms.findLast((m) => m.from_id !== box)
  const boxLast = ms.findLast((m) => m.from_id === box || (m.recipients ?? []).some((r) => r.id === box))
  return {
    thread_id: t.thread_id,
    subject: ms[0].subject ?? '',
    title: threadTitle(ms),
    kind: last.kind ?? null,
    itsa_id: ms.find((m) => m.itsa_id)?.itsa_id ?? null,
    from_id: last.from_id,
    from_name: last.from_name ?? null,
    // The newest mail the box sent or received: its place in the list (S-542).
    last_at: (boxLast ?? last).created_at,
    mail_count: ms.length,
    unread: ms.filter((m) => (m.recipients ?? []).some((r) => r.id === box && !r.read_at)).length,
    ask: ms.some((m) => m.permission?.status === 'pending') ? 'pending' : null,
    // The daemon reads 400 characters from the body's first that isn't a space, tab or line break (SQLite
    // substr(ltrim(body)), by code point), then collapses and cuts to 200.
    snippet: Array.from((last.body ?? '').replace(/^[ \t\n\r]+/, '')).slice(0, 400).join('').replace(/\s+/g, ' ').trim().slice(0, 200),
    card_from_id: from?.from_id ?? ms.flatMap((m) => m.recipients ?? []).findLast((r) => r.id !== box)?.id ?? box,
    card_from_name: from?.from_name ?? null,
    card_text: Array.from(card.summary?.trim() || (card.body ?? '').trim()).slice(0, CARD_CHARS).join(''),
    card_title: card.title ?? null,
    card_subject: card.subject ?? '',
    verdict_kind: card.verdict?.kind ?? null,
    about_itsa: card.about_itsa ?? card.itsa_id ?? null,
    itsa_chip: card.itsas?.[0] ? { key: card.itsas[0].key, title: card.itsas[0].title } : null,
    box_last_from: boxLast?.from_id,
    first_created_at: ms[0].created_at,
    last_created_at: last.created_at,
    last_mail_id: last.id,
    perms: ms.flatMap((m) => (m.permission_id ? [{ id: m.permission_id, placed: isPlacedAsk(m) }] : [])),
    ...threadLinks(ms),
    agents: threadPeople(ms, box),
  }
}

export const indexRows = (box: string, ts: Thread[]): IndexRow[] => ts.filter((t) => t.mails.length).map((t) => indexRow(box, t))
// The human's lists as the store holds them (S-4617), from whole threads: for stories and tests.
export const humanRowsOf = (active: Thread[] = [], archived: Thread[] = [], deferred: Thread[] = []): Record<ThreadList, IndexRow[]> =>
  ({ active: indexRows('human', active), archived: indexRows('human', archived), deferred: indexRows('human', deferred) })

// After a 404 the index isn't asked again for INDEX_RECHECK ms: the page keeps the old route until a daemon that
// gained the route (a deploy) can be seen.
export const INDEX_RECHECK = 5 * 60_000
let missingUntil = 0
export const resetIndexRoute = () => { missingUntil = 0 }

// The fallback's own cursor: how many rows the pages before it held.
const FALLBACK = 'old:'

// A route cursor that can't be followed: the route went away (a 404) between pages. The caller starts the list
// again without a cursor, which the old route then answers.
export class IndexRestart extends Error {
  constructor() { super('The thread list has to be read again from the start') }
}
const listQuery: Record<ThreadList, string> = { active: '', archived: '&archived=1', deferred: '&deferred=1' }

// A page of a mailbox's thread list. `limit` defaults to 50, as the route does; `with` keeps the threads with
// that agent, as on /threads.
export async function fetchIndex(box: string, list: ThreadList, opts: { limit?: number; cursor?: string | null; with?: string } = {}): Promise<IndexPage> {
  const limit = opts.limit ?? 50
  const withQ = opts.with ? `&with=${encodeURIComponent(opts.with)}` : ''
  const cursor = opts.cursor ?? null
  if (Date.now() >= missingUntil && !cursor?.startsWith(FALLBACK)) {
    const q = `list=${list}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}${withQ}`
    try {
      return await api<IndexPage>('GET', `/api/agents/${encodeURIComponent(box)}/thread-index?${q}`)
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e
      missingUntil = Date.now() + INDEX_RECHECK
    }
  }
  // A route cursor can't say where the old route's list stands: never answer it with the first page again.
  if (cursor && !cursor.startsWith(FALLBACK)) throw new IndexRestart()
  // The old route has no cursor: ask for the pages before as well, and keep this one.
  const skip = cursor?.startsWith(FALLBACK) ? Number(cursor.slice(FALLBACK.length)) || 0 : 0
  const ts = await api<Thread[]>('GET', `/api/agents/${encodeURIComponent(box)}/threads?limit=${skip + limit}${listQuery[list]}${withQ}`)
  const threads = indexRows(box, ts.slice(skip))
  return { threads, next_cursor: ts.length >= skip + limit ? FALLBACK + (skip + limit) : null }
}
