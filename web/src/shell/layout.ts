// The shell's state: the agent tree on the left, the main world in
// the middle, and a bottom bar under main. Each agent (and each mail thread, Settings, and
// Usage) has its own main world: the view for working with it, usually one view, with any
// tabs and splits the user adds. A world's layout is a tree: a split holds children side by
// side (row) or stacked (col); a pane holds tabs. Tabs move between panes by dragging, and
// a drop on a pane's edge splits it that way.
// The worlds and which one shows are the daemon's (src/layout.ts), shared by every client
// and arranged by agents too: they come and go through layout-sync.ts. The side worlds'
// sizes and whether they're open stay per browser.
import { useSyncExternalStore } from 'react'
import { token } from '../api'
import { PAGE } from '../page'
import { defaultWorld, emptyLayout, isEmptyLayout, validLayout, type Layout, type LayoutOp } from '../../../src/layout-ops.ts'
import { LayoutSync, parseEvents, Refused } from './layout-sync'

export type Dir = 'row' | 'col'
export type Side = 'right' | 'left' | 'down' | 'up'
export interface Leaf { id: string; tabs: string[]; active: string | null; showTabs?: boolean; split?: undefined }
export interface Split { id: string; split: Dir; children: Node[]; sizes: number[] }
export type Node = Leaf | Split
export interface World {
  root: Node
  focused: string
  // The tree view (app code): its direction, the layout it replaced, the agent's own pane.
  tree?: Dir
  saved?: Node
  mainPane?: string
  treeSig?: string
}
// What this browser keeps for itself.
interface Local {
  v: number
  open: { left: boolean; bottom: boolean }
  size: { left: number; right: number; bottom: number }
  // On a phone, what covers main: the agent tree ('left') or the
  // issues ('issues').
  mobile?: 'left' | 'issues' | 'bottom' | null
  // The world this device shows. The human's own navigation changes only this; an agent
  // moving the daemon's current world moves every device.
  current?: string | null
}
export interface ShellState extends Local {
  current: string | null
  agentWorlds: Record<string, World>
  worlds: Record<string, World>
}

export interface ShellHooks {
  // Whether a saved tab still has something to show, and a saved world still exists.
  keep: (key: string) => boolean
  keepWorld: (id: string) => boolean
  // Whether a key names a view that can be made.
  valid: (key: string) => boolean
}

// This browser's own state; the daemon's layout as last seen (to start with before the
// stream answers, and offline); and the layout from before the daemon kept it, moved to the
// daemon once.
const LOCAL = 'stam/shell-local'
const CACHE = 'stam/layout'
const OLD = 'stam/shell3'
const MOVED = 'stam/shell3-moved'
const MIN = { left: 200, right: 260, bottom: 120 }
export const HOME = '_home'
export const pid = () => 'p' + Math.random().toString(36).slice(2, 10)
export const leaf = (tabs: string[] = [], active: string | null = tabs[0] ?? null): Leaf => ({ id: pid(), tabs, active })
export const split = (dir: Dir, children: Node[], sizes = children.map(() => 1)): Split => ({ id: pid(), split: dir, children, sizes })
const DEFAULTS = (): Local => ({ v: 7, open: { left: true, bottom: true }, size: { left: 300, right: 360, bottom: 200 } })

export const isPhone = () => matchMedia('(max-width: 760px)').matches

let local: Local = DEFAULTS()
// Before init (and in tests without a daemon) changes stay local: nothing is online to send them to.
let sync = new LayoutSync(emptyLayout(), { send: () => Promise.reject(new Error('not started')), changed: () => layoutChanged(), newId: pid })
let state: ShellState = compose()
let hooks: ShellHooks
let focusWorld = 'main'
let version = 0
const listeners = new Set<() => void>()
const changeListeners: (() => void)[] = []

function compose(): ShellState {
  const l = sync.view
  return { ...local, current: local.current ?? null, agentWorlds: l.agentWorlds, worlds: l.worlds }
}
function read(key: string): any {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') } catch { return null }
}
function write(key: string, v: unknown) {
  try { localStorage.setItem(key, JSON.stringify(v)) } catch {}
}
function loadLocal(): Local {
  const s = read(LOCAL) ?? read(OLD)
  if (!s?.open || !s?.size) return DEFAULTS()
  return { v: 7, open: { left: !!s.open.left, bottom: s.v >= 5 ? !!s.open.bottom : true }, size: { ...DEFAULTS().size, ...s.size }, mobile: s.mobile ?? null, current: typeof s.current === 'string' ? s.current : null }
}
// The layout the earlier shell kept in this browser, as the daemon keeps one; null when
// there's none, or it isn't well formed.
export function oldLayout(raw: any): Layout | null {
  if (!raw?.agentWorlds || typeof raw.agentWorlds !== 'object') return null
  const l: Layout = { version: 0, current: typeof raw.current === 'string' ? raw.current : null, agentWorlds: raw.agentWorlds, worlds: {} }
  return validLayout(l) && Object.keys(l.agentWorlds).length ? l : null
}
// Back to one pane per world, in every world and on every device.
// The daemon's current world is put back in the same batch, so no device moves.
export function resetLayout() {
  const cur = sync.view.current
  exec([...Object.keys(sync.view.agentWorlds).map((world): LayoutOp => ({ op: 'dropWorld', world })), { op: 'current', world: cur }])
}

// Re-renders the shell and tells app code (the bottom prompt input, the phone nav).
export function changed() {
  write(LOCAL, local)
  state = compose()
  bump()
  for (const fn of changeListeners) fn()
}
function bump() {
  version++
  for (const fn of listeners) fn()
}
export const onChange = (fn: () => void) => { changeListeners.push(fn) }
export function useShell() {
  useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn) } }, () => version)
  return state
}
// A change to the shared layout: applied here now, and sent to the daemon. 'main' names
// this device's world, not the daemon's current one.
function exec(ops: LayoutOp[]) {
  return sync.exec(ops.map((op) => (op.op !== 'current' && op.world === 'main' ? { ...op, world: here() } : op)))
}
const here = () => local.current ?? HOME
// The daemon's current world as last seen; undefined before its first layout.
let seenCurrent: string | null | undefined
// The copy changed, by us or by the daemon. A new daemon current world (an agent sent the
// human there; this shell never moves it) moves this device too, out from under a phone's
// overlay. Views no layout has go, and the shell re-renders.
function layoutChanged() {
  const cur = sync.server?.current
  if (cur !== undefined && seenCurrent !== undefined && cur !== seenCurrent) {
    local.current = cur
    if (isPhone()) local.mobile = null
  }
  if (cur !== undefined && seenCurrent !== undefined) seenCurrent = cur
  gc()
  changed()
}

// --- Layout trees -------------------------------------------------------------------

export function leaves(n: Node): Leaf[] { return n.split ? n.children.flatMap(leaves) : [n] }
export function parentOf(root: Node, node: Node): { parent: Split; index: number } | null {
  if (!root.split) return null
  for (const [i, c] of root.children.entries()) {
    if (c === node) return { parent: root, index: i }
    const r = parentOf(c, node)
    if (r) return r
  }
  return null
}
// A world not made yet shows its default here; the daemon makes the same one on the first
// change to it.
function W(world = 'main'): World {
  const l = sync.view
  if (world !== 'main' && l.worlds[world]) return l.worlds[world]
  const id = world === 'main' ? here() : world
  return (l.agentWorlds[id] ??= defaultWorld(id))
}
export const leafById = (w: World, id: string | undefined) => leaves(w.root).find((l) => l.id === id)
export const focusedLeaf = (w: World) => leafById(w, w.focused) ?? leaves(w.root)[0]
export const currentWorld = () => local.current ?? null
export const mainWorld = () => W('main')

// --- Views: the things tabs show -------------------------------------------------------

// Views made so far. A view stays alive (a terminal keeps its connection) while any
// world's layout has it, shown or not, and goes when none does.
const made = new Set<string>()
const madeListeners = new Set<() => void>()
let madeVersion = 0
let madeList: string[] = []
function madeChanged() { madeVersion++; madeList = [...made]; for (const fn of madeListeners) fn() }
export function useMadeViews() {
  useSyncExternalStore((fn) => { madeListeners.add(fn); return () => { madeListeners.delete(fn) } }, () => madeVersion)
  return madeList
}
export function makeView(key: string): boolean {
  if (made.has(key)) return true
  if (!hooks.valid(key)) return false
  made.add(key)
  queueMicrotask(madeChanged)
  return true
}

// What a view does beyond rendering, registered by its component.
export interface ViewHandle {
  show?: () => void
  // The view is on screen no longer, beside another that is (a terminal beside its conversation).
  hide?: () => void
  focus?: () => void
  resize?: () => void
  // Terminals: a key the phone's keyboard lacks, and putting the keyboard away.
  key?: (name: string) => void
  blur?: () => void
  // Returns false to keep the tab open.
  beforeClose?: () => boolean
}
const handles = new Map<string, ViewHandle>()
export const registerView = (key: string, h: ViewHandle) => { handles.set(key, h); return () => { if (handles.get(key) === h) handles.delete(key) } }
export const viewHandle = (key: string) => handles.get(key)
export const resizeAll = () => { for (const h of handles.values()) h.resize?.() }
// A view that shows takes the focus, except on a phone, where focus raises the keyboard over it.
export const autoFocus = (key: string) => { if (!isPhone()) requestAnimationFrame(() => viewHandle(key)?.focus?.()) }

// Views not on screen wait here, alive, so terminals stay connected.
const elements = new Map<string, HTMLDivElement>()
let storeEl: HTMLDivElement | null = null
export function viewStore() {
  if (!storeEl) { storeEl = document.createElement('div'); storeEl.id = 'view-store'; storeEl.hidden = true; document.body.append(storeEl) }
  return storeEl
}
export function viewElement(key: string) {
  let el = elements.get(key)
  if (!el) { el = document.createElement('div'); el.className = 'view'; el.dataset.key = key; viewStore().append(el); elements.set(key, el) }
  return el
}

// --- Worlds -------------------------------------------------------------------------

// Whether this browser had no state of its own at start.
let freshDevice = false
export function init(h: ShellHooks) {
  hooks = h
  freshDevice = read(LOCAL) === null && read(OLD) === null
  local = loadLocal()
  const cached = read(CACHE)
  const start = validLayout(cached) ? cached : (!read(MOVED) && oldLayout(read(OLD))) || emptyLayout()
  sync = new LayoutSync(start, {
    send: (ops, batch) => call('POST', '/api/layout/ops', { ops, batch }),
    changed: layoutChanged,
    newId: pid,
  })
  state = compose()
  bump()
  void follow()
}
// A layout request. A 4xx is the daemon refusing it (Refused); a failed fetch or a 5xx
// means it couldn't take it, so the sync sends it again.
async function call(method: string, path: string, body: unknown): Promise<Layout> {
  const r = await fetch(path, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-stam-human': '1' }, body: JSON.stringify(body) })
  const d = await r.json().catch(() => ({}))
  if (r.ok) return d as Layout
  const msg = (d as { error?: string }).error || `HTTP ${r.status}`
  throw r.status >= 500 ? new Error(msg) : new Refused(msg)
}

// Reads the daemon's layout stream for as long as the page lives, reconnecting after a
// break; EventSource can't send the token header, so it's a fetch.
async function follow() {
  let first = true
  for (let wait = 500; ; wait = Math.min(wait * 2, 10_000)) {
    try {
      const r = await fetch('/api/layout/stream', { headers: { authorization: 'Bearer ' + token, 'x-stam-human': '1', 'x-stam-page': PAGE } })
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`)
      const reader = r.body.pipeThrough(new TextDecoderStream()).getReader()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        const { layouts, rest } = parseEvents(buf + value)
        buf = rest
        for (const l of layouts) {
          if (first) { first = false; firstLayout(l) }
          sync.receive(l)
          write(CACHE, l)
          wait = 500
        }
      }
    } catch {}
    sync.disconnected()
    await new Promise((r) => setTimeout(r, wait))
  }
}

// The daemon's first layout this page sees. An empty one takes this browser's layout from
// before the daemon kept it, once; then tabs and worlds whose agent or view is gone close.
function firstLayout(l: Layout) {
  const old = !read(MOVED) && oldLayout(read(OLD))
  // Moved once the daemon took it, or refused it (a 409: its layout isn't empty any more);
  // a page closed before then tries again on the next load.
  if (old && isEmptyLayout(l)) sync.run(() => call('PUT', '/api/layout', { layout: old }), () => write(MOVED, true))
  else write(MOVED, true)
  sync.view = JSON.parse(JSON.stringify(old && isEmptyLayout(l) ? old : l))
  const ops: LayoutOp[] = []
  for (const [id, w] of Object.entries(sync.view.agentWorlds)) {
    if (id !== HOME && !hooks.keepWorld(id)) { ops.push({ op: 'dropWorld', world: id }); continue }
    for (const k of leaves(w.root).flatMap((x) => x.tabs)) if (!hooks.keep(k)) ops.push({ op: 'close', world: id, key: k })
  }
  seenCurrent = l.current
  if (local.current && !hooks.keepWorld(local.current)) local.current = null
  // A new device starts where the daemon last sent the human.
  if (freshDevice && !local.current && l.current && hooks.keepWorld(l.current)) {
    local.current = l.current
    if (isPhone()) local.mobile = null
  }
  if (ops.length) exec(ops)
  else layoutChanged()
}

export function clampSize(name: 'left' | 'bottom') {
  const max = name === 'bottom' ? innerHeight - 160 : Math.max(MIN[name], innerWidth / 2 - 100)
  return Math.round(Math.min(Math.max(local.size[name], MIN[name]), max))
}
export function setSize(name: 'left' | 'bottom', px: number) { local.size[name] = px; state = compose(); bump() }

export function toggleWorld(name: 'left' | 'bottom', open = isPhone() ? local.mobile !== name : !local.open[name]) {
  if (isPhone()) local.mobile = open ? name : null
  else local.open[name] = open
  changed()
  setTimeout(resizeAll, 0)
}
export const worldOpen = (name: 'left' | 'bottom') => (isPhone() ? local.mobile === name : local.open[name])
export function closePhoneOverlay() { if (isPhone() && local.mobile) { local.mobile = null; changed() } }
// The phone's bottom navigation: shows the agent tree, the mail list, or the issues over
// main, or none of them.
export type Mobile = 'left' | 'issues' | 'bottom' | null
export function phoneShow(side: Mobile) { if (local.mobile !== side) { local.mobile = side; changed() } }
export const phoneShows = (): Mobile => local.mobile ?? null

// Shows an agent's world in main (null: the home world). Threads are `t:ID`, Settings and
// Usage `w:config` and `w:usage`, an ITSA `w:itsa:ID`.
export function showAgentWorld(id: string | null) {
  if (local.current !== id) {
    local.current = id
    // The daemon keeps every world the human visits, so its views stay alive (a terminal
    // keeps its connection) after the human moves on; focusing its pane makes it.
    const w = sync.view.agentWorlds[id ?? HOME]
    if (!w) exec([{ op: 'focus', world: id ?? HOME, pane: defaultWorld(id ?? HOME).focused }])
    else changed()
  }
  closePhoneOverlay()
}

export function dropAgentWorld(id: string) {
  if (sync.view.agentWorlds[id]) exec([{ op: 'dropWorld', world: id }])
}

// Replaces the current main world's layout, keeping views that stay, with the tree view's
// fields as app code left them on the world.
export function setLayout(root: Node, focusKey: string) {
  const w = W()
  const meta = { tree: w.tree, saved: w.saved, mainPane: w.mainPane, treeSig: w.treeSig }
  for (const k of Object.keys(meta) as (keyof typeof meta)[]) if (meta[k] === undefined) delete meta[k]
  exec([{ op: 'setRoot', world: 'main', root, focusKey, meta }])
}

// --- Panes and tabs -----------------------------------------------------------------

function find(world: string, key: string) {
  const l = leaves(W(world).root).find((x) => x.tabs.includes(key))
  return l ? { world, leaf: l } : null
}
function usedAnywhere(key: string) {
  // A world's saved layout (kept while its tree view shows) counts too.
  const roots = Object.values(sync.view.agentWorlds).flatMap((w) => [w.root, w.saved].filter((x): x is Node => !!x))
  return roots.some((r) => leaves(r).some((l) => l.tabs.includes(key)))
}
// Drops views no layout has any more.
function gc() {
  W() // the current world counts while it still shows its default
  let any = false
  for (const key of made) if (!usedAnywhere(key)) { made.delete(key); any = true }
  if (any) queueMicrotask(madeChanged)
}
export function destroyViewElement(key: string) {
  elements.get(key)?.remove()
  elements.delete(key)
}

export const isOpen = (key: string, world = 'main') => !!find(world, key)
// Every agent world whose layout has the tab.
export const worldsWith = (key: string) => Object.entries(sync.view.agentWorlds).filter(([, w]) => leaves(w.root).some((l) => l.tabs.includes(key))).map(([id]) => id)
export const activeIn = (world = 'main') => (hooks ? focusedLeaf(W(world))?.active ?? null : null)
export const focusedWorld = () => focusWorld
export const tabsIn = (world = 'main') => leaves(W(world).root).flatMap((l) => l.tabs)
export const paneActive = (id: string, world = 'main') => leafById(W(world), id)?.active ?? null

// Opens a tab in a world, or focuses it if that world already has it. `pane` is a pane id;
// `split` puts it in a new pane beside that pane.
export function open(world: string, key: string, { pane, split: side, background }: { pane?: string; split?: Side; background?: boolean } = {}) {
  if (!find(world, key) && !makeView(key)) return
  const w = W(world)
  if (!exec([{ op: 'open', world, key, pane: leafById(w, pane) ? pane : undefined, split: side, background }])) return
  if (!background) focusWorld = world
  if (world === 'main') closePhoneOverlay()
  if (!background) autoFocus(key)
}

export function close(key: string, world = 'main') {
  if (!find(world, key)) return
  if (viewHandle(key)?.beforeClose?.() === false) return
  exec([{ op: 'close', world, key }])
}

// Shows `withKey` in place of `key`, in the same pane and place (an agent's terminal and
// stam's view of it trade places).
export function swap(key: string, withKey: string, world = 'main') {
  if (!find(world, key) || !makeView(withKey)) return
  exec([{ op: 'swap', world, key, with: withKey }])
  if (activeIn(world) === withKey) autoFocus(withKey)
}

export function move(key: string, world: string, toId: string, beforeKey: string | null, side?: Side) {
  if (!find(world, key) || !leafById(W(world), toId)) return
  exec([{ op: 'move', world, key, to: toId, before: beforeKey, side }])
}

export function splitPane(world: string, id: string, side: Side) {
  if (leafById(W(world), id)) exec([{ op: 'split', world, pane: id, side }])
}

export function closePane(world: string, id: string) {
  const w = W(world)
  if (leafById(w, id) && leaves(w.root).length > 1) exec([{ op: 'closePane', world, pane: id }])
}

export function setTabBar(world: string, id: string, on: boolean) {
  if (leafById(W(world), id)) exec([{ op: 'tabBar', world, pane: id, on }])
}

export function activate(world: string, id: string, key: string) {
  const l = leafById(W(world), id)
  if (!l?.tabs.includes(key)) return
  if (l.active !== key) exec([{ op: 'activate', world, pane: id, key }])
  autoFocus(key)
}

export function setFocus(world: string, id: string) {
  const w = W(world)
  focusWorld = world
  if (w.focused === id || !leafById(w, id)) return
  exec([{ op: 'focus', world, pane: id }])
}

// A split's sizes changed by dragging its separator (in place, on our copy); the drag's
// end sends them, queued behind the change that made the split, so a split the daemon
// hasn't seen yet still gets them. Without a split, every split in main.
export function resized(dragged?: Split) {
  const splits: Split[] = []
  const walk = (n: Node) => { if (n.split) { splits.push(n); n.children.forEach(walk) } }
  if (dragged) splits.push(dragged)
  else walk(W().root)
  if (splits.length) exec(splits.map((s): LayoutOp => ({ op: 'resize', world: 'main', split: s.id, sizes: [...s.sizes] })))
  else changed()
  resizeAll()
}

// Re-renders tab titles and badges that views changed (a thread's subject once loaded).
export const refreshTabs = () => bump()
