// The Work table's quick filters (S-1515): one-tap named presets that AND with each other and with
// the column filters. The layout keeps the ids of those that are on (views.ts), so a saved view
// keeps them. No browser imports, so the unit tests run in node.
import type { Itsa } from '../types'
import { isPull, linkKind } from './links'

export type QuickId = 'waiting' | 'mine' | 'stale' | 'blocked' | 'review' | 'pr'

// What a status is, so the presets read the settings' categories without importing the store.
export interface StatusLookup { category(status: string): string; human(status: string): boolean }

const STALE_AFTER = 2 * 24 * 3_600_000

interface Quick { id: QuickId; label: string; hint: string; test(it: Itsa, st: StatusLookup, now: number): boolean }

export const QUICK: Quick[] = [
  { id: 'waiting', label: 'Waiting on Kim', hint: 'In a status that waits on the human', test: (it, st) => st.human(it.status) },
  { id: 'mine', label: 'Mine', hint: 'The human owns it or takes part', test: (it) => it.owner === 'human' || (it.participants ?? []).includes('human') },
  { id: 'stale', label: 'Stale', hint: 'Active, with no update in 2 days', test: (it, st, now) => st.category(it.status) === 'active' && now - Date.parse(it.updated_at) > STALE_AFTER },
  { id: 'blocked', label: 'Blocked', hint: 'Status blocked', test: (it) => it.status === 'blocked' },
  { id: 'review', label: 'In review', hint: 'In the review category', test: (it, st) => st.category(it.status) === 'review' },
  { id: 'pr', label: 'Has PR', hint: 'Has a GitHub pull request', test: (it) => (it.links ?? []).some((l) => linkKind(l) === 'github' && isPull(l.url)) },
]
export const QUICK_IDS = QUICK.map((q) => q.id)

// Whether an ITSA passes every quick filter that is on. None on keeps everything.
export function quickKeeps(on: QuickId[] | undefined, it: Itsa, st: StatusLookup, now: number): boolean {
  return (on ?? []).every((id) => QUICK.find((q) => q.id === id)?.test(it, st, now) ?? true)
}

// Checks a stored list: known ids only, each once, in the presets' order.
export function cleanQuick(raw: unknown): QuickId[] {
  return Array.isArray(raw) ? QUICK_IDS.filter((id) => raw.includes(id)) : []
}

// Turns one preset on or off in a list.
export function toggleQuick(on: QuickId[] | undefined, id: QuickId): QuickId[] {
  const set = new Set(on ?? [])
  if (set.has(id)) set.delete(id); else set.add(id)
  return cleanQuick([...set])
}
