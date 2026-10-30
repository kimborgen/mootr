// A paused epic's roll-up (S-4103), free of the store so it can be tested alone. An epic left
// in_progress while every open child sits in the ready or backlog categories, and whose owner has
// been idle for a day, isn't live work: the Work page shows it as waiting. Display only: the
// stored status, the API, itsa_get, and the Process view's counts keep what the owner set, and
// the status column's sort, filter and search read the stored status too.
import type { Agent, Itsa, ItsaCategory } from '../types'

export const PAUSED_STATUS = 'waiting'
export const PAUSED_IDLE_MS = 24 * 60 * 60 * 1000

// `owner` is the owner's agent row, or undefined when it isn't known: an unknown owner, or one
// with no idle_since (working, or never idle), leaves the epic as it is.
export function pausedEpic(it: Itsa, all: Itsa[], owner: Pick<Agent, 'idle_since'> | undefined, now: number,
  category: (status: string) => ItsaCategory): boolean {
  if (it.status !== 'in_progress') return false
  const open = all.filter((x) => x.parent_id === it.id && category(x.status) !== 'closed')
  if (!open.length || !open.every((x) => category(x.status) === 'ready' || category(x.status) === 'backlog')) return false
  const since = owner?.idle_since ? Date.parse(owner.idle_since) : NaN
  return Number.isFinite(since) && now - since >= PAUSED_IDLE_MS
}

export const PAUSED_TITLE = 'Stored as in progress. Shown as waiting: every open child is todo or backlog, and the owner has been idle for a day.'
