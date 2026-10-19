// The requirements the web shows: whether the feature is on (`GET /api/req-enabled`, cheap and
// unauthenticated), and while it is, the tree with each requirement's latest verdicts. Polled
// with the ITSAs' slow pace; nothing is fetched beyond the flag while it is off.
import { useSyncExternalStore } from 'react'
import { api } from '../api'
import type { Requirement } from './model'

interface ReqData { enabled: boolean; reqs: Requirement[]; loaded: boolean; error: string | null }
let data: ReqData = { enabled: false, reqs: [], loaded: false, error: null }
const ls = new Set<() => void>()
const set = (patch: Partial<ReqData>) => { data = { ...data, ...patch }; for (const fn of ls) fn() }
export const getReq = () => data
export const useReq = () => useSyncExternalStore((fn) => { ls.add(fn); return () => { ls.delete(fn) } }, getReq)

let inflight: Promise<void> | null = null
// Bumped by resetReq: a read that started before it is dropped when it lands.
let epoch = 0
// Back to the start (off, nothing read, nothing in flight), for the stories page and its tests,
// where each state begins from a clean store.
export function resetReq() {
  epoch++
  inflight = null
  data = { enabled: false, reqs: [], loaded: false, error: null }
  for (const fn of ls) fn()
}
export function refreshReq(): Promise<void> {
  return (inflight ??= (async () => {
    const mine = epoch
    try {
      const { enabled } = await api<{ enabled: boolean }>('GET', '/api/req-enabled')
      if (mine !== epoch) return
      if (!enabled) { if (data.enabled || !data.loaded) set({ enabled: false, reqs: [], loaded: true, error: null }); return }
      const reqs = await api<Requirement[]>('GET', '/api/requirements?verdicts=latest')
      if (mine !== epoch) return
      if (JSON.stringify(reqs) !== JSON.stringify(data.reqs) || !data.enabled || !data.loaded || data.error) set({ enabled: true, reqs, loaded: true, error: null })
    } catch (e) {
      if (mine !== epoch) return
      if (data.error !== (e as Error).message) set({ error: (e as Error).message, loaded: true })
    } finally { if (mine === epoch) inflight = null }
  })())
}

let timer: ReturnType<typeof setInterval> | undefined
// Starts the poll; the returned function stops it (a component's effect cleanup).
export function watchReq(ms = 8000) {
  void refreshReq()
  clearInterval(timer)
  const mine = setInterval(refreshReq, ms)
  timer = mine
  return () => { clearInterval(mine); if (timer === mine) timer = undefined }
}

export const findReq = (key: string) => data.reqs.find((x) => x.key === key || x.id === key)
