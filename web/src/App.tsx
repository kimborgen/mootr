// stam's web UI: the agent tree and the human's mail on the left,
// the current world in main (an agent's, a thread's, Settings, or Usage), the prompt input
// in the bottom bar, the executive assistant dropping down from the top (Alt+C), and the
// prompt that suggests where a message goes, centred over the page (Alt+A).
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { threadKey } from './thread-keys'
import { agentMenu, assistantOpts, enterTree, exitTree, newShell, nextTopTarget, openAssistant, leaveMail, openMail, openWorld, paneAgent, sendToAgentByMail, sendToChief, setTopTarget, toggleThreadArchived, toggleThreadDeferred, topTarget, topTargets, topView, treeItem } from './actions'
import { api } from './api'
import { Composer, type ComposerHandle, type SendPayload } from './Composer'
import { live, model, stateLabel } from './format'
import { Glyph, glyphHtml, PlainGlyph } from './Glyph'
import { Icon } from './Icon'
import { closeImage, ImageViewer, installImageViewer } from './ImageViewer'
import { MachinesSide } from './MachinesSide'
import { closeSearch, SearchPalette, toggleSearch } from './Search'
import { closeSuggest, openSuggest, SuggestBar, SuggestModal, toggleSuggest } from './SuggestModal'
import { IssuesSide } from './itsa/IssuesSide'
import { ReqSide } from './req/ReqSide'
import { useDeferred, useWaiting } from './itsa/WaitingList'
import { PageButtons } from './PageButtons'
import { unreadCount } from './mail/inbox-model'
import * as shell from './shell/layout'
import { getBottomSlot, setBottomHandle, useBottomSlotVersion } from './bottom-slot'
import { bottomTarget } from './composer-target'
import { useBottomColumn } from './bottom-column'
import { useLive } from './views/ownview-live'
import { inputMain } from './image-tab'
import { MainWorld } from './shell/MainWorld'
import { byId, chiefsOfStaff, getData, isArchivedThread, isDeferredThread, threadWaitsOnHuman, useData } from './store'
import { hidesInput, retheme, setHideInput, TermSession } from './term/TermSession'
import { SpawnPanel, spawnMenu } from './spawn'
import { SidebarPanes } from './SidebarPanes'
import { Tree } from './Tree'
import { MenuLayer, showMenu, type MenuItem } from './ui/menu'
import type { Agent } from './types'
import { useTyping } from './ui/phone'
import { getUi, setUi, useUi } from './ui/state'
import { isRapid, rapidTarget, rapidThreads, sendRapid, setPick, usePick, type RapidPick } from './views/rapid'
import { viewMeta, ViewPortals } from './views/registry'

// --- Theme ----------------------------------------------------------------------------
const THEMES = ['system', 'light', 'dark'] as const
type Theme = (typeof THEMES)[number]
function applyTheme(t: Theme) {
  if (t === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = t
  try { localStorage.setItem('stam/theme', t) } catch {}
  retheme()
}
export const initialTheme = (): Theme => { try { return (localStorage.getItem('stam/theme') as Theme) || 'system' } catch { return 'system' } }

function ThemeButton() {
  const [t, setT] = useState<Theme>(initialTheme)
  return <button className="icon-btn" id="theme" aria-label="Theme" title={`Theme: ${t === 'system' ? 'following the system' : t}`}
    onClick={() => { const n = THEMES[(THEMES.indexOf(t) + 1) % 3]; applyTheme(n); setT(n) }}><Icon name={{ system: 'monitor', light: 'sun', dark: 'moon' }[t]} /></button>
}

// --- Separators and reveal buttons ------------------------------------------------------
function WorldSep({ name }: { name: 'left' | 'bottom' }) {
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const sep = e.currentTarget
    sep.setPointerCapture(e.pointerId)
    sep.classList.add('drag')
    const start = { x: e.clientX, y: e.clientY }
    let moved = false
    const move = (ev: PointerEvent) => {
      moved = moved || Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) > 6
      shell.setSize(name, name === 'left' ? ev.clientX : innerHeight - ev.clientY)
    }
    const up = () => {
      sep.classList.remove('drag')
      sep.removeEventListener('pointermove', move)
      sep.removeEventListener('pointerup', up)
      // A click on a separator, without a drag, closes its world.
      if (!moved) shell.toggleWorld(name, false)
      shell.changed()
      shell.resizeAll()
    }
    sep.addEventListener('pointermove', move)
    sep.addEventListener('pointerup', up)
  }
  return <div className={'sep ' + (name === 'left' ? 'v' : 'h')} id={'sep-' + name} data-world={name} hidden={shell.isPhone() || !shell.worldOpen(name)} onPointerDown={down} />
}

// Reveal buttons fade in as the pointer nears the edge of a closed world.
function Reveal() {
  const left = useRef<HTMLButtonElement>(null), bottom = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    let raf = 0, last: PointerEvent
    const on = (e: PointerEvent) => {
      last = e
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        for (const [b, d] of [[left.current, last.clientX], [bottom.current, innerHeight - last.clientY]] as const) {
          if (b && !b.hidden) b.style.setProperty('--reveal', String(Math.max(0, Math.min(1, 1 - d / 150))))
        }
      })
    }
    addEventListener('pointermove', on)
    return () => removeEventListener('pointermove', on)
  }, [])
  const phone = shell.isPhone()
  return <>
    <button className="reveal" id="reveal-left" ref={left} hidden={phone || shell.worldOpen('left')} title="Show the agent tree" aria-label="Show the agent tree" onClick={() => shell.toggleWorld('left', true)}><Icon name="panel-left-open" /></button>
    <button className="reveal" id="reveal-bottom" ref={bottom} hidden={phone || shell.worldOpen('bottom')} title="Show the prompt input" aria-label="Show the prompt input" onClick={() => shell.toggleWorld('bottom', true)}><Icon name="panel-bottom-open" /></button>
  </>
}

// --- The bottom bar: a prompt input for the focused pane --------------------------------
// It writes to the focused pane: an agent gets the text as typed input (with files saved
// next to it), a terminal gets it as a command line. A thread has its own reply box, so
// the bar steps aside while a thread's pane has the focus.
function paneTarget(pick: RapidPick | null) {
  const main = inputMain()
  const phone = shell.isPhone()
  const bt = bottomTarget(main)
  // An agent's own tabs write to the agent (a desktop only; a phone shows no bar there).
  const key = !phone && bt.kind === 'agent' && bt.key.startsWith('agent:') ? bt.key : main ?? ''
  if (key.startsWith('agent:')) {
    const a = byId(key.slice(6))
    if (!a) return { key, enabled: false }
    return { key, name: a.name, kind: 'agent', a, enabled: live(a), label: <><Glyph agent={a} /><b>{a.name}</b></>, placeholder: live(a) ? `Message ${a.name}` : `${a.name} isn't running` }
  }
  // stam's own view of an agent: through the harness's API where it takes prompts from the
  // view (only on the daemon the browser reaches), else typed into its terminal as above.
  if (key.startsWith('view:')) {
    const a = byId(key.slice(5))
    if (!a) return { key, enabled: false }
    // Rapid-fire mode (S-1004) mails the agent: a new thread per send, or a follow-up in the picked
    // card's thread. Mail reaches it running or not. The target is taken now, at the send.
    if (isRapid(a.id)) {
      const rapid = rapidTarget(a.id, pick, rapidThreads(a.id, getData()))
      return { key, name: a.name, kind: 'rapid', a, rapid, enabled: true,
        label: pick ? <span className="rf-target" data-rf="reply" title={`Follow-up in: ${pick.text}`}><Icon name="reply" size="xs" /><span className="rf-target-t"><span className="rf-target-w">Follow-up in </span><b>{pick.text}</b></span>
          <button className="icon-btn rf-unpick" type="button" title="Back to new threads (Esc)" aria-label="Back to new threads" onClick={() => setPick(a.id, null)}><Icon name="x" size="xs" /></button></span>
          : <span className="rf-target" data-rf="new"><Icon name="zap" size="xs" /><span className="rf-target-t">New thread to <b>{a.name}</b></span></span>,
        placeholder: pick ? 'Follow up in this thread' : `A new thread to ${a.name}` }
    }
    // Where the view can't take prompts, the box mails the agent: Direct is off, its reason the terminal.
    const direct = !!a.view?.can_send && a.machine === getData().machine
    const placeholder = !live(a) ? `${a.name} isn't running` : direct ? `Message ${a.name}` : `Mail ${a.name}`
    return { key, name: a.name, kind: 'agent', a, direct, enabled: live(a), noDirect: direct ? undefined : 'Prompts are typed into its terminal', label: <><Glyph agent={a} /><b>{a.name}</b></>, placeholder }
  }
  if (key.startsWith('shell:')) return { key, name: 'a terminal', kind: 'shell', enabled: true, label: <><Icon name="terminal" size="xs" /><b>Terminal</b></>, placeholder: 'Type a command; Enter runs it' }
  // A desktop's mail thread and ITSA are written to from this bar (S-1436): the view publishes what the send needs.
  // A phone's thread and ITSA views keep their own box.
  if (!phone && (key.startsWith('thread:') || key.startsWith('itsa:'))) {
    const slot = getBottomSlot(key)
    return slot ? { key, kind: 'slot', slot, enabled: slot.target.enabled, label: slot.target.label, placeholder: slot.target.placeholder, name: slot.target.name }
      : { key, kind: 'slot', enabled: false, label: '', placeholder: 'Loading' }
  }
  // A thread has its own reply box.
  if (key.startsWith('thread:') || key.startsWith('itsa:')) return { key, kind: 'thread', enabled: false }
  // A requirement's world has nobody to write to.
  if (key.startsWith('req:')) return bt.kind === 'none' && !phone ? { key, kind: 'none', enabled: false, label: '', placeholder: bt.context } : { key, kind: 'thread', enabled: false }
  // The Work page writes to the chief of staff, by mail.
  if (key === 'work') {
    const cos = getData().agents.find((a) => a.chief_of_staff)
    if (!cos) return { key, kind: 'chief', enabled: false, label: '', placeholder: 'No chief of staff' }
    return { key, name: cos.name, kind: 'chief', a: cos, enabled: true, label: <><Glyph agent={cos} /><b>{cos.name}</b></>, placeholder: `Mail ${cos.name}` }
  }
  return { key, kind: 'none', enabled: false, label: '', placeholder: bt.kind === 'none' && !phone ? bt.context : 'Select an agent or terminal pane to write to it' }
}
// Types a message into an agent: through its view where the view takes prompts, else into its terminal.
async function typeToAgent(a: Agent, { text, files, client_id }: SendPayload, direct: boolean) {
  if (direct && !files?.length) await api('POST', `/api/agents/${a.id}/view/prompt`, { text, client_id })
  else await api('POST', `/api/agents/${a.id}/prompt`, { text, files, client_id })
}
// Sends to the pane `t` named when the human submitted (not the pane focused when a retry runs).
async function sendToPane(t: ReturnType<typeof paneTarget>, p: SendPayload): Promise<string | void> {
  const { text, files, client_id } = p
  if (!t.enabled) throw new Error('Select an agent or terminal pane first.')
  if (t.kind === 'slot') return t.slot!.onSend(p)
  if (t.kind === 'rapid') return sendRapid(t.a!, t.rapid!, { text, files, client_id })
  if (t.kind === 'agent') await typeToAgent(t.a!, { text, files, client_id }, !!t.direct)
  else if (t.kind === 'shell') { const [, m, id] = t.key.split(':'); await api('POST', `/api/shells/${id}/input`, { text, files, machine: m, client_id }) }
  else if (t.kind === 'chief') return sendToChief(t.a!, { text, files, client_id })
}
function Bottom() {
  useData()
  const typing = useTyping()
  const [toAsst, setToAsst] = useState(false)
  useUi()
  useBottomSlotVersion()
  const composer = useRef<ComposerHandle>(null)
  const bottom = useRef<HTMLElement>(null)
  useEffect(() => { setBottomHandle({ focus: () => composer.current?.focus(), restore: (d, k) => composer.current?.restore(d, k) }); return () => setBottomHandle(null) }, [])
  const pick = usePick(inputMain()?.startsWith('view:') ? inputMain()!.slice(5) : '')
  const t = paneTarget(pick)
  // The open view of the focused agent: its turn's Stop takes the send button's place, and a failed Stop shows under the box.
  const viewing = useLive(t.key.startsWith('view:') ? t.key.slice(5) : undefined)
  // Mail mode only where it means something: the focused pane is a live agent.
  const mailTo = t.kind === 'agent' && t.enabled && t.a ? t.a : null
  // A phone shows the prompt input only for an agent or a terminal (a thread has its own
  // reply box), and swaps it for a row of the keys its keyboard lacks while a terminal
  // itself has the keyboard.
  const phone = shell.isPhone()
  const keys = phone && !!typing?.closest('#w-main .term-view')
  // Nothing in the main world takes input (or nothing is selected): the bar suggests a recipient (S-1474).
  const bt = bottomTarget(shell.activeIn('main'))
  const hidden = phone ? bt.kind !== 'none' && !(t.kind === 'agent' || t.kind === 'shell' || t.kind === 'chief' || t.kind === 'rapid') : !shell.worldOpen('bottom')
  // On a desktop a conversation or a thread takes the focused pane's column (S-2284).
  useBottomColumn(bottom, !phone && (t.key.startsWith('view:') || t.key.startsWith('thread:')))
  return (
    <section ref={bottom} className={'world' + (t.kind === 'thread' && !toAsst ? ' yield' : '') + (!phone && t.key.startsWith('view:') ? ' conv' : '') + (!phone && t.key.startsWith('thread:') ? ' conv mail' : '')} id="w-bottom" aria-label="Bottom" hidden={hidden}>
      {keys ? <KeyRow viewKey={t.key} /> : null}
      {bt?.kind === 'none' ? <SuggestBar composerRef={composer} context={bt.context} /> : <div hidden={keys} style={{ display: 'contents' }}>
        <Composer ref={composer} target={t.slot ? t.slot.target : { key: t.key || 'none', enabled: t.enabled, label: t.label, placeholder: t.placeholder, name: t.name, to: mailTo?.id }} onSend={(p) => sendToPane(t, p)} assistant={assistantOpts} onAssistantChange={setToAsst}
          staged={!!t.slot?.staged} onInput={t.slot?.onInput} onSubmit={t.slot?.onSubmit} note={t.slot?.note} takesCc={t.slot?.takesCc}
          mail={mailTo ? (p) => sendToAgentByMail(mailTo, p) : undefined} noDirect={'noDirect' in t ? t.noDirect : undefined} onStop={viewing?.running && viewing.stop ? viewing.stop : undefined} stopError={viewing?.stopError} />
      </div>}
    </section>
  )
}

// The keys a phone's keyboard lacks, for typing into a terminal: they go to the focused
// pane's terminal without taking the focus from it, so the keyboard stays up.
const KEYS: { key: string; label: React.ReactNode; title: string }[] = [
  { key: 'esc', label: 'Esc', title: 'Escape' }, { key: 'tab', label: 'Tab', title: 'Tab' }, { key: 'backtab', label: '⇧Tab', title: 'Shift+Tab' },
  { key: 'up', label: <Icon name="arrow-up" />, title: 'Up' }, { key: 'down', label: <Icon name="arrow-down" />, title: 'Down' },
  { key: 'left', label: <Icon name="arrow-left" />, title: 'Left' }, { key: 'right', label: <Icon name="arrow-right" />, title: 'Right' },
  { key: 'ctrl-c', label: 'Ctrl C', title: 'Ctrl+C: interrupt' }, { key: 'enter', label: <Icon name="corner-down-left" />, title: 'Enter' },
]
function KeyRow({ viewKey }: { viewKey: string }) {
  const h = () => shell.viewHandle(viewKey)
  return (
    <div className="key-row" role="toolbar" aria-label="Terminal keys" onMouseDown={(e) => e.preventDefault()}>
      <div className="keys">{KEYS.map((k) => <button key={k.key} className="key" type="button" title={k.title} aria-label={k.title} onClick={() => h()?.key?.(k.key)}>{k.label}</button>)}</div>
      <button className="icon-btn" type="button" title="Put the keyboard away" aria-label="Put the keyboard away" onClick={() => h()?.blur?.()}><Icon name="keyboard-off" /></button>
    </div>
  )
}

// --- The top world: the assistant's terminal and a prompt input, over everything --------
function TopTerm({ id }: { id: string }) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const s = new TermSession(id)
    host.current!.append(s.el)
    const raf = requestAnimationFrame(() => s.show())
    const on = () => s.resize()
    addEventListener('resize', on)
    return () => { cancelAnimationFrame(raf); removeEventListener('resize', on); s.destroy() }
  }, [id])
  return <div ref={host} style={{ display: 'contents' }} />
}
const OwnView = lazy(() => import('./views/OwnView').then((m) => ({ default: m.OwnView })))
export function TopWorld() {
  useData()
  const { topOpen } = useUi()
  const composer = useRef<ComposerHandle>(null)
  const t = topTarget()
  // The chief of staff's open view: its turn's Stop and why the last one failed, as the bottom input has them.
  const viewing = useLive(t.agent?.id)
  // A view the daemon gives up on shows the terminal here, as it does in the main world (S-82).
  const [gone, setGone] = useState<string | null>(null)
  useEffect(() => { if (topOpen && !shell.isPhone()) requestAnimationFrame(() => composer.current?.focus()) }, [topOpen, t.id])
  if (!topOpen) return null
  // With a chief of staff, a switch picks whom to write to; each shows its own terminal.
  const all = topTargets()
  const a = t.agent
  const chief = t.id !== 'assistant'
  // The agent shows as it does elsewhere: its conversation by default, its terminal otherwise.
  const view = gone === a?.id ? 'terminal' : topView(a)
  return <>
    <div id="top-scrim" onClick={() => openAssistant(false)} />
    <section id="top-world" aria-label={chief ? t.name : 'Assistant'} data-target={t.id}>
      <header>
        {all.length > 1 ? <div className="seg top-targets" role="group" aria-label="Write to">{all.map((x) =>
          <button key={x.id} type="button" data-target={x.id} className={x.id === t.id ? 'on' : ''} aria-pressed={x.id === t.id}
            title={x.title} onClick={() => setTopTarget(x.id)}>
            {x.agent ? <Glyph agent={x.agent} /> : <PlainGlyph name="bot" />}{x.name}</button>)}</div> : null}
        <span className="top-name">{a ? <>{all.length > 1 ? null : <><Glyph agent={a} /><b>{a.name}</b></>}<span className="muted">{t.tag ? t.tag + ' · ' : ''}{stateLabel(a)} · {model(a).label}</span></> : <><PlainGlyph name="bot" /><b>Assistant</b><span className="muted">not started</span></>}</span>
        <span className="spacer" /><span className="kbd" title={all.length > 1 ? 'The next one to write to' : 'Close'}>Alt+C</span>
        <button className="icon-btn" id="top-close" title="Close (Esc)" aria-label={chief ? `Close ${t.name}` : 'Close the assistant'} onClick={() => openAssistant(false)}><Icon name="x" /></button>
      </header>
      <div className="top-term">{a && live(a) ? (view === 'conversation' ? <Suspense fallback={null}><OwnView key={a.id} id={a.id} onGone={() => setGone(a.id)} /></Suspense> : <TopTerm key={a.id} id={a.id} />)
        : <div className="empty-pane"><h3>Your executive assistant</h3><p>It routes what you write to the right agent, starts new agents, and manages mootr. It starts with your first message.</p></div>}</div>
      {/* A chief of staff takes Direct (typed into its agent, as in the bottom bar) or Mail (its mail). A
          chief that isn't running, or whose view gave up (gone), gets no Direct over its view. */}
      <div className="top-input"><Composer ref={composer} className="inline" onSend={chief && a ? (p) => typeToAgent(a, p, !!a.view?.can_send && a.machine === getData().machine && gone !== a.id) : t.send}
        mail={chief ? t.send : undefined} noDirect={chief && a && !live(a) ? `${a.name} isn't running` : undefined}
        onStop={viewing?.running && viewing.stop ? viewing.stop : undefined} stopError={viewing?.stopError}
        target={chief
          ? { key: 'top:' + t.id, name: t.name, to: a?.id, enabled: true, label: <><Glyph agent={a!} /><b>{t.name}</b></>, placeholder: a && live(a) ? `Message ${t.name}` : `${t.name} isn't running; it gets this as mail` }
          : { key: 'assistant-top', name: 'the assistant', enabled: true, label: assistantOpts.label(), placeholder: 'Ask your assistant: route a message, start an agent, check on things' }} /></div>
    </section>
  </>
}

// --- Phone navigation --------------------------------------------------------------------
// The bottom navigation: the agent tree, the mail list, the issues, the world in main
// (named for what it shows), and the assistant. Each keeps its place: the tree and the
// lists cover main without changing it, and main comes back as it was.
function MobileNav() {
  const { humanThreads, humanArchived, humanDeferred } = useData()
  const { topOpen } = useUi()
  const on = shell.phoneShows()
  const cw = shell.currentWorld()
  const world = !cw ? null : viewMeta(cw.startsWith('t:') ? 'thread:' + cw.slice(2) : cw.startsWith('w:') ? cw.slice(2) : 'agent:' + cw)
  // What waits on you, counted once (`useWaiting`): the Mail, Issues and Work badges agree. Unread is the Inbox page's own count.
  const waitingRows = useWaiting()
  const unread = unreadCount({ humanThreads, humanArchived, humanDeferred }, waitingRows, useDeferred())
  const waiting = waitingRows.length
  const onWork = cw === 'w:work'
  const onMail = cw === 'w:inbox'
  // The Inbox page is Mail's, so the Main slot keeps its own name and icon there.
  const onOwn = onWork || onMail
  const go = (side: 'left' | 'issues' | null) => { openAssistant(false); closeSearch(); closeSuggest(); shell.phoneShow(side) }
  const goWork = () => { openAssistant(false); closeSearch(); closeSuggest(); shell.phoneShow(null); openWorld('work') }
  const goMail = () => { openAssistant(false); closeSearch(); closeSuggest(); openMail() }
  return (
    <nav id="mobile-nav" aria-label="Navigation">
      <button data-nav="left" className={on === 'left' && !topOpen ? 'on' : ''} onClick={() => go('left')}><Icon name="users" /><span className="nl">Agents</span></button>
      <button data-nav="mail" className={onMail && !topOpen ? 'on' : ''} onClick={goMail}><Icon name="mail" /><span className="nl">Mail</span>
        {waiting ? <span className="badge warn" title={`${waiting} waiting on you`}>{waiting}</span> : unread ? <span className="badge" title={`${unread} unread`}>{unread}</span> : null}</button>
      <button data-nav="issues" className={on === 'issues' && !topOpen ? 'on' : ''} onClick={() => go('issues')}><Icon name="list-checks" /><span className="nl">Issues</span>
        {waiting ? <span className="badge warn" title={`${waiting} waiting on you`}>{waiting}</span> : null}</button>
      <button data-nav="main" className={!on && !topOpen ? 'on' : ''} onClick={() => { go(null); leaveMail() }}>{!onOwn && world?.icon ? world.icon : <Icon name="terminal" />}<span className="nl">{!onOwn && world?.title ? world.title : 'Main'}</span></button>
      <button data-nav="work" className={onWork ? 'on' : ''} onClick={goWork}><Icon name="layout-list" /><span className="nl">Work</span>
        {waiting ? <span className="badge warn" title={`${waiting} waiting on you`}>{waiting}</span> : null}</button>
      <button data-nav="assistant" className={topOpen ? 'on' : ''} onClick={() => openAssistant()}><Icon name="bot" /><span className="nl">Assistant</span></button>
    </nav>
  )
}

// --- Menus: a pane's items, then stam's and the layout's ------------------------------------
function paneItems(id: string): MenuItem[] {
  const w = shell.mainWorld()
  const l = shell.leafById(w, id)
  const d = getData()
  const a = byId(shell.currentWorld())
  const others = d.agents.filter((x) => live(x) && x.id !== a?.id)
  const pa = paneAgent(id)
  const items: MenuItem[] = [{ section: 'This pane' },
    ...(pa ? [hidesInput(pa) ? { label: 'Show the input area', icon: 'rows-2', action: () => setHideInput(pa, false) } : { label: 'Hide the input area', icon: 'rows-2', action: () => setHideInput(pa, true) }] : []),
    { label: 'New terminal', icon: 'terminal', action: () => newShell(a) },
    ...(a ? [treeItem(a)] : []),
    { label: 'Add an agent tab…', icon: 'plus', disabled: !others.length, action: (r) => showMenu(r.left, r.top, [{ section: 'Open as a tab' }, ...others.map((x) => ({ label: x.name, glyph: <Glyph agent={x} />, action: () => shell.open('main', 'agent:' + x.id, { pane: id }) }))]) },
    ...(a ? [{ label: `${a.name}'s inbox`, icon: 'inbox', action: () => shell.open('main', 'mail:' + a.id, { pane: id }) },
      { label: `${a.name}'s details`, icon: 'info', action: () => shell.open('main', 'details:' + a.id, { pane: id }) },
      { label: `${a.name}'s instructions`, icon: 'file-text', action: () => shell.open('main', 'instructions:' + a.id, { pane: id }) },
      { label: `${a.name}'s inventory`, icon: 'layers', action: () => shell.open('main', 'inventory:' + a.id, { pane: id }) }] : []),
    { label: 'Split right', icon: 'columns-2', action: () => shell.splitPane('main', id, 'right') },
    { label: 'Split down', icon: 'rows-2', action: () => shell.splitPane('main', id, 'down') }]
  if (l && shell.leaves(w.root).length === 1 && l.tabs.length <= 1) items.push(l.showTabs ? { label: 'Hide tab bar', icon: 'menu', action: () => shell.setTabBar('main', id, false) } : { label: 'Show tab bar', icon: 'menu', action: () => shell.setTabBar('main', id, true) })
  if (l?.active) { const k = l.active; items.push({ label: 'Close tab', icon: 'x', action: () => shell.close(k) }) }
  items.push({ label: 'Close pane', icon: 'x', disabled: shell.leaves(w.root).length < 2, action: () => shell.closePane('main', id) })
  return items
}
function globalItems(): MenuItem[] {
  const label = (n: 'left' | 'bottom', t: string) => `${shell.worldOpen(n) ? 'Hide' : 'Show'} ${t}`
  return [
    { section: 'mootr' },
    { label: 'Write and pick where…', icon: 'send', hint: 'Alt+A', action: openSuggest },
    { label: 'Assistant', icon: 'bot', hint: 'Alt+C', action: () => setTopTarget('assistant') },
    ...chiefsOfStaff().map((a): MenuItem => ({ label: `${a.name}, chief of staff`, glyph: <Glyph agent={a} />, hint: 'Alt+C', action: () => setTopTarget(a.id) })),
    { label: 'Add agent…', icon: 'plus', action: (r) => spawnMenu(r.left, r.top) },
    { label: 'Settings', icon: 'settings', action: () => openWorld('config') },
    { label: 'Usage', icon: 'chart-column', action: () => openWorld('usage') },
    { label: 'System view', icon: 'network', action: () => openWorld('system') },
    { label: 'Process view', icon: 'git-branch', action: () => openWorld('process') },
    { label: 'Files', icon: 'folder', action: () => openWorld('files') },
    { section: 'Layout' },
    { label: label('left', 'agent tree'), icon: 'panel-left-open', action: () => shell.toggleWorld('left') },
    { label: label('bottom', 'bottom bar'), icon: 'panel-bottom-open', action: () => shell.toggleWorld('bottom') },
    { label: 'Reset layout', icon: 'rotate-ccw', action: shell.resetLayout },
  ]
}

// A phone's one menu, from a pane's menu button or a long press: the world's agent's
// actions, then the pane's, then stam's. Splits and the desktop's side worlds don't apply,
// and what the agent's actions already hold isn't repeated.
const labelOf = (it: MenuItem) => (typeof it === 'object' && 'label' in it ? it.label : '')
function phoneItems(id: string | undefined): MenuItem[] {
  const a = byId(shell.currentWorld())
  const cw = shell.currentWorld()
  const thread = cw?.startsWith('t:') ? cw.slice(2) : null
  const needsAnswer = !!thread && threadWaitsOnHuman(thread)
  const drop = new Set(['Open its world', 'Split right', 'Split down', 'Hide tab bar', 'Show tab bar', 'Hide agent tree', 'Show agent tree', 'Hide bottom bar', 'Show bottom bar'])
  const dupe = new Set(a ? ['New terminal', `${a.name}'s inbox`, `${a.name}'s details`, `${a.name}'s instructions`, labelOf(treeItem(a))] : [])
  const keep = (it: MenuItem) => !drop.has(labelOf(it))
  return [
    ...(thread ? [{ section: 'This thread' } as MenuItem,
      isDeferredThread(thread)
        ? { label: 'Undefer', icon: 'alarm-clock-off', action: () => toggleThreadDeferred(thread) }
        : { label: 'Defer', icon: 'alarm-clock', action: () => toggleThreadDeferred(thread) },
      isArchivedThread(thread)
        ? { label: 'Unarchive', icon: 'archive-restore', action: () => toggleThreadArchived(thread) }
        : { label: 'Archive', icon: 'archive', disabled: needsAnswer, action: () => toggleThreadArchived(thread) }] : []),
    ...(a ? agentMenu(a) : []), ...(id ? paneItems(id) : []).filter((it) => !dupe.has(labelOf(it))), ...globalItems()].filter(keep)
}

export function App() {
  const st = shell.useShell()
  const { machine } = useData()
  const ui = useUi()
  const left = useRef<HTMLElement>(null)
  useEffect(() => {
    const menu = (e: MouseEvent) => {
      // A control that handled its own contextmenu (the paperclip, the mic) has cancelled it: no pane menu over it.
      if (e.defaultPrevented) return
      const t = e.target as Element
      if (t.closest('input, textarea, .node, .mail-read, pre, .menu, .bcard')) return
      // A long press on a mail's text selects it on a phone.
      if (shell.isPhone() && t.closest('.msg, .reply-preview')) return
      e.preventDefault()
      const pane = t.closest<HTMLElement>('.pane')
      showMenu(e.clientX, e.clientY, shell.isPhone() ? phoneItems(pane?.dataset.id) : [...(pane ? paneItems(pane.dataset.id!) : []), ...globalItems()])
    }
    // Alt+1: the tree view, side by side first; Alt+2: stacked first; the same key again, or
    // Alt+0, leaves it. Alt+A opens or closes the prompt that suggests where a message goes
    // (S-1461); Alt+C opens the assistant on the one last written to, or moves to the next
    // (the assistant, then each chief of staff). Ctrl/Cmd+K opens the search palette.
    // Caught before the terminal sees them.
    const keys = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyK') { e.preventDefault(); e.stopPropagation(); toggleSearch(); return }
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      const fn = ({ Digit1: () => enterTree('row'), Digit2: () => enterTree('col'), Digit0: exitTree, KeyA: toggleSuggest, KeyC: nextTopTarget } as Record<string, () => void | boolean>)[e.code]
      if (!fn || fn() === false) return
      e.preventDefault()
      e.stopPropagation()
    }
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // The image viewer is the topmost overlay; Escape closes it first.
      if (getUi().viewer) { e.preventDefault(); closeImage(); return }
      // The palette owns Escape while it is open; this catches the case where its box lost focus.
      if (getUi().searchOpen) { e.preventDefault(); closeSearch(); return }
      if (getUi().suggestOpen) { e.preventDefault(); closeSuggest(); return }
      const top = document.getElementById('top-world')
      const term = top?.querySelector('.term-view')
      if (top && !term?.contains(document.activeElement)) { e.preventDefault(); openAssistant(false) }
    }
    // `e` archives the open mail thread, or unarchives it when it is archived, and `d` defers it, or
    // undefers it; never while typing, and not with a menu open over it.
    const archive = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      const cw = shell.currentWorld()
      const act = threadKey(e.key.toLowerCase(), cw)
      if (!act) return
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable=true]') || document.querySelector('.menu, .spawn-panel')) return
      e.preventDefault()
      void (act === 'archive' ? toggleThreadArchived : toggleThreadDeferred)(cw!.slice(2))
    }
    const resize = () => { shell.changed(); shell.resizeAll() }
    const offViewer = installImageViewer()
    document.addEventListener('contextmenu', menu)
    addEventListener('keydown', keys, true)
    addEventListener('keydown', escape)
    addEventListener('keydown', archive)
    addEventListener('resize', resize)
    return () => { offViewer(); document.removeEventListener('contextmenu', menu); removeEventListener('keydown', keys, true); removeEventListener('keydown', escape); removeEventListener('keydown', archive); removeEventListener('resize', resize) }
  }, [])
  const phone = shell.isPhone()
  const leftOpen = phone ? st.mobile === 'left' || st.mobile === 'issues' : st.open.left
  return <>
    <div id="shell">
      <section className={'world' + (phone && leftOpen ? ` mobile-open phone-${st.mobile}` : '')} id="w-left" aria-label="Agents" ref={left} hidden={!leftOpen} style={phone ? undefined : { width: shell.clampSize('left') }}>
        <div className="tree-tools">
          <button type="button" className="tree-search" data-tree-search onClick={() => toggleSearch()}><Icon name="search" /><span>Search agents, mail, issues</span></button>
          <div className="search"><Icon name="search" /><input id="search" placeholder="Search agents" autoComplete="off" spellCheck={false} value={ui.filter} onChange={(e) => setUi({ filter: e.target.value })} /></div>
          <button className="icon-btn" id="new-agent" title="Add an agent" aria-label="Add agent" aria-haspopup="menu"
            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); spawnMenu(r.left, r.bottom + 4, {}, e.currentTarget) }}><Icon name="plus" /></button>
        </div>
        {phone ? <>
          <Tree />
          <IssuesSide leftRef={left} />
          <ReqSide />
          <MachinesSide />
        </> : <SidebarPanes left={left} />}
        <div className="tree-footer">
          <ThemeButton />
          <PageButtons />
          <button className="icon-btn" id="open-config" title="Settings" aria-label="Settings" onClick={() => openWorld('config')}><Icon name="settings" /></button>
          <button className="icon-btn" id="open-usage" title="Usage and spend" aria-label="Usage" onClick={() => openWorld('usage')}><Icon name="chart-column" /></button>
          <button className="icon-btn" id="open-system" title="The whole system: every agent in its tree" aria-label="System view" onClick={() => openWorld('system')}><Icon name="network" /></button>
          <button className="icon-btn" id="open-process" title="A process: lanes, nodes, and live counts" aria-label="Process view" onClick={() => openWorld('process')}><Icon name="git-branch" /></button>
          <span className="spacer" />
          <span className="machine" title="This daemon's machine"><Icon name="server" size="xs" /><span id="machine">{machine}</span></span>
        </div>
      </section>
      <WorldSep name="left" />
      <div id="center">
        <MainWorld />
        <WorldSep name="bottom" />
        <Bottom />
      </div>
    </div>
    <Reveal />
    <TopWorld />
    <SearchPalette />
    <SuggestModal />
    <ImageViewer />
    <MobileNav />
    <SpawnPanel />
    <MenuLayer />
    <ViewPortals />
  </>
}

export { applyTheme, glyphHtml }
