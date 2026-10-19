// The Work columns on each row of the Agents sidebar (S-697): up to two, picked in the order the
// human chose them, kept in stam settings as `sidebarCols` (one record, id `main`) so the choice
// follows them to every device. An empty list shows the agent's role, as before.
import { useEffect, useSyncExternalStore } from 'react'
import { settingsRecord } from './settings-views'
import { cardBadges, type Badge } from './system/model'
import type { Field } from './itsa/fields'
import type { Itsa } from './types'

export const MAX_SIDEBAR_COLS = 2
const ID = 'main'
// The built-in columns a row can show, before the ITSA fields.
export const BUILTIN_COLS: { id: string; label: string }[] = [{ id: 'review', label: 'Review' }, { id: 'tests', label: 'Tests' }, { id: 'health', label: 'Health' }]

// A stored value as a column list: at most two distinct ids; anything else is none.
export function sanitizeCols(x: unknown): string[] {
  const raw = x && typeof x === 'object' ? (x as { cols?: unknown }).cols : null
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.filter((c): c is string => typeof c === 'string' && c !== ''))].slice(0, MAX_SIDEBAR_COLS)
}

// The list after the human picks or clears one column; a third pick is refused (the list stays).
export function toggleCol(cols: string[], id: string): string[] {
  if (cols.includes(id)) return cols.filter((c) => c !== id)
  return cols.length < MAX_SIDEBAR_COLS ? [...cols, id] : cols
}

// The ids that can be picked: the built-ins, then each field by position.
export function pickable(fields: Pick<Field, 'id' | 'label' | 'position'>[]): { id: string; label: string }[] {
  return [...BUILTIN_COLS, ...[...fields].sort((a, b) => a.position - b.position).map((f) => ({ id: 'field:' + f.id, label: f.label }))]
}

// Drops picked ids that no longer exist (a deleted field), so a stale pick doesn't hold a slot.
export function liveCols(cols: string[], fields: Pick<Field, 'id'>[] | null): string[] {
  if (!fields) return cols
  const ids = new Set([...BUILTIN_COLS.map((c) => c.id), ...fields.map((f) => 'field:' + f.id)])
  return cols.filter((c) => ids.has(c))
}

// What a row shows for each picked column: the badge, or null for a dash.
export function rowValues(it: Itsa | undefined, cols: string[], fields: Field[]): (Badge | null)[] {
  const badges = it ? cardBadges(it, cols, fields, true) : []
  return cols.map((id) => badges.find((b) => b.id === id) ?? null)
}

const record = settingsRecord<{ cols: string[] }>({
  field: 'sidebarCols',
  legacy: 'stam/sidebar-cols',
  clean: (x) => ({ cols: sanitizeCols(x) }),
})

let cols: string[] = []
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())

export function setSidebarCols(next: string[]) {
  cols = next
  record.save(ID, { cols: next })
  emit()
}

let loading: Promise<void> | null = null
const loadOnce = () => (loading ??= record.load().then(() => { cols = record.cached(ID)?.cols ?? cols; emit() }, () => { loading = null }))

export function useSidebarCols(): string[] {
  useEffect(() => { void loadOnce() }, [])
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => cols)
}
