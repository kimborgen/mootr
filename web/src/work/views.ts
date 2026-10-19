// The Work table's layout: which columns show, in what order, at what widths, and the named
// views that save them. The state transitions are pure. The views (columns, order, grouping,
// filter) are kept in stam settings (S-293), so they follow the user across devices; the column widths
// stay on this device, in localStorage. Every column id is checked against the registry the
// caller passes in, so a stale or corrupt store falls back to the default instead of hiding work.
import { fieldIdOf, isFieldCol } from '../itsa/fields'
import { settingsRecord } from '../settings-views'
import { LINK_KINDS } from './links'
import { GROUPS, type Group, type Show } from './model'
import { cleanQuick, toggleQuick, type QuickId } from './quick'
import { cleanFilters, cleanSort, type ColFilter, type SortKey } from './sortfilter'

export interface Layout {
  // The visible column ids, in order. `work` is always first.
  cols: string[]
  // How the rows are grouped: by issue, by agent, flat, or by a column (S-1520).
  group: Group
  // The column id of a 'column' grouping. Kept as stored while the column is unknown to the page
  // (a field not loaded yet), so a save never drops it; the page shows the issue tree meanwhile.
  groupBy?: string
  // A resized column's width in px. The user's value, not a design value, so it is stored raw;
  // every write goes through clampWidth.
  widths: Record<string, number>
  // The ITSA field ids this layout has been shown (S-369): a field not listed is new to it and
  // shows at its place; a listed one the user hid stays hidden. Absent on layouts from before.
  seen?: string[]
  // The sort keys, first the most significant, and the column filters by column id (S-1504). Part of the
  // layout, so a saved view keeps them. Absent when there are none.
  sort?: SortKey[]
  filters?: Record<string, ColFilter>
  // The quick filters that are on (S-1515), ANDed with the column filters. Absent when none.
  quick?: QuickId[]
}
export interface SavedView extends Layout { id: string; name: string; show: Show }
// `current` is the view the layout came from; '' is Default. `show` is the open/all filter.
export interface ViewStore { views: SavedView[]; current: string; layout: Layout; show: Show }

// This browser's copy from before settings held the views, and the widths that stay on it.
export const VIEWS_KEY = 'stam/work-views'
const WIDTHS_KEY = 'stam/work-widths'
export const LOCKED = ['work']
// Columns a saved view may still name that became others: the one Links column is a column per
// kind of link (S-363). The Needs-you actions column is gone, so it drops as unknown.
const RENAMED: Record<string, string[]> = { links: LINK_KINDS }
export const MIN_WIDTH = 48
export const MAX_WIDTH = 800

export const clampWidth = (px: number) => Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, px)))

// The ITSA field ids among the registry's column ids.
const fieldIdsOf = (ids: string[]): string[] => ids.filter(isFieldCol).map((id) => fieldIdOf(id)!)
// A seen list as the layout keeps it: absent while there is no field, which reads the same as empty.
const seenProp = (seen: string[]): { seen?: string[] } => (seen.length ? { seen } : {})
// Sort and filters as the layout keeps them: absent while empty, which reads the same.
const sortProps = (sort: SortKey[] | undefined, filters: Record<string, ColFilter> | undefined): Pick<Layout, 'sort' | 'filters'> => ({
  ...(sort?.length ? { sort } : {}),
  ...(filters && Object.keys(filters).length ? { filters } : {}),
})

// The grouping column as the layout keeps it: only for a column grouping, absent otherwise.
const groupProp = (group: Group, by: unknown): { groupBy?: string } => (group === 'column' && typeof by === 'string' && by ? { groupBy: by } : {})

// The quick list as the layout keeps it: absent while empty.
const quickProp = (quick: unknown): { quick?: QuickId[] } => { const q = cleanQuick(quick); return q.length ? { quick: q } : {} }

export function defaultLayout(ids: string[]): Layout {
  return { cols: ids.slice(), widths: {}, group: 'issues', ...seenProp(fieldIdsOf(ids)) }
}

// A layout's columns and seen list against the registry: a field the layout has not seen is shown
// at its registry place, a removed field drops out of both, and the rest keep their state.
export function settle(cols: string[], seen: string[] | undefined, ids: string[]): { cols: string[]; seen?: string[] } {
  const known = new Set(seen ?? [])
  const current = fieldIdsOf(ids)
  const fresh = new Set(current.filter((f) => !known.has(f)).map((f) => ids.find((id) => fieldIdOf(id) === f)!))
  const kept = tidyCols(cols, ids)
  const shown = new Set([...kept, ...fresh])
  return { cols: tidyCols(fullOrder(kept, ids).filter((id) => shown.has(id)), ids), ...seenProp(current) }
}

// Sets how the rows are grouped; the layout is what a saved view keeps. A column grouping names
// its column; the others carry none.
export function setGroup(layout: Layout, group: Group, by?: string): Layout {
  const { groupBy: _, ...bare } = layout
  return { ...bare, group, ...groupProp(group, by) }
}

// Sorts by a column. `add` (shift-click) appends the key or updates its direction among the others;
// without it the key replaces them all. A null direction removes the key.
export function setSort(layout: Layout, col: string, dir: SortKey['dir'] | null, add: boolean): Layout {
  const rest = (layout.sort ?? []).filter((k) => k.col !== col)
  const old = (layout.sort ?? []).findIndex((k) => k.col === col)
  let sort: SortKey[]
  if (dir === null) sort = rest
  else if (!add) sort = [{ col, dir }]
  else if (old < 0) sort = [...rest, { col, dir }]
  else sort = (layout.sort ?? []).map((k) => (k.col === col ? { col, dir } : k))
  const { sort: _, ...bare } = layout
  return { ...bare, ...sortProps(sort, undefined) }
}

// Replaces the whole sort (the phone sheet edits its keys as a list); malformed or repeated keys drop.
export function setSortKeys(layout: Layout, keys: SortKey[]): Layout {
  const { sort: _, ...bare } = layout
  return { ...bare, ...sortProps(cleanSort(keys), undefined) }
}

// Sets the filter on a column; null removes it.
export function setFilter(layout: Layout, col: string, f: ColFilter | null): Layout {
  const filters = { ...layout.filters }
  if (f) filters[col] = f
  else delete filters[col]
  const { filters: _, ...bare } = layout
  return { ...bare, ...sortProps(undefined, filters) }
}

// Turns a quick filter on or off.
export function setQuick(layout: Layout, id: QuickId): Layout {
  const { quick: _, ...bare } = layout
  return { ...bare, ...quickProp(toggleQuick(layout.quick, id)) }
}

// Removes every column filter and quick filter; the sort stays.
export function clearFilters(layout: Layout): Layout {
  const { filters: _, quick: __, ...bare } = layout
  return bare
}

export function emptyStore(ids: string[]): ViewStore {
  return { views: [], current: '', layout: defaultLayout(ids), show: 'open' }
}

// Every column in registry order where the visible ones keep their order, so a hidden column
// shown again returns to where the registry puts it. The Columns menu lists this order.
export function fullOrder(cols: string[], ids: string[]): string[] {
  const out = cols.slice()
  for (const id of ids) {
    if (out.includes(id)) continue
    const at = out.findIndex((x) => ids.indexOf(x) > ids.indexOf(id))
    out.splice(at < 0 ? out.length : at, 0, id)
  }
  return out
}

// Keeps `work` first, renames old ids, drops unknown and repeated ids.
function tidyCols(cols: string[], ids: string[]): string[] {
  const seen = new Set<string>()
  const body = cols.flatMap((id) => RENAMED[id] ?? [id]).filter((id) => ids.includes(id) && !LOCKED.includes(id) && !seen.has(id) && seen.add(id))
  return [...(ids.includes('work') ? ['work'] : []), ...body]
}

export function setShown(layout: Layout, ids: string[], id: string, shown: boolean): Layout {
  if (LOCKED.includes(id)) return layout
  const want = new Set(layout.cols)
  if (shown) want.add(id)
  else want.delete(id)
  // Keeps the registry order for the rest and the visible order the user chose.
  const cols = fullOrder(layout.cols, ids).filter((x) => want.has(x))
  return { ...layout, cols: tidyCols(cols, ids) }
}

// Moves a visible, movable column to `index` among the visible columns (0 is the first
// column; `work` stays at 0).
export function moveTo(layout: Layout, ids: string[], id: string, index: number): Layout {
  if (LOCKED.includes(id) || !layout.cols.includes(id)) return layout
  const rest = layout.cols.filter((x) => x !== id)
  const at = Math.min(rest.length, Math.max(1, index))
  rest.splice(at, 0, id)
  return { ...layout, cols: tidyCols(rest, ids) }
}

export function moveBy(layout: Layout, ids: string[], id: string, delta: number): Layout {
  const from = layout.cols.indexOf(id)
  return from < 0 ? layout : moveTo(layout, ids, id, from + delta)
}

export function setWidth(layout: Layout, id: string, px: number | null): Layout {
  const widths = { ...layout.widths }
  if (px === null) delete widths[id]
  else widths[id] = clampWidth(px)
  return { ...layout, widths }
}

// What settings hold for the Work table, one entry per key. 'work' is the working layout (its
// current view, columns, grouping, filter); each saved view is an entry under its own id, so two
// pages that change different views both keep theirs. Widths stay on this device.
export interface StoredEntry { name?: string; current?: string; show: Show; cols: string[]; group: Group; groupBy?: string; seen?: string[]; sort?: SortKey[]; filters?: Record<string, ColFilter>; quick?: QuickId[] }
// Widths per view, this device only: '' is the Default layout's working widths.
type Widths = Record<string, Record<string, number>>
const WORK = 'work'

const work = settingsRecord<StoredEntry>({
  field: 'workViews',
  legacy: VIEWS_KEY,
  clean: cleanEntry,
  // The browser's old copy is one whole store, widths and all: its layout, then each view by id.
  fromLegacy: (raw) => entriesOf(raw as Record<string, unknown>, legacyShow()),
  // The widths move in independently: a device that already has widths keeps them.
  migrated: (raw) => { if (raw && typeof raw === 'object' && !hasWidths()) saveWidths(widthsOf(raw as Record<string, unknown>)) },
})
export const loadWork = work.load

function strings(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((c): c is string => typeof c === 'string') : []
}

// Shape only, with the keys in one fixed order; the columns are checked against the registry in fromStored.
function cleanEntry(x: unknown): StoredEntry {
  const r = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
  const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 40) : undefined
  return {
    ...(name !== undefined ? { name } : {}),
    ...(typeof r.current === 'string' ? { current: r.current } : {}),
    show: r.show === 'all' ? 'all' : 'open',
    cols: strings(r.cols),
    ...cleanGroup(r.group, r.groupBy),
    ...seenProp(strings(r.seen)),
    ...sortProps(cleanSort(r.sort), cleanFilters(r.filters)),
    ...quickProp(r.quick),
  }
}

// The stored grouping: a known mode, and for a column grouping its column; one with none is the issue tree.
function cleanGroup(group: unknown, by: unknown): { group: Group; groupBy?: string } {
  const g = GROUPS.includes(group as Group) ? group as Group : 'issues'
  return g === 'column' && !groupProp(g, by).groupBy ? { group: 'issues' } : { group: g, ...groupProp(g, by) }
}

// The open/all filter the browser kept beside its copy (in the Work page's own prefs).
function legacyShow(): Show {
  try { return JSON.parse(localStorage.getItem('stam/work') ?? '{}').show === 'all' ? 'all' : 'open' } catch { return 'open' }
}

// The widths in an old browser copy, by view.
function widthsOf(raw: Record<string, unknown>): Widths {
  const out: Widths = { '': (raw.layout as { widths?: Record<string, number> } | undefined)?.widths ?? {} }
  if (Array.isArray(raw.views)) for (const v of raw.views as { id?: unknown; widths?: Record<string, number> }[]) {
    if (typeof v.id === 'string') out[v.id] = v.widths ?? {}
  }
  return out
}

function loadWidths(): Widths {
  try {
    const raw = JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? '{}')
    return raw && typeof raw === 'object' ? raw as Widths : {}
  } catch { return {} }
}

function hasWidths(): boolean {
  try { return localStorage.getItem(WIDTHS_KEY) !== null } catch { return true }
}

function saveWidths(w: Widths) {
  try { localStorage.setItem(WIDTHS_KEY, JSON.stringify(w)) } catch {}
}

// A layout with only known columns (work first) and clamped widths.
function cleanLayout(l: Layout, ids: string[]): Layout {
  return { cols: tidyCols(l.cols, ids), group: l.group, ...groupProp(l.group, l.groupBy), widths: cleanWidths(l.widths, ids), ...seenProp(l.seen ?? []), ...sortProps(cleanSort(l.sort, ids), cleanFilters(l.filters, ids)), ...quickProp(l.quick) }
}

// The widths a layout keeps: only known columns, clamped.
function cleanWidths(raw: Record<string, number> | undefined, ids: string[]): Record<string, number> {
  const widths: Record<string, number> = {}
  for (const [id, px] of Object.entries(raw ?? {})) {
    if (ids.includes(id) && typeof px === 'number' && Number.isFinite(px)) widths[id] = clampWidth(px)
  }
  return widths
}

// An old browser copy (widths included) as the settings entries: the layout, then each view by id.
function entriesOf(raw: Record<string, unknown>, show: Show): Record<string, StoredEntry> {
  const layout = (raw.layout ?? {}) as Record<string, unknown>
  const out: Record<string, StoredEntry> = {}
  const views = Array.isArray(raw.views) ? raw.views as Record<string, unknown>[] : []
  const valid = views.filter((v) => v && typeof v.id === 'string' && v.id !== WORK && typeof v.name === 'string' && v.name.trim())
  for (const v of valid) out[v.id as string] = cleanEntry({ name: v.name, show: v.show, cols: v.cols, group: v.group })
  const current = typeof raw.current === 'string' && valid.some((v) => v.id === raw.current) ? raw.current : ''
  out[WORK] = cleanEntry({ current, show, cols: layout.cols, group: layout.group })
  return out
}

// The store the settings entries and this device's widths make, with unknown columns dropped.
function fromEntries(all: Record<string, StoredEntry>, ids: string[], w: Widths): ViewStore {
  const st = all[WORK]
  const views: SavedView[] = Object.entries(all)
    .filter(([id, e]) => id !== WORK && e.name)
    .map(([id, e]) => ({ id, name: e.name!, show: e.show, ...settle(e.cols, e.seen, ids), group: e.group, ...groupProp(e.group, e.groupBy), widths: cleanWidths(w[id], ids), ...sortProps(cleanSort(e.sort, ids), cleanFilters(e.filters, ids)), ...quickProp(e.quick) }))
  const current = views.some((v) => v.id === st?.current) ? st!.current! : ''
  const layout: Layout = st ? { ...settle(st.cols, st.seen, ids), group: st.group, ...groupProp(st.group, st.groupBy), widths: cleanWidths(w[''], ids), ...sortProps(cleanSort(st.sort, ids), cleanFilters(st.filters, ids)), ...quickProp(st.quick) } : { ...defaultLayout(ids), widths: cleanWidths(w[''], ids) }
  return { views, current, layout, show: st?.show ?? 'open' }
}

// Reads the store from settings as this page has it (empty before the first load), with this device's widths.
export function loadStore(ids: string[]): ViewStore {
  return fromEntries(work.all(), ids, loadWidths())
}

// Saves the store: each view and the working layout to settings, the widths to this device. A
// view that is gone is deleted from settings; a view that didn't change sends nothing.
// What a save writes of the field columns follows one rule: it never drops or adds a `field:` id, a
// seen entry or a width the page doesn't know (`ids` is the registry it has: a field list that may be
// missing, stale, or new). Those pass through as stored, a column at its stored place. Only a layout
// settled against a loaded field list (`settled`, the page's own reload of the fields) writes the
// fields as they are: that is what reveals a new field and drops a removed one.
function passThrough(e: StoredEntry, old: StoredEntry | undefined, ids: string[]): StoredEntry {
  if (!old) return e
  const known = new Set(ids)
  const cols = e.cols.slice()
  old.cols.forEach((c, i) => {
    if (!isFieldCol(c) || known.has(c) || cols.includes(c)) return
    const prev = old.cols.slice(0, i).reverse().find((x) => cols.includes(x))
    cols.splice(prev ? cols.indexOf(prev) + 1 : cols.length, 0, c)
  })
  const mine = e.seen ?? []
  const seen = [...mine, ...(old.seen ?? []).filter((f) => !known.has('field:' + f) && !mine.includes(f))]
  // A sort key or filter on a field column the page doesn't know stays too.
  const lost = (c: string) => isFieldCol(c) && !known.has(c)
  // Its sort key stays only while the edit kept every known key the old sort had: a replace-sort
  // that dropped one is a new sort, and takes no hidden second key. With only unknown keys before,
  // an add and a replace look the same, so the key stays: the safe side.
  const kept = (old.sort ?? []).filter((k) => !lost(k.col)).every((k) => (e.sort ?? []).some((x) => x.col === k.col))
  const sort = [...(e.sort ?? []), ...(kept ? (old.sort ?? []).filter((k) => lost(k.col) && !(e.sort ?? []).some((x) => x.col === k.col)) : [])]
  const filters = { ...Object.fromEntries(Object.entries(old.filters ?? {}).filter(([c]) => lost(c))), ...e.filters }
  return cleanEntry({ ...e, cols, seen, sort, filters })
}

// Saves the store: each view and the working layout to settings, the widths to this device. A
// view that is gone is deleted from settings; a view that didn't change sends nothing. `ids` is
// the page's registry, for what passes through (see above); without it everything is written as is.
export function saveStore(store: ViewStore, ids?: string[], settled = false) {
  // A view with no stored entry yet (a new one) takes what passes through from the working layout.
  const entry = (id: string, e: StoredEntry) => (ids && !settled ? passThrough(e, work.all()[id] ?? work.all()[WORK], ids) : e)
  work.save(WORK, entry(WORK, cleanEntry({ current: store.current, show: store.show, cols: store.layout.cols, group: store.layout.group, groupBy: store.layout.groupBy, seen: store.layout.seen, sort: store.layout.sort, filters: store.layout.filters, quick: store.layout.quick })))
  for (const v of store.views) work.save(v.id, entry(v.id, cleanEntry({ name: v.name, show: v.show, cols: v.cols, group: v.group, groupBy: v.groupBy, seen: v.seen, sort: v.sort, filters: v.filters, quick: v.quick })))
  const keep = new Set(store.views.map((v) => v.id))
  for (const id of Object.keys(work.all())) if (id !== WORK && !keep.has(id)) work.remove(id)
  saveWidthsOf(store, ids, settled)
}

// Saves only this device's widths: a resize changes nothing in settings. A field column's width the
// page doesn't know stays (see passThrough).
export function saveWidthsOf(store: ViewStore, ids?: string[], settled = false) {
  const now: Widths = { '': store.layout.widths, ...Object.fromEntries(store.views.map((v) => [v.id, v.widths])) }
  if (ids && !settled) {
    const old = loadWidths()
    for (const [id, w] of Object.entries(now)) {
      const lost = Object.entries(old[id] ?? old[''] ?? {}).filter(([c]) => isFieldCol(c) && !ids.includes(c) && !(c in w))
      now[id] = { ...w, ...Object.fromEntries(lost) }
    }
  }
  saveWidths(now)
}

// Saves the working layout as a new view, and makes it current.
export function saveAs(store: ViewStore, name: string, show: Show, ids: string[], newId = `v${Date.now().toString(36)}`): ViewStore {
  const clean = name.trim().slice(0, 40)
  if (!clean) return store
  const view: SavedView = { ...cleanLayout(store.layout, ids), id: newId, name: clean, show }
  return { ...store, views: [...store.views, view], current: newId }
}

// Makes a view current: Default (id '') resets the layout, a saved view copies its own.
export function useView(store: ViewStore, id: string, ids: string[]): ViewStore {
  if (!id) return { ...store, current: '', layout: defaultLayout(ids) }
  const v = store.views.find((x) => x.id === id)
  if (!v) return store
  return { ...store, current: id, layout: { cols: v.cols.slice(), widths: { ...v.widths }, group: v.group, ...groupProp(v.group, v.groupBy), seen: v.seen, ...sortProps(v.sort?.slice(), v.filters && { ...v.filters }), ...quickProp(v.quick) } }
}

// Deletes a saved view; if it was current, the layout falls back to Default.
export function deleteView(store: ViewStore, id: string, ids: string[]): ViewStore {
  const views = store.views.filter((v) => v.id !== id)
  if (store.current !== id) return { ...store, views }
  return { ...store, views, current: '', layout: defaultLayout(ids) }
}

// What the current view was saved as: the saved view, or the default layout (shown 'open') for Default.
function baseline(store: ViewStore, ids: string[]): { layout: Layout; show: Show } {
  const v = store.current ? store.views.find((x) => x.id === store.current) : undefined
  if (!v) return { layout: defaultLayout(ids), show: 'open' }
  return { layout: cleanLayout(v, ids), show: v.show }
}

// A layout's own state as a string, with object keys sorted: widths and the seen list stay out, so
// resizing a column or a new field doesn't mark a view edited.
const stable = (x: unknown): string => JSON.stringify(x, (_, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v))
// The order a checklist's values were ticked in isn't state: sorted. (cleanLayout already puts the quick filters in their own order.)
const filtersShape = (f: Record<string, ColFilter> | undefined) => Object.fromEntries(Object.entries(f ?? {}).map(([c, x]) => [c, x.kind === 'values' ? { ...x, ...(x.values ? { values: x.values.slice().sort() } : {}), ...(x.not ? { not: x.not.slice().sort() } : {}) } : x]))
const shape = (l: Layout, show: Show) => stable({ cols: l.cols, group: l.group, groupBy: l.group === 'column' ? l.groupBy : null, show, sort: l.sort ?? [], filters: filtersShape(l.filters), quick: l.quick ?? [] })

// Whether the working layout differs from what the current view was saved as: its columns, grouping,
// open/all filter, sort, filters or quick filters.
export function isDirty(store: ViewStore, ids: string[]): boolean {
  const b = baseline(store, ids)
  return shape(cleanLayout(store.layout, ids), store.show) !== shape(b.layout, b.show)
}

// Overwrites the current saved view with the working layout. Default has nothing to overwrite.
export function saveView(store: ViewStore, ids: string[]): ViewStore {
  if (!store.current) return store
  const layout = cleanLayout(store.layout, ids)
  return { ...store, views: store.views.map((v) => (v.id === store.current ? { ...layout, id: v.id, name: v.name, show: store.show } : v)) }
}

// Drops the unsaved edits: the working layout goes back to the current view (or Default).
export function revertView(store: ViewStore, ids: string[]): ViewStore {
  return { ...useView(store, store.current, ids), show: baseline(store, ids).show }
}
