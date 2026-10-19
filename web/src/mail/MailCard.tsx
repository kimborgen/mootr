// One mail thread as a minimal card (S-1003): who wrote last, how long ago, a short version of
// what the mail says, a band for its kind (decision, blocker, done, general: label, icon, colour), and a chip for what
// it holds (an approval, an ITSA). The Swipe view
// stacks them; the conversation view (S-1004) lists them. The card knows nothing of gestures:
// whoever shows it moves it, and `onTap` is its one action.
import { useMemo, useRef, type CSSProperties, type Ref } from 'react'
import { ago, baseSubject, plainSubject } from '../format'
import { Icon } from '../Icon'
import { StatusGlyph, statusLabel } from '../itsa/itsa'
import { hasPendingPermission, isUnreadForHuman, useData } from '../store'
import type { Mail, Thread } from '../types'
import { cardKind, type CardKind } from './cardKind'
import { useWatchMailTitle } from './mail-titles'
import { parseSummary, sameLine, type CardSummary } from './cardSummary'
import * as mb from './mailblocks'
import { Avatar, mdInline, nameFor } from './ThreadPanel'

// A card is a mail to you: it speaks for the thread's latest mail to you, from its sender.
// A thread with none (only your own mail) speaks for its latest mail, from the other party.
const toHuman = (m: Mail) => m.from_id !== 'human' && m.recipients.some((r) => r.id === 'human')
export const cardMail = (t: Thread): Mail => t.mails.findLast(toHuman) ?? t.mails.at(-1)!
export function cardFrom(t: Thread): { id: string; name?: string | null } {
  const m = t.mails.findLast(toHuman)
  if (m) return { id: m.from_id, name: m.from_name }
  const other = t.mails.findLast((x) => x.from_id !== 'human')
  if (other) return { id: other.from_id, name: other.from_name }
  return { id: t.mails.flatMap((x) => x.recipients).findLast((x) => x.id !== 'human')?.id ?? 'human' }
}
// A card for mail you sent (the conversation view's rapid-fire mode, S-1004) speaks for the
// thread's first mail from you, the idea you sent; its head says who wrote last, and when.
export const sentMail = (t: Thread): Mail => t.mails.find((m) => m.from_id === 'human') ?? cardMail(t)

// One body line without Markdown marks: no heading, quote, or list marker, code ticks, bold, or link targets.
const plain = (l: string) => l.replace(/^(#+|>|[-*+]|\d+\.)\s+/, '').replace(/`|\*\*|__|\[!\w+\]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim()

// A body's first lines of prose, without Markdown marks: no fence, heading, quote, list marker, tag,
// or table row. At most `max` lines, joined by newlines, and cut to `chars` characters.
export function bodyLines(body: string, max = 1, chars = 400): string {
  const out: string[] = []
  let fenced = false
  for (const raw of body.split('\n')) {
    const l = raw.trim()
    if (l.startsWith('```')) { fenced = !fenced; continue }
    if (fenced || !l || /^(<[^>]+>|\||(-{3,}|\*{3,}|_{3,})$)/.test(l)) continue
    const p = plain(l)
    if (!p) continue
    out.push(p)
    if (out.length >= max) break
  }
  return cut(out.join('\n'), chars)
}
// Text cut to `max` code points, never inside an emoji's surrogate pair, at a word boundary when one is near, with an ellipsis.
function cut(text: string, max: number): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text.trim()
  const head = chars.slice(0, max - 1)
  const at = head.findLastIndex((c) => /\s/.test(c))
  return (at > max / 2 ? head.slice(0, at) : head).join('').trimEnd() + '…'
}
export const firstLine = (body: string): string => bodyLines(body, 1, Infinity)

// What the card says (S-1111): the mail's summary, a condensed version of the mail with line breaks
// and "- " bullets, else the first lines of its body as prose, else its title with the subject
// after it (a title is 1-3 words), else its subject. The text is Markdown (S-1309): the card renders it
// with the mail renderer; a body is cut to its first `BODY_CHARS` characters, at a line end.
const BODY_CHARS = 1200
export function cardText(m: Mail): { text: string; more?: string } {
  const s = m.summary?.trim()
  if (s) return { text: s }
  const raw = (m.body ?? '').trim()
  if (raw) {
    if (raw.length <= BODY_CHARS) return { text: raw }
    const head = raw.slice(0, BODY_CHARS)
    const nl = head.lastIndexOf('\n')
    return { text: (nl > BODY_CHARS / 2 ? head.slice(0, nl) : head).trimEnd() }
  }
  const subject = plainSubject(m.subject)
  if (m.title) return { text: m.title, more: subject || undefined }
  return { text: subject || '(no text)' }
}

// The card's text as plain lines, for a label that can't render Markdown (the Swipe view's undo notice).
export function cardPlain(m: Mail): string {
  return bodyLines(cardText(m).text, 4, 320) || cut(m.title?.trim() || plainSubject(m.subject) || '(no text)', 320)
}

// What a card for mail you sent says: the first line you wrote, else its subject.
export const sentText = (m: Mail): { text: string; more?: string } => ({ text: firstLine(m.body) || plainSubject(m.subject) || '(no text)' })

// Each kind's band: a label and an icon besides its colour (S-1312), colour alone never says the kind.
export const KIND: Record<CardKind, { label: string; icon: 'circle-help' | 'circle-alert' | 'check' | 'message-square' }> = {
  decision: { label: 'Decision', icon: 'circle-help' },
  blocker: { label: 'Blocker', icon: 'circle-alert' },
  done: { label: 'Done', icon: 'check' },
  general: { label: 'Mail', icon: 'message-square' },
}

// The summary's structure, as the kind's contract writes it: a decision's question and options (the
// recommended one badged), a blocker's or done card's labelled sections. Inline Markdown and ITSA keys link as in the title.
const inline = (s: string) => mb.linkItsaKeys(mdInline(s))
function Structured({ s, title }: { s: CardSummary; title: string }) {
  if (s.type === 'decision') return (
    <div className="mc-text mc-struct">
      {sameLine(s.question, title) ? null : <p className="mc-q" dangerouslySetInnerHTML={{ __html: inline(s.question) }} />}
      <ul className="mc-opts">
        {s.options.map((o, i) => (
          <li key={i} className={o.recommended ? 'rec' : undefined}>
            <span className="mc-opt-l" dangerouslySetInnerHTML={{ __html: inline(o.label) }} />
            {o.recommended ? <span className="badge ok" data-chip="recommended"><Icon name="check" size="xs" />Recommended</span> : null}
            {o.why ? <span className="mc-opt-w" dangerouslySetInnerHTML={{ __html: inline(o.why) }} /> : null}
          </li>
        ))}
      </ul>
    </div>
  )
  return (
    <div className="mc-text mc-struct">
      {s.sections.map((x) => (
        <div key={x.key} className={`mc-sec ${x.key}`}>
          <div className="mc-sec-l">{x.label}</div>
          <div dangerouslySetInnerHTML={{ __html: inline(x.text) }} />
        </div>
      ))}
    </div>
  )
}

export interface MailCardProps {
  thread: Thread
  // Picked: the conversation view's follow-up target, say. Accent-subtle, as a selected row is.
  selected?: boolean
  // 'sent': a card for mail you sent, as above. The default speaks for mail to you.
  side?: 'inbox' | 'sent'
  onTap?: () => void
  className?: string
  style?: CSSProperties
  ref?: Ref<HTMLDivElement>
}

export function MailCard({ thread: t, selected, side, onTap, className, style, ref }: MailCardProps) {
  const d = useData()
  const sent = side === 'sent'
  const last = t.mails.at(-1)!
  const m = sent ? sentMail(t) : cardMail(t)
  const from = sent ? { id: last.from_id, name: last.from_name } : cardFrom(t)
  const at = sent ? last.created_at : m.created_at
  // Your own mail reads in your own words: its first line, not a title or summary made of it.
  const { text, more } = sent ? sentText(m) : cardText(m)
  const unread = isUnreadForHuman(t)
  const perm = hasPendingPermission(t)
  const decision = d.decisions.some((x) => x.thread_id === t.thread_id)
  const ask = d.attention.find((x) => x.ask_thread_id === t.thread_id)
  const about = m.about_itsa ?? m.itsa_id
  const itsa = about ? d.itsas.find((x) => x.id === about) : undefined
  // ITSA keys link from the live ITSAs and their statuses, which load apart from mail: the body's HTML
  // follows them, and the title, cheap, is made on every render, as the thread panel's is.
  const html = useMemo(() => mb.renderMail(text), [text, d.itsas, d.itsaStatuses])
  // What kind of card it is (the Swipe view's classifier); a mail you sent has none. A kind's structure
  // shows only for the mail's own summary; anything off its contract renders as Markdown, as before.
  const kind: CardKind | null = sent ? null : cardKind({ waiting: perm || decision || !!ask, verdictKind: m.verdict?.kind })
  const struct = kind && m.summary?.trim() ? parseSummary(kind, text) : null
  const titleHtml = mb.linkItsaKeys(mdInline(baseSubject(t.mails[0].subject)))
  const files = t.mails.reduce((n, x) => n + (x.attachments?.length ?? 0), 0)
  // The card's title or summary made with another model or prompt is asked again while it shows (S-1843).
  const headRef = useRef<HTMLDivElement>(null)
  useWatchMailTitle(m.id, headRef)
  return (
    <div ref={ref} className={`mail-card${kind ? ' k-' + kind : ''}${unread ? ' unread' : ''}${selected ? ' sel' : ''}${className ? ' ' + className : ''}`} style={style}
      data-card={t.thread_id} role={onTap ? 'button' : undefined} tabIndex={onTap ? 0 : undefined} aria-pressed={onTap && selected !== undefined ? selected : undefined}
      title={`${plainSubject(t.mails[0].subject)} · ${sent ? 'last from' : from.id === m.from_id ? 'from' : 'with'} ${nameFor(from.id, from.name)} · ${new Date(at).toLocaleString()}`}
      onClick={onTap ? (e) => { if (!(e.target as Element).closest('a, button')) onTap() } : undefined} onKeyDown={onTap ? (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) { e.stopPropagation(); onTap() } } : undefined}>
      {kind ? <div className="mc-kind" data-kind={kind}><Icon name={KIND[kind].icon} size="sm" /><span>{KIND[kind].label}</span></div> : null}
      <div ref={headRef} className="mc-head">
        <Avatar id={from.id} /><span className="mc-from">{nameFor(from.id, from.name)}</span>
        {unread ? <span className="dot" aria-label="Unread" /> : null}
        <span className="mc-chips">
          {perm ? <span className="badge warn" data-chip="approval"><Icon name="shield-alert" size="xs" />Approval</span>
            : ask ? <span className="badge warn" data-chip="ask" title={`${ask.key}: ${statusLabel(ask.status)}`}><StatusGlyph status={ask.status} />{ask.key}</span>
            : itsa ? <span className="chip" data-chip="itsa" title={itsa.title}>{itsa.key}</span> : null}
          {files ? <span className="mc-meta" title={`${files} attachment${files > 1 ? 's' : ''}`}><Icon name="paperclip" size="xs" />{files}</span> : null}
          {t.mails.length > 1 ? <span className="badge n" title={`${t.mails.length} messages`}>{t.mails.length}</span> : null}
        </span>
        <time className="mc-time">{ago(at)}</time>
      </div>
      <div className="mc-title" dangerouslySetInnerHTML={{ __html: titleHtml }} />
      {struct ? <Structured s={struct} title={plainSubject(t.mails[0].subject)} /> : <div className="mc-text md" dangerouslySetInnerHTML={{ __html: html }} />}
      {more ? <div className="mc-more">{more}</div> : null}
    </div>
  )
}
