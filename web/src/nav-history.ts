// The browser history's places, so a phone's back button (and the back gesture) returns to
// the previous place in stam instead of leaving the app, and a desktop's back and forward do
// the same. A place is the world in main (an agent, a thread, an issue, Settings, Usage, the
// board), the phone's bottom-nav tab, and whether an overlay is open (the search palette, the
// Alt+A prompt, the assistant, a menu, the add panel). Moving to a new place pushes a history entry; a back
// press restores the place below, or closes an overlay first. The page's first place is left
// alone, so a back from it leaves the page as it would with no history at all.
//
// A menu or the add panel can't be rebuilt from a history entry, so going forward into one
// only ever closes it. Every push, replace, or back happens from here; the shell and the UI
// only change state, and a subscription tells us to record the new place.
import * as shell from './shell/layout'
import { closeSpawnPanel, onSpawnPanelChange, spawnPanelOpen } from './spawn'
import { hideMenu, menuOpen, onMenuChange } from './ui/menu'
import { onWorkSheetChange, setWorkSheet, workSheetOpen } from './work/sheet-state'
import { getUi, onUiChange, setUi } from './ui/state'
import { encodeUsage, getUsageState, onUsageChange, restoreUsage, usageHash } from './usage/state'

type Mobile = shell.Mobile
export interface Place {
  current: string | null
  mobile: Mobile
  search: boolean
  // The Alt+A prompt (S-1461). Optional: entries recorded before it existed have none.
  suggest?: boolean
  top: boolean
  menu: boolean
  // The image viewer's image showing, as a src; null when closed. Kept, so a forward into
  // an open viewer restores the image.
  viewer: string | null
  // The Settings section showing, while Settings is the world; null otherwise.
  section: string | null
  // The Usage page's tab, period, measure and drill scope, encoded, while Usage is the world.
  usage?: string | null
}

const SECTION_KEY = 'stam/settings-section'
let reported: string | null = null
let cur: Place | null = null
let applying = false
let scheduled = false
// The agents, threads and ITSAs visited lately, newest first: the Alt+A prompt sends them to
// /api/suggest, which ranks them higher.
const RECENT_MAX = 20
let recent: string[] = []
const visitedId = (w: string | null) => !w ? null : w.startsWith('t:') ? w.slice(2) : w.startsWith('w:itsa:') ? w.slice(7) : w.startsWith('w:') ? null : w
export function noteVisit(world: string | null) {
  const id = visitedId(world)
  if (id) recent = [id, ...recent.filter((x) => x !== id)].slice(0, RECENT_MAX)
}
export const recentIds = () => recent

// The section Settings shows, read from the key every path writes before it changes one
// (a nav click, the palette's result, InstructionsView's Edit in Settings). Settings also
// reports its section, which only tells us to look again.
function settingsSection(): string {
  try { return localStorage.getItem(SECTION_KEY) || 'assistant' } catch { return 'assistant' }
}
const place = (): Place => ({
  current: shell.currentWorld(),
  mobile: shell.phoneShows(),
  search: getUi().searchOpen,
  suggest: getUi().suggestOpen,
  top: getUi().topOpen,
  menu: menuOpen() || spawnPanelOpen() || workSheetOpen(),
  viewer: getUi().viewer?.src ?? null,
  section: shell.currentWorld() === 'w:config' ? settingsSection() : null,
  usage: shell.currentWorld() === 'w:usage' ? encodeUsage(getUsageState()) : null,
})
const eq = (a: Place, b: Place) => a.current === b.current && a.mobile === b.mobile && a.search === b.search && !!a.suggest === !!b.suggest && a.top === b.top && a.menu === b.menu && a.viewer === b.viewer && a.section === b.section && (a.usage ?? null) === (b.usage ?? null)
const anyOverlay = (p: Place) => p.search || !!p.suggest || p.top || p.menu || p.viewer !== null
// The address a place shows. Usage's state is in the hash, `#view=usage&tab=...`, so a copied link
// opens the same view; any other place drops a hash that was Usage's and leaves the rest alone.
const urlOf = (p: Place): string | undefined => {
  if (p.current === 'w:usage' && p.usage) return usageHash(getUsageState())
  if (new URLSearchParams(location.hash.slice(1)).get('view') === 'usage') return location.pathname + location.search
  return undefined
}
const isPlace = (v: unknown): v is Place => !!v && typeof v === 'object'
  && 'current' in v && 'mobile' in v && 'search' in v && 'top' in v && 'menu' in v && 'viewer' in v && 'section' in v

// Settings tells us which section it shows, so moving between them is a step of its own.
export function settingShown(section: string) {
  if (section === reported) return
  reported = section
  schedule()
}

// Applies a place: the shell's world and phone tab, the Settings section, the overlays back
// the way the entry had them, and any menu or add panel closed (they never come back).
function apply(t: Place) {
  if (t.current === 'w:config' && t.section) {
    try { localStorage.setItem(SECTION_KEY, t.section) } catch {}
  }
  if (t.current !== shell.currentWorld()) shell.showAgentWorld(t.current)
  if (t.mobile !== shell.phoneShows()) shell.phoneShow(t.mobile)
  setUi({ searchOpen: t.search, suggestOpen: !!t.suggest, topOpen: t.top, viewer: t.viewer ? { src: t.viewer, alt: '' } : null })
  if (t.current === 'w:usage' && t.usage) restoreUsage(t.usage)
  hideMenu()
  closeSpawnPanel()
  setWorkSheet(false)
  // A Settings section already on screen changes through the same event the palette uses.
  if (t.current === 'w:config' && t.section) window.dispatchEvent(new CustomEvent('stam:open-setting', { detail: { section: t.section } }))
}

function sync() {
  if (!cur) return
  const p = place()
  if (eq(p, cur)) return
  if (p.current !== cur.current) noteVisit(p.current)
  // Leaving an overlay: a plain dismiss (nothing but the overlay changed) takes its entry
  // back off the stack, while a pick that went somewhere else leaves the entry as the place.
  if (anyOverlay(cur) && !anyOverlay(p)) {
    if (p.current === cur.current && p.mobile === cur.mobile && p.section === cur.section && (p.usage ?? null) === (cur.usage ?? null)) {
      cur = p
      history.back()
      return
    }
    cur = p
    history.replaceState({ stam: p }, '', urlOf(p))
    return
  }
  cur = p
  history.pushState({ stam: p }, '', urlOf(p))
}

// Shell, UI, menu, and panel changes settle in one microtask, so a close that is also a move
// (picking a search result, a menu item that opens a world) reads as the single place it ends.
function schedule() {
  if (applying || scheduled) return
  scheduled = true
  queueMicrotask(() => { scheduled = false; sync() })
}

function onPop(e: PopStateEvent) {
  const t = (e.state as { stam?: unknown } | null)?.stam
  if (!isPlace(t)) return
  const target: Place = { ...t, menu: false }
  if (target.current !== cur?.current) noteVisit(target.current)
  cur = target
  applying = true
  apply(target)
  applying = false
}

export function init() {
  const saved = (history.state as { stam?: unknown } | null)?.stam
  cur = isPlace(saved) ? saved : place()
  noteVisit(cur.current)
  // A reload on Usage restores the tab, period, measure and scope the entry recorded.
  if (cur.current === 'w:usage' && cur.usage) restoreUsage(cur.usage)
  history.replaceState({ stam: cur }, '', urlOf(cur))
  shell.onChange(schedule)
  onUiChange(schedule)
  onMenuChange(schedule)
  onSpawnPanelChange(schedule)
  onWorkSheetChange(schedule)
  onUsageChange(schedule)
  addEventListener('popstate', onPop)
}
