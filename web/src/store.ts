// The daemon's data the UI shows. The live stream (S-457) applies agent, ITSA, mail, and
// usage events as they arrive; the fallback polls run agents every 2 s, pending permission
// requests every 2 s, ITSAs every 4 s (15 s while connected), the human's threads and rings
// every 8 s, each machine's load every 5 s. Components read it with useData().
import { useSyncExternalStore } from 'react'
import { api, setKnownOrigins } from './api'
import { rearmMailTitles } from './mail/mail-titles'
import { rearmToolSummaries } from './mail/tool-summaries'
import { rearmToolNames } from './mail/tool-names'
import { live } from './format'
import { onLiveEvent } from './live'
import type { Agent, CostMode, DecisionMail, Itsa, ItsaAttention, ItsaQueueRow, ItsaStatus, Machine, Permission, PlainShell, Ring, Thread, Thresholds } from './types'

export interface Data {
  agents: Agent[]
  perms: Permission[]
  // Harness dialogs still with the agent's parent or the chief of staff (S-594): shown to the human
  // as who they are with, read-only and not waiting on them, until escalated into `perms`.
  delegateDialogs: Permission[]
  rings: Ring[]
  humanThreads: Thread[]
  // The human's threads archive hides; they return here when a new mail arrives.
  humanArchived: Thread[]
  // The human's threads set aside for later (S-976); a new mail in one brings it back to the inbox.
  humanDeferred: Thread[]
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
  agents: [], perms: [], delegateDialogs: [], rings: [], humanThreads: [], humanArchived: [], humanDeferred: [], openThreads: [], rapidWith: {}, unread: 0, machine: '',
  thresholds: { warnTokens: 300000, instructTokens: 400000, enforceTokens: 500000 }, agentView: 'conversation', assistantDefault: 'assistant', promptDefaultMode: 'mail', mailOpens: 'inbox', costMode: 'api',
  shells: [], error: null, mailTick: 0, booted: false, loaded: { agents: false, mail: false, itsas: false }, itsas: [], itsaStatuses: [], attention: [], decisions: [], queue: [], itsaError: null, machines: [],
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
  const t = [...d.humanThreads, ...d.humanArchived, ...d.humanDeferred, ...d.openThreads].find((x) => x.thread_id === tid)
  if (t && hasPendingPermission(t)) return true
  if (d.decisions.some((x) => x.thread_id === tid)) return true
  // An agent's wait for the human's reply in this thread (S-1881) is an open ask too.
  if (d.agents.some((a) => (a.waits ?? []).some((w) => w.kind === 'human' && w.thread === tid))) return true
  return d.attention.some((x) => x.ask_thread_id === tid && d.itsaStatuses.find((s) => s.name === x.status)?.category !== 'closed')
}
export const isArchivedThread = (tid: string) => data.humanArchived.some((t) => t.thread_id === tid)
export const isDeferredThread = (tid: string) => data.humanDeferred.some((t) => t.thread_id === tid)
export const permThread = (pid: string) => [...data.humanThreads, ...data.humanDeferred].find((t) => t.mails.some((m) => m.permission_id === pid))?.thread_id

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
      for (const cb of mailSubs) cb({ type: 'sent', id: d.id as string, from: d.from as string, to: (d.to as string[]) ?? [], thread: (d.thread as string | null) ?? null, itsa: (d.itsa as string | null) ?? null, ask: !!d.ask, subject: (d.subject as string) ?? '', at: (d.at as string | null) ?? null })
      return
    case 'mail.read':
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
      emitAgentEvent({ type: 'spawned', id: d.id as string, parent: (d.parent_id as string | null) ?? null })
      void refresh()
      void refreshItsas()
      return
    case 'agent.archived':
      emitAgentEvent({ type: 'archived', id: d.id as string, parent: null })
      void refresh()
      return
    case 'itsa.changed': {
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
let agentPoll: ReturnType<typeof setInterval> | undefined
let permPoll: ReturnType<typeof setInterval> | undefined
let itsaPoll: ReturnType<typeof setInterval> | undefined
export function startPolls(lives: boolean): void {
  if (agentPoll) clearInterval(agentPoll)
  if (permPoll) clearInterval(permPoll)
  if (itsaPoll) clearInterval(itsaPoll)
  agentPoll = setInterval(refreshAgents, 2000)
  permPoll = setInterval(refreshPerms, 2000)
  itsaPoll = setInterval(refreshItsas, lives ? 15_000 : 4000)
}

// Marks a list as loaded once its first fetch has succeeded.
const loadedOnce = (k: keyof Data['loaded']): Partial<Data> => (polled.loaded[k] ? {} : { loaded: { ...polled.loaded, [k]: true } })

// The agents and the human's pending permission requests, together: the boot fetch and a
// spawn or archive need both. The polls split them (S-457): only ITSAs slow, agents don't.
export async function refresh() {
  await Promise.all([refreshAgents(), refreshPerms()])
}

// The agent list. The live stream carries agent changes, but a poll still covers a missed
// one, and the spawn/archive events come through here.
export async function refreshAgents() {
  const startedAt = agentSeq
  try {
    const listed = await api<Agent[]>('GET', '/api/agents')
    // Re-apply an agent change that landed while this fetch was in flight.
    const agents = listed.map((a) => {
      const e = agentPatches.get(a.id)
      return e && e.seq > startedAt ? { ...a, ...e.patch } : a
    })
    const first = loadedOnce('agents')
    if (JSON.stringify(agents) !== JSON.stringify(polled.agents) || polled.error || Object.keys(first).length) {
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
    if (JSON.stringify(perms) !== JSON.stringify(polled.perms)) setData({ perms })
    if (JSON.stringify(delegateDialogs) !== JSON.stringify(polled.delegateDialogs)) setData({ delegateDialogs })
  } catch {}
}

// The agents whose rapid-fire view is open (S-1121), and how many threads each box fetches for them.
export const RAPID_PAGE = 60
const rapidLimit = new Map<string, number>()
// Panes showing each agent's rapid-fire view: the last to close stops the fetch.
const rapidPanes = new Map<string, number>()
export const watchRapid = (id: string) => {
  if (!rapidLimit.has(id)) rapidLimit.set(id, RAPID_PAGE)
  rapidPanes.set(id, (rapidPanes.get(id) ?? 0) + 1)
  void refreshSlow()
  return () => {
    const n = (rapidPanes.get(id) ?? 1) - 1
    if (n > 0) { rapidPanes.set(id, n); return }
    rapidPanes.delete(id); rapidLimit.delete(id)
  }
}
export const rapidOlder = (id: string) => { rapidLimit.set(id, (rapidLimit.get(id) ?? RAPID_PAGE) + RAPID_PAGE); return refreshSlow() }

async function fetchRapid(): Promise<Data['rapidWith']> {
  const out: Data['rapidWith'] = {}
  await Promise.all([...rapidLimit].map(async ([id, limit]) => {
    const q = `limit=${limit}&with=${encodeURIComponent(id)}`
    const pages = await Promise.all(['', '&archived=1', '&deferred=1'].map((x) => api<Thread[]>('GET', `/api/agents/human/threads?${q}${x}`)))
    out[id] = { threads: pages.flat(), more: pages.some((p) => p.length >= limit) }
  }))
  return out
}

// A refresh that started earlier never lands over a later one that has: a poll begun before
// Load older would otherwise shrink the list again.
let slowSeq = 0
let slowApplied = 0
export async function refreshSlow() {
  const seq = ++slowSeq
  try {
    const [threads, archived, deferred, rs, decisions, rapidWith] = await Promise.all([
      api<Thread[]>('GET', '/api/agents/human/threads?limit=60'),
      api<Thread[]>('GET', '/api/agents/human/threads?limit=60&archived=1'),
      api<Thread[]>('GET', '/api/agents/human/threads?limit=60&deferred=1'),
      api<Ring[]>('GET', '/api/rings'),
      api<DecisionMail[]>('GET', '/api/mail/decisions'),
      fetchRapid(),
    ])
    if (seq < slowApplied) return
    slowApplied = seq
    const unread = threads.reduce((n, t) => n + t.mails.filter((m) => m.recipients.some((r) => r.id === 'human' && !r.read_at)).length, 0)
    // A ring shows while it runs and at least one member is running.
    const rings = rs.filter((r) => r.status !== 'done' && (JSON.parse(r.members || '[]') as string[]).some((id) => { const a = byId(id); return a && live(a) }))
    const changed = JSON.stringify(threads) !== JSON.stringify(polled.humanThreads) || JSON.stringify(archived) !== JSON.stringify(polled.humanArchived) || JSON.stringify(deferred) !== JSON.stringify(polled.humanDeferred) || JSON.stringify(rings) !== JSON.stringify(polled.rings) || JSON.stringify(rapidWith) !== JSON.stringify(polled.rapidWith)
    const decided = JSON.stringify(decisions) !== JSON.stringify(polled.decisions)
    setData({ ...(changed ? { humanThreads: threads, humanArchived: archived, humanDeferred: deferred, rapidWith, unread, rings } : {}), ...(decided ? { decisions } : {}), ...loadedOnce('mail'), mailTick: polled.mailTick + 1 })
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
async function fetchItsas() {
  const startedAt = itsaSeq
  try {
    const [listed, st, attention, queue] = await Promise.all([
      api<Itsa[]>('GET', '/api/itsas'),
      polled.itsaStatuses.length ? null : api<{ statuses: ItsaStatus[] }>('GET', '/api/itsas/statuses'),
      api<ItsaAttention[]>('GET', '/api/itsas/attention'),
      // A daemon that predates the queue has no route: keep the rows we last had rather than
      // failing the whole ITSA refresh.
      api<ItsaQueueRow[]>('GET', '/api/itsas/queue').catch((): ItsaQueueRow[] => polled.queue),
    ])
    // Re-apply an ITSA change that landed while this fetch was in flight.
    const itsas = listed.map((s) => {
      const e = itsaPatches.get(s.id)
      return e && e.seq > startedAt ? { ...s, ...e.patch } : s
    })
    const patch: Partial<Data> = {}
    if (st) patch.itsaStatuses = st.statuses
    if (JSON.stringify(itsas) !== JSON.stringify(polled.itsas)) patch.itsas = itsas
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

// Every computer's CPU, RAM, and swap; the daemon samples every 5 s, so this polls no faster.
export async function refreshMachines() {
  try {
    const machines = await api<Machine[]>('GET', '/api/machines')
    setKnownOrigins(machines)
    if (JSON.stringify(machines) !== JSON.stringify(polled.machines)) setData({ machines })
  } catch {}
}
