// The Agents page's bulk actions (S-3117): which agents each action applies to, what its verb is for each one, the
// one toast it ends with, and the checked set's rules. Pure, so the page, the bar and the test share one rule. The
// per-agent requests are the ones agentMenu makes (actions.tsx); a bulk action sends no request of its own.
import { live } from './format'
import { followsSettings } from './permission-modes'
import type { Agent } from './types'

// Four agents at a time: a bulk action never floods the daemon.
export const BULK_CONCURRENCY = 4
// The names a confirm lists before it says how many more there are.
export const CONFIRM_NAMES = 5

export type ModeId = 'auto' | 'bypass' | 'default' | 'settings'
export const MODES: { id: ModeId; label: string }[] = [
  { id: 'auto', label: 'Auto mode' },
  { id: 'bypass', label: 'Bypass permissions' },
  { id: 'default', label: 'Ask mode' },
  { id: 'settings', label: 'Settings’ mode' },
]

// The bulk actions: Pause, Resume (unpause for a paused agent, resume for a stopped one), Archive and a permission mode.
export type BulkAct = { kind: 'pause' } | { kind: 'resume' } | { kind: 'archive' } | { kind: 'mode'; mode: ModeId }

// Whether the agent is already in the mode a bulk mode change would set it to: a switch to it does nothing.
const inMode = (a: Agent, mode: ModeId) => (mode === 'settings' ? followsSettings(a) : !followsSettings(a) && (a.permission_mode ?? 'auto') === mode)

// Whether the action applies to the agent. An action skips the agents it doesn't apply to (pause on a paused agent,
// archive on an archived one), so a button counts only these.
export function applies(a: Agent, act: BulkAct): boolean {
  switch (act.kind) {
    case 'pause': return a.lifecycle === 'active'
    case 'resume': return a.lifecycle === 'paused' || a.lifecycle === 'shut_down'
    case 'archive': return a.lifecycle !== 'archived'
    case 'mode': return live(a) && !inMode(a, act.mode)
  }
}

// The per-agent action an agent gets for the bulk action (the path under /api/agents/ID/), and null for a mode change,
// which has its own request. Resume sends unpause to a paused agent and resume to a stopped one, as agentMenu does.
export function verbOf(a: Agent, act: BulkAct): string | null {
  switch (act.kind) {
    case 'pause': return 'pause'
    case 'resume': return a.lifecycle === 'paused' ? 'unpause' : 'resume'
    case 'archive': return 'archive'
    case 'mode': return null
  }
}

// What the action says once it ends, as the toast's first words: "Paused 5".
export function doneWord(act: BulkAct): string {
  switch (act.kind) {
    case 'pause': return 'Paused'
    case 'resume': return 'Resumed'
    case 'archive': return 'Archived'
    case 'mode': return 'Switched'
  }
}
export function actLabel(act: BulkAct): string {
  switch (act.kind) {
    case 'pause': return 'pause'
    case 'resume': return 'resume'
    case 'archive': return 'archive'
    case 'mode': return `switch to ${MODES.find((m) => m.id === act.mode)!.label.toLowerCase()}`
  }
}

// Why a bulk action applies to none of the agents: the reason a disabled button gives on a tap (S-3282). Called only when
// `applies` is false for every agent; a mode change asks whether any agent is live, since the bar's Mode button needs one.
export function reasonOf(agents: Agent[], act: BulkAct): string {
  const verb = act.kind === 'mode' ? 'change the mode' : actLabel(act)
  const why = act.kind === 'pause' ? 'none is running'
    : act.kind === 'resume' ? 'all are running or archived'
    : act.kind === 'archive' ? 'all are archived'
    : agents.some(live) ? 'all are already in that mode' : 'none is live'
  return `None of the ${agents.length} can ${verb}: ${why}`
}

// One agent's outcome in a bulk action. `result` is what the daemon said for an archive: "done" when it finished,
// or the wait it queued (the agent is still running its step), with cascade notes after "; " for a parent.
export interface BulkResult { id: string; name: string; ok: boolean; reason?: string; result?: string }

// An archive the daemon queued rather than finished: it succeeded, but the agent is still running.
export const queuedOf = (r: BulkResult) => r.ok && !!r.result && !r.result.startsWith('done')
// The cascade notes of an archive's result ("also archived idle x; couldn't archive y"), or '' when it has none.
export const notesOf = (result?: string) => (result?.includes('; ') ? result.slice(result.indexOf('; ') + 2) : '')
// The note about one agent, from a cascade's notes: the segment that names it, or '' when none does.
export function noteFor(notes: string, name: string): string {
  return notes.split('; ').find((seg) => seg.split(/[\s,:]+/).includes(name)) ?? ''
}

// The toast a bulk action ends with: "Paused 5", or "Paused 4, 1 failed: name (reason)". An archive the daemon queued
// counts as "1 queued: name", and each parent's cascade notes follow it by name. With nothing done, the failures
// alone: "Couldn't pause: name (reason)". Every failure names its agent, so a partial failure never reads as success.
export function summarize(act: BulkAct, rs: BulkResult[]): { text: string; err: boolean } {
  // Only an archive has a queued outcome and cascade notes: pause, resume and a mode change answer with their own words.
  const archive = act.kind === 'archive'
  const queued = archive ? rs.filter(queuedOf) : []
  const done = rs.filter((r) => r.ok && !queued.includes(r)).length
  const failed = rs.filter((r) => !r.ok).map((r) => `${r.name}${r.reason ? ` (${r.reason})` : ''}`)
  const word = doneWord(act)
  const head = act.kind === 'mode' ? `${word} ${done} to ${MODES.find((m) => m.id === act.mode)!.label}` : `${word} ${done}`
  const notes = archive ? rs.filter((r) => notesOf(r.result)).map((r) => `${r.name}: ${notesOf(r.result)}`) : []
  const tail = notes.length ? `. Notes: ${notes.join('; ')}` : ''
  if (!queued.length && !failed.length) return { text: head + tail, err: false }
  if (!done && !queued.length) return { text: `Couldn't ${actLabel(act)}: ${failed.join(', ')}${tail}`, err: true }
  const parts = [done || !queued.length ? head : '']
  if (queued.length) parts.push(`${queued.length} queued: ${queued.map((r) => r.name).join(', ')}`)
  if (failed.length) parts.push(`${failed.length} failed: ${failed.join(', ')}`)
  return { text: parts.filter(Boolean).join(', ') + tail, err: failed.length > 0 }
}

// Runs `run` on each item, `limit` at a time, and returns the results in the items' order.
export async function mapLimit<T, R>(items: T[], limit: number, run: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await run(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

// The checked set after a change of agents or scope: the ids still in the scope's list. The same set comes back when
// none drops, so a poll that changes nothing doesn't redraw the page.
export function keepChecked(checked: ReadonlySet<string>, inScope: ReadonlySet<string>): ReadonlySet<string> {
  const kept = [...checked].filter((id) => inScope.has(id))
  return kept.length === checked.size ? checked : new Set(kept)
}

// The names a confirm lists: up to CONFIRM_NAMES, then how many more there are.
export function confirmNames(names: string[]): { names: string[]; more: number } {
  return { names: names.slice(0, CONFIRM_NAMES), more: Math.max(0, names.length - CONFIRM_NAMES) }
}

// The ids from `from` to `to` in the order the table shows, both ends included, for a Shift-click. A `to` the order doesn't
// list gives just `to`.
export function rangeOf(order: string[], from: string, to: string): string[] {
  const i = order.indexOf(from)
  const j = order.indexOf(to)
  if (i < 0 || j < 0) return [to]
  return order.slice(Math.min(i, j), Math.max(i, j) + 1)
}
