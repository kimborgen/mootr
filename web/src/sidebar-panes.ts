// The desktop sidebar as a stack of tabbed panes (S-1421): the layout is data, kept in stam
// settings as `sidebarPanes` (one record, id `main`) so it follows the human to every device.
// Each pane lists tab ids and the one showing; the ids name entries of the registry in
// SidebarPanes.tsx, so a new sidebar entry is a new id there and, to show by default, here.
import { useEffect, useSyncExternalStore } from 'react'
import { settingsRecord } from './settings-views'

export interface PaneLayout { tabs: string[]; active: string }
// How tall the tab strips are: compact is half the main tab bar (the default), regular the same height.
export type TabBar = 'compact' | 'regular'
export const TAB_BARS: readonly TabBar[] = ['compact', 'regular']
// `v` is the layout version a save was made under (LAYOUT_V); a record saved before it is absent.
export interface PanesValue { panes: PaneLayout[]; tabBar: TabBar; v?: number }
export interface Sidebar { panes: PaneLayout[]; tabBar: TabBar }

export const MAX_PANES = 4
// Pane 1 holds the agents and the issues, pane 2 the mail, pane 3 the cost and the machines, with
// the cost showing.
export const DEFAULT_PANES: PaneLayout[] = [
  { tabs: ['agents', 'issues'], active: 'agents' },
  { tabs: ['mail', 'history'], active: 'mail' },
  { tabs: ['cost', 'machines'], active: 'cost' },
]
// The layout version. 2 added the `cost` tab: a saved layout older than that gets it once, in the
// pane that holds `machines` (else the last pane), without becoming the showing tab. Every save
// carries the current version, so a human who removes the tab afterwards keeps it removed. 3 added
// `history` the same way, in the pane that holds `mail` (else the last pane).
export const LAYOUT_V = 3

const clone = (p: PaneLayout[]): PaneLayout[] => p.map((x) => ({ tabs: [...x.tabs], active: x.active }))

// A stored layout as a usable one. Ids not in `known` are dropped, and so is a repeat of an id
// (a tab sits in one pane only); a pane left with no tab is dropped; an `active` that isn't a tab
// of its pane becomes the first tab. A missing or unreadable layout takes the defaults. Tabs the
// layout leaves out are not shown.
export function sanitizePanes(x: unknown, known: readonly string[]): PaneLayout[] {
  const raw = x && typeof x === 'object' ? (x as { panes?: unknown }).panes : null
  if (!Array.isArray(raw)) return clone(DEFAULT_PANES)
  const seen = new Set<string>()
  const out: PaneLayout[] = []
  for (const p of raw) {
    if (!p || typeof p !== 'object' || out.length >= MAX_PANES) continue
    const t = (p as { tabs?: unknown }).tabs
    if (!Array.isArray(t)) continue
    const tabs = t.filter((id): id is string => typeof id === 'string' && known.includes(id) && !seen.has(id) && !!seen.add(id))
    if (!tabs.length) continue
    const a = (p as { active?: unknown }).active
    out.push({ tabs, active: typeof a === 'string' && tabs.includes(a) ? a : tabs[0] })
  }
  if (!out.length) return clone(DEFAULT_PANES)
  const v = (x as { v?: unknown }).v
  if ((typeof v === 'number' ? v : 1) < 2 && known.includes('cost') && !seen.has('cost')) {
    const at = out.findIndex((p) => p.tabs.includes('machines'))
    out[at < 0 ? out.length - 1 : at].tabs.push('cost')
  }
  if ((typeof v === 'number' ? v : 1) < 3 && known.includes('history') && !seen.has('history')) {
    const at = out.findIndex((p) => p.tabs.includes('mail'))
    out[at < 0 ? out.length - 1 : at].tabs.push('history')
  }
  return out
}

// A stored value as a tab strip height; anything else is the default.
export function sanitizeTabBar(x: unknown): TabBar {
  const t = x && typeof x === 'object' ? (x as { tabBar?: unknown }).tabBar : null
  return TAB_BARS.find((b) => b === t) ?? 'compact'
}

// The layout as this page holds it, for code outside React and for tests.
export const currentPanes = (): PaneLayout[] => state.panes

// Shows tab `id` in the sidebar pane that holds it, as a click on its tab does; false when no pane holds it.
export function showTab(id: string): boolean {
  const i = state.panes.findIndex((p) => p.tabs.includes(id))
  if (i < 0) return false
  setSidebarPanes(activate(state.panes, i, id))
  return true
}

// The layout after the human picks a tab in pane `i`; an id that isn't a tab of that pane changes nothing.
export function activate(panes: PaneLayout[], i: number, id: string): PaneLayout[] {
  if (!panes[i]?.tabs.includes(id) || panes[i].active === id) return panes
  return panes.map((p, j) => (j === i ? { ...p, active: id } : p))
}

// The tab a key moves to from `id` among `tabs`: arrows step and wrap, Home and End jump.
export function tabKey(tabs: string[], id: string, key: string): string | null {
  const i = tabs.indexOf(id)
  if (i < 0) return null
  if (key === 'ArrowRight') return tabs[(i + 1) % tabs.length]
  if (key === 'ArrowLeft') return tabs[(i - 1 + tabs.length) % tabs.length]
  if (key === 'Home') return tabs[0]
  if (key === 'End') return tabs[tabs.length - 1]
  return null
}

// --- Layout edits (S-1422): pure functions behind Settings › Sidebar. Each returns the new layout,
// or the same array when the edit changes nothing; a pane left with no tab is dropped, an `active`
// that left its pane becomes the first tab, and the last tab can't be removed (a layout needs one).

// Tab ids of `known` that no pane holds.
export const unusedTabs = (panes: PaneLayout[], known: readonly string[]): string[] => known.filter((id) => !panes.some((p) => p.tabs.includes(id)))

const tidy = (panes: PaneLayout[]): PaneLayout[] =>
  panes.filter((p) => p.tabs.length).map((p) => (p.tabs.includes(p.active) ? p : { ...p, active: p.tabs[0] }))

const swap = <T,>(a: T[], i: number, d: number): T[] | null => {
  const j = i + d
  if (i < 0 || i >= a.length || j < 0 || j >= a.length) return null
  const n = [...a]; [n[i], n[j]] = [n[j], n[i]]
  return n
}

// Moves pane `i` up (-1) or down (+1).
export function movePane(panes: PaneLayout[], i: number, d: -1 | 1): PaneLayout[] {
  return swap(clone(panes), i, d) ?? panes
}

// Removes pane `i`; its tabs become unused. The only pane stays.
export function removePane(panes: PaneLayout[], i: number): PaneLayout[] {
  if (panes.length < 2 || !panes[i]) return panes
  return clone(panes).filter((_, j) => j !== i)
}

// Adds a pane holding the tab `id`, taken from its pane when it has one. No change past MAX_PANES.
export function addPane(panes: PaneLayout[], id: string): PaneLayout[] {
  if (panes.length >= MAX_PANES) return panes
  const from = panes.findIndex((p) => p.tabs.includes(id))
  const next = clone(panes)
  if (from >= 0) next[from].tabs = next[from].tabs.filter((t) => t !== id)
  next.push({ tabs: [id], active: id })
  return tidy(next)
}

// Moves tab `id` up (-1) or down (+1) inside its pane.
export function moveTab(panes: PaneLayout[], id: string, d: -1 | 1): PaneLayout[] {
  const i = panes.findIndex((p) => p.tabs.includes(id))
  if (i < 0) return panes
  const tabs = swap(panes[i].tabs, panes[i].tabs.indexOf(id), d)
  return tabs ? panes.map((p, j) => (j === i ? { ...p, tabs } : p)) : panes
}

// Puts tab `id`, from another pane or from unused, at the end of pane `to`.
export function sendTab(panes: PaneLayout[], id: string, to: number): PaneLayout[] {
  if (!panes[to] || panes[to].tabs.includes(id)) return panes
  const next = clone(panes).map((p) => ({ ...p, tabs: p.tabs.filter((t) => t !== id) }))
  next[to].tabs.push(id)
  // A pane the move empties is dropped after it, so `to` stays valid during it.
  return tidy(next)
}

// Takes tab `id` out of its pane (it becomes unused). The last tab of the layout stays.
export function removeTab(panes: PaneLayout[], id: string): PaneLayout[] {
  if (!panes.some((p) => p.tabs.includes(id)) || panes.reduce((n, p) => n + p.tabs.length, 0) < 2) return panes
  return tidy(clone(panes).map((p) => ({ ...p, tabs: p.tabs.filter((t) => t !== id) })))
}

export const defaultPanes = (): PaneLayout[] => clone(DEFAULT_PANES)

// Known ids are only given by the registry, so the record is cleaned against them when used.
let knownIds: readonly string[] = []
const record = settingsRecord<PanesValue>({
  field: 'sidebarPanes',
  legacy: 'stam/sidebar-panes',
  // `v` stays, so a cleaned value is not read as an old layout and migrated again.
  clean: (x) => ({ panes: sanitizePanes(x, knownIds), tabBar: sanitizeTabBar(x), v: LAYOUT_V }),
})
const ID = 'main'

let state: Sidebar = { panes: clone(DEFAULT_PANES), tabBar: 'compact' }
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())

export function setSidebarPanes(next: PaneLayout[]) {
  state = { ...state, panes: next }
  record.save(ID, { ...state, v: LAYOUT_V })
  emit()
}

export function setTabBar(tabBar: TabBar) {
  state = { ...state, tabBar }
  record.save(ID, { ...state, v: LAYOUT_V })
  emit()
}

let loading: Promise<void> | null = null
const loadOnce = () => (loading ??= record.load().then(() => {
  const v = record.cached(ID)
  if (v) state = { panes: sanitizePanes(v, knownIds), tabBar: sanitizeTabBar(v) }
  emit()
}, () => { loading = null }))

export function useSidebarPanes(known: readonly string[]): Sidebar {
  knownIds = known
  useEffect(() => { void loadOnce() }, [])
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => state)
}
