// The requirements the web shows: whether the feature is on (`GET /api/req-enabled`, cheap and
// unauthenticated), and while it is, the tree with each requirement's latest verdicts. Polled
// with the ITSAs' slow pace; nothing is fetched beyond the flag while it is off.
import { useEffect, useSyncExternalStore } from 'react'
import { api } from '../api'
import { useViewKey, useViewShown } from '../shell/layout'
import { poll } from '../store'
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

// The readers of the requirements that are on screen now. One 8 s poll runs a round while the count is above
// 0 (and, through `poll`, the tab is visible); the first reader reads at once. Nothing shown, nothing polled.
let reqReaders = 0
let stopReqPoll: (() => void) | null = null
export function holdReq(ms = 8000): () => void {
  let held = true
  if (++reqReaders === 1) { if (!document.hidden) void refreshReq(); stopReqPoll = poll(() => refreshReq(), ms) }
  return () => {
    if (!held) return
    held = false
    if (--reqReaders === 0) { stopReqPoll?.(); stopReqPoll = null }
  }
}
// A reader that draws while `shown` (a view on screen, or an inline reader whose host view is): holds the poll.
export function useReqShown(shown: boolean) {
  useEffect(() => (shown ? holdReq() : undefined), [shown])
}
// For a reader that renders inside a view (ReqBatch, ItsaReqs, the views): it counts while its host view is shown.
export function useReqReader(key?: string) {
  const ctx = useViewKey()
  useReqShown(useViewShown(key ?? ctx))
}

// A reader that has no view of its own (the sidebar section) holds the poll while `el` is on screen (its
// offsetParent is null while it or an ancestor is hidden) and the tab is visible. When `el` goes from hidden
// to shown, a ResizeObserver reads at once; a tab shown again checks through the poll. The returned function stops it.
export function watchReq(el: () => HTMLElement | null, ms = 8000) {
  let release: (() => void) | null = null
  const check = () => {
    const now = !document.hidden && !!el()?.offsetParent
    if (now && !release) release = holdReq(ms)
    else if (!now && release) { release(); release = null }
  }
  check()
  const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(check)
  const target = el()
  if (target) ro?.observe(target)
  const stop = poll(() => { check(); return Promise.resolve() }, ms)
  return () => { stop(); ro?.disconnect(); release?.(); release = null }
}

export const findReq = (key: string) => data.reqs.find((x) => x.key === key || x.id === key)
