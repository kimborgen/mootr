// The web side of stam's own view of an agent (S-79): the daemon's view schema
// (src/agent-view.ts, which documents every field) and the pure state changes the view
// makes from its stream and from older pages. The daemon is the source of truth: a
// `state` event replaces everything, a `message` event replaces one message whole.

export interface ViewCapabilities { can_stream: boolean; can_send: boolean; can_interrupt: boolean; can_approve: boolean }
export type ToolStatus = 'pending' | 'running' | 'done' | 'error'
export type PermissionDecision = 'once' | 'always' | 'reject'
export type ViewPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool'; id: string; name: string; input?: unknown; output?: string; status: ToolStatus }
  | { type: 'permission'; id: string; action: string; resources: string[]; tool?: string; status: 'asked' | PermissionDecision }
  | { type: 'mail'; id: string; from_id: string; from: string; subject: string; body: string; thread: string; read_at: number | null; to?: { id: string; name: string; read_at: number | null }[]; kind?: string; health?: string }
export interface ViewMessage { id: string; role: 'user' | 'assistant' | 'system'; kind?: string; at: number; marks?: number[]; parts: ViewPart[]; running?: boolean; error?: string }
export interface ViewPermission { id: string; action: string; resources: string[]; message?: string; tool?: string }
export interface ViewState { agent: string; harness: string; capabilities: ViewCapabilities; running: boolean; messages: ViewMessage[]; permissions: ViewPermission[]; older: string | null }
export type ViewEvent =
  | { type: 'state'; state: ViewState }
  | { type: 'message'; message: ViewMessage }
  | { type: 'status'; running: boolean; permissions: ViewPermission[] }
export interface ViewPage { messages: ViewMessage[]; older: string | null }

// Messages stay oldest first, by time. One that changes keeps its place unless its time
// changed (a streamed message starts with the daemon's clock, then a re-read gives it the
// harness's), and then it moves; equal times keep their arrival order.
function upsert(list: ViewMessage[], m: ViewMessage): ViewMessage[] {
  const i = list.findIndex((x) => x.id === m.id)
  if (i >= 0 && list[i].at === m.at) return list.with(i, m)
  const rest = i >= 0 ? list.toSpliced(i, 1) : list
  let at = rest.length
  while (at > 0 && rest[at - 1].at > m.at) at--
  return [...rest.slice(0, at), m, ...rest.slice(at)]
}

// Mail among the harness's messages, which keep their order: a mail goes above the first
// harness message that started after it was sent. As the daemon orders it (src/agent-view.ts).
export function interleave(messages: ViewMessage[]): ViewMessage[] {
  const mail = messages.filter((m) => m.kind === 'mail').sort((x, y) => x.at - y.at)
  if (!mail.length) return messages
  const out: ViewMessage[] = []
  let i = 0
  for (const h of messages) {
    if (h.kind === 'mail') continue
    while (i < mail.length && mail[i].at < h.at) out.push(mail[i++])
    out.push(h)
  }
  return [...out, ...mail.slice(i)]
}

// The messages as the view draws them (S-255): mail where it came in. A message whose parts
// carry their times (`marks`: a Claude Code turn, one message that can run for hours) splits
// at each mail sent during it, so the mail stays below the parts written before it and the
// turn's newer parts go below the mail. The first piece keeps the message's id, the rest are
// `ID#1`, `ID#2`, and so on; the last one keeps `running`.
export function layout(messages: ViewMessage[]): ViewMessage[] {
  const mail = messages.filter((m) => m.kind === 'mail').sort((x, y) => x.at - y.at)
  if (!mail.length) return messages
  const out: ViewMessage[] = []
  let i = 0
  for (const h of messages) {
    if (h.kind === 'mail') continue
    while (i < mail.length && mail[i].at < h.at) out.push(mail[i++])
    const marks = h.marks ?? []
    let from = 0
    let n = 0
    const piece = (to: number): ViewMessage => {
      const { running, ...rest } = h
      const p = { ...rest, id: n ? `${h.id}#${n}` : h.id, at: n ? marks[from] : h.at, parts: h.parts.slice(from, to), marks: marks.slice(from, to) }
      n++
      return to === h.parts.length && running ? { ...p, running } : p
    }
    for (let k = 0; k < marks.length && k < h.parts.length; k++) {
      if (!(i < mail.length && mail[i].at < marks[k])) continue
      if (k > from) {
        out.push(piece(k))
        from = k
      }
      while (i < mail.length && mail[i].at < marks[k]) out.push(mail[i++])
    }
    out.push(from ? piece(h.parts.length) : h)
  }
  return [...out, ...mail.slice(i)]
}

// The conversation as turns (S-1483), over the drawn messages (`layout`): each input opens a
// turn that runs until the next input. An input is what the agent was given: the human's own
// message, a mail into the agent, or a stam notice. Everything else is the turn's items:
// agent text, reasoning, tool calls, permissions, mail the agent sent, and other system rows
// (a compaction, an interrupted turn). What comes before the first input is a turn with no
// input. A turn's id is its first message's. The stam notice that only says mail came joins
// the mail's turn before the agent answers, as its compact line: the mail is the input.
export interface Turn { id: string; input: ViewMessage | null; items: ViewMessage[] }
export const isInput = (m: ViewMessage): boolean =>
  m.kind === 'mail' ? !m.parts.some((p) => p.type === 'mail' && p.to) : m.role === 'user' || (m.role === 'system' && m.kind === 'notice')
const onlyMailNotice = (m: ViewMessage): boolean => m.kind === 'notice' && mailNoticeSplit(plainText(m))?.length === 1
// `prev`: the turns last built. A turn whose input and every item are the same objects keeps
// its previous object, so assistant-ui (which caches converted messages by identity) only
// reconverts and redraws the turn that changed (S-1566). A message that `layout` splits at a
// mail is rebuilt into new pieces on every call, so the turns holding those pieces aren't
// reused: caching them would need a piece cache keyed by source message, and splits are rare.
export function turns(messages: ViewMessage[], prev: Turn[] = []): Turn[] {
  const out: Turn[] = []
  for (const m of layout(messages)) {
    const cur = out[out.length - 1]
    const joins = onlyMailNotice(m) && cur?.input?.kind === 'mail' && cur.items.every((x) => x.kind === 'notice')
    if (isInput(m) && !joins) out.push({ id: m.id, input: m, items: [] })
    else if (out.length) out[out.length - 1].items.push(m)
    else out.push({ id: m.id, input: null, items: [m] })
  }
  const old = new Map(prev.map((t) => [t.id, t]))
  return out.map((t) => {
    const o = old.get(t.id)
    return o && o.input === t.input && o.items.length === t.items.length && o.items.every((x, i) => x === t.items[i]) ? o : t
  })
}

// What opened a turn, for how its input card reads: the human's own message, a mail from
// the human, a mail from another agent, a stam notice, or nothing (the conversation's start).
export type TurnKind = 'human' | 'human-mail' | 'mail' | 'notice' | 'start'
export function turnKind(t: Turn): TurnKind {
  const m = t.input
  if (!m) return 'start'
  if (m.kind === 'mail') return m.parts.some((p) => p.type === 'mail' && p.from_id === 'human') ? 'human-mail' : 'mail'
  return m.role === 'user' ? 'human' : 'notice'
}

export function applyEvent(s: ViewState | null, ev: ViewEvent): ViewState | null {
  if (ev.type === 'state') {
    // A fresh state after a reconnect keeps the older pages already read, when they join up.
    if (!s || s.agent !== ev.state.agent) return ev.state
    const first = ev.state.messages[0]
    const at = first ? s.messages.findIndex((m) => m.id === first.id) : -1
    return at > 0 ? { ...ev.state, messages: [...s.messages.slice(0, at), ...ev.state.messages], older: s.older } : ev.state
  }
  if (!s) return s
  if (ev.type === 'message') return { ...s, messages: interleave(upsert(s.messages, ev.message)) }
  return { ...s, running: ev.running, permissions: ev.permissions }
}

// An older page from /view/history, read with `before`, goes before what the view has,
// minus any it already has. A page read for an earlier window (a reconnect replaced it
// while the read was out) no longer joins up, so it's dropped: the same state comes back.
export function prependOlder(s: ViewState, page: ViewPage, before: string): ViewState {
  if (s.older !== before) return s
  const have = new Set(s.messages.map((m) => m.id))
  return { ...s, messages: interleave([...page.messages.filter((m) => !have.has(m.id)), ...s.messages]), older: page.older }
}

// Waiting permissions that no message in the view holds, so they get a card of their own.
export function loosePermissions(s: ViewState): ViewPermission[] {
  const held = new Set(s.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === 'permission' ? [p.id] : []))))
  return s.permissions.filter((p) => !held.has(p.id))
}

// A tool call's one-line summary: the input field that says what it does.
export function toolLine(input: unknown): string {
  if (input === undefined || input === null) return ''
  if (typeof input !== 'object') return String(input)
  const o = input as Record<string, unknown>
  const first = o.command ?? o.cmd ?? o.path ?? o.file_path ?? o.filePath ?? o.pattern ?? o.url ?? o.query ?? o.description ?? Object.values(o)[0]
  return typeof first === 'string' ? first : JSON.stringify(input)
}

// A message's parts in reading order: a permission request right after the tool call that
// asked, since the daemon adds it at the end of the message.
export function readingOrder(parts: ViewPart[]): ViewPart[] {
  const asks = parts.filter((p): p is Extract<ViewPart, { type: 'permission' }> => p.type === 'permission' && !!p.tool && parts.some((t) => t.type === 'tool' && t.id === p.tool))
  if (!asks.length) return parts
  return parts.flatMap((p): ViewPart[] => (asks.includes(p as never) ? [] : p.type === 'tool' ? [p, ...asks.filter((a) => a.tool === p.id)] : [p]))
}

// The message's text, for assistant-ui's own copy of it (the view draws from the original).
// A stam mail notice (templates/mail-notice.md, mail-prompt.md). The mail's card already shows
// the mail, so its row shows one line and the full text opens on demand (S-296). The agent
// still gets the full text; this only changes the view.
const MAIL_NOTICE = /^\s*\[stam\] You have \d+ unread mail\b/
export const MAIL_NOTICE_LINE = '[stam] You have mail'
export const isMailNotice = (text: string): boolean => MAIL_NOTICE.test(text)
// A notice text can hold other notices before the mail notice, joined by blank lines: src/mail.ts
// puts the mail notice last, after the pending notices. Split only there, so the rest stays one
// text (a code block in it keeps its blank lines). Null when the text holds no mail notice, so
// other notices render as before.
const MAIL_NOTICE_AT = /(?<=^|\n\n)\[stam\] You have \d+ unread mail\b/g
export function mailNoticeSplit(text: string): { text: string; mail: boolean }[] | null {
  const starts = [...text.matchAll(MAIL_NOTICE_AT)]
  if (!starts.length) return null
  const at = starts.at(-1)!.index
  const before = text.slice(0, at).replace(/\n\n$/, '')
  const mail = { text: text.slice(at), mail: true }
  return before ? [{ text: before, mail: false }, mail] : [mail]
}
export const plainText = (m: ViewMessage): string => m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n\n')

// A message's parts as the view draws them: each run of consecutive tool calls is one drawer,
// and anything else (text, thinking, a permission card) is a part of its own. A permission
// breaks a run, so a card that waits is never folded into a drawer.
export type ToolPart = Extract<ViewPart, { type: 'tool' }>
export type ViewItem = { type: 'part'; part: ViewPart } | { type: 'tools'; tools: ToolPart[] }
export function toolRuns(parts: ViewPart[]): ViewItem[] {
  const items: ViewItem[] = []
  for (const p of parts) {
    if (p.type !== 'tool') { items.push({ type: 'part', part: p }); continue }
    const last = items[items.length - 1]
    if (last?.type === 'tools') last.tools.push(p)
    else items.push({ type: 'tools', tools: [p] })
  }
  return items
}

// What the agent is doing while its turn runs, for the working indicator: waiting on a
// permission, running a tool (its name and one-line input), thinking, writing, or, before
// anything of the turn shows, just working. `since` is when the turn's reply started. Null
// when the turn has ended and nothing waits.
export type ActivityKind = 'asking' | 'tool' | 'thinking' | 'writing' | 'working'
export interface Activity { kind: ActivityKind; label: string; detail?: string; since: number | null }
export function activity(s: ViewState): Activity | null {
  if (s.permissions.length) return { kind: 'asking', label: 'Waiting for your answer', since: null }
  if (!s.running) return null
  // The turn's reply: the newest assistant message after the newest prompt. A mail that
  // arrives mid-turn (kind 'mail') doesn't start a new one.
  const i = s.messages.findLastIndex((m) => m.role !== 'system' && m.kind !== 'mail')
  const m = i >= 0 && s.messages[i].role === 'assistant' ? s.messages[i] : null
  if (!m) return { kind: 'working', label: 'Working', since: null }
  const last = m.parts.findLast((p) => p.type !== 'permission')
  if (last?.type === 'tool' && (last.status === 'running' || last.status === 'pending')) return { kind: 'tool', label: `Running ${last.name}`, detail: toolLine(last.input) || undefined, since: m.at }
  if (last?.type === 'reasoning') return { kind: 'thinking', label: 'Thinking', since: m.at }
  if (last?.type === 'text' && last.text) return { kind: 'writing', label: 'Writing', since: m.at }
  return { kind: 'working', label: 'Working', since: m.at }
}

// A turn's running time, as the indicator shows it: 8s, 1m 05s, 1h 02m.
export function elapsed(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000))
  if (t < 60) return `${t}s`
  if (t < 3600) return `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, '0')}s`
  return `${Math.floor(t / 3600)}h ${String(Math.floor(t / 60) % 60).padStart(2, '0')}m`
}
