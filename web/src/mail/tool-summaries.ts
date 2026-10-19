// Tool-call summaries in the conversation (S-1481): each call reads as two short fields, the
// tool in plain English and what the agent is doing, written once per call by the daemon's
// cheapest model (POST /api/tool-summaries, src/tool-summaries.ts). Lazy: only calls in tool
// groups on screen are asked for, the groups lowest on screen (the latest) first and each
// group's latest call (the one its header shows) ahead of the rest; groups above or below the
// viewport aren't asked. A call waits up to HOLD_MS from when it first shows for its summary,
// drawn but invisible; after that it shows raw and fades to the summary if one arrives.
//
// The state lives here, outside React, one entry per call, and a component subscribes to its
// own calls only: a summary arriving redraws that call's row and its group, never another turn.
import { useCallback, useEffect, useReducer, useSyncExternalStore } from 'react'
import { api } from '../api'

export interface ToolSummary { tool: string; doing: string }
// `status` 'pending': the harness may still be filling the call's input, so it isn't asked for
// yet (a summary is stored per id here, and the daemon keys by the input it was made from).
export interface SummaryCall { id: string; name: string; input?: unknown; status?: string }
// One call's state: its summary; when it first showed (the hold starts then); and `settled`,
// asked with no summary coming (the model failed or refused), so it shows raw. `stale`: the summary
// is an older one, shown until the daemon's new one lands (S-1843), so the call is asked again.
interface Entry { s?: ToolSummary; seen?: number; settled?: boolean; stale?: boolean }
interface Reply { enabled?: boolean; summaries?: Record<string, ToolSummary>; pending?: string[] }

// How long a call waits for its summary before it shows raw: --duration-summary-hold
// (web/tokens-stam.css), read once; a threshold, not motion, so reduced motion keeps it.
let holdMs: number | undefined
export function holdMsNow(): number {
  if (holdMs === undefined) {
    const v = typeof getComputedStyle === 'function' ? parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--duration-summary-hold')) : NaN
    holdMs = Number.isFinite(v) && v > 0 ? v : 1000
  }
  return holdMs
}
// How long the daemon may take on one request, and when to ask again for calls still pending.
const WAIT_MS = 8000
const RETRY_MS = 2000
// Failed requests for one call before it shows raw for the session.
const TRIES = 3
const BATCH = 40

const EMPTY: Entry = {}
const entries = new Map<string, Entry>()
const listeners = new Map<string, Set<() => void>>()
// Whether the step is on, as the daemon last said: null until it answers. Off, the stored summaries
// still show and nothing waits; with no IntersectionObserver to tell what shows, every call is raw at once.
let enabled: boolean | null = null
// Bumped by a re-arm: a reply asked before it says nothing about the step now (S-1843).
let generation = 0
const enabledListeners = new Set<() => void>()
const asking = new Set<string>()
const errors = new Map<string, number>()
const keyOf = (agent: string, id: string) => `${agent}\u0000${id}`

function set(agent: string, id: string, patch: Partial<Entry>): void {
  const k = keyOf(agent, id)
  entries.set(k, { ...(entries.get(k) ?? EMPTY), ...patch })
  for (const fn of listeners.get(k) ?? []) fn()
}
function setEnabled(on: boolean): void {
  if (enabled === on) return
  enabled = on
  for (const fn of enabledListeners) fn()
}
const subscribeEnabled = (fn: () => void) => { enabledListeners.add(fn); return () => { enabledListeners.delete(fn) } }

// What a call draws: its summary, or `held` while it waits for one (drawn invisible), else raw.
export interface CallView { summary?: ToolSummary; held: boolean }
export function useToolSummary(agent: string | undefined, id: string): CallView {
  const k = agent ? keyOf(agent, id) : ''
  const subscribe = useCallback((fn: () => void) => {
    if (!k) return () => {}
    const set = listeners.get(k) ?? new Set()
    listeners.set(k, set)
    set.add(fn)
    return () => { set.delete(fn); if (!set.size) listeners.delete(k) }
  }, [k])
  const e = useSyncExternalStore(subscribe, () => (k ? entries.get(k) ?? EMPTY : EMPTY))
  const on = useSyncExternalStore(subscribeEnabled, () => enabled)
  const [, tick] = useReducer((n: number) => n + 1, 0)
  const off = !agent || !observable()
  const left = e.seen === undefined ? Infinity : e.seen + holdMsNow() - Date.now()
  const held = !off && on !== false && !e.s && !e.settled && left > 0
  // The hold ends on time, without waiting for anything else to redraw the row.
  useEffect(() => {
    if (!held || left === Infinity) return
    const t = setTimeout(tick, left)
    return () => clearTimeout(t)
  }, [held, left])
  return { summary: off ? undefined : e.s, held }
}

// Tool groups and lone calls on screen, by the element that draws them.
type Watched = { agent: string; calls: SummaryCall[] }
const watched = new Map<Element, Watched>()
const visible = new Set<Element>()
let observer: IntersectionObserver | null = null
const observable = () => typeof IntersectionObserver !== 'undefined'

// Watches an element that draws `calls` (oldest first) while it is mounted; a call is asked
// for once its element shows.
export function useWatchCalls(agent: string | undefined, calls: SummaryCall[], el: React.RefObject<Element | null>): void {
  const ids = calls.map((c) => c.id).join('\n')
  useEffect(() => {
    const node = el.current
    if (!agent || !node || !observable()) return
    observer ??= new IntersectionObserver(onIntersect)
    watched.set(node, { agent, calls })
    observer.observe(node)
    return () => { observer?.unobserve(node); watched.delete(node); visible.delete(node) }
    // The calls' ids say when to watch again; a status change alone keeps the watch.
  }, [agent, ids, el])
  // A status change updates the watched calls in place: a call no longer pending is asked for.
  const statuses = calls.map((c) => c.status).join('\n')
  useEffect(() => {
    const w = el.current && watched.get(el.current)
    if (!w) return
    w.calls = calls
    if (visible.has(el.current!)) schedule(0)
  }, [statuses])
}

// What else follows what shows (the tool names, S-1933), so the page keeps one observer: asked when
// something shows or hides, and which elements show now.
export const onVisibleChange = new Set<() => void>()
export const isShown = (el: Element): boolean => visible.has(el)

function onIntersect(list: IntersectionObserverEntry[]): void {
  for (const x of list) {
    if (x.isIntersecting) visible.add(x.target)
    else visible.delete(x.target)
  }
  schedule(0)
  for (const fn of onVisibleChange) fn()
}

// One flush pending at a time, at the earliest time asked: a retry waiting doesn't delay a
// group that just showed.
let timer: ReturnType<typeof setTimeout> | undefined
let due = Infinity
function schedule(ms: number): void {
  const at = Date.now() + ms
  if (timer !== undefined) {
    if (at >= due) return
    clearTimeout(timer)
  }
  due = at
  timer = setTimeout(() => { timer = undefined; due = Infinity; void flush() }, ms)
}

// Asks for the calls on screen that have no summary yet, per agent: first the latest call of
// each visible group, latest group first, then the rest of those groups' calls, latest first.
async function flush(): Promise<void> {
  // The daemon said the step is off: nothing more is asked until it is re-armed (a settings change).
  if (enabled === false) return
  const now = Date.now()
  const byAgent = new Map<string, { heads: SummaryCall[]; rest: SummaryCall[] }>()
  const els = [...visible].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? 1 : -1))
  for (const el of els) {
    const w = watched.get(el)
    if (!w) continue
    const want = [...w.calls].reverse().filter((c) => {
      const e = entries.get(keyOf(w.agent, c.id)) ?? EMPTY
      if (e.seen === undefined) set(w.agent, c.id, { seen: now })
      return c.status !== 'pending' && (!e.s || e.stale) && !e.settled && !asking.has(keyOf(w.agent, c.id))
    })
    if (!want.length) continue
    const b = byAgent.get(w.agent) ?? { heads: [], rest: [] }
    byAgent.set(w.agent, b)
    b.heads.push(want[0])
    b.rest.push(...want.slice(1))
  }
  await Promise.all([...byAgent].map(async ([agent, b]) => {
    await ask(agent, b.heads)
    await ask(agent, b.rest)
  }))
}

async function ask(agent: string, calls: SummaryCall[]): Promise<void> {
  for (let i = 0; i < calls.length; i += BATCH) {
    // The daemon said the step is off: nothing more is asked.
    if (enabled === false) return
    const batch = calls.slice(i, i + BATCH).filter((c) => !asking.has(keyOf(agent, c.id)))
    if (!batch.length) continue
    for (const c of batch) asking.add(keyOf(agent, c.id))
    const gen = generation
    let r: Reply
    try {
      r = await api<Reply>('POST', '/api/tool-summaries', { agent, calls: batch.map(({ id, name, input }) => ({ id, name, input })), wait: WAIT_MS })
    } catch {
      // Unreachable or refused: asked again later while they show, up to TRIES times, then raw.
      for (const c of batch) {
        const k = keyOf(agent, c.id)
        asking.delete(k)
        const n = (errors.get(k) ?? 0) + 1
        errors.set(k, n)
        if (n >= TRIES) set(agent, c.id, { settled: true })
      }
      schedule(RETRY_MS)
      continue
    }
    for (const c of batch) asking.delete(keyOf(agent, c.id))
    // A reply asked before a re-arm says nothing about the step now: its summaries show, its step answer and
    // settled calls don't.
    const current = gen === generation
    if (current) setEnabled(r.enabled === true)
    const pending = new Set(r.pending ?? [])
    for (const c of batch) {
      const s = r.summaries?.[c.id]
      // A summary still pending is an older one being replaced: shown, and asked again.
      if (s) set(agent, c.id, { s, stale: pending.has(c.id) })
      else if (current && !pending.has(c.id)) set(agent, c.id, { settled: true })
    }
    if (pending.size) schedule(RETRY_MS)
  }
}

// For stories and tests: put a call's state in place, say whether the step is on, or start over.
export function seedToolSummary(agent: string, id: string, patch: Partial<Entry>): void { set(agent, id, patch) }
// The step came back on (a tiny-model setting changed): the calls settled while it was off are asked for
// again, once they show. Nothing happens unless the last answer said off.
export function rearmToolSummaries(): void {
  if (enabled !== false) return
  enabled = null
  generation++
  errors.clear()
  for (const [k, e] of entries) if (e.settled && !e.s) entries.set(k, { ...e, settled: false })
  for (const fn of enabledListeners) fn()
  schedule(0)
}

// A step turned on from another tab, the phone or the CLI shows when this one comes back to the front (S-1843).
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') rearmToolSummaries() })
}

export function seedEnabled(on: boolean | null): void { if (on === null) { enabled = null; for (const fn of enabledListeners) fn() } else setEnabled(on) }
export function resetToolSummaries(): void {
  entries.clear()
  asking.clear()
  errors.clear()
  visible.clear()
  enabled = null
  holdMs = undefined
  if (timer !== undefined) clearTimeout(timer)
  timer = undefined
  due = Infinity
  observer?.disconnect()
  observer = null
  watched.clear()
  for (const s of listeners.values()) for (const fn of s) fn()
  for (const fn of enabledListeners) fn()
}
