// stam's own view of an agent (`view:ID`, S-79): its conversation drawn by stam beside its
// terminal, which stays the fallback. Both show one session. Live from the daemon's view
// stream (GET /api/agents/:id/view, src/agent-view.ts), which stays the source of truth:
// assistant-ui's external-store runtime only draws what the stream says (its viewport keeps
// the newest message in sight). Text goes through the mail renderer, so every mail
// component works in chat. The bottom prompt input sends (App.tsx); this view answers
// permissions and stops a turn, each only where the harness can (`capabilities`). The
// conversation reads as turns, like messages in a mail thread (S-1483): each input (the
// human's message, a mail into the agent, a stam notice) is a card on top, and the agent's
// response runs full width below it until the next input. Mail cards say who has read them.
// While a turn runs, a working indicator sits where the agent's next output will appear, and
// says what it does (S-205). There is no bar under the conversation: the agent's tab icon
// carries its state, and the prompt input's send button becomes Stop while a turn runs
// (ownview-live.ts, Composer.tsx).
// Loaded lazily (registry.tsx): assistant-ui is about 100 kB gzipped.
import { AssistantRuntimeProvider, getExternalStoreMessages, MessagePrimitive, ThreadPrimitive, useAuiState, useExternalStoreRuntime, type ThreadMessageLike } from '@assistant-ui/react'
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { fallBackToTerminal, openAgent, showView } from '../actions'
import { api, token } from '../api'
import { agentBase, FileBaseCtx } from '../files/fileBase'
import { Icon } from '../Icon'
import * as mb from '../mail/mailblocks'
import { Rendered } from '../mail/Rendered'
import { ConvMailCard, type ConvMail } from '../mail/ConvMailCard'
import { Avatar } from '../mail/ThreadPanel'
import { ToolCall, ToolGroup, type ToolCallItem } from '../mail/ToolGroup'
import { NoticeLine, TurnFrame } from '../mail/TurnFrame'
import { byId, getData, useData } from '../store'
import { clock } from '../waits'
import { clearLive, setLive } from './ownview-live'
import { activity, applyEvent, elapsed, loosePermissions, MAIL_NOTICE_LINE, mailNoticeSplit, plainText, prependOlder, readingOrder, toolRuns, turnKind, turns, type Activity, type PermissionDecision, type ToolPart, type Turn, type ViewEvent, type ViewMessage, type ViewPage, type ViewPart, type ViewPermission, type ViewState } from './ownview-model'
import { Loading } from '../Loading'
import { registerView } from '../shell/layout'
import { takeOpenFocus } from '../mail/diffOpen'

const PAGE = 50
const RETRY_MS = 2000

// Follows the view stream: server-sent events read through fetch, which can send the token
// header (EventSource can't). Reconnects after a drop; a 4xx (no view for this agent) stops.
function useViewStream(id: string) {
  const [state, setState] = useState<ViewState | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The daemon refused the view for good (4xx): the terminal takes its place.
  const [gone, setGone] = useState(false)
  useEffect(() => {
    let stop = false
    const ctl = new AbortController()
    ;(async () => {
      while (!stop) {
        try {
          const r = await fetch(`/api/agents/${id}/view`, { headers: { authorization: 'Bearer ' + token, 'x-stam-human': '1' }, signal: ctl.signal })
          if (!r.ok || !r.body) {
            const why = ((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`
            setError(why)
            if (r.status < 500) { setGone(true); return }
          } else {
            setError(null)
            const reader = r.body.pipeThrough(new TextDecoderStream()).getReader()
            let buf = ''
            for (;;) {
              const { value, done } = await reader.read()
              if (done) break
              buf += value
              let i
              while ((i = buf.indexOf('\n\n')) >= 0) {
                const data = buf.slice(0, i).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')
                buf = buf.slice(i + 2)
                if (data) { const ev = JSON.parse(data) as ViewEvent; setState((s) => applyEvent(s, ev)) }
              }
            }
          }
        } catch { if (stop) return }
        await new Promise((r) => setTimeout(r, RETRY_MS))
      }
    })()
    return () => { stop = true; ctl.abort() }
  }, [id])
  return { state, setState, error, gone }
}

// assistant-ui gets one message per turn, with its text only; the view draws each turn from
// the original. A turn the agent answered is the assistant's; one it hasn't is its input's.
function convert(t: Turn): ThreadMessageLike {
  const rows = t.input ? [t.input, ...t.items] : t.items
  const role = t.items.length || !t.input ? 'assistant' : t.input.role
  return {
    id: t.id,
    role,
    createdAt: new Date(rows[0].at),
    status: role === 'assistant' ? (t.items.some((m) => m.running) ? { type: 'running' } : { type: 'complete', reason: 'stop' }) : undefined,
    content: [{ type: 'text', text: rows.map(plainText).filter(Boolean).join('\n\n') }],
  }
}

const DECIDED: Record<string, string> = { once: 'Allowed once', always: 'Allowed always', reject: 'Denied' }

// The agent and its state, for the messages assistant-ui renders.
const Ctx = createContext<{ id: string; permissions: ViewPermission[]; can_approve: boolean } | null>(null)
// The agent alone, for the tool calls' summaries (S-1481): it never changes while the view
// shows, so a permission change doesn't redraw every row.
const AgentId = createContext<string | undefined>(undefined)

// A tool part as the shared tool components take it.
const call = (t: ToolPart): ToolCallItem => ({ id: t.id, name: t.name, input: t.input, result: t.output, status: t.status })

function PermissionCard({ id, p, status, waiting, canApprove }: { id: string; p: { id: string; action: string; resources: string[] }; status: string; waiting: boolean; canApprove: boolean }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const answer = async (decision: PermissionDecision) => {
    setBusy(true); setErr('')
    try { await api('POST', `/api/agents/${id}/view/permission`, { request: p.id, decision }) } catch (e) { setErr((e as Error).message) }
    setBusy(false)
  }
  const asked = status === 'asked' && waiting
  return (
    <div className={'ov-perm' + (asked ? ' asked' : '')} role={asked ? 'group' : undefined} aria-label="Permission request">
      <div className="ov-perm-q"><Icon name="shield-alert" size="xs" /><span>Allow <b>{p.action}</b>{p.resources.length ? <> on <code>{p.resources.join(' ')}</code></> : null}?</span></div>
      {asked && canApprove ? (
        <div className="ov-perm-actions">
          <button className="btn primary" type="button" disabled={busy} onClick={() => answer('once')}>Allow once</button>
          <button className="btn" type="button" disabled={busy} onClick={() => answer('always')}>Always</button>
          <button className="btn" type="button" disabled={busy} onClick={() => answer('reject')}>Deny</button>
        </div>
      ) : <div className="ov-perm-status">{asked ? 'Answer it in the terminal.' : (DECIDED[status] ?? 'No longer waiting.')}</div>}
      {err ? <div className="ov-perm-err" role="alert">{err}</div> : null}
    </div>
  )
}

// A mail part as the shared mail card takes it: a mail in has the agent as its one recipient.
type MailPart = Extract<ViewPart, { type: 'mail' }>
const asMail = (part: MailPart, at: number, self: string): ConvMail => ({
  id: part.id, from_id: part.from_id, from_name: part.from, subject: part.subject, body: part.body, thread_id: part.thread, created_at: at,
  recipients: part.to ?? [{ id: self, read_at: part.read_at }], kind: part.kind, health: part.health,
})

// A stam notice stays compact: one line, the rest on a tap or click. A notice of one line shows whole.
const noticeText = (text: string, i: number) => text.includes('\n') ? <NoticeLine key={i} text={text} /> : <Rendered key={i} text={text} className="ov-text" />

function Part({ part, m }: { part: ViewPart; m: ViewMessage }) {
  const c = useContext(Ctx)!
  if (part.type === 'text' && m.role === 'system') {
    const split = mailNoticeSplit(part.text)
    if (split) return <>{split.map((s, i) => s.mail ? <NoticeLine key={i} className="ov-mail-notice" line={MAIL_NOTICE_LINE} text={s.text} /> : noticeText(s.text, i))}</>
    if (m.kind === 'notice') return noticeText(part.text, 0)
  }
  if (part.type === 'text') return part.text ? <Rendered text={part.text} className="ov-text" /> : null
  if (part.type === 'reasoning') {
    if (!part.text.trim()) return null
    return <details className="ov-reasoning"><summary><Icon name="chevron-right" size="xs" />Thinking</summary><div className="ov-reasoning-body">{part.text}</div></details>
  }
  if (part.type === 'tool') return <ToolCall {...call(part)} agent={c.id} />
  if (part.type === 'mail') return <ConvMailCard m={asMail(part, m.at, c.id)} self={c.id} />
  const waiting = c.permissions.some((x) => x.id === part.id)
  return <PermissionCard key={m.id + part.id} id={c.id} p={part} status={part.status} waiting={waiting} canApprove={c.can_approve} />
}

// One drawn message: a row of the turn it belongs to.
function Row({ m, turn }: { m: ViewMessage; turn: string }) {
  const agent = useContext(AgentId)
  return (
    <div className={m.kind === 'mail' ? `ov-msg ov-mail${m.parts[0]?.type === 'mail' && m.parts[0].to ? ' out' : ''}` : `ov-msg ov-${m.role}`} data-id={m.id} data-kind={m.kind} data-turn={turn}>
      {m.role === 'user' && !m.kind ? <div className="ov-mail-head"><Avatar id="human" /><span className="who">You</span><time title={new Date(m.at).toLocaleString()}>{clock(m.at)}</time></div> : null}
      {toolRuns(readingOrder(m.parts)).map((item, i) => item.type === 'tools'
        ? <ToolGroup key={`tools:${item.tools[0].id}`} tools={item.tools.map(call)} agent={agent} />
        : <Part key={item.part.type === 'text' || item.part.type === 'reasoning' ? `${item.part.type}${i}` : `${item.part.type}:${item.part.id}`} part={item.part} m={m} />)}
      {m.error ? <p className="ov-error"><Icon name="circle-x" size="xs" />{m.error}</p> : null}
    </div>
  )
}

// assistant-ui draws a turn as one message (S-1483): its input as the card on top, its rows below.
function Message() {
  const msg = useAuiState((s) => s.message)
  const t = getExternalStoreMessages<Turn>(msg)[0]
  if (!t) return null
  return (
    <MessagePrimitive.Root className="ov-turn-root">
      <TurnFrame id={t.id} kind={turnKind(t)} input={t.input ? <Row m={t.input} turn={t.id} /> : null}>
        {t.items.map((m) => <Row key={m.id} m={m} turn={t.id} />)}
      </TurnFrame>
    </MessagePrimitive.Root>
  )
}

// Reduced motion asks for a still indicator; the zeroed duration tokens stop it too.
const REDUCED = '(prefers-reduced-motion: reduce)'
const onMotionChange = (fn: () => void) => { const q = matchMedia(REDUCED); q.addEventListener('change', fn); return () => q.removeEventListener('change', fn) }
const useStill = () => useSyncExternalStore(onMotionChange, () => matchMedia(REDUCED).matches)

// The time now, once a second while `on`: the turn's running time counts up.
function useNow(on: boolean) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [on])
  return now
}

// The working indicator, where the agent's next output will appear: three dots in the
// working colour that pass a slow wave along while a tool runs or the agent writes, and
// breathe together while it thinks; then what it does and for how long. A permission that
// waits stills it to a warning line. Reduced motion: the dots stand still.
function Working({ act }: { act: Activity }) {
  const still = useStill()
  const now = useNow(act.since !== null)
  return (
    <div className={`ov-work ${act.kind}${still ? ' still' : ''}`} data-kind={act.kind}>
      {act.kind === 'asking' ? <Icon name="shield-alert" size="xs" /> : <span className="ov-work-dots" aria-hidden="true"><i /><i /><i /></span>}
      <span className="ov-work-label" role="status">{act.label}{act.detail ? <>: <code>{act.detail}</code></> : null}</span>
      {act.since !== null ? <span className="ov-work-time">{elapsed(now - act.since)}</span> : null}
    </div>
  )
}

// Older messages, read on scrolling near the top (or with the button), keeping what's on
// screen where it was.
function useOlder(id: string, state: ViewState | null, setState: (f: (s: ViewState | null) => ViewState | null) => void, viewport: React.RefObject<HTMLDivElement | null>) {
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const keep = useRef<number | null>(null)
  const older = state?.older ?? null
  const load = useCallback(async () => {
    if (!older || loading) return
    setLoading(true); setErr('')
    try {
      const page = await api<ViewPage>('GET', `/api/agents/${id}/view/history?before=${encodeURIComponent(older)}&limit=${PAGE}`)
      const el = viewport.current
      keep.current = el ? el.scrollHeight - el.scrollTop : null
      setState((s) => {
        const next = s ? prependOlder(s, page, older) : s
        if (next === s) keep.current = null
        return next
      })
    } catch (e) { setErr((e as Error).message) }
    setLoading(false)
  }, [id, older, loading, setState, viewport])
  const first = state?.messages[0]?.id
  useLayoutEffect(() => {
    const el = viewport.current
    if (el && keep.current !== null) el.scrollTop = el.scrollHeight - keep.current
    keep.current = null
  }, [first, viewport])
  useEffect(() => {
    const el = viewport.current
    if (!el) return
    const near = () => { if (el.scrollTop < el.clientHeight / 2) load() }
    el.addEventListener('scroll', near, { passive: true })
    return () => el.removeEventListener('scroll', near)
  }, [load, viewport])
  return { older, loading, err, load }
}

// onGone: what to do when the view stream is gone; the default swaps the terminal in for it in
// every world that shows it (the top world has no such tab, so it passes its own).
export function OwnView({ id, onGone, viewKey }: { id: string; onGone?: () => void; viewKey?: string }) {
  useData()
  const { state, setState, error, gone } = useViewStream(id)
  // The terminal stays the fallback: a view the daemon can't give shows the terminal in its
  // place (S-82), in whichever world has it; the note below shows until it does.
  useEffect(() => { if (gone && !state) (onGone ?? (() => fallBackToTerminal(id)))() }, [gone, state, id])
  const viewport = useRef<HTMLDivElement>(null)
  // The Open button in a diff block takes focus back on return, as in a thread (S-2105 review): only one from this view.
  useEffect(() => (viewKey ? registerView(viewKey, { focus: () => takeOpenFocus(viewport.current)?.focus() }) : undefined), [viewKey])
  const older = useOlder(id, state, setState, viewport)
  const [stopErr, setStopErr] = useState('')
  const stop = useCallback(async () => { setStopErr(''); try { await api('POST', `/api/agents/${id}/view/interrupt`) } catch (e) { setStopErr((e as Error).message) } }, [id])
  // The drawn messages (`layout`), in turns (S-1483).
  const lastTurns = useRef<Turn[]>([])
  const shown = useMemo(() => (lastTurns.current = turns(state?.messages ?? [], lastTurns.current)), [state?.messages])
  const runtime = useExternalStoreRuntime<Turn>({
    messages: shown,
    isRunning: state?.running ?? false,
    convertMessage: convert,
    // The bottom prompt input sends (App.tsx); this view has no composer of its own.
    onNew: async () => {},
    onCancel: async () => { await api('POST', `/api/agents/${id}/view/interrupt`) },
  })
  const name = byId(id)?.name ?? 'the agent'
  // The chrome around the view (the tab icon, the prompt input's Stop) follows the live turn.
  const here = byId(id)?.machine === getData().machine
  const canStop = here && !!state?.capabilities.can_interrupt
  const running = !!state?.running, asking = !!state?.permissions.length
  // A stop error shows under the prompt input while the turn runs, where the send button was Stop.
  // A failed stop belongs to the turn it failed in: the next turn starts with no error.
  useEffect(() => { if (!running) setStopErr('') }, [running])
  const [owner] = useState(() => ({}))
  useEffect(() => { setLive(id, owner, { running, asking, stop: canStop ? stop : null, stopError: running ? stopErr : '' }) }, [id, owner, running, asking, canStop, stop, stopErr])
  useEffect(() => () => clearLive(id, owner), [id, owner])
  // What a Part reads, memoized so a stream event doesn't redraw the parts of unchanged turns (S-1566).
  const canApprove = here && !!state?.capabilities.can_approve
  const permissions = state?.permissions
  const ctx = useMemo(() => ({ id, permissions: permissions ?? [], can_approve: canApprove }), [id, permissions, canApprove])
  // Relative file paths in this conversation resolve in the viewed agent's cwd, on its machine (S-1529).
  const viewed = byId(id)
  const fileBase = useMemo(() => agentBase(id), [id, viewed?.machine, viewed?.cwd])
  if (error && !state) return <div className="ov-empty"><Icon name="info" /><span>{error}</span><button className="btn" type="button" onClick={() => showView(id, 'terminal')}><Icon name="terminal" size="xs" />Show the terminal</button></div>
  if (!state) return <Loading className="ov-empty" size="lg" label={`Loading ${name}'s conversation`} />
  // Sending, stopping, and answering go only through the daemon the browser reaches; for an
  // agent on another machine it answers 409, so the view stays read-only there.
  const caps = here ? state.capabilities : { ...state.capabilities, can_send: false, can_interrupt: false, can_approve: false }
  const loose = loosePermissions(state)
  const act = activity(state)
  const click = (e: React.MouseEvent) => {
    const o = (e.target as HTMLElement).closest<HTMLElement>('[data-open-agent]')
    if (o) { e.preventDefault(); return openAgent(o.dataset.openAgent!) }
    mb.handleClick(e.nativeEvent)
  }
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <AgentId.Provider value={id}><Ctx.Provider value={ctx}>
      <FileBaseCtx.Provider value={fileBase}>
        <ThreadPrimitive.Root className="ov">
          <ThreadPrimitive.Viewport className="ov-scroll" ref={viewport}>
            <div className="ov-col" onClick={click} onInput={(e) => mb.handleInput(e.nativeEvent)}>
              {older.older ? <button className="ov-older" type="button" disabled={older.loading} onClick={older.load}><Icon name="history" size="xs" />{older.loading ? 'Loading earlier messages…' : 'Earlier messages'}</button>
                : state.messages.length ? <p className="ov-start">Start of the conversation</p> : <p className="ov-start">No messages yet.</p>}
              {older.err ? <p className="ov-error" role="alert">{older.err}</p> : null}
              <ThreadPrimitive.Messages components={{ Message }} />
              {loose.map((p: ViewPermission) => <PermissionCard key={p.id} id={id} p={p} status="asked" waiting canApprove={caps.can_approve} />)}
              {act ? <Working act={act} /> : null}
              {error ? <p className="ov-work reconnecting"><Icon name="info" size="xs" />Reconnecting</p> : null}
            </div>
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
      </FileBaseCtx.Provider>
      </Ctx.Provider></AgentId.Provider>
    </AssistantRuntimeProvider>
  )
}
