// What an open own view (OwnView.tsx) knows live about its agent, for the chrome around it:
// whether the turn runs or waits on a permission (the agent's tab icon and the phone's
// bottom navigation show it), how to stop the turn (the prompt input's send button becomes
// Stop), and why the last stop failed (a line under the prompt input). The view stream is
// fresher than the agent list, so its word wins while the view is open.
import { useSyncExternalStore } from 'react'

export interface Live { running: boolean; asking: boolean; stop: (() => void) | null; stopError: string }

// Each open view of an agent keeps its own word, keyed by its owner (one per OwnView mount), so
// the same agent open in two worlds doesn't lose its Stop when one of them closes (S-1774).
const live = new Map<string, Map<object, Live>>()
const ls = new Set<() => void>()
const changed = () => { for (const f of ls) f() }

export function setLive(id: string, owner: object, v: Live) {
  const views = live.get(id) ?? new Map<object, Live>()
  const was = views.get(owner)
  if (was && was.running === v.running && was.asking === v.asking && was.stop === v.stop && was.stopError === v.stopError) return
  // Re-inserted, so the view that spoke last is the one the agent shows.
  views.delete(owner)
  views.set(owner, v)
  live.set(id, views)
  changed()
}
export function clearLive(id: string, owner: object) {
  const views = live.get(id)
  if (!views?.delete(owner)) return
  if (!views.size) live.delete(id)
  changed()
}
export const getLive = (id: string) => { let last: Live | undefined; for (const v of live.get(id)?.values() ?? []) last = v; return last }
const subscribe = (f: () => void) => { ls.add(f); return () => { ls.delete(f) } }
export const useLive = (id: string | undefined) => useSyncExternalStore(subscribe, () => (id ? getLive(id) : undefined))

// An agent's state with the open view's word on top: a running turn is working, a waiting
// permission blocked; otherwise the agent list's state stands.
export const liveState = (state: string, l: Live | undefined) => (l?.asking ? 'blocked' : l?.running && state !== 'blocked' && state !== 'errored' ? 'working' : state)
