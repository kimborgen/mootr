// The Agents table's view, kept in stam settings (S-293) as the sidebar's columns are: the columns it
// shows, in the order they were picked, its grouping, its scope chip (S-2937), and whether its detail pane is
// open (S-3048). One record under one id, so the choice follows the human to every device and a page never
// overwrites another page's view.
import { useEffect, useSyncExternalStore } from 'react'
import { ALL_COLS, sanitizeCols, sanitizeGroup, sanitizeScope, type ColumnId, type Group, type Scope } from './agents-table'
import { settingsRecord } from './settings-views'

export interface AgentsView {
  cols: ColumnId[]
  group: Group
  scope: Scope
  // Whether the detail pane is open. Unset until the human presses Space, so the pane follows the page's width.
  pane?: boolean
}

const ID = 'main'
const DEFAULT: AgentsView = { cols: ALL_COLS, group: 'tree', scope: 'live' }
const record = settingsRecord<AgentsView>({
  field: 'agentsTableCols',
  legacy: 'stam/agents-table',
  clean: (x) => {
    const o = (x && typeof x === 'object' ? x : {}) as { cols?: unknown; group?: unknown; scope?: unknown; pane?: unknown }
    const view: AgentsView = { cols: sanitizeCols(o.cols), group: sanitizeGroup(o.group), scope: sanitizeScope(o.scope) }
    if (typeof o.pane === 'boolean') view.pane = o.pane
    return view
  },
})

let view: AgentsView = DEFAULT
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())

// `remember: false` changes the view on screen only, not the saved record (the stories use it).
export function setAgentsView(patch: Partial<AgentsView>, { remember = true }: { remember?: boolean } = {}) {
  view = { ...view, ...patch }
  if (remember) record.save(ID, view)
  emit()
}

let loading: Promise<void> | null = null
const loadOnce = () => (loading ??= record.load().then(() => { view = record.cached(ID) ?? view; emit() }, () => { loading = null }))

export function useAgentsView(): AgentsView {
  useEffect(() => { void loadOnce() }, [])
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => view)
}
