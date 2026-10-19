// The prompt input: a growing text box that takes pasted or dropped images and files.
// The bottom bar uses it for the focused pane, a mail thread uses it to reply, and the top
// world for the assistant. Each target keeps its own draft, so switching panes doesn't
// lose what was typed.
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { Icon } from './Icon'
import type { Agent, Mail, SearchResult, UploadFile } from './types'
import { hideMenu, showPopover, swallowNextClick } from './ui/menu'
import { coarse } from './ui/phone'
import { HOLD_SLOP, buzz, holdMs } from './ui/longpress'
import { durationMs } from './ui/duration'
import { api, uploadClip } from './api'
import { addDraft, submit, take, useOutbox, type OutboxRow } from './outbox'
import { assistant as assistantAgent, byId, chiefAssistants, chiefsOfStaff, getData, subscribe, useData } from './store'
import { Glyph, PlainGlyph } from './Glyph'
import { RecipientMenu, makeRecipStore, type Recip, type RecipSnap } from './RecipientMenu'
import { CcPills, ccable, useCcSuggest } from './CcPills'
import { addItem, ccPayload, ccPills, type CcItem } from './cc-pills'
import { openStagedImage } from './image-tab'
import { startRecording, type Recording } from './voice'

const MAX_FILE = 20 * 1024 * 1024
// How long after a send the button stays Send: the --duration-hold token (a press's length, the same
// as the double-click window it stands in for), so a second click on the emptied box doesn't Stop the turn.
const sendGuardMs = () => durationMs(getComputedStyle(document.documentElement).getPropertyValue('--duration-hold')) || 400
// Where the box sends: into the agent's terminal, or as mail from the human. A box starts in
// settings.promptDefaultMode and its toggle switches that box only.
type PromptMode = 'direct' | 'mail'
const useDefaultMode = () => useSyncExternalStore(subscribe, () => getData().promptDefaultMode)
// The text of each target's draft also lives in sessionStorage, so it survives a reload or a
// phone switching away and back. Files stay in memory: they are too big to store.
const DRAFT_KEY = 'stam/draft/'
const readDraft = (k: string | null) => { if (!k) return ''; try { return sessionStorage.getItem(DRAFT_KEY + k) ?? '' } catch { return '' } }
const writeDraft = (k: string | null, text: string) => {
  if (!k) return
  try { if (text) sessionStorage.setItem(DRAFT_KEY + k, text); else sessionStorage.removeItem(DRAFT_KEY + k) } catch {}
}
// Voice: a press longer than this records until release; a shorter tap toggles.
const HOLD_MS = 300
// Whether the daemon has an ElevenLabs key; asked once for the page, not once per box.
let voiceCfg: Promise<boolean> | undefined
const voiceConfigured = () => (voiceCfg ??= api<{ configured: boolean }>('GET', '/api/voice').then((d) => d.configured).catch(() => { voiceCfg = undefined; return false }))
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
const micError = (e: unknown) => {
  const name = (e as { name?: string })?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access is blocked: allow it in the browser to dictate'
  if (name === 'NotFoundError') return 'No microphone found'
  return 'Could not start the microphone'
}
// The files of a message, by name and size, to tell whether a put-back message was changed.
const fileSig = (fs: { name: string; size: number }[]) => fs.map((f) => `${f.name}:${f.size}`).join('|')
const ccSig = (cc: string[] | undefined) => (cc ?? []).join(',')
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`)

// `name`: the target in plain text, for the mail about a message that failed (S-375).
// `to`: the agent id the box mails, so a cc pick never repeats it.
export interface ComposerTarget { key: string | null; enabled: boolean; label?: ReactNode; placeholder?: string; name?: string; to?: string }
// Note mode: the box writes a note on one decision instead of the reply. Finishing hands the
// text back (empty removes the note) and the box returns to the reply's draft.
export interface ComposerNote { key: string; label: ReactNode; text: string; done: (text: string) => void; cancel: () => void }
// `client_id` goes into the request body: the daemon dedups a retry on it.
// `cc`: agent ids that get the mail besides its recipient (Mail mode only).
// `itsa`: the ITSA the mail is filed on, picked as a cc pill (S-1464).
export interface SendPayload { text: string; files: UploadFile[]; client_id?: string; cc?: string[]; itsa?: string }
interface Draft { text: string; files: FileItem[] }
export interface FileItem extends UploadFile { url: string }
// A draft handed to another box (S-1463): the box showing that target, or holding its draft aside,
// adds the text after its own; with none, the text joins the stored draft and the files wait for
// the box that next shows the target.
const handoffs = new Set<(key: string, text: string, files: FileItem[]) => boolean>()
const movers = new Set<(from: string, to: string) => void>()
const stashedFiles = new Map<string, FileItem[]>()
const joinDraft = (had: string, add: string) => (had.trim() ? (add ? `${had}\n\n${add}` : had) : add)
export function handoffDraft(key: string, text: string, files: FileItem[] = []) {
  if (!text && !files.length) return
  let held = false
  for (const h of handoffs) if (h(key, text, files)) held = true
  if (held) return
  writeDraft(key, joinDraft(readDraft(key), text))
  if (files.length) stashedFiles.set(key, [...(stashedFiles.get(key) ?? []), ...files])
}
// A target's draft moves to another key (a view swapped for the terminal): its stored text and the
// files waiting for a box to show it go with it, joined to what the new key already holds.
export function moveDraft(from: string, to: string) {
  const text = readDraft(from)
  if (text) { writeDraft(from, ''); writeDraft(to, joinDraft(readDraft(to), text)) }
  const fs = stashedFiles.get(from)
  if (fs) { stashedFiles.delete(from); stashedFiles.set(to, [...(stashedFiles.get(to) ?? []), ...fs]) }
  // Mounted boxes hold their own files (and the one showing `from` its text), which the stash no longer has.
  for (const m of movers) m(from, to)
}
export interface ComposerHandle {
  focus: () => void
  // Puts a draft back in the box, before anything the human has typed since.
  // `key`: the target the draft belongs to; when the box has moved on, it goes to that target's draft instead.
  restore: (draft: string, key?: string | null) => void
  // Takes the box's text and files out and empties the box, its stored draft too (Go to moves them on).
  take: () => { text: string; files: FileItem[] }
}
export interface Alternate { id: string; name: string; glyph: ReactNode; label: ReactNode; placeholder: string; send: (p: SendPayload) => Promise<string | void> }

interface Props {
  target: ComposerTarget
  // Sends; it throws to keep the draft. A string it returns shows as the notice.
  onSend: (p: SendPayload) => Promise<string | void>
  className?: string
  // With it, a Direct/Mail toggle sits beside send: Mail sends the text to the agent as mail
  // from the human (a thread of its own) instead of typing it into its terminal.
  mail?: (p: SendPayload) => Promise<string | void>
  // With it, Direct is off and Mail is the only way to send; the string says why, on Direct's title.
  noDirect?: string
  // With it, the stam icon opens the recipient menu with the executive assistant among its choices;
  // `to` makes the agent choices (parent, intake, cos) mail instead of the box's own send.
  assistant?: { send: (p: SendPayload) => Promise<string | void>; label: () => ReactNode; to?: (a: Agent) => Alternate }
  // Something besides the text is ready to send (a thread's staged answers).
  staged?: boolean
  onInput?: (text: string) => void
  // Runs at submit, before the box clears: for what the send consumes besides the text (a thread's
  // staged answers), taken at once so a second submit doesn't send them again. What it returns runs
  // if the message ends up failed.
  // It can instead return `{ onFailed, send, meta }`: `send` is the function this message goes out with
  // (bound now, so a retry doesn't look anything up again), and `meta` rides on its outbox row and
  // comes back through `onPutBack` when the row is put back in the box.
  onSubmit?: () => (() => void) | { onFailed?: () => void; send?: (p: SendPayload) => Promise<string | void>; meta?: unknown } | void
  onPutBack?: (meta: unknown) => void
  onAssistantChange?: (on: boolean) => void
  note?: ComposerNote | null
  // The box's own send takes cc and an ITSA, though it has no Mail mode (a thread reply).
  takesCc?: boolean
  // No cc pills: the Alt+A prompt and the bottom bar's suggestion mode suggest recipients themselves.
  noCcPills?: boolean
  // With it, the send button is Stop while the box is empty, in either mode: an agent's turn runs and its harness can be interrupted. With text or files, it stays Send.
  onStop?: () => void
  // Why the last Stop failed; it shows under the box until the next Stop or the turn's end.
  stopError?: string
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer({ target, onSend, mail, noDirect, className = '', assistant, staged = false, onInput, onSubmit, onPutBack, onAssistantChange, note, takesCc, noCcPills, onStop, stopError }, ref) {
  useData()
  // null writes to the target; 'assistant' or an agent's id writes there instead.
  const [asst, setAsst0] = useState<string | null>(null)
  const altAgent = asst && asst !== 'assistant' ? byId(asst) : undefined
  const alt = altAgent ? assistant?.to?.(altAgent) : undefined
  const toAssistant = !!asst && (asst === 'assistant' || !!alt)
  // The agent the message goes to, which no cc repeats.
  const recipientId = altAgent ? altAgent.id : asst === 'assistant' ? assistantAgent()?.id : target.to
  // The box's own pick; until the human picks, it follows the setting.
  const [picked, setPicked] = useState<PromptMode | null>(null)
  const defaultMode = useDefaultMode()
  const mode = picked ?? defaultMode
  // Mail only where it means something: an agent's pane, not a note or the assistant.
  const mailMode = (mode === 'mail' || !!noDirect) && !!mail && !note && !toAssistant
  // cc rides on mail: the Mail mode, or a message to an agent chosen in the recipient menu.
  const ccOk = !note && !!target.enabled && (mailMode || !!alt || (!!takesCc && !toAssistant))
  const [text, setText] = useState('')
  const [files, setFiles] = useState<FileItem[]>([])
  const [cc, setCc] = useState<string[]>([])
  // Threads and the ITSA picked from the cc pills (S-1464); agents picked there join `cc`.
  const [ccItems, setCcItems] = useState<CcItem[]>([])
  // Bumped whenever the cc empties (a send, a draft, another target), so a thread pick still
  // fetching its participants then is dropped rather than landing on the next message.
  const ccGen = useRef(0)
  const dropCc = () => { setCc([]); setCcItems([]); ccGen.current++ }
  // A transient notice or error; with none, the bar shows nothing there.
  const [flash, setFlash] = useState<{ text: string; err: boolean } | null>(null)
  const [drop, setDrop] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  // A long press on the paperclip opens the image-only picker: on Android Chrome that is the system
  // photo picker, which lists recent photos and screenshots first. A web page can't list the gallery.
  const imagePicker = useRef<HTMLInputElement>(null)
  const holdTimer = useRef<number | undefined>(undefined)
  const held = useRef(false)
  const [holding, setHolding] = useState(false)
  const stopTimer = () => { window.clearTimeout(holdTimer.current); holdTimer.current = undefined }
  // The timer only marks the hold: a file chooser needs the user activation a touch's pointerup
  // grants, so the picker opens when the finger lifts. At the threshold the finger hears a short
  // buzz and the paperclip takes its accent ring (`.cmp-attach.holding`), so it knows to lift
  // (S-776). A leave or cancel drops both.
  const holdFrom = useRef<{ x: number; y: number } | null>(null)
  // Only a hold in progress listens for a scroll: the page scrolling by itself (new mail) mustn't touch it.
  const endHoldRef = useRef((_keep: boolean) => {})
  const scrolled = useRef(() => endHoldRef.current(false)) // one function for good, so removeEventListener finds it
  const endHold = (keep: boolean) => {
    stopTimer(); holdFrom.current = null; removeEventListener('scroll', scrolled.current, true)
    setHolding(false); if (!keep) held.current = false
  }
  endHoldRef.current = endHold
  // A finger that slides more than a tap's wobble is scrolling or dragging, not holding.
  const moveHold = (e: ReactPointerEvent) => {
    const at = holdFrom.current
    if (at && Math.hypot(e.clientX - at.x, e.clientY - at.y) > HOLD_SLOP) endHold(false)
  }
  const startHold = (e: ReactPointerEvent) => {
    held.current = false
    if (e.pointerType !== 'touch') return
    stopTimer()
    holdFrom.current = { x: e.clientX, y: e.clientY }
    addEventListener('scroll', scrolled.current, true)
    holdTimer.current = window.setTimeout(() => {
      held.current = true
      setHolding(true)
      buzz()
    }, holdMs())
  }
  // Android sends no click after a hold (S-703), so the picker opens from the pointerup, which grants
  // a touch the user activation a file chooser needs; a click that does follow (iOS) is swallowed.
  const upHold = () => {
    const hold = held.current
    endHold(false)
    if (!hold) return
    imagePicker.current?.click()
    // After the picker's own click, which the swallow would eat and so block the chooser.
    swallowNextClick()
  }
  useEffect(() => () => { stopTimer(); removeEventListener('scroll', scrolled.current, true) }, [])
  const drafts = useRef(new Map<string | null, Draft>())
  const cur = useRef({ text, files })
  cur.current = { text, files }
  const timer = useRef(0)
  const sentTimer = useRef(0)
  const [sent, setSent] = useState(false)
  // Voice: one recording at a time. Starting takes a moment (the browser asks for the mic),
  // so a stop or cancel that comes during it is remembered and applied when it starts.
  const [voiceOn, setVoiceOn] = useState(false)
  const [voiceState, setVoiceState] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const [recSecs, setRecSecs] = useState(0)
  const [voiceErr, setVoiceErr] = useState('')
  const rec = useRef<Recording | null>(null)
  const starting = useRef(false)
  const after = useRef<'stop' | 'cancel' | null>(null)
  const recKey = useRef<string | null>(null)
  const recTimer = useRef(0)
  const errTimer = useRef(0)
  const levelEl = useRef<HTMLSpanElement>(null)
  const press = useRef({ at: 0, wasRec: false })
  const caret = useRef<number | null>(null)
  // False once the box has unmounted, so a mic request still pending then ends cleanly.
  const alive = useRef(true)

  const t: ComposerTarget = note
    ? { key: note.key, enabled: true, label: note.label, placeholder: 'Write a note: both, neither, or why' }
    : alt
    ? { key: 'to:' + alt.id, enabled: true, label: alt.label, placeholder: alt.placeholder, name: alt.name }
    : toAssistant && assistant
    ? { key: 'assistant', name: 'the assistant', enabled: true, label: assistant.label(), placeholder: 'Ask your assistant: route a message, start an agent, check on things' }
    : target
  const key = t.key
  const rows = useOutbox(key ?? '')
  // Unset until the first render, so the first target's draft is restored too.
  const keyRef = useRef<string | null | undefined>(undefined)
  const noteKey = useRef<string | null>(null)
  // A new target: keep the old draft, bring back the new one's.
  useLayoutEffect(() => {
    if (keyRef.current === key) return
    // A note keeps no draft: it ends finished or cancelled, and starts from the note itself.
    if (keyRef.current && keyRef.current !== noteKey.current) drafts.current.set(keyRef.current, cur.current)
    noteKey.current = note?.key ?? null
    const saved = drafts.current.get(key)
    const d = note ? { text: note.text, files: [] } : saved ?? { text: readDraft(key), files: [] }
    const stash = !note ? stashedFiles.get(key ?? '') : undefined
    if (stash) stashedFiles.delete(key ?? '')
    setText(d.text)
    setFiles(stash ? [...d.files, ...stash] : d.files)
    // A draft restored from sessionStorage is the box's text, so the parent hears it too.
    if (!note && !saved && d.text) onInput?.(d.text)
    keyRef.current = key
  }, [key])
  // cc belongs to the pane the box was writing to: a switch to another pane drops it, but a change of
  // recipient in the menu keeps the cc that aren't the new recipient (pick drops that one).
  useLayoutEffect(dropCc, [target.key])
  // The box grows with its text, up to a limit.
  useLayoutEffect(() => {
    const el = ta.current!
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 280) + 'px'
  }, [text, files, t.placeholder])
  useEffect(() => {
    const h = (k: string, add: string, fs: FileItem[]) => {
      if (keyRef.current === k) { change(joinDraft(cur.current.text, add)); if (fs.length) setFiles((f) => [...f, ...fs]); return true }
      const d = drafts.current.get(k)
      if (!d) return false
      const next = joinDraft(d.text, add)
      drafts.current.set(k, { text: next, files: [...d.files, ...fs] })
      writeDraft(k, next)
      return true
    }
    handoffs.add(h)
    const mv = (from: string, to: string) => {
      const keep = (fs: FileItem[]) => { if (fs.length) stashedFiles.set(to, [...(stashedFiles.get(to) ?? []), ...fs]) }
      if (keyRef.current === from) { keep(cur.current.files); setText(''); setFiles([]); onInput?.('') }
      const d = drafts.current.get(from)
      if (d) { keep(d.files); drafts.current.delete(from) }
    }
    movers.add(mv)
    return () => { handoffs.delete(h); movers.delete(mv) }
  })
  useImperativeHandle(ref, () => ({
    take: () => {
      const out = { text: cur.current.text.trim(), files: cur.current.files }
      change(''); setFiles([]); drafts.current.delete(key)
      return out
    },
    focus: () => ta.current?.focus(),
    restore: (draft, forKey) => {
      if (forKey !== undefined && forKey !== keyRef.current) {
        const d = drafts.current.get(forKey) ?? { text: readDraft(forKey), files: [] }
        const text = d.text.trim() ? `${draft}\n\n${d.text}` : draft
        drafts.current.set(forKey, { ...d, text })
        writeDraft(forKey, text)
        return
      }
      setText((cur) => { const next = cur.trim() ? `${draft}\n\n${cur}` : draft; onInput?.(next); writeDraft(keyRef.current ?? null, next); return next })
    },
  }), [onInput])
  useEffect(() => () => { clearTimeout(timer.current); clearTimeout(sentTimer.current) }, [])
  useEffect(() => { let live = true; voiceConfigured().then((on) => { if (live) setVoiceOn(on) }); return () => { live = false } }, [])
  // After a voice insert the caret goes to the end of the inserted text.
  useLayoutEffect(() => {
    if (caret.current === null || !ta.current) return
    ta.current.setSelectionRange(caret.current, caret.current)
    caret.current = null
  }, [text])
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      clearInterval(recTimer.current)
      clearTimeout(errTimer.current)
      rec.current?.cancel()
      rec.current = null
    }
  }, [])

  // Status renders here, at its source, rather than in a toast; the hint comes back after.
  const putBackRef = useRef<{ id: string; key: string; text: string; files: string; cc: string; itsa?: string } | null>(null)
  const noticeRef = useRef<(msg: string, err?: boolean) => void>(() => {})
  const notice = (msg: string, err = false) => {
    setFlash({ text: msg, err })
    clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setFlash(null), err ? 8000 : 3000)
  }
  noticeRef.current = notice
  const change = (v: string) => { setText(v); if (!note) { onInput?.(v); writeDraft(keyRef.current ?? null, v) } }
  // The x empties the box and forgets its draft; the files stay, as before.
  const clear = () => { change(''); drafts.current.delete(key); ta.current?.focus() }
  const setMode = (m: PromptMode) => {
    setPicked(m)
    ta.current?.focus()
  }
  const setAsst = (to: string | null) => { setAsst0(to); onAssistantChange?.(!!to); ta.current?.focus() }
  const toggleCc = (id: string) => setCc((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]))
  // The recipients the menu offers, those that exist, each agent once: the box's own target, its
  // parent, intake, cos, the assistant.
  const recips = (): Recip[] => {
    const out: Recip[] = [{ id: null, name: target.name ?? 'This box', tag: 'current', glyph: byId(target.to) ? <Glyph agent={byId(target.to)!} /> : <PlainGlyph name="terminal" /> }]
    if (!assistant?.to) return out
    const seen = new Set<string>(target.to ? [target.to] : [])
    const add = (a: Agent | undefined, tag: string) => { if (a && !seen.has(a.id)) { seen.add(a.id); out.push({ id: a.id, name: a.name, tag, glyph: <Glyph agent={a} /> }) } }
    add(byId(byId(target.to)?.parents?.[0]), 'parent')
    add(chiefAssistants()[0], 'intake')
    add(chiefsOfStaff()[0], 'chief of staff')
    const a = assistantAgent()
    out.push({ id: 'assistant', name: 'Assistant', tag: 'executive assistant', glyph: a ? <Glyph agent={a} /> : <PlainGlyph name="bot" /> })
    return out
  }
  const recipStore = useRef(makeRecipStore()).current
  const snap: RecipSnap = {
    recips: recips(), picked: asst, cc, ccOk, to: target.to, toggle: toggleCc,
    items: ccItems, drop: (id) => setCcItems((xs) => xs.filter((x) => x.id !== id)),
    pick: (id) => {
      hideMenu()
      // The new recipient can't also be a cc.
      const gone = id === 'assistant' ? assistantAgent()?.id : id ?? target.to
      if (gone) setCc((c) => c.filter((x) => x !== gone))
      setAsst(id)
    },
  }
  useLayoutEffect(() => { recipStore.set(snap) })
  const openRecipients = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault()
    const r = e.currentTarget.getBoundingClientRect()
    recipStore.set(snap)
    showPopover(r.left, r.top - 4, 'Recipient', <RecipientMenu store={recipStore} />, e.currentTarget, true)
  }
  const recipientName = alt ? alt.name : toAssistant ? 'the assistant' : t.name ?? 'this box'
  const ccN = cc.length + ccItems.length
  // The filed ITSA as an outbox row keeps it, so a put-back brings the pick back.
  const itsaOf = (id?: string) => { const x = id ? ccItems.find((y) => y.kind === 'itsa' && y.id === id) : undefined; return x && { id: x.id, title: x.title } }

  // cc pills (S-1464): wherever the box can send mail, what the human types suggests who else could
  // get it. A pick only adds a cc, and shows in the recipient menu: an agent joins cc, a thread brings
  // the agents who wrote in it, an ITSA has the mail filed on it. A box in Direct switches to Mail.
  const pillsOk = !noCcPills && !note && !!t.enabled && (ccOk || (!!mail && !toAssistant))
  const pills = ccPills(useCcSuggest(text, pillsOk), { to: recipientId, cc, items: ccItems }, ccable)
  // The room the pills take stays until the box empties, so the text doesn't jump as they come and go.
  const [room, setRoom] = useState(false)
  useEffect(() => { if (pills.length) setRoom(true); else if (!text.trim()) setRoom(false) }, [pills.length, text])
  const pickCc = async (r: SearchResult) => {
    if (!ccOk) setMode('mail')
    if (r.kind === 'agent') setCc((c) => (c.includes(r.id) ? c : [...c, r.id]))
    else if (r.kind === 'itsa') setCcItems((xs) => addItem(xs, { kind: 'itsa', id: r.id, title: r.title, people: [] }))
    else if (r.kind === 'thread') {
      const at = { key: keyRef.current, gen: ccGen.current }
      try {
        const [{ recipients }, mails] = await Promise.all([import('./views/ThreadView'), api<Mail[]>('GET', `/api/threads/${encodeURIComponent(r.id)}`)])
        if (keyRef.current !== at.key || ccGen.current !== at.gen) return
        const people = recipients(mails)
        if (!people.length) return notice(`Nobody in ${r.title} can get a cc`, true)
        setCcItems((xs) => addItem(xs, { kind: 'thread', id: r.id, title: r.title, people }))
      } catch (e) {
        notice(`Could not cc ${r.title}: ${(e as Error).message}`, true)
      }
    }
    ta.current?.focus()
  }

  const voiceFail = (msg: string) => {
    setVoiceErr(msg)
    clearTimeout(errTimer.current)
    errTimer.current = window.setTimeout(() => setVoiceErr(''), 8000)
  }
  async function startVoice() {
    if (rec.current || starting.current || !t.enabled) return
    setVoiceErr('')
    starting.current = true
    recKey.current = key
    let r: Recording
    try {
      r = await startRecording((l) => levelEl.current?.style.setProperty('--lvl', String(l)))
    } catch (e) {
      starting.current = false
      after.current = null
      voiceFail(micError(e))
      return
    }
    starting.current = false
    const next = after.current
    after.current = null
    // Unmounted while the browser asked for the mic: nothing is left running.
    if (next === 'cancel' || !alive.current) { r.cancel(); return }
    rec.current = r
    setVoiceState('recording')
    setRecSecs(0)
    const t0 = Date.now()
    clearInterval(recTimer.current)
    recTimer.current = window.setInterval(() => setRecSecs(Math.floor((Date.now() - t0) / 1000)), 250)
    if (next === 'stop') void stopVoice()
  }
  async function stopVoice() {
    const r = rec.current
    if (!r) { if (starting.current) after.current = 'stop'; return }
    rec.current = null
    clearInterval(recTimer.current)
    setVoiceState('transcribing')
    const k = recKey.current
    try {
      const clip = await r.stop()
      if (!clip.size) throw new Error('Nothing was recorded')
      const { text: heard } = await uploadClip(clip)
      insertVoice(heard, k)
    } catch (e) {
      voiceFail((e as Error).message || 'Could not transcribe that')
    } finally {
      setVoiceState('idle')
    }
  }
  function cancelVoice() {
    if (starting.current) after.current = 'cancel'
    const r = rec.current
    if (!r) return
    rec.current = null
    clearInterval(recTimer.current)
    r.cancel()
    setVoiceState('idle')
    setRecSecs(0)
  }
  // The text goes in at the caret, spaced to join what is there. Nothing is sent. If the box
  // has moved on to another target, it goes to that target's draft instead.
  function insertVoice(heard: string, k: string | null) {
    const clean = heard.trim()
    if (!clean) return voiceFail('No speech was heard')
    if (keyRef.current !== k) {
      const d = drafts.current.get(k) ?? { text: '', files: [] }
      const text = d.text + (d.text && !/\s$/.test(d.text) ? ' ' : '') + clean
      drafts.current.set(k, { ...d, text })
      writeDraft(k, text)
      return
    }
    const v = cur.current.text
    const el = ta.current
    const from = el ? el.selectionStart : v.length
    const to = el ? el.selectionEnd : v.length
    const before = v.slice(0, from)
    const rest = v.slice(to)
    const lead = before && !/\s$/.test(before) ? ' ' : ''
    const trail = rest && !/^\s/.test(rest) ? ' ' : ''
    caret.current = from + lead.length + clean.length
    change(before + lead + clean + trail + rest)
    el?.focus()
  }
  // The press rules: a press that starts a recording is a hold if it lasts past HOLD_MS, and
  // a tap otherwise (recording goes on until the next tap). A press during a recording stops it.
  function pressDown() {
    press.current = { at: Date.now(), wasRec: !!rec.current || starting.current }
    if (!press.current.wasRec) void startVoice()
  }
  function pressUp() {
    const p = press.current
    if (!p.at) return
    press.current = { at: 0, wasRec: false }
    if (p.wasRec || Date.now() - p.at >= HOLD_MS) void stopVoice()
  }

  async function add(list: File[]) {
    const out: FileItem[] = []
    for (const f of list) {
      if (f.size > MAX_FILE) { notice(`${f.name} is over ${size(MAX_FILE)}`, true); continue }
      const url = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(f) })
      out.push({ name: f.name, type: f.type, size: f.size, url, content_b64: url.split(',')[1] ?? '' })
    }
    setFiles((fs) => [...fs, ...out])
    ta.current?.focus()
  }

  // A staged image opens big, with the other staged images a step away.
  const openStaged = (at: number) => {
    const imgs = files.filter((f) => f.type.startsWith('image/'))
    openStagedImage(imgs.map((f) => ({ src: f.url, alt: f.name })), files.slice(0, at).filter((f) => f.type.startsWith('image/')).length)
  }
  const ready = !!note || t.enabled && (!!text.trim() || files.length > 0 || (!toAssistant && staged))
  // Sends at once: the box clears and the message goes to the outbox, whose strip shows it
  // until the request succeeds. The send function is picked now, so a retry goes where the
  // human meant even after they switch to another pane.
  function send() {
    const msg = text.trim()
    if (note) return note.done(msg)
    if (!ready) return
    // The box is empty after this send, so the button would be Stop: it stays Send, disabled, for the guard.
    setSent(true)
    clearTimeout(sentTimer.current)
    sentTimer.current = window.setTimeout(() => setSent(false), sendGuardMs())
    const items = files
    const extra = ccOk ? ccPayload(cc, ccItems, recipientId) : { cc: [] }
    const filed = itsaOf(extra.itsa)
    const payload: SendPayload = { text: msg, files: items.map(({ name, type, size, content_b64 }) => ({ name, type, size, content_b64 })), ...(extra.cc.length ? { cc: extra.cc } : {}), ...(extra.itsa ? { itsa: extra.itsa } : {}) }
    const fn = mailMode ? mail! : alt ? alt.send : toAssistant && assistant ? assistant.send : onSend
    // Sent again unchanged from a failed row: the same client id, so the daemon answers from the
    // first try (which may have landed even though its answer was lost) rather than sending twice.
    const back = putBackRef.current
    putBackRef.current = null
    const same = back && back.key === key && back.text === msg && back.files === fileSig(items) && back.cc === ccSig(payload.cc) && back.itsa === payload.itsa
    const sub = onSubmit?.()
    const bound = typeof sub === 'object' && sub ? sub : undefined
    const onFailed = (typeof sub === 'function' ? sub : bound?.onFailed) || undefined
    const sendFn = bound?.send ?? fn
    submit({ id: same ? back.id : undefined, onFailed, meta: bound?.meta, target: t.name, key: key ?? '', text: msg, files: items, mode: mailMode ? 'mail' : 'direct', cc: payload.cc, itsa: filed,
      title: !msg && !items.length ? 'Answers' : undefined,
      send: async (client_id) => { const sent = await sendFn({ ...payload, client_id }); if (typeof sent === 'string' && alive.current) noticeRef.current(sent) } })
    setText('')
    setFiles([])
    dropCc()
    drafts.current.delete(key)
    writeDraft(key, '')
    onInput?.('')
  }
  // Sets the box's text and files aside as a draft row for this target, and clears the box. The
  // row sits in the strip until a click restores it (putBack); the live draft goes with the box.
  function saveDraft() {
    const msg = text.trim()
    if (note || !(msg || files.length)) return
    const extra = ccOk ? ccPayload(cc, ccItems, recipientId) : { cc: [] }
    addDraft(key ?? '', msg, files, mailMode ? 'mail' : 'direct', extra.cc, itsaOf(extra.itsa))
    setText('')
    setFiles([])
    dropCc()
    drafts.current.delete(key)
    writeDraft(key, '')
    onInput?.('')
    ta.current?.focus()
  }
  // A failed row comes back into the box, before whatever was typed since.
  function putBack(r: OutboxRow) {
    const row = take(r.id)
    if (!row) return
    putBackRef.current = { id: row.id, key: row.key, text: row.text.trim(), files: fileSig(row.files), cc: ccSig(row.cc), itsa: row.itsa?.id }
    if (row.mode !== 'note' && mail && !note) setMode(row.mode)
    setText((cur) => { const next = cur.trim() ? (row.text ? `${row.text}\n\n${cur}` : cur) : row.text; onInput?.(next); writeDraft(keyRef.current ?? null, next); return next })
    setFiles((fs) => [...row.files, ...fs])
    if (row.cc?.length) setCc((c) => [...new Set([...row.cc!, ...c])])
    if (row.itsa) { const x = row.itsa; setCcItems((xs) => addItem(xs, { kind: 'itsa', id: x.id, title: x.title, people: [] })) }
    if (row.meta !== undefined) onPutBack?.(row.meta)
    ta.current?.focus()
  }

  const recording = voiceState === 'recording'
  return (
    <div className={['composer', className, !t.enabled && 'disabled', drop && 'drop', toAssistant && !note && 'to-assistant', note && 'noting', text && !note && 'has-text'].filter(Boolean).join(' ')}
      // Esc discards a recording wherever focus is in the box, the mic button included.
      onKeyDown={(e) => { if (e.key === 'Escape' && (rec.current || starting.current)) { e.preventDefault(); cancelVoice() } }}
      onDragOver={(e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); setDrop(true) } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(false) }}
      onDrop={(e) => { if (!e.dataTransfer?.files.length) return; e.preventDefault(); setDrop(false); add([...e.dataTransfer.files]) }}
      onMouseDown={(e) => {
        const el = e.target as Element
        if (el.closest('textarea, a')) return
        // The box's own buttons keep the focus in the text: on a phone, losing it drops the
        // keyboard and moves the button from under the finger before the tap lands.
        if (el.closest('button')) { if (document.activeElement === ta.current) e.preventDefault(); return }
        e.preventDefault()
        ta.current?.focus()
      }}>
      <OutboxStrip rows={rows} onPick={putBack} />
      <div className={'cmp-box' + (pills.length || (room && pillsOk) ? ' cc-room' : '')}>
        <CcPills pills={pills} onPick={pickCc} />
        <div className="cmp-files" hidden={!files.length}>
          {files.map((f, i) => f.type.startsWith('image/')
            ? <div key={i} className="cmp-file img" title={`${f.name} · ${size(f.size)}`}><button className="cmp-open" type="button" aria-label={`Open ${f.name}`} onClick={() => openStaged(i)}><img src={f.url} alt={f.name} /></button><button className="cmp-x" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}><Icon name="x" size="xs" /></button></div>
            : <div key={i} className="cmp-file" title={f.name}><Icon name="file-text" size="xs" /><span className="nm">{f.name}</span><span className="sz">{size(f.size)}</span><button className="cmp-x" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}><Icon name="x" size="xs" /></button></div>)}
        </div>
        <textarea ref={ta} rows={1} spellCheck autoComplete="off" value={text} disabled={!t.enabled} placeholder={t.placeholder ?? 'Write a message'}
          onChange={(e) => change(e.target.value)}
          // On a touch screen Enter adds a line, as phone keyboards expect; the send button sends.
          enterKeyHint={coarse() ? 'enter' : 'send'}
          onKeyUp={(e) => { if (e.code === 'KeyV' && press.current.at && voiceOn) pressUp() }}
          onKeyDown={(e) => {
            // Esc discards a recording before it closes a note.
            if (e.key === 'Escape' && (rec.current || starting.current)) { e.preventDefault(); e.stopPropagation(); cancelVoice(); return }
            if (e.altKey && e.code === 'KeyV') { e.preventDefault(); if (voiceOn && t.enabled && !e.repeat) pressDown(); return }
            if (e.key === 'Escape' && note) { e.preventDefault(); e.stopPropagation(); note.cancel(); return }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !e.altKey && !coarse()) { e.preventDefault(); send() } }}
          onPaste={(e) => {
            const fs = [...(e.clipboardData?.files ?? [])]
            if (!fs.length) return
            // A copied image arrives as a file; text pasted alongside it still goes in.
            if (!e.clipboardData.getData('text/plain')) e.preventDefault()
            add(fs.map((f) => (f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type }))))
          }} />
        {voiceState !== 'idle' || voiceErr
          ? <div className={'cmp-voice' + (voiceErr && voiceState === 'idle' ? ' err' : '')} role="status">
              {recording
                ? <><span className="cmp-rec-dot" aria-hidden="true" /><span className="cmp-level-track" aria-hidden="true"><span className="cmp-level" ref={levelEl} /></span><span className="cmp-timer">{clock(recSecs)}</span></>
                : voiceState === 'transcribing' ? <span>Transcribing…</span> : <span>{voiceErr}</span>}
            </div>
          : null}
        <div className="cmp-bar">
          {note ? null : <button className={'icon-btn cmp-attach' + (holding ? ' holding' : '')} type="button" data-lp="" title="Attach files (or paste, or drop them here; hold on a phone for recent screenshots)" aria-label="Attach files"
            aria-description="Hold for recent photos and screenshots"
            onPointerDown={startHold} onPointerMove={moveHold} onPointerUp={upHold} onPointerLeave={() => endHold(false)} onPointerCancel={() => endHold(false)}
            onContextMenu={(e) => { if (coarse() || held.current || holding) e.preventDefault() }}
            onClick={() => picker.current?.click()}><Icon name="paperclip" /></button>}
          {voiceOn && t.enabled
            ? <button className={'icon-btn cmp-mic' + (recording ? ' rec' : '')} type="button" aria-label={recording ? 'Stop recording' : 'Dictate'} aria-pressed={recording}
                disabled={voiceState === 'transcribing'}
                title={recording ? 'Stop (Alt+V); Esc discards the recording' : 'Dictate (Alt+V): tap to start and stop, or hold to talk'}
                onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); pressDown() }}
                onPointerUp={pressUp}
                onPointerCancel={pressUp}
                // A keyboard press has no pointer; it toggles.
                onClick={(e) => { if (e.detail === 0) { if (rec.current || starting.current) void stopVoice(); else void startVoice() } }}
                onContextMenu={(e) => e.preventDefault()}><Icon name="mic" /></button>
            : null}
          {!note && (assistant || ccOk)
            ? <button className={'icon-btn cmp-asst cmp-to' + (toAssistant || ccN ? ' on' : '')} type="button" aria-label={`Recipient: ${recipientName}${ccN ? `, cc ${ccN}` : ''}`} aria-haspopup="dialog"
                title={'Choose who it goes to' + (ccOk ? ' and who to cc' : '') + (assistant ? ': this agent, its parent, intake, cos, or your executive assistant' : '')}
                onClick={openRecipients} onContextMenu={openRecipients}>{alt ? alt.glyph : <Icon name="bot" />}{ccN ? <span className="cmp-to-n" aria-hidden="true">+{ccN}</span> : null}</button>
            : null}
          <span className="cmp-target">{t.label}</span>
          <span className={'cmp-hint' + (flash?.err ? ' err' : '')} role="status">{flash?.text}</span>
          {text && !note
            ? <button className="icon-btn cmp-clear" type="button" title="Clear the text" aria-label="Clear the text" onClick={clear}><Icon name="x" /></button>
            : null}
          {!note && t.enabled && (text.trim() || files.length)
            ? <button className="icon-btn cmp-draft" type="button" title="Save as draft (restore it from the strip)" aria-label="Save as draft (restore it from the strip)" onClick={saveDraft}><Icon name="pencil" /></button>
            : null}
          {mail && !note && !toAssistant
            ? <div className="seg cmp-mode" role="group" aria-label="Send as">
                <button type="button" className={!mailMode ? 'on' : ''} aria-pressed={!mailMode} disabled={!!noDirect} title={noDirect ?? "Type it into the agent's terminal"}
                  onClick={() => setMode('direct')}>Direct</button>
                <button type="button" className={mailMode ? 'on' : ''} aria-pressed={mailMode} title="Send it as mail from you: it lands in your mailbox and the answer joins the thread"
                  onClick={() => setMode('mail')}>Mail</button>
              </div>
            : null}
          {/* The phone has no room for both halves: one button holds the mode and switches it. */}
          {mail && !note && !toAssistant
            ? <button type="button" className={'icon-btn cmp-mode-one' + (mailMode ? ' on' : '')} aria-pressed={mailMode} disabled={!!noDirect}
                aria-label={mailMode ? 'Sending as mail; tap to send direct' : 'Sending direct; tap to send as mail'}
                title={noDirect ?? (mailMode ? 'Sending as mail from you: it lands in your mailbox and the answer joins the thread. Tap to type into the agent\'s terminal instead' : 'Sending direct: typed into the agent\'s terminal. Tap to send as mail instead')}
                onClick={() => setMode(mailMode ? 'direct' : 'mail')}><Icon name={mailMode ? 'mail' : 'terminal'} /></button>
            : null}
          {note
            ? <><button className="icon-btn cmp-cancel" type="button" title="Cancel the note (Esc)" aria-label="Cancel note" onClick={note.cancel}><Icon name="x" /></button>
              <button className="cmp-send cmp-note" type="button" title="Add the note (Enter)" aria-label="Add note" onClick={send}><Icon name="check" /></button></>
            : onStop && !text.trim() && !files.length && !sent
              ? <button className="cmp-send cmp-stop" type="button" title="Stop the turn" aria-label="Stop" onClick={onStop}><Icon name="square" /></button>
              : <button className="cmp-send" type="button" title={mailMode ? 'Mail it (Enter)' : 'Send (Enter)'} aria-label={mailMode ? 'Mail' : 'Send'} disabled={!ready} onClick={send}>{mailMode ? <><span className="ico-mail"><Icon name="mail" /></span><span className="ico-up"><Icon name="arrow-up" /></span></> : <Icon name="arrow-up" />}</button>}
        </div>
      </div>
      {stopError ? <p className="ov-error cmp-stop-err" role="alert">{stopError}</p> : null}
      <input ref={picker} type="file" multiple hidden onChange={(e) => { add([...(e.target.files ?? [])]); e.target.value = '' }} />
      <input ref={imagePicker} type="file" accept="image/*" multiple hidden data-images onChange={(e) => { add([...(e.target.files ?? [])]); e.target.value = '' }} />
    </div>
  )
})

// One thin line per message not yet delivered, above the box: pending ones wait on their
// request, failed ones can be clicked to put the message back in the box, drafts are ones
// the human set aside. At most three show; the rest scroll.
const firstLine = (r: OutboxRow) => r.title || r.text.split('\n').find((l) => l.trim())?.trim() || (r.files[0]?.name ?? 'Message')
function OutboxStrip({ rows, onPick }: { rows: OutboxRow[]; onPick: (r: OutboxRow) => void }) {
  if (!rows.length) return null
  return (
    <div className="cmp-outbox" role="list" aria-label="Messages not yet delivered">
      {rows.map((r) => {
        const n = r.files.length
        const body = <>
          <span className="ob-icon" aria-hidden="true"><Icon name={r.kind === 'failed' ? 'circle-alert' : r.kind === 'draft' ? 'pencil' : r.attempts > 1 ? 'rotate-ccw' : 'clock'} size="xs" /></span>
          {r.kind === 'failed' && r.error
            ? <span className="ob-text why"><b>{firstLine(r)}:</b> {r.error}</span>
            : <span className="ob-text">{firstLine(r)}</span>}
          {n ? <span className="ob-count"><Icon name={r.files.every((f) => f.type.startsWith('image/')) ? 'file-text' : 'paperclip'} size="xs" />{n}</span> : null}
          {r.kind === 'pending' && r.attempts > 1 ? <span className="ob-state ob-why" data-why>{r.error ? `Retrying: ${r.error}` : 'retrying'}</span> : null}
        </>
        return r.kind === 'pending'
          ? <div key={r.id} role="listitem" className="ob-row pending" data-kind="pending" title={r.attempts > 1 ? `Sending; retrying (${r.error})` : 'Sending'}>{body}</div>
          : <button key={r.id} type="button" role="listitem" className={'ob-row ' + r.kind} data-kind={r.kind} onClick={() => onPick(r)}
              title={r.kind === 'failed' ? `Failed: ${r.error ?? 'not sent'}. Click to put it back in the box` : 'Click to put it back in the box'}>{body}</button>
      })}
    </div>
  )
}
