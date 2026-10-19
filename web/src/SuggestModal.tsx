// The Alt+A prompt (S-1461): the prompt input alone, centred over the dimmed page. The human
// writes first; as they type, stam suggests where it could go (agents, mail threads, ITSAs,
// from `GET /api/suggest`) as compact cards above the box. A pick sets the recipient and the
// other cards go; with no pick, the message mails the top target, marked as routed by default.
// The overlay follows the search palette's: a raised panel over the scrim, full screen on a phone.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { openAssistant, topTarget } from './actions'
import { api } from './api'
import { KIND, kindIcon } from './CcPills'
import { Composer, type ComposerHandle, type SendPayload } from './Composer'
import { Icon } from './Icon'
import { recentIds } from './nav-history'
import { closeSearch } from './Search'
import * as shell from './shell/layout'
import { useData } from './store'
import { openPreview, openPreviewAt } from './SuggestPreview'
import { IDLE_MS, SUGGEST_LIMIT, asksNow, goTo, queryOf, routeFor, routeName, sendOn, suggestPath, useRescore, type Route } from './suggest-pick'
import { useLongPress } from './ui/longpress'
import { hideMenu, toast } from './ui/menu'
import { getUi, setUi, useUi } from './ui/state'
import type { SearchResult } from './types'

export const openSuggest = () => { openAssistant(false); closeSearch(); shell.closePhoneOverlay(); setUi({ suggestOpen: true }) }
export const closeSuggest = () => setUi({ suggestOpen: false })
export const toggleSuggest = () => (getUi().suggestOpen ? closeSuggest() : openSuggest())

// One suggestion: its icon, title, one line of snippet, and its kind. `actions` is the slot at
// the card's end for buttons beside the pick (Go to, S-1463).
export function SuggestCard({ r, sel, onPick, onHover, actions }: { r: SearchResult; sel: boolean; onPick: (r: SearchResult) => void; onHover?: () => void; actions?: (r: SearchResult) => ReactNode }) {
  return (
    <div className={'sg-card' + (sel ? ' sel' : '')} role="option" aria-selected={sel} data-suggest={r.kind + ':' + r.id} onMouseEnter={onHover}>
      {/* Pressing a card keeps the caret in the box, so a phone's keyboard stays up. */}
      <button type="button" className="sg-pick" onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(r)} title={`Send it to ${r.title}`}>
        <span className="pal-ico">{kindIcon(r)}</span>
        <span className="sg-t">{r.title}</span>
        <span className="sg-s">{r.snippet ?? ''}</span>
        <span className="sg-k">{KIND[r.kind] ?? r.kind}</span>
      </button>
      <span className="sg-actions" data-card-actions>{actions?.(r)}</span>
    </div>
  )
}

export function SuggestModal() {
  const { suggestOpen } = useUi()
  return suggestOpen ? <SuggestPanel /> : null
}

// The suggestion state both prompts share (S-1474): the Alt+A modal and the bottom bar in suggestion
// mode. Hand its `onInput` to the Composer's `onInput`, and render `list` above the box. `after` runs
// once a send is on its way or Go to has moved the text; `extra` rides on every mail it sends.
export function useSuggest(composer: React.RefObject<ComposerHandle | null>, opts: { after?: () => void; extra?: Record<string, unknown> } = {}) {
  const { after, extra } = opts
  const [text, setText] = useState('')
  const [cards, setCards] = useState<SearchResult[]>([])
  // The card the arrows point at; -1 is none, the box itself.
  const [sel, setSel] = useState(-1)
  const [pick, setPick] = useState<SearchResult | null>(null)
  const asked = useRef('')
  // The query whose embedding order is on screen: a rescored list is only shown for it.
  const shown = useRef('')
  const inflight = useRef<AbortController | null>(null)
  useEffect(() => () => inflight.current?.abort(), [])

  // Asks on a space, or once the typing pauses; a new ask aborts the one in flight. A pick stops it.
  useEffect(() => {
    if (pick) return
    const q = queryOf(text)
    if (!q) { inflight.current?.abort(); asked.current = ''; shown.current = ''; setCards([]); setSel(-1); return }
    if (q === asked.current) return
    const go = () => {
      inflight.current?.abort()
      const ctl = (inflight.current = new AbortController())
      asked.current = q
      api<SearchResult[]>('GET', suggestPath(q, recentIds()), undefined, ctl.signal).then(
        (rs) => { if (!ctl.signal.aborted) { shown.current = q; setCards(rs.filter((r) => r.kind in KIND)); setSel(-1) } },
        () => { if (!ctl.signal.aborted) setCards([]) })
    }
    if (asksNow(text)) { go(); return }
    const t = window.setTimeout(go, IDLE_MS)
    return () => clearTimeout(t)
  }, [text, pick])

  // The Decision Model's order (S-1465) replaces the embedding order once the typing has paused; the
  // cursor follows its card (by kind and id) to the new position, and clears if the card is gone.
  useRescore(text, !pick, (q, rs) => {
    if (q !== shown.current) return
    // At most SUGGEST_LIMIT cards, as the embedding order shows; the arrow stays on the card it was on.
    const kept = rs.filter((r) => r.kind in KIND).slice(0, SUGGEST_LIMIT)
    const was = cards[sel]
    setCards(kept)
    setSel(was ? kept.findIndex((r) => r.kind === was.kind && r.id === was.id) : -1)
  })

  const choose = (r: SearchResult) => {
    inflight.current?.abort()
    setPick(r); setCards([]); setSel(-1)
    composer.current?.focus()
  }
  const unpick = () => { asked.current = ''; setPick(null); composer.current?.focus() }

  const route = routeFor(pick)
  const name = typeof route === 'string' ? '' : routeName(route)
  // The text is on its way: the prompt closes, and a failure says where to find it. The route is
  // fixed now: with no pick, the top target as it is at this press, and a retry goes there too.
  // The pick rides on the outbox row, so a put-back after a failure brings it back.
  const onSubmit = (failed: string) => {
    const fixed: Route | string = typeof route === 'string' || route.kind !== 'fallback' ? route : { kind: 'fallback', target: topTarget() }
    const to = typeof fixed === 'string' ? '' : routeName(fixed)
    if (after) queueMicrotask(after)
    return {
      meta: pick ? { pick } : undefined,
      send: async (p: SendPayload) => {
        if (typeof fixed === 'string') throw new Error(fixed)
        const said = await sendOn(fixed, p, extra)
        toast(said)
        return said
      },
      onFailed: () => toast(`Not sent to ${to || 'its recipient'}: ${failed}`, true),
    }
  }
  const onPutBack = (meta: unknown) => {
    const back = (meta as { pick?: SearchResult } | undefined)?.pick
    if (!back) return
    inflight.current?.abort()
    setPick(back); setCards([]); setSel(-1)
  }
  // Go to: the item opens, and its text and files become a draft in the item's box.
  const goto = (r: SearchResult) => {
    const taken = composer.current?.take() ?? { text: '', files: [] }
    inflight.current?.abort()
    goTo(r, taken.text, taken.files)
    after?.()
  }

  // Preview (S-1910): a hold or right click on a card, the Preview button, or Alt+P on the highlighted
  // card (the best one with none) shows what it is, with a Pick that does what a tap does.
  const hold = useLongPress((at) => {
    const hit = cards.find((c) => at.el.dataset.suggest === c.kind + ':' + c.id)
    if (hit) openPreview(hit, at.x, at.y, choose)
  }, '.sg-card')

  // Up from the box walks the cards from the best (nearest the box) away; down walks back.
  // Enter in the box on a card picks it instead of sending; on a button (Go to) it presses the button.
  const onKey = (e: React.KeyboardEvent) => {
    if (!cards.length) return
    if (e.altKey && e.code === 'KeyP' && !e.ctrlKey && !e.metaKey && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); openPreviewAt(cards[Math.max(sel, 0)], choose); return }
    const ta = e.target as HTMLTextAreaElement
    const firstLine = ta.tagName !== 'TEXTAREA' || !ta.value.slice(0, ta.selectionStart).includes('\n')
    if (e.key === 'ArrowUp' && (sel >= 0 || firstLine)) { e.preventDefault(); setSel((n) => Math.min(n + 1, cards.length - 1)) }
    else if (e.key === 'ArrowDown' && sel >= 0) { e.preventDefault(); setSel((n) => n - 1) }
    else if (e.key === 'Enter' && !e.shiftKey && sel >= 0 && ta.tagName === 'TEXTAREA') { e.preventDefault(); e.stopPropagation(); choose(cards[sel]) }
  }

  const label = pick
    ? <span className="sg-chip" data-pick={pick.kind + ':' + pick.id}>
        <span className="pal-ico">{kindIcon(pick)}</span><b>{typeof route === 'string' ? pick.title : name}</b>
        <button type="button" className="icon-btn sg-unpick" aria-label={`Remove ${pick.title}; suggest again`} title="Remove: suggest again"
          onMouseDown={(e) => e.preventDefault()} onClick={unpick}><Icon name="x" size="xs" /></button>
      </span>
    : <span className="muted sg-default">{text.trim() ? `No pick: goes to ${name}` : `Goes to ${name} unless you pick`}</span>

  const list = <>
    <div className="sg-list" role="listbox" aria-label="Suggested recipients" hidden={!!pick || !cards.length} {...hold}>
      {cards.map((r, i) => <SuggestCard key={r.kind + ':' + r.id} r={r} sel={i === sel} onPick={choose} onHover={() => setSel(i)}
        actions={(c) => <><button type="button" className="sg-prev" data-preview-btn aria-label={`Preview ${c.title}`} onMouseDown={(e) => e.preventDefault()} onClick={() => openPreviewAt(c, choose)} title="Preview (Alt+P, or hold on a phone)"><Icon name="eye" size="xs" /></button><button type="button" className="sg-go" data-go onMouseDown={(e) => e.preventDefault()} onClick={() => goto(c)} title={`Go to ${c.title}, with what you wrote as a draft`}>Go to<Icon name="chevron-right" size="xs" /></button></>} />)}
    </div>
    {typeof route === 'string' ? <p className="sg-why" role="status">{route}</p> : null}
  </>
  const to = route !== null && typeof route === 'object' && route.kind === 'agent' ? route.agent.id : undefined
  return { onInput: setText, onSubmit, onPutBack, onKey, list, label, name, to }
}

function SuggestPanel() {
  useData()
  const composer = useRef<ComposerHandle>(null)
  const s = useSuggest(composer, { after: closeSuggest })
  useEffect(() => {
    const raf = requestAnimationFrame(() => composer.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [])
  return <>
    {/* A scrim click closes a suggestion's preview over the prompt as well, even when it lands before the
      preview's own outside press is listening (S-2020). */}
    <div id="suggest-scrim" onClick={() => { hideMenu(); closeSuggest() }} />
    <section id="suggest-modal" aria-label="Write and send" onKeyDownCapture={s.onKey}
      // Esc closes the prompt unless the box took it first: it discards a recording.
      onKeyDown={(e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); closeSuggest() } }}>
      <header className="sg-head">
        <span className="eyebrow">Write first; pick where it goes</span>
        <span className="spacer" />
        <span className="kbd">Alt+A</span>
        <button className="icon-btn" title="Close (Esc)" aria-label="Close" onClick={closeSuggest}><Icon name="x" /></button>
      </header>
      {s.list}
      <Composer ref={composer} className="inline" noCcPills onSend={async () => { throw new Error('Not sent') }} onInput={s.onInput} onSubmit={() => s.onSubmit('press Alt+A to put it back in the box')} onPutBack={s.onPutBack}
        target={{ key: 'suggest', enabled: true, name: s.name, to: s.to, label: s.label, placeholder: 'Write your message; mootr suggests where it goes' }} />
    </section>
  </>
}

// The bottom bar in suggestion mode (S-1474): the main world has nothing to write to, so the one
// prompt input suggests where the text could go, as the Alt+A prompt does. It sends mail only, and
// each mail carries what the main world showed as a system note.
export function SuggestBar({ composerRef, context }: { composerRef: React.RefObject<ComposerHandle | null>; context: string }) {
  const s = useSuggest(composerRef, { extra: { looking_at: context } })
  return <div style={{ display: 'contents' }} onKeyDownCapture={s.onKey}>
    {s.list}
    <Composer ref={composerRef} noCcPills onSend={async () => { throw new Error('Not sent') }} onInput={s.onInput} onSubmit={() => s.onSubmit('it is in the box\'s strip; put it back to try again')} onPutBack={s.onPutBack}
      target={{ key: 'suggest-bottom', enabled: true, name: s.name, to: s.to, label: s.label, placeholder: `Write your message; mootr suggests where it goes · ${context}` }} />
  </div>
}
