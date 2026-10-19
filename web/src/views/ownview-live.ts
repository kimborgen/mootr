// What an open own view (OwnView.tsx) knows live about its agent, for the chrome around it:
// whether the turn runs or waits on a permission (the agent's tab icon and the phone's
// bottom navigation show it), how to stop the turn (the prompt input's send button becomes
// Stop), and why the last stop failed (a line under the prompt input). The view stream is
// fresher than the agent list, so its word wins while the view is open.
import { useSyncExternalStore } from 'react'

export interface Live { running: boolean; asking: boolean; stop: (() => void) | null; stopError: string }

const live = new Map<string, Live>()
const ls = new Set<() => void>()
const changed = () => { for (const f of ls) f() }

export function setLive(id: string, v: Live) {
  const was = live.get(id)
  if (was && was.running === v.running && was.asking === v.asking && was.stop === v.stop && was.stopError === v.stopError) return
  live.set(id, v)
  changed()
}
export function clearLive(id: string) {
  if (!live.has(id)) return
  live.delete(id)
  changed()
}
export const getLive = (id: string) => live.get(id)
const subscribe = (f: () => void) => { ls.add(f); return () => { ls.delete(f) } }
export const useLive = (id: string | undefined) => useSyncExternalStore(subscribe, () => (id ? live.get(id) : undefined))

// An agent's state with the open view's word on top: a running turn is working, a waiting
// permission blocked; otherwise the agent list's state stands.
export const liveState = (state: string, l: Live | undefined) => (l?.asking ? 'blocked' : l?.running && state !== 'blocked' && state !== 'errored' ? 'working' : state)
