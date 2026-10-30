// The daemon's data the UI shows. The live stream (S-457) applies agent, ITSA, mail, and
// usage events as they arrive; the fallback polls run live agents every 2 s (archived ones every minute), pending permission
// requests every 2 s, ITSAs every 4 s (15 s while connected), the human's threads and rings
// every 8 s, each machine's load every 5 s while a reader shows it (otherwise about once a minute). Components read it with useData().
import { useEffect, useId, useSyncExternalStore } from 'react'
import { api, ApiError, setKnownOrigins } from './api'
import { useViewShown } from './shell/layout'
import { rearmMailTitles } from './mail/mail-titles'
import { rearmToolSummaries } from './mail/tool-summaries'
import { rearmToolNames } from './mail/tool-names'
import { live } from './format'
import { fetchIndex } from './mail/thread-index'
import { liveConnected, onLiveConnection, onLiveEvent } from './live'
import type { Agent, Ask, CostMode, DecisionMail, IndexRow, Itsa, ItsaAttention, ItsaQueueRow, ItsaStatus, Machine, Permission, PlainShell, Ring, Thread, ThreadList, Thresholds } from './types'

export interface Data {
  agents: Agent[]
  perms: Permission[]
  // Harness dialogs still with the agent's parent or the chief of staff (S-594): shown to the human
  // as who they are with, read-only and not waiting on them, until escalated into `perms`.
  delegateDialogs: Permission[]
  rings: Ring[]
  // The human's thread lists as index rows (S-4617), the first 60 of each: the inbox (`active`), the threads archive
  // hides (they return to the inbox when a new mail arrives), and the ones set aside for later (S-976).
  humanRows: Record<ThreadList, IndexRow[]>
  // The threads a thread view has loaded, most recent last (S-2286): a thread past the 60 above still
  // counts as waiting on the human when its own mails say so.
  openThreads: Thread[]
  // Per agent, its threads with the human from every box, newest first (S-1121): rapid-fire's pages, past the 60 above.
  rapidWith: Record<string, { threads: Thread[]; more: boolean }>
  unread: number
  machine: string
  thresholds: Thresholds
  // Settings' default view of an agent (S-82): its terminal or its conversation.
  agentView: 'terminal' | 'conversation'
  // The assistant the Assistant tab opens on for a device that hasn't picked one (S-164): 'assistant' or a chief of staff's assistant's name.
  assistantDefault: string
  // Minutes a failed prompt-input message waits before the human is mailed about it; 0 is off (S-375).
  // The mode a prompt input starts in: Mail or Direct (settings.promptDefaultMode).
  promptDefaultMode: 'mail' | 'direct'
  // Where Mail opens on the desktop: the Inbox page, or the sidebar's Mail tab (settings.mailOpens, S-2310).
  mailOpens: 'inbox' | 'sidebar'
  // The Settings cost unit (cost.display.mode), which every cost figure shows (S-333).
  costMode: CostMode
  shells: PlainShell[]
  error: string | null
  // Bumps when mail may have changed, so open mail views reload.
  mailTick: number
  booted: boolean
  // Whether each list has had its first load, so an empty list shows its loading mark until
  // then and its empty state after (the tree's agents, the mail, the ITSAs).
  loaded: { agents: boolean; mail: boolean; itsas: boolean }
  // Every ITSA (a flat list; the sidebar builds the tree), the status set, and why the
  // list failed (the ITSA home unreachable), if it did.
  itsas: Itsa[]
  itsaStatuses: ItsaStatus[]
  // The ITSAs in a human status, oldest first, with their actions.
  attention: ItsaAttention[]
  // The agents' mail to the human that holds a decision and waits for their reply, oldest first.
  decisions: DecisionMail[]
  // The Needs you list (GET /api/asks): open asks, then those settled in the last day.
  asks: Ask[]
  // The merge queue (GET /api/itsas/queue): ready_to_merge ITSAs with a branch link.
  queue: ItsaQueueRow[]
  itsaError: string | null
  // Every computer's load, this one and each peer's (offline ones included).
  machines: Machine[]
}

// The polled data, as the daemon last sent it. `data` is what the UI shows: the polled data
// with each optimistic change (optimistic.ts) applied on top, so a poll never undoes one still
// in flight.
let polled: Data = {
  agents: [], perms: [], delegateDialogs: [], rings: [], humanRows: { active: [], archived: [], deferred: [] }, openThreads: [], rapidWith: {}, unread: 0, machine: '',
  thresholds: { warnTokens: 300000, instructTokens: 400000, enforceTokens: 500000 }, agentView: 'conversation', assistantDefault: 'assistant', promptDefaultMode: 'mail', mailOpens: 'inbox', costMode: 'api',
  shells: [], error: null, mailTick: 0, booted: false, loaded: { agents: false, mail: false, itsas: false }, itsas: [], itsaStatuses: [], attention: [], decisions: [], asks: [], queue: [], itsaError: null, machines: [],
}
let data = polled
const overlays = new Map<number, (d: Data) => Data>()
const listeners = new Set<() => void>()
const fold = () => { data = [...overlays.values()].reduce((d, f) => f(d), polled) }
const notify = () => { for (const fn of listeners) fn() }

export const getData = () => data
// The daemon's data without the overlays: what a change waits for a poll to show.
export const getPolled = () => polled
export function setData(patch: Partial<Data>) {
  polled = { ...polled, ...patch }
  fold()
  notify()
}
// Adds (fn) or removes (null) the overlay with this id; it applies on every poll until removed.
export function setOverlay(id: number, fn: ((d: Data) => Data) | null) {
  if (fn) overlays.set(id, fn)
  else overlays.delete(id)
  fold()
  notify()
}
export function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
export const useData = () => useSyncExternalStore(subscribe, getData)

export const byId = (id: string | null | undefined) => (id ? data.agents.find((a) => a.id === id) : undefined)
export const childrenOf = (id: string) => data.agents.filter((x) => live(x) && (x.parents ?? []).includes(id)).sort((x, y) => x.created_at.localeCompare(y.created_at))
// The executive assistant: the newest assistant agent that isn't archived.
export const assistant = () => data.agents.filter((a) => a.kind === 'assistant' && a.lifecycle !== 'archived').at(-1)
// The chiefs of staff, oldest first: one per machine today (each daemon's settings name
// theirs, and the agent list marks it), one per project perhaps later.
export const chiefsOfStaff = () => data.agents.filter((a) => a.chief_of_staff && live(a)).sort((x, y) => x.created_at.localeCompare(y.created_at))
// Each chief of staff's assistant: a live child of a chief of staff whose registry role names an
// assistant (intake's role is "cos's intake assistant: ..."), so no flag or name is needed.
export const chiefAssistants = () => {
  const chiefs = new Set(chiefsOfStaff().map((c) => c.id))
  return data.agents.filter((a) => live(a) && /\bassistant\b/i.test(a.role ?? '') && (a.parents ?? []).some((p) => chiefs.has(p))).sort((x, y) => x.created_at.localeCompare(y.created_at))
}
export const isUnreadForHuman = (t: Thread) => t.mails.some((m) => m.recipients.some((r) => r.id === 'human' && !r.read_at))
// A thread waiting on a permission answer: it can't be archived until the human answers.
export const hasPendingPermission = (t: Thread) => t.mails.some((m) => m.permission?.status === 'pending')
// A thread that can't be archived until the human answers: it holds a pending permission
// request, it is the ask thread of an ITSA waiting on them (S-311), or an agent waits for their reply in it.
export function threadWaitsOnHuman(tid: string, d: Data = data): boolean {
  // The lists' index row (S-4579), else the copy a view has loaded.
  const r = humanRow(tid, d)
  if (r ? r.ask === 'pending' : d.openThreads.some((x) => x.thread_id === tid && hasPendingPermission(x))) return true
  if (d.decisions.some((x) => x.thread_id === tid)) return true
  // An agent's wait for the human's reply in this thread (S-1881) is an open ask too.
  if (d.agents.some((a) => (a.waits ?? []).some((w) => w.kind === 'human' && w.thread === tid))) return true
  return d.attention.some((x) => x.ask_thread_id === tid && d.itsaStatuses.find((s) => s.name === x.status)?.category !== 'closed')
}

// The human's thread lists as index rows (S-4577), what the mail lists show of each thread: the polled rows with
// each optimistic change on top (S-4617).
export const humanIndex = (d: Pick<Data, 'humanRows'>, list: ThreadList): IndexRow[] => d.humanRows[list]
// How many rows of each list the poll reads.
export const LIST_ROWS = 60
// The human's unread mail the inbox counts: its rows', not the archive's or the deferred ones'.
export const unreadIn = (rows: IndexRow[]) => rows.reduce((n, r) => n + r.unread, 0)
// A thread's row in the human's lists (inbox, archive, deferred), if one holds it.
export const humanRow = (tid: string, d: Data = data): IndexRow | undefined =>
  (['active', 'archived', 'deferred'] as const).map((l) => humanIndex(d, l).find((r) => r.thread_id === tid)).find(Boolean)
export const isArchivedThread = (tid: string) => humanIndex(data, 'archived').some((t) => t.thread_id === tid)
export const isDeferredThread = (tid: string) => humanIndex(data, 'deferred').some((t) => t.thread_id === tid)
// The row in the inbox or the deferred list whose mail carries a permission.
const permRow = (pid: string) => [...humanIndex(data, 'active'), ...humanIndex(data, 'deferred')].find((r) => r.perms?.some((p) => p.id === pid))
export const permThread = (pid: string) => permRow(pid)?.thread_id
// The thread a request started, so the request's row stands for it; none for an ask placed in another thread (S-3827),
// whose thread holds other work the human is asked about.
export const ownPermThread = (pid: string) => {
  const r = permRow(pid)
  return r && !r.perms!.some((p) => p.id === pid && p.placed) ? r.thread_id : undefined
}

const fresh = new Set<() => void>()
// Runs after each fast refresh that changed something (the tree view follows the tree).
export function onAgentsChanged(fn: () => void) { fresh.add(fn) }

// A mail event off the live stream, for the system view's flights and stacks (S-457).
export type MailEvent =
  | { type: 'sent'; id: string; from: string; to: string[]; thread: string | null; itsa: string | null; ask: boolean; subject: string; at: string | null }
  | { type: 'read'; id: string; by: string; at: string | null }

const mailSubs = new Set<(e: MailEvent) => void>()
const usageSubs = new Set<() => void>()
const agentSubs = new Set<(e: AgentEvent) => void>()
// A real spawn or archive as it arrives on the stream (S-700). A poll or a bulk load never calls
// this, so the sidebar animates only an agent that really appeared or went.
export type AgentEvent = { type: 'spawned' | 'archived'; id: string; parent: string | null }
export function emitAgentEvent(e: AgentEvent) { for (const cb of agentSubs) cb(e) }
export function onAgentEvent(cb: (e: AgentEvent) => void) { agentSubs.add(cb); return () => { agentSubs.delete(cb) } }
// Each mail event as it arrives on the stream. Returns the unsubscribe.
export function onMailEvent(cb: (e: MailEvent) => void) { mailSubs.add(cb); return () => { mailSubs.delete(cb) } }
// Usage changed: the event carries nothing else, so the view refetches /api/usage.
export function onUsageChanged(cb: () => void) { usageSubs.add(cb); return () => { usageSubs.delete(cb) } }

// A poll can start before an event lands and return after it, and its older snapshot would
// undo the event's fields (S-457). Each applied event gets a sequence, and a poll re-applies
// the changes that landed after it started; see refreshAgents and refreshItsas.
let agentSeq = 0
const agentPatches = new Map<string, { seq: number; patch: Partial<Agent> }>()
let itsaSeq = 0
const itsaPatches = new Map<string, { seq: number; patch: Partial<Itsa> }>()

// Whether applying `patch` would change anything, field by field (a value may be an object).
function wouldChange<T extends object>(cur: T, patch: Partial<T>): boolean {
  for (const k of Object.keys(patch) as (keyof T)[]) {
    if (cur[k] === patch[k]) continue
    if (JSON.stringify(cur[k]) !== JSON.stringify(patch[k])) return true
  }
  return false
}

// Applies one event from the daemon's live stream (S-456) to what the UI shows. A value is
// only set when it differs, as the polls do; an agent or ITSA the store doesn't know waits
// for its refresh, which a spawn or the poll brings.
export function applyLiveEvent(type: string, d: Record<string, unknown>): void {
  switch (type) {
    case 'mail.sent':
      viewsStale = true
      for (const cb of mailSubs) cb({ type: 'sent', id: d.id as string, from: d.from as string, to: (d.to as string[]) ?? [], thread: (d.thread as string | null) ?? null, itsa: (d.itsa as string | null) ?? null, ask: !!d.ask, subject: (d.subject as string) ?? '', at: (d.at as string | null) ?? null })
      return
    case 'mail.read':
      viewsStale = true
      for (const cb of mailSubs) cb({ type: 'read', id: d.id as string, by: d.by as string, at: (d.at as string | null) ?? null })
      return
    case 'agent.changed': {
      const i = polled.agents.findIndex((a) => a.id === d.id)
      if (i < 0) return
      const patch: Partial<Agent> = {}
      // The stream names the lifecycle `state`; map it, and the fields the event carries.
      if (typeof d.state === 'string') patch.lifecycle = d.state
      if ('activity' in d) patch.activity = d.activity as Agent['activity']
      if ('context_tokens' in d) patch.context_tokens = d.context_tokens as number | null
      if ('cost_usd' in d) patch.cost_usd = d.cost_usd as number | null
      if ('unread' in d) patch.unread = d.unread as number
      const cur = polled.agents[i]
      if (!wouldChange(cur, patch)) return
      agentPatches.set(cur.id, { seq: ++agentSeq, patch })
      const agents = polled.agents.slice()
      agents[i] = { ...cur, ...patch }
      setData({ agents })
      return
    }
    // A spawn or an archive can't be built from the event alone (the daemon's own shape):
    // refetch the list, as the poll would. A spawn usually comes with an ITSA for the new agent
    // to own, so the ITSAs are refetched too, and its card shows it from the start (S-462).
    case 'agent.spawned':
      viewsStale = true
      emitAgentEvent({ type: 'spawned', id: d.id as string, parent: (d.parent_id as string | null) ?? null })
      void refresh()
      void refreshItsas()
      return
    case 'agent.archived':
      viewsStale = true
      emitAgentEvent({ type: 'archived', id: d.id as string, parent: null })
      void refresh()
      return
    case 'itsa.changed': {
      viewsStale = true
      const i = polled.itsas.findIndex((s) => s.id === d.id)
      if (i < 0) { void refreshItsas(); return }
      const cur = polled.itsas[i]
      const patch: Partial<Itsa> = {}
      if (typeof d.status === 'string') patch.status = d.status
      if ('owner' in d) patch.owner = (d.owner as string | null) ?? null
      if ('fields' in d && d.fields != null) patch.fields = d.fields as Record<string, unknown>
      if (!wouldChange(cur, patch)) return
      itsaPatches.set(cur.id, { seq: ++itsaSeq, patch })
      const itsas = polled.itsas.slice()
      itsas[i] = { ...cur, ...patch }
      setData({ itsas })
      return
    }
    case 'usage.changed':
      for (const cb of usageSubs) cb()
      return
  }
}

onLiveEvent((e) => applyLiveEvent(e.type, (e.data ?? {}) as Record<string, unknown>))

// The fallback polls. Agents stay at 2 s: the stream's agent.changed event carries only the
// lifecycle, activity, tokens, cost and unread fields, so a change to any other field
// (chief_of_staff, parents, name, model) reaches the UI only through the poll. The ITSA poll
// alone slows, 4 s to 15 s while the stream is connected (S-457), since itsa.changed carries
// status, owner and fields; it restores on a break. Permissions keep their 2 s: the stream
// carries no permission events, so an approval prompt must not wait.
let agentPoll: (() => void) | undefined
let permPoll: (() => void) | undefined
let itsaPoll: (() => void) | undefined
export function startPolls(lives: boolean): void {
  agentPoll?.()
  permPoll?.()
  itsaPoll?.()
  agentPoll = poll(refreshAgents, 2000)
  permPoll = poll(refreshPerms, 2000)
  itsaPoll = poll(refreshItsas, lives ? 15_000 : 4000)
}

// Every poll runs `fn` each `ms` (S-4517), skipping a tick while its last round is still in flight, so a
// slow daemon gets one round at a time rather than a growing pile, and none while the tab is hidden. Showing
// the tab again runs one round of each at once. Returns the stop.
const inFlight = new Set<() => Promise<unknown>>()
const ticks = new Set<() => void>()
export function poll(fn: () => Promise<unknown>, ms: number): () => void {
  const tick = () => {
    if (inFlight.has(fn) || document.hidden) return
    inFlight.add(fn)
    void fn().catch(() => {}).finally(() => inFlight.delete(fn))
  }
  const timer = setInterval(tick, ms)
  ticks.add(tick)
  return () => { clearInterval(timer); ticks.delete(tick) }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) for (const t of ticks) t() })

// Promise.all that settles only once every read has: a round whose first read failed fast must not free its
// poll while a sibling read is still in flight (S-4517).
async function allOf<T extends readonly unknown[]>(ps: T): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  await Promise.allSettled(ps)
  return Promise.all(ps)
}

// Marks a list as loaded once its first fetch has succeeded.
const loadedOnce = (k: keyof Data['loaded']): Partial<Data> => (polled.loaded[k] ? {} : { loaded: { ...polled.loaded, [k]: true } })

// The agents and the human's pending permission requests, together: the boot fetch and a
// spawn or archive need both. The polls split them (S-457): only ITSAs slow, agents don't.
export async function refresh() {
  await Promise.all([refreshAgents(), refreshPerms()])
}

// Keeps each agent's object from `prev` when its data is unchanged (S-3292), so a memoised row
// redraws only for an agent that changed. Returns `prev` itself when nothing did.
function keepUnchanged(prev: Agent[], next: Agent[]): Agent[] {
  const before = new Map(prev.map((a) => [a.id, a]))
  let changed = next.length !== prev.length
  const out = next.map((a, i) => {
    const p = before.get(a.id)
    if (p && (p === a || JSON.stringify(p) === JSON.stringify(a))) {
      if (prev[i] !== p) changed = true
      return p
    }
    changed = true
    return a
  })
  return changed ? out : prev
}

// The archived agents (S-3816): ~99% of the registry and none of them change, so the 2 s poll asks only for live and
// stopped ones, and the archived come apart, at most every ARCHIVED_EVERY ms or as soon as a known agent leaves the
// poll (it was archived). They sit behind the live ones in `agents`, so a view still finds an archived sender or owner
// by id, and the first load waits for both, so no name shows as its id meanwhile.
export const ARCHIVED_EVERY = 60_000
let archived: Agent[] = []
let archivedAt: number | null = null
// The ids the last poll listed, to see one leave (once: a peer that went down doesn't refetch on every poll).
let lastListed = new Set<string>()

// The agent list. The live stream carries agent changes, but a poll still covers a missed
// one, and the spawn/archive events come through here.
export async function refreshAgents() {
  const startedAt = agentSeq
  try {
    const listed = await api<Agent[]>('GET', '/api/agents?state=live,stopped')
    const here = new Set(listed.map((a) => a.id))
    const left = [...lastListed].some((id) => !here.has(id))
    lastListed = here
    let read = false
    if (archivedAt === null || left || Date.now() - archivedAt >= ARCHIVED_EVERY) {
      // A failed read keeps the last archived set and tries again after 10 s (an agent that left waits for it).
      try {
        archived = await api<Agent[]>('GET', '/api/agents?state=archived')
        archivedAt = Date.now()
        read = true
      } catch {
        // Retry in 10 s, not on every 2 s poll; the live agents above are already in `listed`.
        archivedAt = Date.now() - (ARCHIVED_EVERY - 10_000)
      }
    }
    // Between reads, an archived row is the one shown now, so what the stream changed on it since the read stays.
    if (!read) {
      const shown = new Map(polled.agents.map((x) => [x.id, x]))
      archived = archived.map((x) => { const s = shown.get(x.id); return s?.lifecycle === 'archived' ? s : x })
    }
    // Re-apply an agent change that landed while this fetch was in flight. A live row wins over an archived one.
    const agents = keepUnchanged(polled.agents, [...listed, ...archived.filter((a) => !here.has(a.id))].map((a) => {
      const e = agentPatches.get(a.id)
      return e && e.seq > startedAt ? { ...a, ...e.patch } : a
    }))
    // The kept objects, so the next poll compares an unchanged archived agent by identity, not JSON.
    const kept = new Map(agents.slice(listed.length).map((x) => [x.id, x]))
    archived = archived.map((x) => kept.get(x.id) ?? x)
    const first = loadedOnce('agents')
    if (agents !== polled.agents || polled.error || Object.keys(first).length) {
      setData({ agents, error: null, ...first })
      for (const fn of fresh) fn()
    }
  } catch (e) {
    setData({ error: (e as Error).message })
  }
}

// The human's pending permission requests, and the harness dialogs still with a parent or the
// chief of staff. The stream carries no permission events, so this never slows: a new approval
// prompt must reach them as fast as it always did.
export async function refreshPerms() {
  try {
    const pending = await api<Permission[]>('GET', '/api/permissions?status=pending')
    const perms = pending.filter((p) => (p.audience ?? 'human') === 'human')
    const delegateDialogs = pending.filter((p) => p.audience === 'delegate' && !!p.dialog)
    if (JSON.stringify(perms) !== JSON.stringify(polled.perms)) { viewsStale = true; setData({ perms }) }
    if (JSON.stringify(delegateDialogs) !== JSON.stringify(polled.delegateDialogs)) { viewsStale = true; setData({ delegateDialogs }) }
  } catch {}
}

// The agents whose rapid-fire view is open (S-1121), and how many threads each box fetches for them.
export const RAPID_PAGE = 60
const rapidLimit = new Map<string, number>()
// Panes showing each agent's rapid-fire view: the last to close drops the page count.
const rapidPanes = new Map<string, number>()
// Panes showing it on screen (S-4691): the fetch runs only while one does; a hidden pane keeps the limit.
const rapidShown = new Map<string, number>()
export const watchRapid = (id: string, shown = true) => {
  if (!rapidLimit.has(id)) rapidLimit.set(id, RAPID_PAGE)
  rapidPanes.set(id, (rapidPanes.get(id) ?? 0) + 1)
  if (shown) rapidShown.set(id, (rapidShown.get(id) ?? 0) + 1)
  void refreshSlowNow()
  return () => {
    if (shown) {
      const k = (rapidShown.get(id) ?? 1) - 1
      if (k > 0) rapidShown.set(id, k); else rapidShown.delete(id)
    }
    const n = (rapidPanes.get(id) ?? 1) - 1
    if (n > 0) { rapidPanes.set(id, n); return }
    rapidPanes.delete(id); rapidLimit.delete(id)
  }
}
// A mounted pane that shows or hides: the page count stays, the fetch follows.
export const showRapid = (id: string) => {
  rapidShown.set(id, (rapidShown.get(id) ?? 0) + 1)
  void refreshSlowNow()
  return () => {
    const k = (rapidShown.get(id) ?? 1) - 1
    if (k > 0) rapidShown.set(id, k); else rapidShown.delete(id)
  }
}
export const rapidOlder = (id: string) => { rapidLimit.set(id, (rapidLimit.get(id) ?? RAPID_PAGE) + RAPID_PAGE); return refreshSlowNow() }

async function fetchRapid(): Promise<Data['rapidWith']> {
  // A hidden pane keeps the threads it has, so showing it again draws them before the fetch lands.
  const out: Data['rapidWith'] = {}
  for (const id of rapidLimit.keys()) if (!rapidShown.has(id) && polled.rapidWith[id]) out[id] = polled.rapidWith[id]
  await allOf([...rapidLimit].filter(([id]) => rapidShown.has(id)).map(async ([id, limit]) => {
    const q = `limit=${limit}&with=${encodeURIComponent(id)}`
    const pages = await allOf(['', '&archived=1', '&deferred=1'].map((x) => api<Thread[]>('GET', `/api/agents/human/threads?${q}${x}`)))
    out[id] = { threads: pages.flat(), more: pages.some((p) => p.length >= limit) }
  }))
  return out
}

// A refresh that started earlier never lands over a later one that has: a poll begun before
// Load older would otherwise shrink the list again.
let slowSeq = 0
let slowApplied = 0
// The rounds begun so far, and the latest that landed: a round begun after a write landed shows it (S-4617).
export const slowBegun = () => slowSeq
export const slowLanded = () => slowApplied

// Calls within SLOW_COALESCE ms of the first share one round at its end (S-4519): answering a mail archives,
// reloads and marks read at once, and each asked for its own round of seven GETs. The promise settles when
// that round lands. The boot, the poll and Load older use refreshSlowNow.
export const SLOW_COALESCE = 300
let slowWaiting: Promise<void> | null = null
export function refreshSlow(): Promise<void> {
  slowWaiting ??= new Promise<void>((done) => setTimeout(() => { slowWaiting = null; void refreshSlowNow().then(done) }, SLOW_COALESCE))
  return slowWaiting
}

// Whether a view that reloads on mailTick may be stale since the last tick: a mail was sent or read, a permission
// changed, an ITSA changed (retro items are ITSAs), an agent was spawned or archived (its final retro round), or
// the stream connected or broke (it replays nothing it missed). mailTick moves only then, when the human's lists
// changed, or on every round while the stream is down (no events to tell).
let viewsStale = false
onLiveConnection(() => { viewsStale = true })

export async function refreshSlowNow() {
  const seq = ++slowSeq
  try {
    // The lists' first pages carry no cursor, so fetchIndex never asks for a restart (IndexRestart); a daemon without
    // the index route answers from the old one.
    const [active, archived, deferred, rs, decisions, rapidWith, asks] = await allOf([
      fetchIndex('human', 'active', { limit: LIST_ROWS }),
      fetchIndex('human', 'archived', { limit: LIST_ROWS }),
      fetchIndex('human', 'deferred', { limit: LIST_ROWS }),
      api<Ring[]>('GET', '/api/rings'),
      api<DecisionMail[]>('GET', '/api/mail/decisions'),
      fetchRapid(),
      // A daemon that predates the Needs you list has no route (404): keep the list empty rather than failing the
      // refresh. Any other failure, a read timeout included, keeps the list shown (S-4517).
      api<Ask[]>('GET', '/api/asks').catch((e): Ask[] => (e instanceof ApiError && e.status === 404 ? [] : polled.asks)),
    ])
    if (seq < slowApplied) return
    slowApplied = seq
    const humanRows = { active: active.threads, archived: archived.threads, deferred: deferred.threads }
    // A ring shows while it runs and at least one member is running.
    const rings = rs.filter((r) => r.status !== 'done' && (JSON.parse(r.members || '[]') as string[]).some((id) => { const a = byId(id); return a && live(a) }))
    const changed = JSON.stringify(humanRows) !== JSON.stringify(polled.humanRows) || JSON.stringify(rings) !== JSON.stringify(polled.rings) || JSON.stringify(rapidWith) !== JSON.stringify(polled.rapidWith)
    const decided = JSON.stringify(decisions) !== JSON.stringify(polled.decisions)
    const asked = JSON.stringify(asks) !== JSON.stringify(polled.asks)
    const tick = changed || decided || asked || viewsStale || !liveConnected()
    viewsStale = false
    const patch: Partial<Data> = { ...(changed ? { humanRows, rapidWith, unread: unreadIn(humanRows.active), rings } : {}), ...(decided ? { decisions } : {}), ...(asked ? { asks } : {}), ...loadedOnce('mail'), ...(tick ? { mailTick: polled.mailTick + 1 } : {}) }
    if (Object.keys(patch).length) setData(patch)
    // A round that found nothing new still tells the changes waiting on it (optimistic.ts): it is the poll a mark
    // waits for once its write landed (S-4617).
    else if (overlays.size) notify()
  } catch {}
}

// One ITSA fetch at a time (S-462): calls while one runs share one more after it, so a burst of
// spawns fetches twice, not once each, and an older snapshot never lands after a newer one.
let itsaRun: Promise<void> | null = null
let itsaNext: Promise<void> | null = null
export function refreshItsas(): Promise<void> {
  if (!itsaRun) {
    itsaRun = fetchItsas().finally(() => { itsaRun = null })
    return itsaRun
  }
  itsaNext ??= itsaRun.then(() => { itsaNext = null; return refreshItsas() })
  return itsaNext
}
// The merge-queue readers on screen, by hook instance id (S-4672). The queue is read only while one is shown;
// with none shown, a poll keeps the rows it has. A reader with no view element counts as shown (layout.ts).
const queueViews = new Set<string>()
// A reader that starts showing reads the queue at once, when no reader was showing before.
export function setQueueReader(id: string, shown: boolean): Promise<void> | undefined {
  const reading = queueViews.size > 0
  if (shown) queueViews.add(id); else queueViews.delete(id)
  return shown && !reading ? refreshItsas() : undefined
}
// Each hook instance registers under its own id, so two readers on one view key don't share a registration.
export function useQueueReader(key: string | undefined) {
  const id = useId()
  const shown = useViewShown(key)
  useEffect(() => {
    void setQueueReader(id, shown)
    return () => { setQueueReader(id, false) }
  }, [id, shown])
}

async function fetchItsas() {
  const startedAt = itsaSeq
  try {
    const [listed, st, attention, queue] = await allOf([
      api<Itsa[]>('GET', '/api/itsas'),
      polled.itsaStatuses.length ? null : api<{ statuses: ItsaStatus[] }>('GET', '/api/itsas/statuses'),
      api<ItsaAttention[]>('GET', '/api/itsas/attention'),
      // A daemon that predates the queue has no route: keep the rows we last had rather than
      // failing the whole ITSA refresh.
      queueViews.size
        ? api<ItsaQueueRow[]>('GET', '/api/itsas/queue').catch((): ItsaQueueRow[] => polled.queue)
        : Promise.resolve(polled.queue),
    ])
    // Re-apply an ITSA change that landed while this fetch was in flight.
    const itsas = listed.map((s) => {
      const e = itsaPatches.get(s.id)
      return e && e.seq > startedAt ? { ...s, ...e.patch } : s
    })
    const patch: Partial<Data> = {}
    if (st) patch.itsaStatuses = st.statuses
    if (JSON.stringify(itsas) !== JSON.stringify(polled.itsas)) { viewsStale = true; patch.itsas = itsas }
    if (JSON.stringify(attention) !== JSON.stringify(polled.attention)) patch.attention = attention
    if (JSON.stringify(queue) !== JSON.stringify(polled.queue)) patch.queue = queue
    if (polled.itsaError) patch.itsaError = null
    Object.assign(patch, loadedOnce('itsas'))
    if (Object.keys(patch).length) setData(patch)
  } catch (e) {
    if (polled.itsaError !== (e as Error).message) setData({ itsaError: (e as Error).message })
  }
}

// cost.display.mode from the settings, or the API default when it is missing or unknown.
const costModeOf = (m: unknown): CostMode => (m === 'subscription' || m === 'five_hour' || m === 'seven_day' ? m : 'api')

export async function loadThresholds() {
  // Called after a settings save: a tool-summary step turned back on is asked again (S-1843).
  rearmToolSummaries()
  rearmToolNames()
  rearmMailTitles()
  try {
    const s = JSON.parse((await api<{ text: string }>('GET', '/api/config/settings')).text)
    setData({ thresholds: { ...polled.thresholds, ...s.context }, agentView: s.agentView?.default === 'terminal' ? 'terminal' : 'conversation', assistantDefault: typeof s.assistantDefault === 'string' ? s.assistantDefault : 'assistant', promptDefaultMode: s.promptDefaultMode === 'direct' ? 'direct' : 'mail', mailOpens: s.mailOpens === 'sidebar' ? 'sidebar' : 'inbox', costMode: costModeOf(s.cost?.display?.mode) })
  } catch {}
}

// Every computer's CPU, RAM, and swap. The machines poll reads every 5 s only while a reader shows them
// (holdMachines); otherwise once a minute, which keeps setKnownOrigins current.
const MACHINES_KEEP_MS = 60_000
let machineReaders = 0
let machinesReadAt = 0
export async function refreshMachines() {
  machinesReadAt = Date.now()
  try {
    const machines = await api<Machine[]>('GET', '/api/machines')
    setKnownOrigins(machines)
    if (JSON.stringify(machines) !== JSON.stringify(polled.machines)) setData({ machines })
  } catch {}
}
// The poll's round, every 5 s: a read while a reader shows, or when the slow keep is due.
export async function pollMachines() {
  if (!machineReaders && Date.now() - machinesReadAt < MACHINES_KEEP_MS) return
  await refreshMachines()
}
// A reader on screen holds the poll at 5 s until the returned release runs; it reads once when it holds.
export function holdMachines(): () => void {
  machineReaders++
  void refreshMachines()
  return () => { machineReaders-- }
}
export function useMachinesShown(shown: boolean) {
  useEffect(() => (shown ? holdMachines() : undefined), [shown])
}
