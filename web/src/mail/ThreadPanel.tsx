// One thread, oldest first, each message its own card. The latest, and any the mailbox
// hasn't read, open; the rest fold to one line, and a long thread folds its middle into
// one "earlier messages" row. Bodies render through the mail components (mailblocks.ts),
// mounted as HTML and finished in place (charts, diagrams, math, embeds).
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, token } from '../api'
import { openAgent, selectThread } from '../actions'
import { ago, baseSubject } from '../format'
import { Glyph, PlainGlyph } from '../Glyph'
import { Icon } from '../Icon'
import { byId, getData, useData } from '../store'
import { AskBlockLine } from '../itsa/AskBlockLine'
import { InputSuggestion } from '../perm/InputSuggestion'
import { ItsaActions } from '../itsa/ItsaActions'
import type { Attachment, ItsaAction, Mail, MailItsa, MailVerdict } from '../types'
import { agentBase, useFileBase } from '../files/fileBase'
import { fileHref } from '../files/fileKey'
import { openFile } from '../files/open'
import { fileLinkClick, linkFilePaths } from '../files/pathLinks'
import { useDiffRepos } from '../diff/diffRepos'
import { linkPrUrls } from './prLinks'
import { ItsaChips } from './ItsaChips'
import { useWatchMailTitle } from './mail-titles'
import * as mb from './mailblocks'
import { askFocus, focusIn, focusScrollTop, onFocus, openScrollTop, settleFocus } from './mailFocus'
import { touchRank } from './touchRank'

export const nameFor = (id: string, fallback?: string | null) => (id === 'human' ? 'you' : byId(id)?.name ?? fallback ?? id)
export function Avatar({ id }: { id: string }) {
  const a = byId(id)
  return a ? <Glyph agent={a} /> : <PlainGlyph name={id === 'human' ? 'user' : 'mail'} />
}
// One line of Markdown, for short texts such as a subject.
export const mdInline = (text: string) => DOMPurify.sanitize(marked.parseInline(text ?? '') as string, { ALLOWED_TAGS: ['code', 'b', 'strong', 'em', 'i'] })
const IMAGE = /\.(png|jpe?g|gif|webp)$/i
const attUrl = (m: Mail, name: string) => `/api/mail/${m.id}/attachments/${encodeURIComponent(name)}`
// What a file attachment's link does (S-1512): the daemon serves text and Markdown as text, so they show in a new tab;
// every other file (and anything it can't show) downloads. The link has no token (S-1534): a click fetches the file
// with the Bearer header and opens or saves the bytes from a blob: URL, so the token never reaches the address bar or history.
const TEXT_FILE = /\.(txt|md|log|json|ya?ml|toml|csv|tsv|ts|js|mjs|py|sh|rs|go|css|html|sql|diff|patch)$/i
export const attachmentLink = (m: Mail, name: string) => ({ href: attUrl(m, name), download: !TEXT_FILE.test(name) })

// Opens or saves one attachment from a click on its link. A tab for text opens first, in the click, so the browser
// doesn't block it while the file loads; a failed load closes it.
export async function openAttachment(m: Mail, name: string, fetcher: typeof fetch = fetch, save = false): Promise<void> {
  const l = attachmentLink(m, name)
  const tab = l.download || save ? null : window.open('', '_blank')
  try {
    const r = await fetcher(l.href, { headers: { authorization: 'Bearer ' + token } })
    if (!r.ok) throw new Error(String(r.status))
    const url = URL.createObjectURL(await r.blob())
    if (tab) tab.location.href = url
    else {
      const a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.append(a)
      a.click()
      a.remove()
    }
    // The tab or save has read the blob by now; keep it a while for a slow tab.
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  } catch (e) {
    tab?.close()
    console.error('attachment', name, e)
  }
}

// Attachment images need the token, so they load as blobs.
const blobs = new Map<string, Promise<string | null>>()
function AttImage({ url, name }: { url: string; name: string }) {
  const [src, setSrc] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    if (!blobs.has(url)) blobs.set(url, fetch(url, { headers: { authorization: 'Bearer ' + token } }).then((r) => (r.ok ? r.blob() : null)).then((b) => b && URL.createObjectURL(b)).catch(() => null))
    let on = true
    blobs.get(url)!.then((s) => { if (on) setSrc(s) })
    return () => { on = false }
  }, [url])
  if (src === null) return null
  // A tap or click opens the image viewer (S-86), through the shared handler.
  return <a className="att-img" data-full={url} title={name}><img src={src ?? undefined} alt={name} /></a>
}

// Compared and embedded attachments in a rendered body: players and <img> can't send the token in a header, so their
// files carry it in the URL; a Download link saves through the Bearer fetch instead, so its URL has no token (S-1600).
export function resolveMailMedia(el: HTMLElement, m: Mail) {
  const has = (name: string) => (m.attachments ?? []).some((a) => a.name === name)
  const media = (name: string) => (has(name) ? `${attUrl(m, name)}?token=${encodeURIComponent(token)}` : null)
  mb.resolveCompare(el, media)
  mb.resolveEmbeds(el, media, (u) => fetch(u).then((r) => (r.ok ? r.text() : Promise.reject())), (name) => attUrl(m, name))
  for (const a of el.querySelectorAll<HTMLAnchorElement>('a[data-att-save]')) {
    a.onclick = (e) => { e.preventDefault(); void openAttachment(m, a.dataset.attSave!, fetch, true) }
    a.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); void openAttachment(m, a.dataset.attSave!, fetch, true) } }
  }
}

// A body: the mail components' HTML, then everything that finishes it in place.
function MailBody({ m, thread, canAnswer }: { m: Mail; thread: Mail[]; canAnswer: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const html = useMemo(() => mb.renderMail(m.body), [m.body])
  const fb = useFileBase(agentBase(m.from_id))
  const repos = useDiffRepos()
  useLayoutEffect(() => {
    const el = ref.current!
    resolveMailMedia(el, m)
    mb.renderDiagrams(el)
    mb.highlight(el)
    mb.renderMath(el)
    mb.renderCharts(el)
    mb.resolveThreadLinks(el, (id) => api<mb.ThreadRef[]>('GET', `/api/mail/${id}/thread`).then((r) => r[0] ?? null))
    linkFilePaths(el, fb)
  }, [html, m, fb.host, fb.cwd])
  useLayoutEffect(() => { linkPrUrls(ref.current!, repos) }, [html, repos])
  const sig = thread.map((x) => x.id).join()
  useLayoutEffect(() => { mb.markDecisions(ref.current!, m, thread, canAnswer) }, [sig, html, canAnswer])
  return <div className="md" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />
}

// What a click inside a card does wherever cards show (the thread panel and the ITSA thread): open an agent, the
// mail components' own controls (sort, show all rows, copy), and a mail link. True when it handled the click.
// Each click is handled once: a Card handles its own, and a host root above it that also calls this skips the rest.
const handled = new WeakSet<Event>()
export const cardHandled = (e: React.MouseEvent) => handled.has(e.nativeEvent)
export function cardClick(e: React.MouseEvent, mails: Mail[], threadKey: string): boolean {
  if (handled.has(e.nativeEvent)) return true
  const did = cardClickOnce(e, mails, threadKey)
  if (did) handled.add(e.nativeEvent)
  return did
}
function cardClickOnce(e: React.MouseEvent, mails: Mail[], threadKey: string): boolean {
  const t = e.target as HTMLElement
  const o = t.closest<HTMLElement>('[data-open-agent]')
  if (o) { e.preventDefault(); openAgent(o.dataset.openAgent!); return true }
  if (fileLinkClick(e)) return true
  const ao = t.closest<HTMLElement>('[data-att-open]')
  if (ao) {
    // An attached PDF's card opens the file view; without the stored path the click saves it.
    e.preventDefault()
    const m = mails.find((x) => x.id === ao.closest<HTMLElement>('[data-id]')?.dataset.id)
    const att = m?.attachments?.find((x) => x.name === ao.dataset.attOpen)
    const machine = getData().machine
    if (att?.path?.startsWith('/') && machine) openFile(machine, att.path)
    else if (m) void openAttachment(m, ao.dataset.attOpen!, fetch, true)
    return true
  }
  if (mb.handleClick(e.nativeEvent)) return true
  const tl = t.closest<HTMLElement>('[data-thread-link]')
  if (!tl) return false
  e.preventDefault()
  // A mail in this thread scrolls here; another thread's mail needs its thread's id, which the link fills in.
  const id = tl.dataset.threadLink!
  const tid = mails.some((m) => m.id === id) ? threadKey : tl.dataset.tid
  if (tid) { askFocus(id, tid); selectThread(tid) }
  return true
}

export type Stage =
  | { kind: 'rank'; mailId: string; block: HTMLElement; order: string[] }
  | { kind: 'choice' | 'pick' | 'defer'; mailId: string; block: HTMLElement; label: string }
  | { kind: 'own'; mailId: string; block: HTMLElement }
  | { kind: 'unnote'; mailId: string; block: HTMLElement }
  | { kind: 'perm'; mailId: string; id: string; approve: boolean; action: string }
  | { kind: 'itsa'; mailId: string; itsa: string; action: string; label: string }

// The ITSA's mail that asks the human to act: its buttons stage the ITSA's action.
export interface ItsaAsk { mailId: string; itsa: string; actions: ItsaAction[]; staged?: string | null }

interface Props {
  className: string
  mails: Mail[]
  // A new key starts the thread fresh: folds reset and the scroll goes to the newest.
  threadKey: string
  unread?: string[]
  head?: ReactNode
  // Stages an answer (a choice, a pick, a deferral, a permission) in the reply; only where
  // the human can reply. Nothing is sent until they send the reply.
  onStage?: (s: Stage) => void
  afterRender?: (el: HTMLElement) => void
  scrollRef?: React.RefObject<HTMLDivElement | null>
  // The latest mail asking the human to act on an ITSA, with the actions it offers now.
  ask?: ItsaAsk | null
  // The reader is the human's mailbox (S-1458): mail between other parties folds to a labelled row. An agent's inbox shows it all.
  humanView?: boolean
}

// The comments an ask in the thread repeats: the ask replies to the comment, so the thread shows it once.
// Only a comment the ask's sender left in the same thread, whose text the ask carries, counts; any
// other mail an ask replies to (Kim's own earlier mail, say) stays visible.
export function repeatedIds(mails: Mail[]): Set<string> {
  const byId = new Map(mails.map((m) => [m.id, m]))
  const ids = new Set<string>()
  for (const ask of mails) {
    if (ask.kind !== 'ask' || !ask.reply_to) continue
    const target = byId.get(ask.reply_to)
    if (!target || (target.kind !== 'comment' && target.kind !== 'update')) continue
    if (target.from_id !== ask.from_id || target.thread_id !== ask.thread_id) continue
    if (!ask.body.includes(target.body.trim())) continue
    ids.add(target.id)
  }
  return ids
}

export function ThreadPanel({ className, mails, threadKey, unread = [], head, onStage, afterRender, scrollRef, ask, humanView }: Props) {
  const { itsas } = useData() // names and glyphs follow the agents; the ITSAs fill the About chips
  const own = useRef<HTMLDivElement>(null)
  const el = scrollRef ?? own
  const [opened, setOpened] = useState<Set<string>>(new Set())
  const [showAll, setShowAll] = useState(false)
  const [repeatOpen, setRepeatOpen] = useState<Set<string>>(new Set())
  // Withdrawn mail (pulled from the human once someone else settled it) the reader opened.
  const [withdrawnOpen, setWithdrawnOpen] = useState<Set<string>>(new Set())
  // Mail between agents (S-1458) the reader opened.
  const [betweenOpen, setBetweenOpen] = useState<Set<string>>(new Set())
  // On a phone the header is one line; who's in the thread folds behind a button.
  const [peopleOpen, setPeopleOpen] = useState(false)
  const seen = useRef<Set<string> | null>(null)
  const freshKey = useRef<string | null>(null)
  // A mail link's target (S-415): opened, scrolled to below the header, and highlighted once.
  const [, rerender] = useState(0)
  const [flash, setFlash] = useState<string | null>(null)
  useEffect(() => onFocus(() => rerender((n) => n + 1)), [])
  const focus = focusIn(threadKey, mails.map((m) => m.id))
  const isFresh = freshKey.current !== threadKey && mails.length > 0
  let open = opened
  if (isFresh) {
    open = new Set(mails.length <= 3 ? mails.map((m) => m.id) : [mails.at(-1)!.id, ...unread])
    seen.current = null
  }
  // New arrivals open.
  const arrived = seen.current ? mails.filter((m) => !seen.current!.has(m.id)) : []
  if (arrived.length) { open = new Set(open); for (const m of arrived) open.add(m.id) }
  if (focus && !open.has(focus)) { open = new Set(open); open.add(focus) }
  const all = showAll && !isFresh
  useLayoutEffect(() => {
    seen.current = new Set(mails.map((m) => m.id))
    if (open !== opened) setOpened(open)
    if (isFresh) {
      freshKey.current = threadKey
      setShowAll(false)
      // A thread opens at its latest message (S-1500). A tall one starts under the header, so it is measured the way the
      // focus scroll below does: box-relative, with the sticky header's height and the row's scroll margin.
      const box = el.current!
      const rows = box.querySelectorAll<HTMLElement>('.msgs > *')
      const last = rows[rows.length - 1]
      const head = box.querySelector<HTMLElement>('.thread-head')
      const sticky = !!head && getComputedStyle(head).position === 'sticky'
      const gap = (sticky ? head!.offsetHeight : 0) + (last ? parseFloat(getComputedStyle(last).scrollMarginTop) || 0 : 0)
      const top = last ? last.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop : 0
      box.scrollTop = openScrollTop(top, last?.offsetHeight ?? 0, box.scrollHeight, box.clientHeight, gap)
    }
  })
  useLayoutEffect(() => { if (el.current) afterRender?.(el.current) })
  // The target scrolls once its card is open. A sticky header stays over the top of the box, so
  // the mail goes below it with its scroll margin; a header that scrolls away (the phone's) leaves
  // the mail at the top. The ask ends here once its thread has loaded.
  useLayoutEffect(() => {
    const id = settleFocus(threadKey, mails.map((m) => m.id))
    if (!id) return
    const root = el.current!
    const card = root.querySelector<HTMLElement>(`.msg.open[data-id="${id}"]`)
    if (!card) return
    const head = root.querySelector<HTMLElement>('.thread-head')
    const sticky = !!head && getComputedStyle(head).position === 'sticky'
    root.scrollTop = focusScrollTop(card.getBoundingClientRect().top - root.getBoundingClientRect().top, root.scrollTop, sticky ? head!.offsetHeight : 0, parseFloat(getComputedStyle(card).scrollMarginTop) || 0)
    setFlash(id)
    // A comment an ask repeats folds to its "Repeated in the ask below" row unless it's open, so the link opens it for good.
    setRepeatOpen((s) => new Set(s).add(id))
    // A withdrawn mail a link points at (a replacement that was itself superseded) opens for good too.
    setWithdrawnOpen((s) => new Set(s).add(id))
  })

  // Ranking by drag: rows move as they're dragged; dropping stages the order.
  useEffect(() => {
    const root = el.current!
    let dragRow: HTMLElement | null = null
    const start = (e: DragEvent) => { const r = (e.target as Element).closest?.<HTMLElement>('.mb-rrow'); if (r && onStage) { dragRow = r; r.classList.add('dragging'); e.dataTransfer!.effectAllowed = 'move' } }
    const over = (e: DragEvent) => {
      const r = dragRow, o = (e.target as Element).closest?.<HTMLElement>('.mb-rrow')
      if (!r || !o || o === r || o.parentElement !== r.parentElement) return
      e.preventDefault()
      const b = o.getBoundingClientRect()
      if (e.clientY < b.top + b.height / 2) o.before(r); else o.after(r)
    }
    const end = () => {
      const r = dragRow
      if (!r) return
      dragRow = null
      r.classList.remove('dragging')
      const block = r.closest<HTMLElement>('.mb-decision')!
      onStage?.({ kind: 'rank', mailId: r.closest<HTMLElement>('.msg')!.dataset.id!, block, order: mb.rankOrder(block) })
    }
    root.addEventListener('dragstart', start)
    root.addEventListener('dragover', over)
    root.addEventListener('dragend', end)
    return () => { root.removeEventListener('dragstart', start); root.removeEventListener('dragover', over); root.removeEventListener('dragend', end) }
  }, [onStage, el])

  useEffect(() => {
    if (!onStage) return
    return touchRank(el.current!, (r) => {
      const block = r.closest<HTMLElement>('.mb-decision')!
      onStage({ kind: 'rank', mailId: r.closest<HTMLElement>('.msg')!.dataset.id!, block, order: mb.rankOrder(block) })
    })
  }, [onStage, el])

  const click = (e: React.MouseEvent) => {
    // A card handles its own clicks (cardClick); the root takes the header's agent chips and the staging controls.
    if (cardHandled(e)) return
    const t = e.target as HTMLElement
    const oa = t.closest<HTMLElement>('.thread-head [data-open-agent]')
    if (oa) { e.preventDefault(); return openAgent(oa.dataset.openAgent!) }
    if (onStage) {
      const block = t.closest<HTMLElement>('.mb-decision')!
      const mailId = t.closest<HTMLElement>('.msg')?.dataset.id ?? ''
      const mv = t.closest<HTMLElement>('[data-rank-move]')
      if (mv) {
        const row = mv.closest<HTMLElement>('.mb-rrow')!
        if (mv.dataset.rankMove === '-1') row.previousElementSibling?.before(row); else row.nextElementSibling?.after(row)
        return onStage({ kind: 'rank', mailId, block, order: mb.rankOrder(block) })
      }
      if (t.closest('[data-rank-keep]')) return onStage({ kind: 'rank', mailId, block, order: mb.rankOrder(block) })
      const ch = t.closest<HTMLElement>('[data-choose]')
      if (ch) return onStage({ kind: block.classList.contains('multi') ? 'pick' : 'choice', mailId, block, label: ch.dataset.choose! })
      const df = t.closest<HTMLElement>('[data-defer]')
      if (df) return onStage({ kind: 'defer', mailId, block, label: df.dataset.defer! })
      if (t.closest('[data-own]')) return onStage({ kind: 'own', mailId, block })
      if (t.closest('[data-unnote]')) return onStage({ kind: 'unnote', mailId, block })
      const ia = t.closest<HTMLElement>('[data-itsa-act]')
      if (ia) return onStage({ kind: 'itsa', mailId, itsa: ia.dataset.itsa!, action: ia.dataset.itsaAct!, label: ia.dataset.label ?? ia.dataset.itsaAct! })
      const ap = t.closest<HTMLElement>('[data-perm]')
      if (ap) return onStage({ kind: 'perm', mailId, id: ap.dataset.perm!, approve: ap.dataset.approve === '1', action: ap.dataset.action || (ap.closest('.msg')?.querySelector('.md')?.textContent?.trim().split('\n')[0] ?? '') })
    }
  }

  if (!mails.length) return <div className={className} ref={el}><div className="empty-pane"><p>No messages here.</p></div></div>

  const firstOpen = mails.findIndex((m) => open.has(m.id))
  const hide = new Set<number>()
  if (!all && firstOpen > 4) for (let i = 1; i < firstOpen - 2; i++) if (!open.has(mails[i].id)) hide.add(i)
  const people = [...new Set(mails.flatMap((m) => [m.from_id, ...m.recipients.map((r) => r.id)]))]
  // The ITSAs the thread's mail is linked to (S-986), or about by `about_itsa`, as chips; the links carry the ITSA's key, title and status.
  const linked = new Map<string, Pick<MailItsa, 'id' | 'key' | 'title' | 'status'>>()
  for (const m of mails) for (const l of m.itsas ?? []) if (!linked.has(l.id)) linked.set(l.id, l)
  for (const m of mails) if (m.about_itsa && !linked.has(m.about_itsa)) { const x = itsas.find((i) => i.id === m.about_itsa); if (x) linked.set(x.id, x) }
  const about = [...linked.values()]
  // The agents attached to the thread's mail (S-1305), as chips that open the agent.
  const attached = [...new Set(mails.flatMap((m) => m.agents ?? []))].filter((id) => byId(id))
  const toggle = (id: string, on: boolean) => { const n = new Set(open); if (on) n.add(id); else n.delete(id); setOpened(n) }
  const repeats = repeatedIds(mails)
  let gap = false
  return (
    <div className={className} ref={el} onClick={click} onInput={(e) => mb.handleInput(e.nativeEvent)}>
      <div className={`thread-head${peopleOpen ? ' people-open' : ''}`}>{head}
        <div className="th-title"><h2 dangerouslySetInnerHTML={{ __html: mb.linkItsaKeys(mdInline(baseSubject(mails[0].subject))) }} />
          <button className="th-people" type="button" aria-expanded={peopleOpen} title="Who's in this thread"
            onClick={() => setPeopleOpen(!peopleOpen)}><Icon name="users" size="xs" />{people.length}<Icon name="chevron-down" size="xs" /></button></div>
        <ItsaChips items={about} className="th-itsas" label="Linked ITSAs" />
        {attached.length ? <div className="th-itsas th-agents" aria-label="Attached agents">{attached.map((id) => (
          <a key={id} href="#" className="ichip-mail" data-open-agent={id} title={`${nameFor(id)}: open the agent`}><Avatar id={id} /><span className="k">{nameFor(id)}</span></a>))}</div> : null}
        <div className="people">{people.map((p) => <span key={p} className="person"><Avatar id={p} />{nameFor(p)}</span>)}<span className="muted">{mails.length} message{mails.length > 1 ? 's' : ''}</span></div>
      </div>
      <div className="msgs">
        {mails.map((m, i) => {
          if (hide.has(i)) {
            if (gap) return null
            gap = true
            return <button key="gap" className="msg-gap" onClick={() => setShowAll(true)}>{hide.size} earlier messages</button>
          }
          if (repeats.has(m.id) && !repeatOpen.has(m.id) && m.id !== focus) {
            return <button key={m.id} className="msg-repeat" data-repeat={m.id} onClick={() => setRepeatOpen(new Set(repeatOpen).add(m.id))}>Repeated in the ask below</button>
          }
          if (humanView && between(m) && !betweenOpen.has(m.id) && m.id !== focus) {
            return <BetweenRow key={m.id} m={m} onOpen={() => setBetweenOpen(new Set(betweenOpen).add(m.id))} />
          }
          const w = withdrawnFor(m)
          if (w && !withdrawnOpen.has(m.id) && m.id !== focus) {
            return <button key={m.id} className="msg-withdrawn" data-withdrawn={m.id} title="Withdrawn from your mail: tap to read it" onClick={() => setWithdrawnOpen(new Set(withdrawnOpen).add(m.id))}>
              <Icon name="info" size="xs" /><span className="note">{w.withdrawn_note || `Withdrawn by ${nameFor(w.withdrawn_by ?? '')}`}</span><time>{ago(w.withdrawn_at!)}</time></button>
          }
          return open.has(m.id) || (humanView && between(m) && betweenOpen.has(m.id)) || (w && (withdrawnOpen.has(m.id) || m.id === focus))
            ? <Card key={m.id} m={m} threadKey={threadKey} humanView={humanView} first={i === 0} thread={mails} canAnswer={!!onStage} ask={ask?.mailId === m.id ? ask : null} flash={flash === m.id} onFlashEnd={() => setFlash(null)} onFold={() => { toggle(m.id, false); if (betweenOpen.has(m.id)) setBetweenOpen(new Set([...betweenOpen].filter((x) => x !== m.id))) }} onMoreItsas={() => el.current?.querySelector('.th-itsas')?.scrollIntoView({ block: 'start' })} />
            : <Folded key={m.id} m={m} onOpen={() => toggle(m.id, true)} />
        })}
      </div>
    </div>
  )
}

// Mail not addressed to the human, sent by someone else (agents talking in a thread the human takes part in, S-1458).
// It folds to a labelled row, and never counts as unread or waiting for the human.
export const between = (m: Mail) => m.from_id !== 'human' && m.recipients.length > 0 && !m.recipients.some((r) => r.id === 'human')

// The folded row of a mail between agents.
export function BetweenRow({ m, onOpen }: { m: Mail; onOpen: () => void }) {
  return (
    <button className="msg-between" data-between={m.id} title="Not addressed to you: tap to read it" onClick={onOpen}>
      <Icon name="users" size="xs" /><span className="note">Between agents: {nameFor(m.from_id, m.from_name)} to {m.recipients.map((r) => nameFor(r.id)).join(', ')} · {mb.preview(m.body, 120)}</span><time>{ago(m.created_at)}</time></button>
  )
}

// The human's copy of a mail, if it was withdrawn from them.
export const withdrawnFor = (m: Mail) => m.recipients.find((r) => r.id === 'human' && !!r.withdrawn_at)

function To({ m }: { m: Mail }) {
  const rs = m.recipients
  if (rs.length > 4) return <>{rs.length} agents</>
  return <>{rs.map((r, i) => <span key={r.id}>{i ? ', ' : ''}{nameFor(r.id)}{r.read_at ? null : <span className="unread-dot" title="Not read yet" />}</span>)}</>
}

// The decision model's verdict on a mail to the human, in the message header: a check for
// yes, a warning mark for no. Hovering or tapping it shows the scores.
// An overridden mail (S-983) shows the sender's reason in the same kind of note.
export function VerdictMark({ v, override }: { v?: MailVerdict | null; override?: string | null }) {
  const [open, setOpen] = useState(false)
  const one = (x: number | null | undefined) => (typeof x === 'number' ? x.toFixed(1) : '—')
  const text = override ? `The sender overrode the mail check: ${override}`
    : `Follows the mail rules: ${v?.follows ? 'yes' : 'no'} · concise ${one(v?.concise)} · fluff ${one(v?.fluff)} · value ${one(v?.value)}`
  const tone = override ? 'warn' : v?.follows ? 'ok' : 'warn'
  const icon = override ? 'shield-alert' : v?.follows ? 'check' : 'triangle-alert'
  return (
    <button type="button" className={`badge verdict ${tone}`} title={text} aria-label={text} aria-expanded={open}
      onClick={(e) => { e.stopPropagation(); setOpen(!open) }}>
      <Icon name={icon} size="xs" />
      {open ? <span className="verdict-note">{text}</span> : null}
    </button>
  )
}

// A file attachment (S-1529): its link opens the file view on the machine that stores it (the path comes with the mail),
// next to a Download action. Without a path (an older daemon) the link keeps S-1512's behaviour: text in a tab, else a download.
function AttFile({ m, a }: { m: Mail; a: Attachment }) {
  const { machine } = useData()
  const view = machine && a.path?.startsWith('/') ? { host: machine, path: a.path } : null
  const l = attachmentLink(m, a.name)
  const open = (e: React.SyntheticEvent) => { e.preventDefault(); if (view) openFile(view.host, view.path); else void openAttachment(m, a.name) }
  return (
    <span className="att-item">
      <a className="mono att-file" href={view ? fileHref(view.host, view.path) : l.href} target={view ? undefined : '_blank'} rel="noopener" title={view ? 'Open in the file view' : l.download ? 'Download' : 'Open in a new tab'}
        onClick={open} onAuxClick={(e) => { if (e.button === 1) open(e) }}>{a.name}</a>
      {view ? <button type="button" className="att-dl" title={`Download ${a.name}`} aria-label={`Download ${a.name}`} onClick={() => void openAttachment(m, a.name, fetch, true)}><Icon name="download" size="xs" /></button> : null}
    </span>
  )
}

// A mail's attachments the body doesn't already show: images inline, other files as links.
export function MailAttachments({ m }: { m: Mail }) {
  const att = m.attachments ?? []
  const shown = mb.shownAttachments(m.body) // files the body already shows
  const imgs = att.filter((a) => IMAGE.test(a.name) && !shown.has(a.name))
  const others = att.filter((a) => !IMAGE.test(a.name) && !shown.has(a.name))
  return <>
    {imgs.length ? <div className="att-imgs">{imgs.map((a) => <AttImage key={a.name} url={attUrl(m, a.name)} name={a.name} />)}</div> : null}
    {others.length ? <div className="files"><Icon name="paperclip" size="xs" />{others.map((a) => <AttFile key={a.name} m={m} a={a} />)}</div> : null}
  </>
}

export function Card({ m, threadKey, humanView, first, thread, canAnswer, ask, flash, onFlashEnd, onFold, onMoreItsas }: { m: Mail; threadKey?: string; humanView?: boolean; first: boolean; thread: Mail[]; canAnswer: boolean; ask: ItsaAsk | null; flash: boolean; onFlashEnd: () => void; onFold: () => void; onMoreItsas: () => void }) {
  const { itsas } = useData()
  // A title or summary made with another model or prompt is asked again while this mail shows (S-1843).
  const mailRef = useRef<HTMLElement>(null)
  useWatchMailTitle(m.id, mailRef)
  const p = m.permission
  const fold = (e: React.MouseEvent) => { if (!(e.target as Element).closest('a') && !getSelection()?.toString()) onFold() }
  const subj = !first && baseSubject(m.subject) !== baseSubject(thread[0]?.subject)
  // A message shows the ITSAs it names itself (a sender's `itsa`, or a key in its text), inline on the sender line, and only
  // those that tell it apart: not one every mail of the thread links (the header says that), and not the ITSA whose own
  // thread this is.
  const own = (id: string) => itsas.find((i) => i.id === id)?.thread_id === m.thread_id
  const named = (m.itsas ?? []).filter((l) => l.source !== 'thread' && !own(l.id) && !thread.every((x) => x.itsas?.some((k) => k.id === l.id)))
  return (
    <article ref={mailRef} className={`msg open ${m.from_id === 'human' ? 'mine' : ''} ${humanView && between(m) ? 'between' : ''} ${p ? 'is-perm ' + p.status : ''} ${m.pending ? 'pending' : ''} ${m.superseded_by ? 'superseded' : ''} ${flash ? 'flash' : ''}`} data-id={m.id}
      onClick={(e) => { cardClick(e, thread, threadKey ?? thread[0]?.thread_id ?? '') }}
      onAnimationEnd={(e) => { if (e.target === e.currentTarget) onFlashEnd() }}>
      <header data-fold onClick={fold}><Avatar id={m.from_id} />
        <span className="who">{byId(m.from_id) ? <a href="#" data-open-agent={m.from_id}>{nameFor(m.from_id)}</a> : nameFor(m.from_id, m.from_name)}</span>
        <span className="to">to <To m={m} /></span>
        {m.title ? <span className="chip mtitle" title="A short title a model gave this mail">{m.title}</span> : null}
        {m.auto_threaded ? <span className="chip auto" title="The daemon joined this to a thread because it looked like a reply">auto-threaded</span> : null}
        {m.override || m.verdict ? <VerdictMark v={m.verdict} override={m.override} /> : null}
        {m.pending ? <span className="chip">Sending</span> : null}
        <ItsaChips items={named} compact max={2} onMore={onMoreItsas} className="msg-itsas" label="Linked ITSAs" />
        <time title={new Date(m.created_at).toLocaleString()}>{ago(m.created_at)}</time>
      </header>
      {humanView && between(m) ? <div className="msg-between-note"><Icon name="users" size="xs" />Between agents, not addressed to you</div> : null}
      {m.superseded_by ? <SupersededBy m={m} thread={thread} /> : null}
      {subj ? <div className="msg-subj">{m.subject}</div> : null}
      {m.body && p?.kind !== 'input' ? <MailBody m={m} thread={thread} canAnswer={canAnswer} /> : null}
      <MailAttachments m={m} />
      {ask ? <div className="perm pending itsa-ask" data-itsa-ask><span className="perm-label"><Icon name="user" size="xs" />Waiting on you</span><span className="spacer" />
        <AskBlockLine thread={m.thread_id} />
        {canAnswer ? <ItsaActions itsa={{ id: ask.itsa, actions: ask.actions }} staged={ask.staged} /> : <span className="muted">Open the thread to answer.</span>}</div> : null}
      {!p ? null : p.kind === 'input' ? <InputSuggestion p={p} canAnswer={canAnswer} thread={m.thread_id ?? undefined}
        note={<p className="muted input-note">Only you can approve it, from mootr's web UI on {p.machine}. An agent reviewing it can only deny it.</p>} />
        : p.status === 'pending'
        ? <div className="perm pending" data-perm-pending><span className="perm-label"><Icon name="shield-alert" size="xs" />Waiting for your approval</span><span className="spacer" />
          <AskBlockLine thread={m.thread_id} />
          {canAnswer
            ? <><button className="btn" data-approve="1" data-perm={p.id} data-action={p.action ?? ''}><Icon name="check" />Approve</button><button className="btn" data-approve="0" data-perm={p.id} data-action={p.action ?? ''}>Deny</button></>
            : <span className="muted">Open the thread to answer.</span>}</div>
        : <div className={`perm ${p.status}`}><Icon name={p.status === 'approved' ? 'check' : p.status === 'denied' ? 'x' : 'info'} size="xs" />
          <span>{p.status === 'approved' ? 'Approved' : p.status === 'denied' ? 'Denied' : 'Withdrawn'}{p.decided_by ? ` by ${nameFor(p.decided_by)}` : ''}{p.decided_at ? ` · ${ago(p.decided_at)}` : ''}{p.note && !/^(I authorize|Denied)$/.test(p.note) ? `: ${p.note}` : ''}</span></div>}
    </article>
  )
}

// The line on a superseded mail (S-1315): it stays in the thread, dimmed, and points at the mail that replaced it.
// The link jumps to that mail when it is in this thread; otherwise the id is plain text.
export function SupersededBy({ m, thread }: { m: Mail; thread: Mail[] }) {
  const id = m.superseded_by!
  const here = thread.some((x) => x.id === id)
  return (
    <div className="msg-superseded" data-superseded-by={id}><Icon name="info" size="xs" />Superseded by{' '}
      {here ? <a href="#" data-superseded-link={id} onClick={(e) => { e.preventDefault(); e.stopPropagation(); askFocus(id, m.thread_id ?? '') }}>{id}</a> : <span className="mono">{id}</span>}</div>
  )
}

export function Folded({ m, onOpen }: { m: Mail; onOpen: () => void }) {
  const n = m.attachments?.length ?? 0
  return (
    <div className={`msg folded ${m.from_id === 'human' ? 'mine' : ''} ${m.permission ? 'is-perm ' + m.permission.status : ''} ${m.superseded_by ? 'superseded' : ''}`} data-id={m.id} onClick={onOpen}>
      {m.permission ? <Icon name="shield-alert" size="xs" /> : null}<Avatar id={m.from_id} /><span className="who">{nameFor(m.from_id, m.from_name)}</span>
      <span className="snip">{mb.preview(m.body, 200) || (n ? `${n} attachment${n > 1 ? 's' : ''}` : '')}</span><time>{ago(m.created_at)}</time>
    </div>
  )
}

