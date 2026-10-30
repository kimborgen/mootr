// The human's threads below the tree, subject lines only: unread dot, message count, age.
// The attention list sits on top: one row per thing waiting on you (`useWaiting`: ITSAs in a
// human status, permission requests, agents waiting for your reply), oldest first, so the
// header's "waiting on you" is the rows under it (a plain wait with no thread stays in To answer). An ITSA
// whose ask mail's thread is in the inbox shows once, as that thread's row with its status. A separator above resizes the list. The header's Awaiting entry lists
// every thread whose latest message is the human's and not yet answered (archived and deferred ones too),
// and its rows carry a clock. The Archived entry switches the list to what archive hides; each
// thread can be opened there and unarchived. On a phone a row swipes left to archive or
// unarchive; on a desktop an archive button shows on hover and focus. Harness dialogs still with
// an agent's parent or the chief of staff (S-594) sit in a collapsed group of their own, off the
// count: read-only, each says what the agent wants (its dialog mail's subject) and who it is with,
// and opens the agent, whose terminal shows the dialog. The To answer entry lists everything still
// waiting on an answer, including a plain agent wait for your reply (kept out of the inbox list), the
// asks whose thread is archived, and the deferred ones, and each leaves when answered or withdrawn (S-984).
// The Swipe entry opens the inbox's threads as a stack of cards in main (`w:swipe`, S-1003).
import { useEffect, useRef, useState } from 'react'
import { openWorld, selectAgent, selectThread, setThreadArchived, setThreadDeferred } from './actions'
import { ago, baseSubject, plainSubject } from './format'
import { Icon } from './Icon'
import { Loading } from './Loading'
import { openedItsa, openItsa, StatusGlyph, statusLabel } from './itsa/itsa'
import { AskBlockLine } from './itsa/AskBlockLine'
import { isPlainWait, useDeferred, useToAnswerCount, useWaiting, type WaitingRow } from './itsa/WaitingList'
import { humanLists, isAwaiting as awaiting, isPending as pending, lastAt, unreadThreads as unreadThreadsOf, type Lists } from './mail/inbox-model'
import { NeedsYouList } from './mail/NeedsYouList'
import { openAskCount } from './mail/needsYou'
import { swipeRow } from './mail/swipeRow'
import { nameFor } from './mail/ThreadPanel'
import { HistorySide } from './HistorySide'
import { currentWorld, useShell } from './shell/layout'
import { byId, useData } from './store'
import { getUi, setUi } from './ui/state'
import type { IndexRow, ItsaAttention, Permission } from './types'

// The tooltip of a row in the Deferred group (S-353): still open, not waiting on you.
const DEFERRED_TIP = 'Deferred: still open; answer any time'
// Who a delegated dialog is with, as mentions (S-594).
const withWhom = (p: Permission) => (p.with?.length ? p.with.map((n) => '@' + n).join(', ') : 'its reviewers')

// The attention list the Inbox shows (see MailSide): one row per thing waiting on you, oldest first. `view` is
// 'inbox' or 'toanswer'; the rows are empty for the other views. The sidebar header's count and the nav badge
// both read it, so they agree. Plain waits (no thread, ask or decision) are left out of the inbox but kept for To answer.
// The lists are index rows (S-4578): `humanLists` of the store's data.
type Thread = IndexRow
export function attentionRows(view: string, lists: Lists, waiting: WaitingRow[]) {
  const { active, archived, deferred } = lists
  const deferredIds = new Set(deferred.map((t) => t.thread_id))
  // To answer also resolves archived threads: an ask stays there while archived or deferred (S-984).
  const inbox = new Map((view === 'toanswer' ? [...active, ...archived, ...deferred] : active).map((t) => [t.thread_id, t]))
  const askRow = new Map<string, ItsaAttention>()
  // An agent's wait tied to a thread folds into that thread's row, which then carries the wait's marker.
  const waitRow = new Map<string, WaitingRow>()
  const att: { at: string; thread: Thread | null; row: WaitingRow | null }[] = []
  const used = new Set<string>()
  // A plain "agent waits for your reply" (no ask, request or decision behind it) only opens the
  // chat: the To answer tab holds it, not the mail list (S-984).
  if (view === 'inbox' || view === 'toanswer') {
    for (const w of view === 'toanswer' ? waiting : waiting.filter((w) => !isPlainWait(w))) {
      const tid = w.itsa ? w.itsa.ask_thread_id : w.threadId
      const t = tid && !used.has(tid) ? inbox.get(tid) : undefined
      if (t) { used.add(t.thread_id); if (w.itsa) askRow.set(t.thread_id, w.itsa); else waitRow.set(t.thread_id, w) }
      att.push({ at: w.since, thread: t ?? null, row: t ? null : w })
    }
    for (const t of view === 'toanswer' ? [...active, ...archived, ...deferred] : active) if (pending(t) && !used.has(t.thread_id) && !deferredIds.has(t.thread_id)) { used.add(t.thread_id); att.push({ at: t.first_created_at ?? t.last_at, thread: t, row: null }) }
    att.sort((a, b) => a.at.localeCompare(b.at))
  }
  return { att, askRow, waitRow, used, inbox }
}

// Harness dialogs still with an agent's parent or the chief of staff (S-594): read-only rows in a collapsed group
// of their own, shared by the Mail list and the Inbox page.
export function DelegatedGroup({ delegated }: { delegated: Permission[] }) {
  const cw = currentWorld()
  if (!delegated.length) return null
  return (
    <details className="mail-delegated" data-delegated-group>
      <summary><Icon name="chevron-right" size="xs" />With parent or chief of staff ({delegated.length})</summary>
      {delegated.map((p) => {
        const name = byId(p.agent_id)?.name ?? p.agent_name ?? p.agent_id
        const open = () => selectAgent(p.agent_id)
        return (
          <div className={`mrow ${p.agent_id === cw ? 'sel' : ''}`} key={p.id} data-delegated={p.id} role="button" tabIndex={0}
            title={`${name} is stopped on a dialog: ${p.action ?? ''} · with ${withWhom(p)}, who deny it or send it on to you${p.created_at ? ' · since ' + new Date(p.created_at).toLocaleString() : ''}`}
            onClick={open} onKeyDown={(e) => { if (e.key === 'Enter') open() }}>
            <Icon name="shield" size="xs" /><span className="s">{p.subject ?? `${name}: ${(p.action ?? 'a dialog').replace(/^Claude Code asks to allow /, '')}`}</span>
            <span className="astat">with {withWhom(p)}</span><span className="t">{p.created_at ? ago(p.created_at) : ''}</span>
          </div>)
      })}
    </details>
  )
}

// In a sidebar pane (`pane`, S-1421) the pane sets the height, so there is no resize separator.
export function MailSide({ leftRef, pane }: { leftRef: React.RefObject<HTMLElement | null>; pane?: boolean }) {
  const d = useData()
  const { decisions, asks, delegateDialogs, loaded } = d
  const lists = humanLists(d)
  const { active: humanThreads, archived: humanArchived, deferred: humanDeferred } = lists
  useShell()
  const waiting = useWaiting()
  const deferred = useDeferred()
  // Which list the header shows: the inbox (with the attention list), the awaiting threads, the archived ones, or the deferred ones (S-976).
  const [view, setView] = useState<'inbox' | 'needsyou' | 'awaiting' | 'archived' | 'deferred' | 'toanswer' | 'history'>('inbox')
  const archived = view === 'archived'
  const archivedIds = new Set(humanArchived.map((t) => t.thread_id))
  const deferredIds = new Set(humanDeferred.map((t) => t.thread_id))
  const cw = currentWorld()
  const sel = cw?.startsWith('t:') ? cw.slice(2) : null
  const side = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [, setTick] = useState(0)
  const height = () => Math.max(64, Math.min(getUi().mailH ?? 260, (leftRef.current?.clientHeight ?? 800) - 160))
  useEffect(() => {
    const on = () => setTick((n) => n + 1)
    addEventListener('resize', on)
    on()
    return () => removeEventListener('resize', on)
  }, [])
  // A row swiped left past half the reveal archives its thread (or unarchives it here).
  useEffect(() => {
    if (!list.current) return
    return swipeRow(list.current, 96, (row) => {
      const tid = row.dataset.thread
      // A request, an ITSA or a decision waiting on the human can't be archived away (the button is disabled too).
      if (tid && !row.classList.contains('ask') && !row.dataset.decision) setThreadArchived(tid, !archivedIds.has(tid))
    })
  }, [view, humanArchived])
  // The unread count is the Inbox page's Unread list (a deferred ask's thread isn't in it).
  const unreadThreads = unreadThreadsOf(lists, waiting, deferred)
  const unreadIds = new Set(unreadThreads.map((t) => t.thread_id))
  const selItsa = cw?.startsWith('w:itsa:') ? openedItsa() : null
  // The attention list: one row per thing waiting on you (`useWaiting`, oldest first), so the
  // header's count is the rows above the mail. Only the inbox has one. An item with a thread in
  // the inbox (an ITSA's ask thread, a request's thread) is that thread's row; any other keeps
  // a row of its own. A pending request's thread is pinned even when the list lacks it.
  const { att, askRow, waitRow, used, inbox } = attentionRows(view, lists, waiting)
  // The deferred asks and decisions (S-353): under the Deferred group at the foot, off the count.
  const def: typeof att = []
  if (view === 'inbox' || view === 'toanswer') {
    for (const w of deferred) {
      const tid = w.itsa ? w.itsa.ask_thread_id : w.threadId
      // A thread set aside with Defer is out of the inbox; To answer and Deferred list it (S-1068).
      if (view === 'inbox' && tid && deferredIds.has(tid)) continue
      const t = tid && !used.has(tid) ? inbox.get(tid) : undefined
      if (t) { used.add(t.thread_id); if (w.itsa) askRow.set(t.thread_id, w.itsa); else waitRow.set(t.thread_id, w) }
      def.push({ at: w.since, thread: t ?? null, row: t ? null : w })
    }
    def.sort((a, b) => a.at.localeCompare(b.at))
  }
  const delegated = view === 'inbox' ? delegateDialogs : []
  const pinned = (t: Thread) => att.some((a) => a.thread === t) || def.some((a) => a.thread === t)
  const awaitingAll = [...humanThreads, ...humanArchived, ...humanDeferred].filter(awaiting)
  const shown = view === 'toanswer' || view === 'needsyou' ? [] : view === 'archived' ? humanArchived : view === 'deferred' ? humanDeferred : view === 'awaiting' ? awaitingAll : humanThreads.filter((t) => !pinned(t))
  // One count for the To answer toggle and its header, one for "waiting on you": the rows this inbox lists (the phone badges and the Issues header count `useWaiting()`, plain waits included).
  const toAnswerN = useToAnswerCount()
  const nAsk = att.length
  const count = [nAsk ? <span key="a" className="asks" title="Everything waiting on you is listed under To answer">{nAsk} waiting on you</span> : null, unreadThreads.length ? `${unreadThreads.length} unread` : null].filter(Boolean)
  // The Needs you count: the open asks the list shows (the same list, so the number and the rows agree).
  const needsN = openAskCount(asks)
  const countNode = view === 'needsyou' ? needsN : view === 'toanswer' ? toAnswerN : view === 'archived' ? humanArchived.length : view === 'deferred' ? humanDeferred.length : view === 'awaiting' ? awaitingAll.length : count.length ? count.map((c, i) => <span key={i}>{i ? ' · ' : ''}{c}</span>) : String(humanThreads.length || '')
  const pick = (v: 'needsyou' | 'awaiting' | 'archived' | 'deferred' | 'toanswer' | 'history') => { setView(view === v ? 'inbox' : v); if (list.current) list.current.scrollTop = 0 }

  // A thread's row. An ITSA waiting on you (x) marks its ask thread's row with its status, and
  // the row opens the ITSA, whose view holds that thread and the action bar; an ask that sits
  // in another thread opens that thread, which shows the same actions on the ask mail. Such a
  // row is the ITSA's (`data-att-itsa`, its thread in `data-ask-thread`): it doesn't swipe to archive.
  const threadRow = (t: Thread, x?: ItsaAttention | null, deferred = false, w?: WaitingRow) => {
    const isUnread = unreadIds.has(t.thread_id), perm = pending(t), decided = decisions.some((d) => d.thread_id === t.thread_id), ask = perm || !!x || decided || !!w, wait = awaiting(t)
    const isArch = archivedIds.has(t.thread_id), isDef = deferredIds.has(t.thread_id), title = t.title
    const why = deferred ? `${DEFERRED_TIP} · ` : x ? `${statusLabel(x.status)}: waits on you · since ${new Date(x.since).toLocaleString()} · ` : perm ? 'Waiting for your approval: ' : decided ? 'Waiting for your decision: ' : w ? 'Waits for your reply: ' : wait ? 'Awaiting reply: ' : ''
    const blocked = x || w ? 'Answer what waits on you before archiving' : perm ? 'Answer the permission request before archiving' : 'Answer the decision before archiving'
    const open = () => (x && x.ask_thread_id === x.thread_id ? openItsa(x.id) : selectThread(t.thread_id))
    return (
      <div className="mrow-wrap" key={t.thread_id}>
        <div className="mrow-act" aria-hidden="true"><Icon name={isArch ? 'archive-restore' : 'archive'} size="xs" />{isArch ? 'Unarchive' : 'Archive'}</div>
        <div className={`mrow ${isUnread ? 'unread' : ''} ${ask ? 'ask' : ''} ${x ? 'att' : ''} ${wait ? 'awaiting' : ''} ${t.thread_id === sel || (x && x.id === selItsa) ? 'sel' : ''}`} data-thread={x ? undefined : t.thread_id} data-ask-thread={x ? t.thread_id : undefined} data-att-itsa={x?.id} data-decision={decided || undefined}
          title={`${why}${baseSubject(t.subject)} · last from ${nameFor(t.from_id, t.from_name)}`} onClick={open}>
          {x ? <StatusGlyph status={x.status} /> : perm ? <Icon name="shield-alert" size="xs" /> : decided ? <Icon name="circle-help" size="xs" /> : w ? <Icon name="user" size="xs" /> : wait ? <Icon name="clock" size="xs" /> : <span className="dot" />}{title ? <span className="chip mtitle">{title}</span> : <span className="s">{plainSubject(t.subject)}</span>}
          {x ? <span className="astat">{statusLabel(x.status)}</span> : decided ? <span className="astat">decision</span> : null}
          {ask ? <AskBlockLine thread={t.thread_id} short /> : null}
          {t.mail_count > 1 ? <span className="badge n">{t.mail_count}</span> : null}
          <span className="row-act two"><span className="t">{ago(lastAt(t))}</span>
            <span className="hover-actions"><button className="icon-btn" data-defer={t.thread_id} title={isDef ? 'Move back to your mail' : ask ? 'Defer: save for later; it stays under To answer' : 'Defer: save for later'}
              aria-label={isDef ? 'Undefer' : 'Defer'}
              onClick={(e) => { e.stopPropagation(); setThreadDeferred(t.thread_id, !isDef) }}><Icon name={isDef ? 'alarm-clock-off' : 'alarm-clock'} size="xs" /></button><button className="icon-btn" data-arch={t.thread_id} disabled={ask || decided || undefined}
              title={ask || decided ? blocked : isArch ? 'Unarchive' : 'Archive'}
              aria-label={ask || decided ? blocked : isArch ? 'Unarchive' : 'Archive'}
              onClick={(e) => { e.stopPropagation(); setThreadArchived(t.thread_id, !isArch) }}><Icon name={isArch ? 'archive-restore' : 'archive'} size="xs" /></button></span></span>
        </div>
      </div>)
  }

  // One pinned row: an ITSA's ask, an agent waiting on you, or a thread of the inbox.
  const attRow = ({ thread: t, row: w, at }: { at: string; thread: Thread | null; row: WaitingRow | null }, deferred = false) => {
      const x = w?.itsa
      const tip = deferred ? DEFERRED_TIP : x ? `${statusLabel(x.status)}: waits on you` : w?.why ?? ''
      if (x) return (
        <div className={`mrow att ask ${x.id === selItsa ? 'sel' : ''}`} key={'i' + x.id} data-att-itsa={x.id} role="button" tabIndex={0}
          title={`${x.key} ${x.title} · ${tip} · since ${new Date(at).toLocaleString()}`}
          onClick={() => openItsa(x.id)} onKeyDown={(e) => { if (e.key === 'Enter') openItsa(x.id) }}>
          <StatusGlyph status={x.status} /><span className="ikey">{x.key}</span><span className="s">{x.title}</span>
          <span className="astat">{statusLabel(x.status)}</span><span className="t">{ago(at)}</span>
        </div>)
      // An agent waiting for your reply, or a request with no thread here: opens the agent (or the request's thread).
      if (w) return (
        <div className={`mrow ask ${w.agent && w.agent.id === cw ? 'sel' : ''}`} key={w.key} data-waiting={w.key} role="button" tabIndex={0}
          title={`${w.who} ${tip}: ${w.what}${at ? ' · since ' + new Date(at).toLocaleString() : ''}`}
          onClick={w.open} onKeyDown={(e) => { if (e.key === 'Enter') w.open() }}>
          <Icon name={w.icon === 'perm' ? 'shield-alert' : w.icon === 'mail' ? 'mail' : 'user'} size="xs" /><span className="s">{w.what}</span>
          <span className="astat">{w.who}</span><span className="t">{at ? ago(at) : ''}</span>
        </div>)
      return threadRow(t!, askRow.get(t!.thread_id), deferred, waitRow.get(t!.thread_id))
  }

  // The separator above the mail list resizes it; the height is remembered.
  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const sep = e.currentTarget
    sep.setPointerCapture(e.pointerId)
    const bottom = side.current!.getBoundingClientRect().bottom
    const move = (ev: PointerEvent) => { getUi().mailH = bottom - ev.clientY; setTick((n) => n + 1) }
    const up = () => { sep.removeEventListener('pointermove', move); sep.removeEventListener('pointerup', up); setUi({ mailH: getUi().mailH }) }
    sep.addEventListener('pointermove', move)
    sep.addEventListener('pointerup', up)
  }
  return (
    <>
      {pane ? null : <div className="sep h side-sep" id="sep-mail" title="Drag to resize the mail list" onPointerDown={drag} />}
      <div className={'mail-side' + (pane ? ' in-pane' : '')} id="mail-side" ref={side} style={pane ? undefined : { height: height() }}>
        {/* Needs you (S-3831) heads the rail, above the mail list: the open count, always shown. */}
        <button className="needs-rail" data-needs-you aria-pressed={view === 'needsyou'} title={view === 'needsyou' ? 'Back to your mail' : 'Every ask waiting on you, and those settled in the last day'}
          onClick={() => pick('needsyou')}>Needs you ({needsN})</button>
        <div className="section eyebrow"><Icon name="mail" size="xs" />{view === 'needsyou' ? 'Needs you' : view === 'archived' ? 'Archived' : view === 'deferred' ? 'Deferred' : view === 'toanswer' ? 'To answer' : view === 'awaiting' ? 'Awaiting reply' : view === 'history' ? 'History' : 'Mail'}
          <span className="count">{countNode}</span>
        </div>
        <div className="mail-views" role="group" aria-label="Mail lists">
          <button className="mail-swipe" data-swipe-toggle aria-pressed={cw === 'w:swipe'} title="Your inbox as cards: swipe left to archive, right to leave, up to defer"
            onClick={() => openWorld('swipe')}><Icon name="layers" size="xs" />Swipe</button>
          <button className="mail-toggle" aria-pressed={view === 'awaiting'} title={view === 'awaiting' ? 'Back to your mail' : 'Threads waiting for an answer from someone'}
            onClick={() => pick('awaiting')}>Awaiting{view === 'awaiting' ? '' : ` (${awaitingAll.length})`}</button>
          <button className="mail-toggle" aria-pressed={archived} title={archived ? 'Back to your mail' : 'Threads you archived'}
            onClick={() => pick('archived')}>{archived ? 'Inbox' : `Archived (${humanArchived.length})`}</button>
          <button className="mail-toggle" aria-pressed={view === 'deferred'} title={view === 'deferred' ? 'Back to your mail' : 'Threads you saved for later'}
            onClick={() => pick('deferred')}>{view === 'deferred' ? 'Inbox' : `Deferred (${humanDeferred.length})`}</button>
          <button className="mail-toggle" data-to-answer aria-pressed={view === 'toanswer'} title={view === 'toanswer' ? 'Back to your mail' : 'Everything still waiting on your answer, archived or deferred too'}
            onClick={() => pick('toanswer')}>To answer{view === 'toanswer' ? '' : ` (${toAnswerN})`}</button>
          {pane ? null : <button className="mail-toggle" data-history-toggle aria-pressed={view === 'history'} title={view === 'history' ? 'Back to your mail' : 'The pages, agents, threads and issues you visited'}
            onClick={() => pick('history')}>{view === 'history' ? 'Inbox' : 'History'}</button>}
        </div>
        {view === 'history' ? <HistorySide bare /> : <div className="mail-side-list" ref={list}>
          {view === 'needsyou' ? <NeedsYouList asks={asks} /> : null}
          {att.map((a) => attRow(a))}
          <DelegatedGroup delegated={delegated} />
          {def.length ? <details className="mail-deferred" data-deferred-group open={view === 'toanswer' || undefined}>
            <summary><Icon name="chevron-right" size="xs" />Decide later ({def.length})</summary>
            {def.map((a) => attRow(a, true))}
          </details> : null}
          {shown.length ? shown.map((t) => threadRow(t)) : !loaded.mail ? <Loading className="mail-empty" /> : att.length || def.length || delegated.length || view === 'needsyou' ? null : <div className="mail-empty muted">{view === 'archived' ? 'Threads you archive show here.' : view === 'deferred' ? 'Threads you defer show here.' : view === 'toanswer' ? 'Nothing waits on your answer.' : view === 'awaiting' ? 'Threads waiting for an answer show here.' : 'Mail agents send you shows here.'}</div>}
        </div>}
      </div>
    </>
  )
}
