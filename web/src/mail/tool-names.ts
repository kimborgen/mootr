// Tool names in the conversation (S-1933): a tool call shows as one stored label per tool ("Send
// mail"), with the MCP server as a prefix ("stam · Send mail"), not as the raw name. The built-in tools
// of each harness are labelled here from the seeded table (src/tool-name-labels.ts), so most calls
// ask for nothing. For any other tool the daemon names it once with the summaries tiny model and
// stores the label (POST /api/tool-names, src/tool-names.ts); later views read it. Lazy: only tools in
// calls on screen are asked for, and only those with no label. Until a label lands, with the step off, or
// when the daemon couldn't name the tool, the prettified raw name stands in ("Send mail" for send_mail).
//
// The state lives here, outside React, one entry per (agent, tool part), and a component subscribes to
// its own tool only. A request in flight, and a tool the daemon is still naming, are not asked for again
// until the retry timer: a flush that follows at once sends only tools not yet asked.
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { api } from '../api'
import { byId } from '../store'
import { isShown, onVisibleChange } from './tool-summaries'
import { seededLabel, splitTool, toolTitle } from '../../../src/tool-name-labels.ts'

interface Entry { label?: string; settled?: boolean }
interface Reply { enabled?: boolean; labels?: Record<string, string>; pending?: string[] }

// How long the daemon may take on one request, and when to ask again for tools it is still naming.
const WAIT_MS = 8000
const RETRY_MS = 2000
// Failed requests for one tool before it shows prettified for the session.
const TRIES = 3
const BATCH = 40

const EMPTY: Entry = {}
const entries = new Map<string, Entry>()
const listeners = new Map<string, Set<() => void>>()
// Whether the daemon can name tools (a model, a key, budget), as it last said: null until it answers. Off, nothing more is
// asked; a seeded or stored label still shows.
let enabled: boolean | null = null
let generation = 0
const asking = new Set<string>()
// Tools the daemon is still naming: not asked again before the retry timer.
const waiting = new Set<string>()
const errors = new Map<string, number>()
const keyOf = (agent: string, tool: string) => `${agent}\u0000${tool}`
// A raw name split by the agent's harness: Codex names MCP tools `server.tool`, the others `mcp__server__tool`.
const split = (agent: string | undefined, name: string) => splitTool(name, agent ? byId(agent)?.harness : undefined)

function set(agent: string, tool: string, patch: Partial<Entry>): void {
  const k = keyOf(agent, tool)
  entries.set(k, { ...(entries.get(k) ?? EMPTY), ...patch })
  for (const fn of listeners.get(k) ?? []) fn()
}

// The seeded label of the agent's harness for a tool part, else the stored one the daemon sent.
function labelOf(agent: string | undefined, tool: string): string | undefined {
  const h = agent ? byId(agent)?.harness : undefined
  return (h ? seededLabel(h, tool) : undefined) ?? (agent ? entries.get(keyOf(agent, tool))?.label : undefined)
}

// What a tool shows as: its label (or the prettified name) with the MCP server in front.
export function useToolTitle(agent: string | undefined, name: string): string {
  const { tool } = split(agent, name)
  const k = agent ? keyOf(agent, tool) : ''
  const subscribe = useCallback((fn: () => void) => {
    if (!k) return () => {}
    const set = listeners.get(k) ?? new Set()
    listeners.set(k, set)
    set.add(fn)
    return () => { set.delete(fn); if (!set.size) listeners.delete(k) }
  }, [k])
  useSyncExternalStore(subscribe, () => (k ? entries.get(k) ?? EMPTY : EMPTY))
  return toolTitle(name, labelOf(agent, tool), agent ? byId(agent)?.harness : undefined)
}

// Calls on screen, by the element that draws them. What shows is tracked by ./tool-summaries.ts, which
// observes the same elements, so the page has one observer.
type Watched = { agent: string; names: string[] }
const watched = new Map<Element, Watched>()

// Watches an element that draws calls of `names` while it is mounted; their tools are asked for once it shows.
export function useWatchNames(agent: string | undefined, names: string[], el: React.RefObject<Element | null>): void {
  const list = [...new Set(names)].join('\n')
  useEffect(() => {
    const node = el.current
    if (!agent || !node) return
    watched.set(node, { agent, names: list.split('\n') })
    onVisibleChange.add(onChange)
    // The element may already show (a re-render with new names).
    if (isShown(node)) schedule(0)
    return () => { watched.delete(node) }
  }, [agent, list, el])
}
const onChange = () => schedule(0)

// One flush pending at a time, at the earliest time asked.
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

// Asks for the tools on screen that have no label yet and aren't being asked or named, per agent, latest first.
async function flush(): Promise<void> {
  if (enabled === false) return
  const byAgent = new Map<string, string[]>()
  const els = [...watched.keys()].filter(isShown).sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? 1 : -1))
  for (const el of els) {
    const w = watched.get(el)
    if (!w) continue
    for (const name of [...w.names].reverse()) {
      const { tool } = split(w.agent, name)
      const k = keyOf(w.agent, tool)
      if (labelOf(w.agent, tool) || entries.get(k)?.settled || asking.has(k) || waiting.has(k)) continue
      const list = byAgent.get(w.agent) ?? []
      byAgent.set(w.agent, list)
      if (!list.includes(name) && !list.some((n) => split(w.agent, n).tool === tool)) list.push(name)
    }
  }
  await Promise.all([...byAgent].map(([agent, names]) => ask(agent, names)))
}

// Holds `keys` out of the next flushes until the retry delay is over, each response its own: a tool the
// daemon is still naming, or whose request failed, is asked again no sooner than RETRY_MS after its own reply.
const retryTimers = new Set<ReturnType<typeof setTimeout>>()
function holdForRetry(keys: string[]): void {
  if (!keys.length) return
  for (const k of keys) waiting.add(k)
  const t = setTimeout(() => {
    retryTimers.delete(t)
    for (const k of keys) waiting.delete(k)
    schedule(0)
  }, RETRY_MS)
  retryTimers.add(t)
}

async function ask(agent: string, names: string[]): Promise<void> {
  // Every name is reserved before the first request, so a flush while an earlier batch is in flight doesn't
  // send a later batch's names, and this loop doesn't send them twice.
  const keys = names.map((n) => keyOf(agent, split(agent, n).tool))
  for (const k of keys) asking.add(k)
  let i = 0
  try {
    for (; i < names.length; i += BATCH) {
      if (enabled === false) return
      const batch = names.slice(i, i + BATCH)
      const gen = generation
      let r: Reply
      try {
        r = await api<Reply>('POST', '/api/tool-names', { agent, names: batch, wait: WAIT_MS })
      } catch {
        // Unreachable or refused: asked again after the retry delay while they show, up to TRIES times, then prettified.
        const again: string[] = []
        for (const n of batch) {
          const { tool } = split(agent, n)
          const k = keyOf(agent, tool)
          asking.delete(k)
          const c = (errors.get(k) ?? 0) + 1
          errors.set(k, c)
          if (c >= TRIES) set(agent, tool, { settled: true })
          else again.push(k)
        }
        holdForRetry(again)
        continue
      }
      const current = gen === generation
      if (current) enabled = r.enabled === true
      const pending = new Set(r.pending ?? [])
      const again: string[] = []
      for (const n of batch) {
        const { tool } = split(agent, n)
        const k = keyOf(agent, tool)
        asking.delete(k)
        const label = r.labels?.[n]
        if (label) set(agent, tool, { label })
        else if (current && pending.has(n)) again.push(k)
        else if (current) set(agent, tool, { settled: true })
      }
      holdForRetry(again)
    }
  } finally {
    // Names not sent (the step went off) are free again.
    for (const k of keys.slice(i)) asking.delete(k)
  }
}

// For stories and tests: put a tool's label in place, say whether the step is on, or start over.
export function seedToolName(agent: string, tool: string, patch: Partial<Entry>): void { set(agent, tool, patch) }
export function seedNamesEnabled(on: boolean | null): void { enabled = on }
// A tiny-model setting changed or the tab came back to the front: tools settled while the step was off are asked again.
export function rearmToolNames(): void {
  if (enabled !== false) return
  enabled = null
  generation++
  errors.clear()
  for (const [k, e] of entries) if (e.settled && !e.label) entries.set(k, { ...e, settled: false })
  schedule(0)
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') rearmToolNames() })
}
export function resetToolNames(): void {
  for (const t of retryTimers) clearTimeout(t)
  retryTimers.clear()
  entries.clear()
  asking.clear()
  waiting.clear()
  errors.clear()
  enabled = null
  if (timer !== undefined) clearTimeout(timer)
  timer = undefined
  due = Infinity
  watched.clear()
  for (const s of listeners.values()) for (const fn of s) fn()
}
