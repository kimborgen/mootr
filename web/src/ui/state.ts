// UI state that isn't layout: tree folds, the filter, the mail list's height, the Issues
// section's height, fold, and open ITSAs, and the top world.
import { useSyncExternalStore } from 'react'

export interface UiState {
  collapsed: Record<string, boolean>
  stoppedOpen: boolean
  mailH?: number
  issuesH?: number
  issuesFolded?: boolean
  // The Machines section folded to its header.
  machinesFolded?: boolean
  // ITSAs expanded in the sidebar, and whether closed roots show.
  itsaOpen: Record<string, boolean>
  closedItsasOpen?: boolean
  // The Requirements section: folded, its expanded requirements, and whether obsolete roots show.
  reqFolded?: boolean
  reqOpen?: Record<string, boolean>
  obsoleteReqOpen?: boolean
  filter: string
  treeFocus: string | null
  topOpen: boolean
  // Whom the top world writes to: 'assistant' or a chief of staff's assistant's agent id, as
  // this device last picked. Null until it picks one: the Assistant tab then opens on the default in Settings.
  topTarget: string | null
  // The search palette, open or not. Never persisted: it starts closed on every load.
  searchOpen: boolean
  // The Alt+A modal (S-1461): a prompt centred over the dimmed page that suggests where to
  // send it. Never persisted: it starts closed on every load.
  suggestOpen: boolean
  // The image viewer: the image showing full screen (S-86), or null when closed. Never
  // persisted: it starts closed on every load.
  viewer: { src: string; alt: string } | null
  // The agents whose conversation view shows in rapid-fire mode (S-1004), as this device last picked.
  rapid?: Record<string, boolean>
  // The phone Agents list's select mode (S-3282). Never persisted: it starts off on every load. The browser history
  // records it as an overlay, so Back leaves it.
  agentSelect?: boolean
}
const KEY = 'stam/ui'
let ui: UiState = { collapsed: {}, itsaOpen: {}, stoppedOpen: false, filter: '', treeFocus: null, topOpen: false, topTarget: null, searchOpen: false, suggestOpen: false, viewer: null }
try { ui = { ...ui, ...JSON.parse(localStorage.getItem(KEY) ?? '{}'), filter: '', treeFocus: null, topOpen: false, searchOpen: false, suggestOpen: false, viewer: null } } catch {}
const ls = new Set<() => void>()

export const getUi = () => ui
// Told when any UI state changes, for the parts outside React (the browser history).
export function onUiChange(fn: () => void) { ls.add(fn); return () => { ls.delete(fn) } }
export function setUi(patch: Partial<UiState>) {
  ui = { ...ui, ...patch }
  try { localStorage.setItem(KEY, JSON.stringify({ collapsed: ui.collapsed, stoppedOpen: ui.stoppedOpen, mailH: ui.mailH, topTarget: ui.topTarget, issuesH: ui.issuesH, issuesFolded: ui.issuesFolded, machinesFolded: ui.machinesFolded, itsaOpen: ui.itsaOpen, closedItsasOpen: ui.closedItsasOpen, reqFolded: ui.reqFolded, reqOpen: ui.reqOpen, obsoleteReqOpen: ui.obsoleteReqOpen, rapid: ui.rapid })) } catch {}
  for (const fn of ls) fn()
}
export const useUi = () => useSyncExternalStore((fn) => { ls.add(fn); return () => { ls.delete(fn) } }, getUi)
