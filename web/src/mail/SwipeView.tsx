// The Swipe view, `w:swipe` (S-1003): your inbox's threads as a stack of cards, the newest on
// top. Pull the top card left to archive its thread, right to leave it (it goes to the back of
// the stack; nothing changes on the server), up to defer it; tap it to open the thread. On a
// desktop the arrow keys do the same, Enter opens, z undoes, and a mouse drags the card too.
// Archive and defer are the inbox's own calls (setThreadArchived, setThreadDeferred). A thread
// that waits on your answer refuses archive as it does there, and the card springs back; defer
// is allowed (S-1068): the ask stays under To answer.
// Archiving a Decision or Blocker card asks first (S-1310): the card springs back and a confirm bar
// replaces the buttons; Archive, Enter or ← confirms, Cancel or Escape keeps the card. Defer, leave
// and open never ask.
// Archiving or deferring the opened thread comes back here (openFromSwipe).
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { openFromSwipe, setThreadArchived, setThreadDeferred } from '../actions'
import { Icon } from '../Icon'
import { Loading } from '../Loading'
import { currentWorld, useShell } from '../shell/layout'
import { hasPendingPermission, threadWaitsOnHuman, useData } from '../store'
import { tokenMs } from '../system/springs'
import type { Thread } from '../types'
import { cardKind } from './cardKind'
import { cardMail, cardPlain, MailCard } from './MailCard'
import { dragCard, dragTransform, flyTo, keyAction, pinFront, pullAction, stackOrder, threshold, type SwipeAction } from './swipeCard'

// What the stack remembers while the page is open, across opening a thread and coming back:
// the threads left at the back, and the last action, for Undo.
const left = new Map<string, string>()
let last: { action: SwipeAction; tid: string; text: string } | null = null
// The card on top, kept there until it is acted on (pinFront).
let pinned: string | null = null

const VERB: Record<SwipeAction, string> = { archive: 'Archived', leave: 'Left', defer: 'Deferred' }
const REFUSED: Record<'archive', string> = { archive: 'Answer what waits on you before archiving' }

// Runs an action on a thread: archive and defer through the inbox's helpers, leave locally.
// Resolves false when the daemon refused it; the thread is then back in the inbox, and on top.
function run(action: SwipeAction, t: Thread): Promise<boolean> {
  if (action === 'leave') {
    left.delete(t.thread_id)
    left.set(t.thread_id, t.mails.at(-1)!.id)
    return Promise.resolve(true)
  }
  return action === 'archive' ? setThreadArchived(t.thread_id, true) : setThreadDeferred(t.thread_id, true)
}

export function SwipeView() {
  const { humanThreads, loaded, decisions, attention } = useData()
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const order = pinFront(stackOrder(humanThreads, left), pinned)
  pinned = order[0]?.thread_id ?? null
  const top = order[0] as Thread | undefined
  const blocked = !!top && threadWaitsOnHuman(top.thread_id)
  const kind = top ? cardKind({
    waiting: hasPendingPermission(top) || decisions.some((x) => x.thread_id === top.thread_id) || attention.some((x) => x.ask_thread_id === top.thread_id),
    verdictKind: cardMail(top).verdict?.kind,
  }) : 'general'
  // The thread whose archive waits on a confirm; only the card on top can be confirming.
  const [confirm, setConfirm] = useState<string | null>(null)
  const confirming = !!top && confirm === top.thread_id
  const card = useRef<HTMLDivElement>(null)
  // The keys need focus in the view: the Swipe button that opened it (or the thread it came back
  // from) keeps focus outside it. Each time the view comes on screen it takes focus, unless you
  // are typing somewhere.
  const root = useRef<HTMLDivElement>(null)
  const shown = useRef(false)
  useShell()
  useEffect(() => {
    const on = currentWorld() === 'w:swipe'
    if (on && !shown.current && !document.activeElement?.closest('input, textarea, select, [contenteditable=true]')) root.current?.focus({ preventScroll: true })
    shown.current = on
  })
  const ghostEl = useRef<HTMLDivElement>(null)
  // The card leaving the stack, drawn over it while it flies off.
  const [ghost, setGhost] = useState<{ t: Thread; action: SwipeAction; from: string; n: number } | null>(null)
  // Which way the card is pulled while it moves, and whether lifting it now fires.
  const [hint, setHint] = useState<{ action: SwipeAction; armed: boolean } | null>(null)
  const hintKey = useRef('')

  const fire = (action: SwipeAction, from: string, confirmed = false) => {
    if (!top) return
    setConfirm(null)
    if (action === 'archive' && blocked) {
      // The inbox's refusal; the card stays.
      void run(action, top)
      return springBack()
    }
    if (action === 'archive' && !confirmed && (kind === 'decision' || kind === 'blocker')) {
      setConfirm(top.thread_id)
      return springBack()
    }
    const t = top
    pinned = null
    // The card's element stays when the stack keeps it on top (the last card, left); it starts at rest.
    if (card.current) { card.current.style.transition = 'none'; card.current.style.transform = '' }
    setGhost((g) => ({ t, action, from, n: (g?.n ?? 0) + 1 }))
    const m = cardMail(t)
    last = { action, tid: t.thread_id, text: cardPlain(m) }
    void run(action, t).then((ok) => { if (!ok && last?.tid === t.thread_id) last = null; bump() })
    bump()
  }
  const springBack = () => {
    const el = card.current
    if (!el) return
    el.style.transition = 'transform var(--duration-slow) var(--ease-out)'
    el.style.transform = ''
  }
  const undo = () => {
    const l = last
    if (!l) return
    last = null
    if (l.action === 'archive') void setThreadArchived(l.tid, false)
    else if (l.action === 'defer') void setThreadDeferred(l.tid, false)
    else left.delete(l.tid)
    pinned = l.tid
    bump()
  }
  const open = () => { if (top) openFromSwipe(top.thread_id) }

  // The top card follows the pointer; the hint changes only when its direction or arming does.
  useEffect(() => {
    const el = card.current
    if (!el) return
    return dragCard(el, {
      onPull: (dx, dy) => {
        el.style.transition = 'none'
        el.style.transform = dragTransform(dx, dy)
        const p = pullAction(dx, dy, threshold(el.getBoundingClientRect().width))
        const next = p.action ? { action: p.action, armed: p.progress >= 1 } : null
        const key = next ? next.action + next.armed : ''
        if (key !== hintKey.current) { hintKey.current = key; setHint(next) }
      },
      onRelease: (action, dx, dy) => {
        hintKey.current = ''
        setHint(null)
        if (action) fire(action, dragTransform(dx, dy))
        else springBack()
      },
    })
  })

  // The ghost starts where the card was let go and flies off the way it went, then goes.
  useLayoutEffect(() => {
    const el = ghostEl.current
    if (!ghost || !el) return
    const ms = tokenMs(el, '--duration-base')
    if (!ms) { setGhost(null); return }
    el.style.transitionDuration = ''
    void el.offsetWidth
    el.classList.add('fly')
    el.style.transform = flyTo(ghost.action)
    const t = setTimeout(() => setGhost(null), ms + 50)
    return () => clearTimeout(t)
  }, [ghost?.n])

  // The desktop's keys, while this view is the world on screen and nothing else has the keyboard.
  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      if (currentWorld() !== 'w:swipe' || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return
      // A key another part of the page has focus for (the agent tree's arrows) isn't the stack's.
      const focus = document.activeElement
      if (focus && focus !== document.body && !focus.closest('.swipe-view')) return
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest('input, textarea, select, [contenteditable=true]') || document.querySelector('.menu, .spawn-panel, #search-palette, #top-world.open')) return
      if (confirming) {
        // The confirm bar has the keys: Enter or ← archives, anything else keeps the card.
        // A focused button or link keeps its own Enter: Cancel's click keeps the card.
        if (e.key === 'Enter' && target?.closest('button, a')) return
        if (e.key === 'Enter' || e.key === 'ArrowLeft') { e.preventDefault(); fire('archive', '', true) }
        else if (keyAction(e.key) || e.key === 'Escape') { e.preventDefault(); setConfirm(null) }
        return
      }
      const k = keyAction(e.key)
      if (!k || (k === 'open' && target?.closest('button, a'))) return
      e.preventDefault()
      if (k === 'open') open()
      else if (k === 'undo') undo()
      else fire(k, '')
    }
    addEventListener('keydown', keys)
    return () => removeEventListener('keydown', keys)
  })

  const lastShown = last
  const hintClass = (a: SwipeAction) => `swipe-hint ${a}${hint?.action === a ? ' on' : ''}${hint?.action === a && hint.armed ? ' armed' : ''}${a === 'archive' && blocked ? ' blocked' : ''}`
  const btnTitle = (a: 'archive' | 'defer', label: string) => (a === 'archive' && blocked ? REFUSED[a] : label)
  return (
    <div className="swipe-view" data-swipe-view ref={root} tabIndex={-1}>
      <div className="swipe-bar">
        <h2>Swipe</h2>
        <span className="count" data-swipe-count>{order.length ? `${order.length} in your inbox` : ''}</span>
        {lastShown ? <span className="swipe-last" data-swipe-last>{VERB[lastShown.action]}: <span className="t">{lastShown.text}</span>
          <button className="btn text" data-swipe-undo onClick={undo} title="Undo (z)">Undo</button></span> : null}
      </div>
      {!top ? (!loaded.mail ? <Loading className="empty-pane" /> : (
        <div className="empty-pane swipe-empty" data-swipe-empty>
          <div className="eyebrow">Swipe</div>
          <h3>Nothing left to swipe</h3>
          <p>Mail agents send you shows here as cards, newest on top.</p>
          {lastShown ? <button className="btn" onClick={undo}><Icon name="rotate-ccw" size="xs" />Undo {VERB[lastShown.action].toLowerCase()}</button> : null}
        </div>)) : (
        <div className="swipe-main">
          <div className="swipe-stage">
            <span className={hintClass('archive')} aria-hidden="true"><Icon name="archive" size="xs" />{blocked ? 'Answer first' : 'Archive'}</span>
            <span className={hintClass('leave')} aria-hidden="true">Leave<Icon name="arrow-right" size="xs" /></span>
            <span className={hintClass('defer')} aria-hidden="true"><Icon name="alarm-clock" size="xs" />Defer</span>
            <div className="swipe-deck">
              {order.slice(1, 3).map((t, i) => <div key={t.thread_id} className={`swipe-edge d${i + 1}`} aria-hidden="true" />)}
              <MailCard key={top.thread_id} ref={card} thread={top} onTap={open} className="swipe-top" />
              {ghost ? <MailCard key={'ghost' + ghost.n} ref={ghostEl} thread={ghost.t} className="swipe-ghost" style={{ transform: ghost.from || undefined }} /> : null}
            </div>
          </div>
          {confirming ? (
            <div className="swipe-confirm" role="alertdialog" aria-label={`Archive this ${kind}?`} data-swipe-confirm>
              <p>Archive this {kind}?</p>
              <div className="swipe-actions">
                <button className="btn" data-swipe-confirm-cancel onClick={() => setConfirm(null)} title="Keep the card (Escape)">Cancel<span className="kbd">Esc</span></button>
                <button className="btn primary" data-swipe-confirm-yes autoFocus onClick={() => fire('archive', '', true)} title="Archive the thread (Enter)"><Icon name="archive" size="xs" />Archive<span className="kbd">Enter</span></button>
              </div>
            </div>
          ) : (
          <div className="swipe-actions" role="group" aria-label="Card actions">
            <button className="btn" data-swipe-act="archive" disabled={blocked} title={btnTitle('archive', 'Archive the thread (←)')} onClick={() => fire('archive', '')}><Icon name="archive" size="xs" />Archive<span className="kbd">←</span></button>
            <button className="btn" data-swipe-act="defer" title={btnTitle('defer', 'Defer: save it for later (↑)')} onClick={() => fire('defer', '')}><Icon name="alarm-clock" size="xs" />Defer<span className="kbd">↑</span></button>
            <button className="btn" data-swipe-act="leave" title="Leave it: next card, nothing changes (→)" onClick={() => fire('leave', '')}>Leave<span className="kbd">→</span></button>
            <button className="btn" data-swipe-act="open" title="Open the thread (Enter)" onClick={open}><Icon name="corner-down-left" size="xs" />Open<span className="kbd">Enter</span></button>
          </div>)}
          <p className="swipe-help muted">Swipe left to archive, right to leave, up to defer; tap to open.</p>
        </div>)}
    </div>
  )
}
