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
// `sizes` are the panes' height ratios, one per pane in order (S-3810); absent means DEFAULT_GROW.
export interface PanesValue { panes: PaneLayout[]; tabBar: TabBar; v?: number; sizes?: number[] }
export interface Sidebar { panes: PaneLayout[]; tabBar: TabBar; sizes?: number[] }

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

// --- Pane sizes (S-3810): the panes' heights as flex ratios, shared in the settings record like the
// layout. Pure functions, so a later slice (collapse) can extend them.

// Taller panes first: the agents get the most room, then the mail, then the rest.
export const DEFAULT_GROW = [3, 2, 1]
// The share of a pair of neighbours one step of the arrow keys moves.
export const KEY_STEP = 0.05

export const defaultSizes = (n: number): number[] => Array.from({ length: n }, (_, i) => DEFAULT_GROW[i] ?? 1)

// Stored sizes for `n` panes, or null when they aren't usable: not an array of `n` finite positive numbers.
export function sanitizeSizes(x: unknown, n: number): number[] | null {
  const raw = x && typeof x === 'object' ? (x as { sizes?: unknown }).sizes : null
  if (!Array.isArray(raw) || raw.length !== n) return null
  return raw.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0) ? [...raw] : null
}

// The ratios to draw `n` panes with: the stored ones when they fit, else today's 3/2/1.
export const resolveSizes = (sizes: number[] | undefined, n: number): number[] =>
  sizes && sizes.length === n && sizes.every((v) => Number.isFinite(v) && v > 0) ? sizes : defaultSizes(n)

// Moves the separator between panes `i` and `i + 1` so pane `i` takes `frac` of the two together.
// `frac` is clamped to [minFrac, 1 - minFrac], the room each must keep (a minimum pane height as a
// share of the pair); the pair's sum and every other pane are unchanged. Same array when nothing moves.
export function resizePair(sizes: number[], i: number, frac: number, minFrac: number): number[] {
  if (i < 0 || i + 1 >= sizes.length || !Number.isFinite(frac)) return sizes
  const lo = Math.min(Math.max(minFrac, 0), 0.5)
  const f = Math.min(Math.max(frac, lo), 1 - lo)
  const sum = sizes[i] + sizes[i + 1]
  if (Math.abs(sizes[i] / sum - f) < 1e-9) return sizes
  const next = [...sizes]
  next[i] = sum * f
  next[i + 1] = sum - next[i]
  return next
}

// Pane `i`'s share of the pair it forms with `i + 1`, from 0 to 1.
export const pairFrac = (sizes: number[], i: number): number => sizes[i] / (sizes[i] + sizes[i + 1])

// The share pane `i` takes after a key on its separator: arrows step, Home and End go to the limits
// (Home gives the pane above its smallest, End its largest); null for any other key.
export function separatorKey(frac: number, key: string, minFrac: number): number | null {
  if (key === 'ArrowUp' || key === 'ArrowLeft') return Math.max(frac - KEY_STEP, minFrac)
  if (key === 'ArrowDown' || key === 'ArrowRight') return Math.min(frac + KEY_STEP, 1 - minFrac)
  if (key === 'Home') return minFrac
  if (key === 'End') return 1 - minFrac
  return null
}

// The sizes after pane `i` moves up (-1) or down (+1): they travel with the pane, as its tabs do.
export function moveSizes(sizes: number[], i: number, d: -1 | 1): number[] {
  const j = i + d
  if (i < 0 || j < 0 || i >= sizes.length || j >= sizes.length) return sizes
  const next = [...sizes]; [next[i], next[j]] = [next[j], next[i]]
  return next
}

// The aria range of a separator, in percent of its pair, from the share each pane must keep.
// An unmeasured or impossible share gives the whole range.
export function ariaRange(minFrac: number): { min: number; max: number } {
  if (!Number.isFinite(minFrac) || minFrac <= 0 || minFrac >= 0.5) return { min: 0, max: 100 }
  return { min: Math.ceil(minFrac * 100), max: Math.floor((1 - minFrac) * 100) }
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
  clean: (x) => {
    const panes = sanitizePanes(x, knownIds)
    const sizes = sanitizeSizes(x, panes.length)
    return { panes, tabBar: sanitizeTabBar(x), v: LAYOUT_V, ...(sizes ? { sizes } : {}) }
  },
})
const ID = 'main'

let state: Sidebar = { panes: clone(DEFAULT_PANES), tabBar: 'compact' }
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())

// The sizes this page holds; undefined is the default 3/2/1.
export const currentSizes = (): number[] | undefined => state.sizes

// `sizes` are the ratios the new layout keeps: by default the held ones, which belong to a pane count,
// so an edit that adds or drops a pane leaves them behind.
export function setSidebarPanes(next: PaneLayout[], sizes: number[] | undefined = state.sizes) {
  const { sizes: _held, ...rest } = state
  state = { ...rest, panes: next, ...(sizes && sizes.length === next.length ? { sizes } : {}) }
  record.save(ID, { ...state, v: LAYOUT_V })
  emit()
}

// Moves pane `i` up (-1) or down (+1), its size with it.
export function moveSidebarPane(i: number, d: -1 | 1) {
  const next = movePane(state.panes, i, d)
  if (next === state.panes) return
  setSidebarPanes(next, state.sizes && moveSizes(state.sizes, i, d))
}

// Saves the pane ratios (null: back to the default 3/2/1). Called once per drag, on release.
export function setSidebarSizes(sizes: number[] | null) {
  const { sizes: _old, ...rest } = state
  state = sizes && sizes.length === state.panes.length ? { ...rest, sizes } : rest
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
  if (v) {
    const panes = sanitizePanes(v, knownIds)
    const sizes = sanitizeSizes(v, panes.length)
    state = { panes, tabBar: sanitizeTabBar(v), ...(sizes ? { sizes } : {}) }
  }
  emit()
}, () => { loading = null }))

export function useSidebarPanes(known: readonly string[]): Sidebar {
  knownIds = known
  useEffect(() => { void loadOnce() }, [])
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => state)
}

// --- Layout defaults (S-3810): "my default" is a second record of the same field (id `default`), apart
// from the live layout (id `main`). A revert replaces the whole live record with the default, so any
// field the record gains (sizes) is reset with the rest; it never writes another setting.
const DEFAULT_ID = 'default'

const cloneValue = (v: Sidebar): PanesValue => ({ panes: clone(v.panes), tabBar: v.tabBar, v: LAYOUT_V, ...(v.sizes ? { sizes: [...v.sizes] } : {}) })

// A stored record as a layout: cleaned panes and strip height, and the sizes when they fit the panes.
function cleanSidebar(x: unknown): Sidebar {
  const panes = sanitizePanes(x, knownIds)
  const sizes = sanitizeSizes(x, panes.length)
  return { panes, tabBar: sanitizeTabBar(x), ...(sizes ? { sizes } : {}) }
}

// mootr's own layout: the factory panes and the compact strip.
export const mootrDefault = (): PanesValue => ({ panes: defaultPanes(), tabBar: 'compact', v: LAYOUT_V })

// The human's saved default, or null when none is saved. Read from the record loaded with the live layout.
// `saved` holds a default saved before the record has loaded (the record keeps no view then).
let saved: PanesValue | null = null
export function userDefault(): PanesValue | null {
  const v = saved ?? record.cached(DEFAULT_ID)
  return v ? cloneValue(cleanSidebar(v)) : null
}

// Saves the live layout as the human's default.
export function saveUserDefault() {
  saved = cloneValue(state)
  record.save(DEFAULT_ID, saved)
  emit()
}

// Replaces the live layout, whole, with `v`.
function replaceLive(v: PanesValue) {
  state = cleanSidebar(v)
  record.save(ID, cloneValue(state))
  emit()
}

export function revertToMootrDefault() { replaceLive(mootrDefault()) }

// Reverts to the saved default; false (and no change) when none is saved.
export function revertToUserDefault(): boolean {
  const d = userDefault()
  if (!d) return false
  replaceLive(d)
  return true
}

// Whether the human has a saved default. Loads the record, so it holds after a reload.
export function useHasUserDefault(): boolean {
  useEffect(() => { void loadOnce().then(() => { saved = null; emit() }) }, [])
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => userDefault() !== null)
}
