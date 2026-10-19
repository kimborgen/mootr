// The Inbox page, `w:inbox` (S-2054): your mail as a list. A header with the title, what waits on
// you and what is unread, a search box and the filter chips (To answer, Unread, All, Awaiting,
// Deferred, Archived); the rows, grouped Needs you, Today and Earlier. The page is a list only: a
// thread opens in its own pane to the list's right, and the next one takes that pane's place
// (`openInboxThread`). On a phone a tap pushes the thread, back returns here with the scroll kept,
// and a row swipes left to archive and right to defer, as the sidebar's rows do. A row is the
// thread's latest mail to you: its kind, who wrote, the subject, one line of what it says, its ITSA,
// its age, and a dot while it is unread. Empty, loading and error are words only.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { inboxThread, openInboxThread, setThreadArchived, setThreadDeferred, stepInbox, triageInboxThread, undoInboxTriage } from '../actions'
import { api } from '../api'
import { bottomHandle } from '../bottom-slot'
import { ago, baseSubject, plainSubject } from '../format'
import { Icon } from '../Icon'
import { useDeferred, useToAnswerCount, useWaiting, type WaitingRow } from '../itsa/WaitingList'
import { currentWorld, isPhone, useShell } from '../shell/layout'
import { hasPendingPermission, isUnreadForHuman, useData } from '../store'
import type { Thread } from '../types'
import { cardKind } from './cardKind'
import { sameLine } from './cardSummary'
import { bodyLines, cardFrom, cardMail, cardText, KIND } from './MailCard'
import { FILTERS, filtered, grouped, hitGroup, isAwaiting, needsIds, type Group, type InboxFilter, type SearchHit } from './inbox-model'
import { setInboxOrder } from './inbox-order'
import { swipeRow } from './swipeRow'
import { Avatar, nameFor } from './ThreadPanel'

// The list's scroll, kept while another page or a thread shows (a phone's back returns to it).
let savedScroll = 0
// The reach of a swipe, as the sidebar's.
const REVEAL = 96
const SEARCH_MS = 250

type Hit = SearchHit
type Search = { q: string; hits: Hit[] | null; error: string | null }

// A search for `q` against the daemon's mail search, a moment after the typing stops.
function useSearch(q: string): Search {
  const [res, setRes] = useState<Search>({ q: '', hits: null, error: null })
  useEffect(() => {
    const text = q.trim()
    if (!text) return setRes({ q: '', hits: null, error: null })
    const ctl = new AbortController()
    const timer = setTimeout(() => {
      api<Hit[]>('GET', `/api/mail/search?${new URLSearchParams({ box: 'human', q: text, limit: '30' })}`, undefined, ctl.signal)
        .then((hits) => setRes({ q: text, hits, error: null }))
        .catch((e: Error) => { if (!ctl.signal.aborted) setRes({ q: text, hits: null, error: e.message }) })
    }, SEARCH_MS)
    return () => { clearTimeout(timer); ctl.abort() }
  }, [q])
  return res
}

const EMPTY: Record<InboxFilter, string> = {
  toanswer: 'Nothing waits on your answer.',
  unread: 'Nothing unread.',
  all: 'Mail agents send you shows here.',
  awaiting: 'Threads waiting for an answer show here.',
  deferred: 'Threads you defer show here.',
  archived: 'Threads you archive show here.',
}

// `selected` marks a row open without a pane (the stories' selected row); the page itself reads the open thread from the shell.
export function InboxView({ selected }: { selected?: string }) {
  const d = useData()
  const { humanThreads, humanArchived, humanDeferred, loaded, decisions, attention, itsas } = d
  useShell()
  const waiting = useWaiting()
  const deferred = useDeferred()
  const toAnswerN = useToAnswerCount()
  const [filter, setFilter] = useState<InboxFilter>('all')
  const [query, setQuery] = useState('')
  const search = useSearch(query)
  const list = useRef<HTMLDivElement>(null)
  const searchBox = useRef<HTMLInputElement>(null)

  const lists = { humanThreads, humanArchived, humanDeferred }
  const needs = needsIds(waiting, lists)
  const unreadN = humanThreads.filter(isUnreadForHuman).length
  const awaitingN = [...humanThreads, ...humanArchived, ...humanDeferred].filter(isAwaiting).length
  const count = { toanswer: toAnswerN, unread: unreadN, all: 0, awaiting: awaitingN, deferred: humanDeferred.length, archived: humanArchived.length }
  const searching = query.trim() !== ''
  const shown = filtered(filter, lists, waiting, deferred)
  const groups: Group[] = searching ? (search.hits && search.q === query.trim() ? hitGroup(search.hits, lists) : []) : grouped(shown.threads, needs)
  const loose = searching ? [] : shown.loose

  // The order the rows show in, for advancing to the next thread when the open one is archived or deferred.
  const order = groups.flatMap((g) => g.threads.map((t) => t.thread_id))
  const orderKey = order.join('\n')
  useEffect(() => { setInboxOrder(order) }, [orderKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const archivedIds = new Set(humanArchived.map((t) => t.thread_id))
  const deferredIds = new Set(humanDeferred.map((t) => t.thread_id))
  // Archive and defer by swipe (a touch only): the sidebar's rules. What waits on you can't be archived, but can be deferred.
  const swipes = useRef({ archivedIds, deferredIds })
  swipes.current = { archivedIds, deferredIds }
  useEffect(() => {
    if (!list.current) return
    return swipeRow(list.current, REVEAL, (row) => {
      const tid = row.dataset.thread
      if (tid && !row.classList.contains('ask')) setThreadArchived(tid, !swipes.current.archivedIds.has(tid))
    }, (row) => {
      const tid = row.dataset.thread
      if (tid) setThreadDeferred(tid, !swipes.current.deferredIds.has(tid))
    })
  }, [])

  // The scroll is kept across the page being hidden (a phone's thread, another page): record it while the list shows, put it back when it returns.
  const world = currentWorld()
  useLayoutEffect(() => {
    const el = list.current
    if (el && world === 'w:inbox' && el.scrollTop !== savedScroll) el.scrollTop = savedScroll
  }, [world])
  const onScroll = () => { const el = list.current; if (el && el.offsetParent) savedScroll = el.scrollTop }

  const openTid = selected ?? (world?.startsWith('t:') ? world.slice(2) : inboxThread())
  const open = (tid: string) => openInboxThread(tid)

  // A key moves the open row, which stays in view. A phone's pushed thread leaves the list's scroll to the saved one.
  useEffect(() => {
    if (isPhone() || !openTid) return
    list.current?.querySelector<HTMLElement>(`[data-thread="${openTid}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [openTid])
  // The desktop keys (S-2189), while the page shows: j/k step the rows, e archives and d defers the open thread,
  // r focuses its reply, / searches and z undoes the last triage. Typing in a field, a held Ctrl, Meta, Alt or
  // Shift, an open menu, and the phone all leave the keys to what they are.
  useEffect(() => {
    const keys: Record<string, () => void> = {
      j: () => stepInbox(1),
      k: () => stepInbox(-1),
      e: () => { const tid = inboxThread(); if (tid) void triageInboxThread(tid, 'archive') },
      d: () => { const tid = inboxThread(); if (tid) void triageInboxThread(tid, 'defer') },
      r: () => { if (inboxThread()) bottomHandle()?.focus() },
      '/': () => searchBox.current?.focus(),
      z: () => void undoInboxTriage(),
    }
    const key = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || isPhone() || currentWorld() !== 'w:inbox') return
      if (document.querySelector('.menu, .spawn-panel')) return
      const t = e.target instanceof HTMLElement ? e.target : null
      // Any editing host, a contenteditable nested in another included.
      if (t?.isContentEditable || t?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return
      // Escape clears the selection focus left on a row; the search box leaves its own Escape.
      if (e.key === 'Escape') { if (t?.closest('[data-inbox-row]')) { e.preventDefault(); t.blur() } return }
      const fn = keys[e.key.toLowerCase()]
      if (!fn) return
      e.preventDefault()
      fn()
    }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [])

  const itsaOf = (t: Thread) => {
    const m = cardMail(t)
    const ask = attention.find((x) => x.ask_thread_id === t.thread_id)
    if (ask) return { key: ask.key, title: ask.title }
    const about = m.about_itsa ?? m.itsa_id
    return itsas.find((x) => x.id === about) ?? m.itsas?.[0] ?? null
  }
  const row = (t: Thread) => {
    const m = cardMail(t)
    const from = cardFrom(t)
    const perm = hasPendingPermission(t)
    const ask = perm || decisions.some((x) => x.thread_id === t.thread_id) || attention.some((x) => x.ask_thread_id === t.thread_id)
    const kind = KIND[cardKind({ waiting: ask, verdictKind: m.verdict?.kind })]
    const subject = plainSubject(t.mails[0].subject) || '(no subject)'
    const summary = bodyLines(cardText(m).text, 1, 240)
    const itsa = itsaOf(t)
    const unread = isUnreadForHuman(t)
    const last = t.mails.at(-1)!
    const go = () => open(t.thread_id)
    return (
      <div className="mrow-wrap" key={t.thread_id}>
        <div className="mrow-act defer" aria-hidden="true"><Icon name={deferredIds.has(t.thread_id) ? 'alarm-clock-off' : 'alarm-clock'} size="xs" />{deferredIds.has(t.thread_id) ? 'Undefer' : 'Defer'}</div>
        <div className="mrow-act" aria-hidden="true"><Icon name={archivedIds.has(t.thread_id) ? 'archive-restore' : 'archive'} size="xs" />{archivedIds.has(t.thread_id) ? 'Unarchive' : 'Archive'}</div>
        <div className={`mrow irow${unread ? ' unread' : ''}${ask ? ' ask' : ''}${t.thread_id === openTid ? ' sel' : ''}`} data-thread={t.thread_id} data-inbox-row role="button" tabIndex={0}
          aria-pressed={t.thread_id === openTid}
          title={`${subject} · ${kind.label} · from ${nameFor(from.id, from.name)} · ${new Date(last.created_at).toLocaleString()}`}
          onClick={go} onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) go() }}>
          <div className="ir-top">
            <span className="ir-kind" data-kind={kind.label.toLowerCase()} title={kind.label} aria-label={kind.label}><Icon name={kind.icon} size="xs" /></span>
            <Avatar id={from.id} />
            <span className="s">{subject}</span>
            {itsa ? <span className="chip" data-chip="itsa" title={itsa.title}>{itsa.key}</span> : null}
            {t.mails.length > 1 ? <span className="badge n" title={`${t.mails.length} messages`}>{t.mails.length}</span> : null}
            <span className="t">{ago(last.created_at)}</span>
            {unread ? <span className="dot" role="img" aria-label="Unread" /> : null}
          </div>
          {summary && !sameLine(summary, baseSubject(t.mails[0].subject)) ? <div className="ir-sum">{summary}</div> : <div className="ir-sum" />}
        </div>
      </div>)
  }
  // A wait with no mail thread of yours (To answer only): it opens what waits.
  const looseRow = (w: WaitingRow) => (
    <div className="mrow-wrap" key={w.key}>
      <div className="mrow irow ask" data-waiting={w.key} role="button" tabIndex={0} title={`${w.who} ${w.why}: ${w.what}`}
        onClick={w.open} onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) w.open() }}>
        <div className="ir-top"><span className="s">{w.what}</span><span className="t">{ago(w.since)}</span></div>
        <div className="ir-sum">{w.who} {w.why}</div>
      </div>
    </div>)

  const parts = [waiting.length ? <span key="w" className="asks">{waiting.length} to answer</span> : null, unreadN ? <span key="u">{unreadN} unread</span> : null].filter(Boolean)
  const rows = groups.some((g) => g.threads.length) || loose.length
  const q = query.trim()
  let state: string | null = null
  if (!loaded.mail) state = d.error ? `Couldn't load your mail: ${d.error}` : 'Loading mail…'
  else if (searching && search.error) state = `Couldn't search: ${search.error}`
  else if (searching && !(search.hits && search.q === q)) state = 'Searching…'
  else if (!rows) state = searching ? `Nothing matches “${q}”.` : EMPTY[filter]
  const stateKind = !loaded.mail ? (d.error ? 'error' : 'loading') : searching && search.error ? 'error' : searching && !(search.hits && search.q === q) ? 'loading' : 'empty'

  return (
    <div className="inbox-view" id="inbox-view">
      <div className="inbox-head">
        <h2 className="inbox-title">Inbox</h2>
        <span className="inbox-count" data-inbox-count>{parts.length ? parts.map((p, i) => <span key={i}>{i ? ' · ' : ''}{p}</span>) : `${humanThreads.length} threads`}</span>
        <input className="inbox-search" type="search" aria-label="Search mail" placeholder="Search mail" value={query} data-inbox-search ref={searchBox}
          onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { setQuery(''); e.currentTarget.blur() } }} />
      </div>
      <div className="inbox-chips" role="group" aria-label="Mail lists">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" className="inbox-chip" data-filter={f.id} aria-pressed={!searching && filter === f.id} title={f.tip}
            onClick={() => { setFilter(f.id); setQuery(''); if (list.current) list.current.scrollTop = 0 }}>
            {f.label}{count[f.id] ? <span className="n"> {count[f.id]}</span> : null}
          </button>))}
      </div>
      <div className="inbox-list" ref={list} onScroll={onScroll} data-inbox-list>
        {groups.map((g) => (
          <section className="inbox-group" key={g.key} data-group={g.key} aria-label={g.label}>
            <h3 className="inbox-group-h">{g.label}<span className="n"> {g.threads.length}</span></h3>
            {g.threads.map(row)}
          </section>))}
        {loose.length ? <section className="inbox-group" data-group="loose" aria-label="Also waiting on you">
          <h3 className="inbox-group-h">Also waiting<span className="n"> {loose.length}</span></h3>
          {loose.map(looseRow)}
        </section> : null}
        {state ? <div className="inbox-state muted" data-inbox-state={stateKind} role={stateKind === 'error' ? 'alert' : 'status'}>{state}</div> : null}
      </div>
      <div className="inbox-keys" data-inbox-keys>j/k move · e archive · d defer · r reply</div>
    </div>
  )
}
