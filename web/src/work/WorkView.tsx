// The Work page (world `w:work`, view key `work`): every open ITSA in one table, grouped by
// issue tree (or by agent tree, or flat: the Group control), under a pinned "Needs you" group. The group holds one row per thing waiting on
// the human (an ITSA in a human status, a pending permission request, an agent's human wait)
// and each ready_to_merge ITSA in the merge queue, oldest first. Both sections share the one
// sticky column header and the one column registry, so the columns line up throughout; the
// group itself has no fold control, so it can't be collapsed away. A group below is a root,
// folded or not (remembered per browser); its rows are the descendants, indented by depth. The
// page is an overview, not a place to act (S-363): a row opens the ITSA's world, where its
// actions are; an agent in a row opens the agent's; a group's key opens its root; a link opens
// in a new tab. On a phone, or below CARD_BELOW, the page
// is a glance instead (Glance.tsx): what needs the human, then what is moving, then what is
// ready to try, with none of the table's controls.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Icon } from '../Icon'
import { fieldIdOf, workColumnIds } from '../itsa/fields'
import { isClosed, openItsa, statusInfo, StatusGlyph } from '../itsa/itsa'
import { useWaiting } from '../itsa/WaitingList'
import { isPhone, registerView, useShell } from '../shell/layout'
import { refreshItsas, useData } from '../store'
import { HarnessMark } from '../spawn'
import { hideMenu, showMenu, showPopover, type MenuItem } from '../ui/menu'
import { CARD_BELOW, WORK_COLUMNS, type CellContext, type WorkColumn } from './columns'
import { nextTick, refreshFields, useWorkExtras } from './data'
import { fieldColumns, withFieldFit } from './field-columns'
import { attentionItsaIds, needsRows, type NeedsRow } from './needs'
import { openNeeds } from './openNeeds'
import { Glance, type GlanceFilter } from './Glance'
import { totalCell, totalLine, workTotals } from './totals'
import { foldRows, GROUPS, groupable, groupFor, pruneFolded, STANDALONE, UNOWNED, type Group, type WorkGroup, type WorkRow } from './model'
import { HeaderMenuBody, optionsFor, publishHeader, type HeaderLive } from './header-menu'
import { showCellMenu } from './cell-menu'
import { filterText } from './filter-editors'
import { ColumnsPanel } from './columns-menu'
import { clearFilters, defaultLayout, deleteView, fullOrder, isDirty, LOCKED, loadStore, loadWork, moveBy, moveTo, revertView, saveAs, saveStore, saveView, saveWidthsOf, setFilter, setGroup, setQuick, setShown, setSort, setWidth, useView, type ViewStore } from './views'
import { QuickBar } from './quick-bar'
import { ViewTabs } from './view-tabs'
import type { StatusLookup } from './quick'
import { Loading, StamLoader } from '../Loading'

// The rough px a registry track takes. A resized column's width beyond it counts against the
// pane when the table decides which columns fit.
const RESIZE_REF_PX = 120
// Pointer travel (px) before a header press becomes a drag, so a click stays a click.
const DRAG_START = 4
const BUILTIN_COLS = WORK_COLUMNS.map((c) => c.id)
// Dispatched on window after Settings saves the shared layout or the fields (S-364): an open Work page reloads, so it never overwrites it.
export const WORK_LAYOUT_EVENT = 'stam:work-layout'
const GROUP_LABEL: Record<Group, string> = { issues: 'Issues', agents: 'Agents', flat: 'Flat', column: 'By column…' }
// The modes the radio buttons set; a column grouping has its own button, since it needs a column.
const PLAIN_GROUPS = GROUPS.filter((g) => g !== 'column')
// A group's fold key: the issue grouping keeps its bare ids (folds saved before the other
// modes), and the others prefix theirs, so no two modes share one.
const foldKey = (mode: Group, id: string) => mode === 'issues' ? id : `${mode}:${id}`
// A row's fold key (S-1437): one fold model, in the same `folded` map as the groups'; the `row:` prefix keeps it apart.
const rowKey = (mode: Group, id: string) => `row:${mode}:${id}`
// The fold on a row of the Work cell: its disclosure chevron (when it has subrows) and how many rows it hides.
interface RowFold { kids: number; open: boolean; hidden: number; label: string; toggle: () => void }
// A row that has nothing to fold, in a table that folds: it only keeps the chevron's slot.
const NO_FOLD: RowFold = { kids: 0, open: true, hidden: 0, label: '', toggle: () => {} }

// Which groups are folded: this device's, since a fold is how this screen is laid out here.
// The views (columns, grouping, the open/all filter) are in settings (views.ts).
interface Prefs { folded: Record<string, boolean> }
const PREFS = 'stam/work'
function loadPrefs(): Prefs {
  try { return { folded: JSON.parse(localStorage.getItem(PREFS) ?? '{}').folded ?? {} } } catch { return { folded: {} } }
}
function savePrefs(p: Prefs) { try { localStorage.setItem(PREFS, JSON.stringify(p)) } catch {} }

// The page's one stack for loading, empty, and error: eyebrow, heading, body, one action.
function Stack({ eyebrow, title, body, action }: { eyebrow?: ReactNode; title: string; body: string; action?: ReactNode }) {
  return <div className="empty-pane work-empty">{eyebrow}<h3>{title}</h3><p>{body}</p>{action}</div>
}

// The Save-as form in the View menu's popover: a name, typed inline, not a browser prompt.
function SaveView({ onSave, onCancel }: { onSave: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  return <form className="w-save" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSave(name) }}>
    <label className="w-save-label">Name for this view
      <input autoFocus value={name} maxLength={40} autoComplete="off" onChange={(e) => setName(e.target.value)} /></label>
    <div className="w-save-actions">
      <button type="button" className="btn text" onClick={onCancel}>Cancel</button>
      <button type="submit" className="btn primary" disabled={!name.trim()}>Save view</button>
    </div>
  </form>
}

// `onMenu` is a right-click on a cell (S-1518): it opens the cell's filter menu and returns whether it did.
type CellMenu = (e: React.MouseEvent, col: WorkColumn, row: WorkRow) => boolean
// `fold` is set in the issue tree: a row with subrows gets a chevron before its title, one without a spacer of the
// same width, so the keys line up. The chevron's click and keys stay its own (they never open the row).
function Cells({ row, cols, cx, onMenu, fold }: { row: WorkRow; cols: WorkColumn[]; cx: CellContext; onMenu?: CellMenu; fold?: RowFold }) {
  return <>{cols.map((c) => (
    <div key={c.id} role="cell" className={`w-cell wc-${c.id}` + (c.align === 'end' ? ' end' : '')} data-cell={c.id}
      onContextMenu={onMenu ? (e) => { if (onMenu(e, c, row)) e.preventDefault() } : undefined}
      style={c.id === 'work' ? { '--depth': row.depth } as CSSProperties : undefined}>
      {c.id === 'work' && fold ? <div className="w-fold">
        {fold.kids ? <button type="button" className="w-rowtoggle" data-fold={fold.open ? 'open' : 'folded'} aria-expanded={fold.open} aria-label={fold.label}
          onClick={(e) => { e.stopPropagation(); fold.toggle() }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation() }}>
          <span className={'chev' + (fold.open ? ' open' : '')}><Icon name="chevron-right" size="xs" /></span></button>
          : <span className="w-rowtoggle spacer" aria-hidden="true" />}
        <div className="w-foldbody">{c.render(row, cx)}</div>
        {fold.hidden ? <span className="count w-hidden" data-hidden title={`${fold.hidden} hidden`} aria-label={`${fold.hidden} hidden`}>{fold.hidden}</span> : null}
      </div> : c.render(row, cx)}</div>))}</>
}

// The pinned group: its head carries a warning mark and, when it has rows, the count; its rows
// wear the Work columns and it has no fold control, so it
// can't be collapsed away. Empty, it is one muted line; until your mail and the agents have loaded, the loading mark
// instead (and until the agents, whose waits feed it), so it never says "Nothing needs you" too early.
const needsWork = (n: NeedsRow): WorkRow => ({ it: n.it, depth: 0, context: false })
function NeedsGroup({ rows, cols, cx, loading = false, spacer }: { rows: NeedsRow[]; cols: WorkColumn[]; cx: CellContext; loading?: boolean; spacer?: RowFold }) {
  return <div role="rowgroup" className={'w-group w-needs' + (rows.length ? '' : ' empty')} data-group="needs">
    <div role="row" className="w-ghead w-needs-head">
      <span className="w-needs-mark" aria-hidden="true"><Icon name="shield-alert" size="xs" /></span>
      {rows.length ? <><span className="w-gname">Needs you</span><span className="count" data-needs-count>{rows.length}</span></> : loading ? <span className="w-gname muted" role="status" aria-label="Loading what needs you"><StamLoader /></span> : <span className="w-gname muted">Nothing needs you</span>}
    </div>
    {rows.map((n) => (
      <div key={n.key} role="row" tabIndex={0} className="w-row w-need" data-need={n.key} data-kind={n.kind}
        aria-label={`${n.it.key ? n.it.key + ' ' : ''}${n.it.title}`}
        onClick={() => openNeeds(n)}
        onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openNeeds(n) } }}>
        <Cells row={needsWork(n)} cols={cols} cx={cx} fold={spacer} />
      </div>))}
  </div>
}

// The sticky last row: the shown columns' counts and sums (totals.ts); a column with nothing to sum is blank.
function TotalsRow({ cols, totals }: { cols: WorkColumn[]; totals: ReturnType<typeof workTotals> }) {
  return <div role="rowgroup" className="w-footgroup"><div role="row" className="w-foot" data-totals>{cols.map((c) => (
    <div key={c.id} role="cell" className={`w-cell wc-${c.id}` + (c.align === 'end' ? ' end' : '')} data-total={c.id}>{totalCell(c.id, totals)}</div>))}</div></div>
}

export function WorkView({ viewKey }: { viewKey: string }) {
  const { itsas, itsaStatuses, itsaError, queue, agents, loaded: storeLoaded } = useData()
  useShell()
  const waiting = useWaiting()
  const phone = isPhone()
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs)
  const setPrefs = (p: Partial<Prefs>) => setPrefsState((cur) => { const n = { ...cur, ...p }; savePrefs(n); return n })
  // Folds kept for agents that are gone are dropped, once the agents have loaded.
  useEffect(() => {
    if (!storeLoaded.agents) return
    const next = pruneFolded(prefs.folded, new Set(agents.map((a) => a.id)), storeLoaded.itsas && !itsaError ? new Set(itsas.map((x) => x.id)) : undefined)
    if (next !== prefs.folded) setPrefs({ folded: next })
  }, [storeLoaded.agents, storeLoaded.itsas, itsas, itsaError, agents, prefs.folded]) // eslint-disable-line react-hooks/exhaustive-deps
  const [text, setText] = useState('')
  const [now, setNow] = useState(Date.now())
  const root = useRef<HTMLDivElement>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const extras = useWorkExtras()
  // The columns: the built-ins, then one per ITSA field (S-369), the ids the layout is checked against.
  const fields = extras.fields
  const { ALL_COLS, COL_BY_ID, SEARCH_COLS } = useMemo(() => {
    const custom = fieldColumns(fields ?? [])
    const all = [...WORK_COLUMNS, ...custom]
    return { ALL_COLS: workColumnIds(BUILTIN_COLS, fields ?? []), COL_BY_ID: new Map(all.map((c) => [c.id, c])), SEARCH_COLS: all }
  }, [fields])
  const idsRef = useRef(ALL_COLS)
  idsRef.current = ALL_COLS
  // The working layout and the saved views. Nothing is saved until the stored views have loaded and
  // the fields have loaded or failed: before then the layout is only the default (or lacks the field
  // columns), and saving it would replace the stored one, widths included. An edit made meanwhile
  // shows at once and is kept in `pending`, then replayed on the loaded layout with the columns as
  // they are by then (an edit gets the current ids, never a closure's) and saved. A save also keeps
  // the stored field columns, seen entries and widths the page doesn't know (views.ts saveStore).
  const [store, setStoreState] = useState<ViewStore>(() => loadStore(ALL_COLS))
  const loaded = useRef(false)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  // The tick the stored views were read at: only a fields read that started after it is fresh.
  const readAt = useRef(Infinity)
  const fieldsRef = useRef(fields)
  fieldsRef.current = fields
  const failedRef = useRef(extras.fieldsFailed)
  failedRef.current = extras.fieldsFailed
  type Edit = (s: ViewStore, ids: string[]) => ViewStore
  const pending = useRef<Edit[]>([])
  const ready = () => loaded.current && (!!fieldsRef.current || failedRef.current)
  const edit = (fn: Edit) => {
    const now = ready()
    if (!now) pending.current.push(fn)
    setStoreState((cur) => { const n = fn(cur, idsRef.current); if (now) saveStore(n, idsRef.current); return n })
  }
  // A width is this device's only: it never reaches settings.
  const editWidths = (fn: Edit) => {
    const now = ready()
    if (!now) pending.current.push(fn)
    setStoreState((cur) => { const n = fn(cur, idsRef.current); if (now) saveWidthsOf(n, idsRef.current); return n })
  }
  // The views come from settings; this page shows what it had until they load.
  useEffect(() => { loadWork().then(() => { loaded.current = true; readAt.current = nextTick(); void refreshFields(); setSettingsLoaded(true); if (!fieldsRef.current) setStoreState(loadStore(idsRef.current)) }).catch(() => {}) }, [])
  // Both loads are in, or the fields changed (added, removed): the stored layout for the current
  // columns, where a new field shows and a removed one drops, with the edits made meanwhile, saved.
  const failed = extras.fieldsFailed
  // Settled: the fields are from a read that started after the stored layout was read, not a cached list.
  const fresh = !!fields && extras.fieldsStart > readAt.current
  useEffect(() => {
    if (!settingsLoaded || !(fields || failed)) return
    const ids = idsRef.current
    const next = pending.current.splice(0).reduce((s, fn) => fn(s, ids), loadStore(ids))
    setStoreState(next)
    saveStore(next, ids, fresh)
  }, [ALL_COLS, settingsLoaded, failed, fresh]) // eslint-disable-line react-hooks/exhaustive-deps
  // Settings saved the layout or the fields: reload, so this page doesn't write its old copy back.
  useEffect(() => {
    // The stored layout is read again: only a fields read that starts after this may settle against it.
    const onSaved = () => { setStoreState(loadStore(idsRef.current)); readAt.current = nextTick(); void refreshFields() }
    window.addEventListener(WORK_LAYOUT_EVENT, onSaved)
    return () => window.removeEventListener(WORK_LAYOUT_EVENT, onSaved)
  }, [])
  const layout = store.layout
  // A column grouping whose column is gone, or can't group, shows the issue tree (model.ts groupFor).
  const groupCol = layout.group === 'column' ? COL_BY_ID.get(layout.groupBy ?? '') : undefined
  const mode: Group = layout.group === 'column' && !groupable(groupCol) ? 'issues' : layout.group
  // Only the issue tree folds its rows (S-1437): in the agent tree the rows under an ITSA aren't its own.
  const tree = mode === 'issues'
  // A header press that is mid-drag: the column, the drop slot (before the k-th table column),
  // and where the indicator sits.
  // A press that moved (a reorder or a resize) is not a click: the click that follows it doesn't sort.
  const moved = useRef(false)
  const [drop, setDrop] = useState<{ id: string; k: number; left: number } | null>(null)
  useEffect(() => registerView(viewKey, { focus: () => root.current?.querySelector<HTMLElement>('.w-row, .w-filter input')?.focus() }), [viewKey])
  // The times stay true between polls.
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t) }, [])

  // Columns with a `hideBelow` drop out of the grid as the window narrows (columns.tsx).
  // The pane's width, measured on the page's root: a sidebar or a split narrows it too.
  const [pane, setPane] = useState(() => window.innerWidth)
  useEffect(() => {
    const el = root.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setPane(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // Below CARD_BELOW the pane shows the glance, as a phone does; wider, columns drop as they narrow.
  const glanced = phone || pane < CARD_BELOW
  // The columns the user shows, in their order. A column drops from the table by `hideBelow`
  // (a resized column's extra width counts toward the fit).
  const shown = withFieldFit(layout.cols.map((id) => COL_BY_ID.get(id)).filter((c): c is WorkColumn => !!c), fields ?? [])
  const extra = layout.cols.reduce((n, id) => layout.widths[id] !== undefined ? n + layout.widths[id] - RESIZE_REF_PX : n, 0)
  // The shown fields in the layout's order, for the phone's cards.
  const shownFields = layout.cols.map(fieldIdOf).flatMap((id) => (id ? (fields ?? []).filter((f) => f.id === id) : []))
  const tableCols = shown.filter((c) => !c.hideBelow || pane - extra >= c.hideBelow)
  const cols = tableCols
  const cx: CellContext = { now, extras }
  // A resized column takes its px as the user set it; the rest keep their registry track.
  // This is the one place a px value reaches the grid: it is the user's width, not a design value.
  // A track never grows the table past its pane: it can shrink to --size-work-col-min and its cell truncates (S-1437).
  const track = (c: WorkColumn) => layout.widths[c.id] !== undefined ? `minmax(var(--size-work-col-min), ${layout.widths[c.id]}px)` : c.width.startsWith('minmax(') ? c.width : `minmax(var(--size-work-col-min), ${c.width})`

  const apply = (id: string) => {
    edit((s, ids) => ({ ...useView(s, id, ids), show: s.views.find((x) => x.id === id)?.show ?? 'open' }))
  }
  // Whether the working layout was edited after the current view was saved. Not before the columns are known.
  const dirty = settingsLoaded && !!(fields || failed) && isDirty(store, ALL_COLS)
  const curName = store.views.find((v) => v.id === store.current)?.name ?? 'Default'
  const columnsMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const choices = fullOrder(layout.cols, ALL_COLS).map((id) => ({ id, label: COL_BY_ID.get(id)?.label ?? id, on: layout.cols.includes(id), locked: LOCKED.includes(id) }))
    showPopover(r.left, r.bottom + 4, 'Columns', <ColumnsPanel cols={choices}
      onToggle={(id, on) => { hideMenu(true); edit((s, ids) => ({ ...s, layout: setShown(s.layout, ids, id, on) })) }}
      onReset={() => { hideMenu(); edit((s, ids) => ({ ...s, layout: defaultLayout(ids) })) }} />, e.currentTarget)
  }
  // "By column…": the columns that can group, the current one ticked. Any registered column, shown or not.
  const groupMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const items: MenuItem[] = SEARCH_COLS.filter((c) => groupable(c)).map((c) => ({
      label: c.label, checked: mode === 'column' && layout.groupBy === c.id,
      action: () => edit((s) => ({ ...s, layout: setGroup(s.layout, 'column', c.id) })) }))
    showMenu(r.left, r.bottom + 4, items, e.currentTarget)
  }
  const viewMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    const trigger = e.currentTarget
    const r = trigger.getBoundingClientRect()
    const cur = store.current
    // A view picked from the menu leaves focus on the button that opened it.
    const pick = (id: string) => () => { if (id !== cur) apply(id); trigger.focus() }
    const items: MenuItem[] = [
      { label: 'Default', checked: cur === '', action: pick('') },
      ...store.views.map((v) => ({ label: v.name, checked: cur === v.id, action: pick(v.id) })),
      'sep',
      { label: 'Save', disabled: cur === '' || !dirty, title: cur === '' ? 'Default can\'t be overwritten: use Save as' : undefined, action: () => { edit((s, ids) => saveView(s, ids)); trigger.focus() } },
      { label: 'Revert', disabled: !dirty, action: () => { edit((s, ids) => revertView(s, ids)); trigger.focus() } },
      { label: 'Save as…', action: (m: DOMRect) => showPopover(m.left, m.bottom + 4, 'Save view', <SaveView
        onCancel={() => hideMenu(true)}
        onSave={(name) => { hideMenu(true); edit((s, ids) => saveAs(s, name, s.show, ids)) }} />, trigger) },
      { label: 'Delete', danger: true, disabled: cur === '', action: () => edit((s, ids) => deleteView(s, s.current, ids)) },
    ]
    showMenu(r.left, r.bottom + 4, items, e.currentTarget)
  }

  // Header drag: a press that moves past DRAG_START starts a reorder; the drop slot is the
  // table column whose middle the pointer has not yet passed. `work` doesn't move.
  const reorderStart = (e: React.PointerEvent<HTMLDivElement>, id: string) => {
    if (e.button !== 0 || LOCKED.includes(id)) return
    const x0 = e.clientX
    let active = false
    let at = -1
    const heads = () => [...(headRef.current?.querySelectorAll<HTMLElement>('[role=columnheader]') ?? [])]
    const move = (ev: PointerEvent) => {
      if (!active) { if (Math.abs(ev.clientX - x0) < DRAG_START) return; active = true; moved.current = true }
      const hs = heads()
      if (!hs.length) return
      at = hs.findIndex((h) => { const r = h.getBoundingClientRect(); return ev.clientX < r.left + r.width / 2 })
      if (at < 0) at = hs.length
      const rowLeft = headRef.current!.getBoundingClientRect().left
      const edge = at < hs.length ? hs[at].getBoundingClientRect().left : hs[hs.length - 1].getBoundingClientRect().right
      setDrop({ id, k: at, left: edge - rowLeft })
    }
    const up = () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      removeEventListener('pointercancel', up)
      setDrop(null)
      if (!active || at < 0) return
      const target = heads()[at]?.dataset.col
      if (target === id) return
      const rest = layout.cols.filter((x) => x !== id)
      const index = target ? rest.indexOf(target) : rest.length
      if (index >= 0) edit((s, ids) => ({ ...s, layout: moveTo(s.layout, ids, id, index) }))
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    addEventListener('pointercancel', up)
  }
  // A header's right edge: drag to set its width (clamped in setWidth); a double-click resets
  // it to the registry width. Only a move writes, so a click on the edge changes nothing.
  const resizeStart = (e: React.PointerEvent<HTMLSpanElement>, id: string) => {
    e.stopPropagation()
    if (e.button !== 0) return
    const x0 = e.clientX
    const w0 = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect().width
    const move = (ev: PointerEvent) => {
      if (ev.clientX === x0) return
      moved.current = true
      editWidths((s) => ({ ...s, layout: setWidth(s.layout, id, w0 + ev.clientX - x0) }))
    }
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up) }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    addEventListener('pointercancel', up)
  }
  // A header click sorts: ascending, descending, off. Shift adds the column to the other keys.
  const sortBy = (id: string, add: boolean) => {
    const dir = layout.sort?.find((k) => k.col === id)?.dir
    edit((s) => ({ ...s, layout: setSort(s.layout, id, dir === undefined ? 'asc' : dir === 'asc' ? 'desc' : null, add) }))
  }
  const headerMenu = (id: string, trigger: HTMLElement) => {
    const r = trigger.getBoundingClientRect()
    showPopover(r.left, r.bottom + 4, `${COL_BY_ID.get(id)?.label ?? id}: sort and filter`, <HeaderMenuBody colId={id} />, trigger)
  }
  const loading = !itsaStatuses.length && !itsaError
  // What the quick filters read of a status; one the settings don't know is backlog (statusInfo).
  const status: StatusLookup = { category: (s) => statusInfo(s).category, human: (s) => statusInfo(s).human }
  const base = { groupBy: layout.groupBy, show: store.show, text, searchCols: SEARCH_COLS, closed: isClosed, sort: layout.sort, cols: (id: string) => COL_BY_ID.get(id), cx, quick: layout.quick, status }
  const colFiltered = Object.keys(layout.filters ?? {}).length > 0
  const quickOn = (layout.quick?.length ?? 0) > 0
  const filtered = colFiltered || quickOn
  // Each ITSA once: a column grouping can list a row (several agents) in more than one group.
  const count = (gs: WorkGroup[]) => new Set(gs.flatMap((g) => g.rows.filter((r) => !r.context).map((r) => r.it.id))).size
  const groups = loading ? [] : groupFor(mode, itsas, agents, { ...base, filters: layout.filters })
  const total = count(groups)
  // With a column or quick filter on, the count says how many of the rows the other settings keep it leaves.
  const unfiltered = loading || !filtered ? total : count(groupFor(mode, itsas, agents, { ...base, quick: undefined }))
  const needs = loading || (itsaError && !itsas.length) ? [] : needsRows(waiting, queue)
  const attention = attentionItsaIds(needs)

  // Every row the page has, once each, with the other columns' filters on: what a checklist counts.
  const rowsFor = (excluding: string) => {
    const { [excluding]: _, ...rest } = layout.filters ?? {}
    const seen = new Set<string>()
    return groupFor(mode, itsas, agents, { ...base, filters: rest }).flatMap((g) => g.rows).filter((r) => !r.context && !seen.has(r.it.id) && !!seen.add(r.it.id))
  }
  // The phone's list when a filter or sort is on: every row that passes, flat, in the sort order.
  const sorted = (layout.sort?.length ?? 0) > 0
  // With a column grouping the list keeps the groups' headers; its matches are the rows of them all, once each.
  const grouped = glanced && mode === 'column' && !loading
  const matchGroups = glanced && (filtered || sorted || grouped) && !loading ? groupFor('flat', itsas, agents, { ...base, filters: layout.filters }) : []
  const matches = (matchGroups[0]?.rows ?? []).filter((r) => !r.context).map((r) => r.it)
  // The footer and the phone's line sum what is shown (totals.ts), with the categories the statuses are in.
  const totalsOf = (gs: WorkGroup[]) => workTotals(gs, extras, fields ?? [], (s) => status.category(s))
  const glanceGroups = grouped ? groups.map((g) => ({ id: g.id, label: g.column?.label ?? g.id, items: g.rows.map((r) => r.it) })) : undefined
  // The sheet lists the shown columns, and any hidden one that still filters or sorts, so each can be cleared.
  const sheetIds = [...layout.cols, ...[...Object.keys(layout.filters ?? {}), ...(layout.sort ?? []).map((k) => k.col)].filter((id, i, a) => !layout.cols.includes(id) && a.indexOf(id) === i)]
  const sheetCols = sheetIds.map((id) => COL_BY_ID.get(id)).filter((c): c is WorkColumn => !!c)
  const glanceOf = (): GlanceFilter => ({ view: { name: curName, dirty, open: viewMenu }, live: headerLive, cols: sheetCols, matches, groups: glanceGroups, groupLabel: grouped ? groupCol?.label : undefined, groupCols: SEARCH_COLS.filter((c) => groupable(c)), line: matches.length ? totalLine(totalsOf(matchGroups)) : undefined, of: count(groupFor('flat', itsas, agents, { ...base, quick: undefined })) })
  // The header menu follows the page: it reads the layout, the rows and the edit from here.
  const headerLive: HeaderLive = { layout, col: (id) => COL_BY_ID.get(id), rows: rowsFor, cx, edit: (fn) => edit((s) => ({ ...s, layout: fn(s.layout) })) }
  useLayoutEffect(() => { publishHeader(headerLive) })
  // A right-click on a cell opens its filter menu (S-1518). A column with nothing to offer keeps the browser's own menu.
  const cellMenu: CellMenu = (e, c, row) => showCellMenu(e.clientX, e.clientY, headerLive, c.id, row)
  const open = (e: React.KeyboardEvent, id: string) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openItsa(id) } }
  // Fold or unfold these rows (S-1437): only folded ones are kept in the map.
  const setRowFolds = (ids: string[], fold: boolean) => {
    const next = { ...prefs.folded }
    for (const id of ids) { if (fold) next[rowKey(mode, id)] = true; else delete next[rowKey(mode, id)] }
    setPrefs({ folded: next })
  }
  // Every row that has subrows, in the issue tree (the agent tree folds by its group heads): what Expand all and Collapse all work on.
  const foldable = tree ? [...new Set(groups.flatMap((g) => [...foldRows(g.rows, () => false).kids.keys()]))] : []
  const group = (g: WorkGroup) => {
    const n = g.rows.filter((r) => !r.context).length
    const { rows: shownRows, kids } = foldRows(g.rows, (r) => tree && !!prefs.folded[rowKey(mode, r.it.id)])
    const rows = (
      shownRows.map((r) => {
        const k = kids.get(r.it.id) ?? 0
        const expanded = !prefs.folded[rowKey(mode, r.it.id)]
        const fold: RowFold | undefined = tree ? { kids: k, open: expanded, hidden: expanded ? 0 : k, label: `${expanded ? 'Collapse' : 'Expand'} ${r.it.key}`,
          toggle: () => setRowFolds([r.it.id], expanded) } : undefined
        return (
          <div key={r.it.id} role="row" tabIndex={0} className={'w-row' + (r.context ? ' context' : '') + (isClosed(r.it) ? ' closed' : '') + (attention.has(r.it.id) ? ' attention' : '')} data-itsa={r.it.id}
            aria-label={`${r.it.key} ${r.it.title}`} onClick={() => openItsa(r.it.id)} onKeyDown={(e) => open(e, r.it.id)}>
            <Cells row={r} cols={cols} cx={cx} onMenu={cellMenu} fold={fold} />
          </div>)
      }))
    // The flat list has no header, so nothing folds it.
    if (mode === 'flat') return <div key={g.id} role="rowgroup" className="w-group" data-group="flat">{rows}</div>
    const key = foldKey(mode, g.id)
    const folded = !!prefs.folded[key]
    const name = g.column ? g.column.label : g.agent ? g.agent.name : g.root ? `${g.root.key} ${g.root.title}` : g.id === UNOWNED ? 'Unowned' : 'Standalone'
    return (
      <div key={g.id} role="rowgroup" className={'w-group' + (folded ? ' folded' : '')} data-group-col={g.column?.col} data-group-value={g.column ? g.column.value || 'blank' : undefined} data-group={g.id === STANDALONE ? 'standalone' : g.id === UNOWNED ? 'unowned' : g.id}>
        <div role="row" className="w-ghead">
          <button type="button" role="cell" className="w-gtoggle" aria-expanded={!folded} aria-label={`${folded ? 'Show' : 'Fold'} ${name}, ${n}`}
            onClick={() => setPrefs({ folded: { ...prefs.folded, [key]: !folded } })}>
            <span className={'chev' + (folded ? '' : ' open')}><Icon name="chevron-right" size="xs" /></span>
            {g.column ? <>{g.column.col === 'status' && g.column.value ? <StatusGlyph status={g.column.value} /> : null}<span className="w-gname">{g.column.label}</span></>
              : g.agent ? <><HarnessMark harness={g.agent.harness} /><span className="w-gname">{g.agent.name}</span></>
              : g.root ? <><StatusGlyph status={g.root.status} /><span className="w-gname">{g.root.title}</span></>
              : <span className="w-gname">{g.id === UNOWNED ? 'Unowned' : 'Standalone'}</span>}
            <span className="count">{n}</span>
          </button>
          {g.root ? <a href="#" className="itsalink w-gkey" title={`Open ${g.root.key}`} onClick={(e) => { e.preventDefault(); openItsa(g.root!.id) }}>{g.root.key}</a> : null}
        </div>
        {folded ? null : rows}
      </div>)
  }

  let empty: ReactNode
  if (filtered && !text.trim()) empty = <Stack title="Nothing matches" body="No issue passes the filters." action={<button type="button" className="btn text" onClick={() => edit((s) => ({ ...s, layout: clearFilters(s.layout) }))}>Clear the filters</button>} />
  else if (text.trim()) empty = <Stack title="Nothing matches" body={`No ${store.show === 'open' ? 'open ' : ''}issue has “${text.trim()}” in any column.`} action={<button type="button" className="btn text" onClick={() => setText('')}>Clear the search</button>} />
  else if (store.show === 'open' && itsas.length) empty = <Stack title="No open work" body="Every issue is closed." action={<button type="button" className="btn text" onClick={() => edit((s) => ({ ...s, show: 'all' }))}>Show all</button>} />
  else empty = <Stack title="No work yet" body="Issues you and agents open show here, grouped by the issue they belong to." />

  let body: ReactNode
  if (loading) body = <Loading className="empty-pane work-empty" size="lg" label="Reading the issues" />
  else if (itsaError && !itsas.length) body = <Stack eyebrow={<span className="badge err">Error</span>} title="Can't load the issues" body={itsaError}
    action={<button type="button" className="btn" onClick={() => refreshItsas()}>Retry</button>} />
  else if (glanced) body = <div className="w-table"><Glance itsas={itsas} needs={needs} extras={extras} now={now} fields={shownFields} filter={glanceOf()} /></div>
  else body = (
    <div className="w-table" role="table" aria-label="Work" style={{ '--w-cols': cols.map(track).join(' ') } as CSSProperties}>
      <div role="rowgroup" className="w-headgroup"><div role="row" className="w-head" ref={headRef}>{cols.map((c) => {
        const movable = !LOCKED.includes(c.id)
        const sortable = !!c.sortValue
        const menu = sortable || !!c.filter
        const rank = (layout.sort ?? []).findIndex((k) => k.col === c.id)
        const dir = rank >= 0 ? layout.sort![rank].dir : undefined
        return <div key={c.id} role="columnheader" data-col={c.id} tabIndex={movable || menu ? 0 : undefined}
          aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined}
          className={`w-cell wc-${c.id}` + (c.align === 'end' ? ' end' : '') + (movable ? ' movable' : '') + (sortable ? ' sortable' : '')} title={c.hint}
          onPointerDown={(e) => { moved.current = false; reorderStart(e, c.id) }}
          onClick={(e) => { if (moved.current) { moved.current = false; return } if (sortable) sortBy(c.id, e.shiftKey) }}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return
            if (menu && e.altKey && e.key === 'ArrowDown') { e.preventDefault(); headerMenu(c.id, e.currentTarget); return }
            if (sortable && e.key === 'Enter') { e.preventDefault(); sortBy(c.id, e.shiftKey); return }
            if (!movable || !e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
            e.preventDefault()
            edit((s, ids) => ({ ...s, layout: moveBy(s.layout, ids, c.id, e.key === 'ArrowLeft' ? -1 : 1) }))
          }}>
          <div className="w-hinner">
            <span className="w-hlabel">{c.label}</span>
            {/* State glyphs only: the sort direction and rank, and a mark when the column is filtered. */}
            {dir ? <span className="w-hsort" data-dir={dir}><Icon name={dir === 'asc' ? 'arrow-up' : 'arrow-down'} size="xs" />{(layout.sort?.length ?? 0) > 1 ? <span className="w-hrank">{rank + 1}</span> : null}</span> : null}
            {layout.filters?.[c.id] ? <span className="w-hfilter" aria-label="Filtered" /> : null}
            {menu ? <button type="button" className="w-hmenu" tabIndex={-1} aria-haspopup="dialog" aria-label={`${c.label}: sort and filter`}
              onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); headerMenu(c.id, e.currentTarget) }}><Icon name="chevron-down" size="xs" /></button> : null}
          </div>
          <span className="w-resize" aria-hidden="true" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => { moved.current = false; resizeStart(e, c.id) }}
            onDoubleClick={(e) => { e.stopPropagation(); editWidths((s) => ({ ...s, layout: setWidth(s.layout, c.id, null) })) }} />
        </div>
      })}{drop ? <span className="w-drop" aria-hidden="true" style={{ left: drop.left }} /> : null}</div></div>
      <NeedsGroup rows={needs} cols={cols} cx={cx} loading={!storeLoaded.mail || !storeLoaded.agents} spacer={tree ? NO_FOLD : undefined} />
      {groups.length ? groups.map(group) : <div className="w-innerstack">{empty}</div>}
      {groups.length ? <TotalsRow cols={cols} totals={totalsOf(groups)} /> : null}
    </div>)

  return (
    <div className="work-view" ref={root} data-phone={phone ? '' : undefined} data-glance={glanced ? '' : undefined}>
      {glanced ? null : <div className="work-bar">
        <h2>Work</h2>
        {loading ? null : <span className="count" title={filtered ? `${total} of ${unfiltered} shown` : `${total} shown`}>{filtered ? `${total} of ${unfiltered}` : total}</span>}
        <div className="w-pair">
          <span className="w-label">Show</span>
          <div className="seg" role="radiogroup" aria-label="Show">
            {(['open', 'all'] as const).map((s) => (
              <button key={s} type="button" role="radio" aria-checked={store.show === s} className={store.show === s ? 'on' : ''} data-show={s} onClick={() => edit((x) => ({ ...x, show: s }))}>{s === 'open' ? 'Open' : 'All'}</button>))}
          </div>
        </div>
        {/* How the rows are grouped. It is part of the layout, so a saved view keeps it. */}
        <div className="w-pair">
          <span className="w-label">Group</span>
          <div className="seg" role="radiogroup" aria-label="Group">
            {PLAIN_GROUPS.map((g) => (
              <button key={g} type="button" role="radio" aria-checked={mode === g} className={mode === g ? 'on' : ''} data-mode={g}
                onClick={() => edit((s) => ({ ...s, layout: setGroup(s.layout, g) }))}>{GROUP_LABEL[g]}</button>))}
          </div>
          <button type="button" className={'btn w-groupcol' + (mode === 'column' ? ' on' : '')} data-group-col-btn aria-haspopup="menu" aria-pressed={mode === 'column'}
            onClick={groupMenu}>{mode === 'column' ? `By ${groupCol!.label}` : GROUP_LABEL.column}</button>
        </div>
        <label className="search w-filter"><Icon name="search" />
          <input type="search" value={text} placeholder="Search all columns" aria-label="Search all columns" autoComplete="off" spellCheck={false}
            onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape' && text) { e.preventDefault(); setText('') } }} />
        </label>
        {foldable.length ? <div className="w-pair w-foldall">
          <button type="button" className="btn text" data-fold-all="expand" disabled={!foldable.some((id) => prefs.folded[rowKey(mode, id)])} onClick={() => setRowFolds(foldable, false)}>Expand all</button>
            <button type="button" className="btn text" data-fold-all="collapse" disabled={foldable.every((id) => prefs.folded[rowKey(mode, id)])} onClick={() => setRowFolds(foldable, true)}>Collapse all</button>
        </div> : null}
        <div className="w-tools">
          <button type="button" className="btn" aria-haspopup="menu" onClick={viewMenu}>View</button>
          <button type="button" className="btn" aria-haspopup="menu" onClick={columnsMenu}>Columns</button>
        </div>
      </div>}
      {/* The saved views: one click switches, a dot marks the current one as edited since it was saved. */}
      {glanced ? null : <ViewTabs views={store.views} current={store.current} dirty={dirty} onPick={apply} />}
      {/* The quick filters: one-tap presets that AND with the column filters. */}
      {glanced ? null : <QuickBar on={layout.quick} onToggle={(id) => edit((s) => ({ ...s, layout: setQuick(s.layout, id) }))}>
        {quickOn && !colFiltered ? <button type="button" className="btn text w-fclear" onClick={() => edit((s) => ({ ...s, layout: clearFilters(s.layout) }))}>Clear all</button> : null}
      </QuickBar>}
      {/* Every active filter, hidden columns' too, so each can be seen and cleared. */}
      {glanced || !colFiltered ? null : <div className="w-filters" role="group" aria-label="Active filters">
        {Object.entries(layout.filters ?? {}).map(([id, f]) => {
          const label = COL_BY_ID.get(id)?.label ?? id
          const text = filterText(label, f, f.kind === 'values' ? optionsFor({ layout, col: (x) => COL_BY_ID.get(x), rows: rowsFor, cx, edit: () => {} }, id) : [])
          return <span key={id} className="w-ftoken" data-col={id}>
            <button type="button" className="w-ftext" title={text} aria-haspopup="dialog" onClick={(e) => headerMenu(id, e.currentTarget)}>{text}</button>
            <button type="button" className="w-fx" aria-label={`Clear the ${label} filter`} onClick={() => edit((s) => ({ ...s, layout: setFilter(s.layout, id, null) }))}><Icon name="x" size="xs" /></button>
          </span>
        })}
        <button type="button" className="btn text w-fclear" onClick={() => edit((s) => ({ ...s, layout: clearFilters(s.layout) }))}>Clear all</button>
      </div>}
      {body}
    </div>
  )
}
