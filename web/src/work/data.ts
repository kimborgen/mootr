// The Work page's extra facts, polled apart from the ITSAs: the issue costs (GET
// /api/usage/issues, at most once a minute), the activity per ITSA (GET /api/activity?by=itsa,
// S-226), and the PR state of each GitHub link (GET /api/watch/state per subject). A failed or
// missing endpoint leaves its cells empty. The costs, activity and PR states are read only while a
// view that shows them is on screen (S-4670); the field definitions are read for the sidebar too.
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { api } from '../api'
import { fetchFields, type Field } from '../itsa/fields'
import { useViewKey, useViewShown } from '../shell/layout'
import { getData, useData } from '../store'
import type { CostMode } from '../types'
import { githubSubject, type IssueCosts, type ItsaActivityReport, type WatchState } from './links'

// The ITSA field definitions (S-369 and S-4670): the always-mounted sidebar reads only these.
export interface WorkFields {
  // null until the first read, and the last good list after a failed one.
  fields: Field[] | null
  // The fields could not be read and none are known: the page opens its saves, keeping what it can't see.
  fieldsFailed: boolean
  // The tick the last successful read of the fields started at (see nextTick).
  fieldsStart: number
}

export interface Extras { costs: IssueCosts | null; activity: ItsaActivityReport | null; watch: Record<string, WatchState> }
export interface WorkExtras extends Extras, WorkFields {}

const REFRESH_MS = 60_000
// A burst of ITSA changes (several list updates in a row) costs one fields read: a read waits this long after the last call.
const FIELDS_DEBOUNCE_MS = 300
// The activity report blocks the daemon for seconds at today's scale (S-2094), so it is read at most every ten minutes, and on a forced refresh.
const ACTIVITY_MS = 10 * 60_000
let lastActivity = 0
let extras: Extras = { costs: null, activity: null, watch: {} }
const listeners = new Set<() => void>()
const notify = () => { for (const fn of listeners) fn() }
let last = 0
let inFlight = false
// The cost unit the costs were fetched in: a unit changed in Settings (even while Work is unmounted) makes them stale.
let costsFor: CostMode | null = null

export const getWorkExtras = () => extras

// Every GitHub subject the ITSAs' links name, once each.
export function subjectsOf(itsas: { links?: { url: string }[] }[]): string[] {
  const s = new Set<string>()
  for (const it of itsas) for (const l of it.links ?? []) {
    const subj = githubSubject(l.url)
    if (subj) s.add(subj)
  }
  return [...s]
}

// A counter for ordering events: a page takes one when its stored layout is read, and a fields read
// takes one when it starts, so a fresh read is one that started after the layout was read.
let seq = 0
export const nextTick = () => ++seq

// The field definitions, a store of their own so the sidebar's subscribers don't re-render on a cost read.
let fieldsState: WorkFields = { fields: null, fieldsFailed: false, fieldsStart: 0 }
const fieldsListeners = new Set<() => void>()
let fieldsPoll: ReturnType<typeof setInterval> | undefined
let fieldsTimer: ReturnType<typeof setTimeout> | undefined
const notifyFields = () => { for (const fn of fieldsListeners) fn() }
// One poll for every subscriber: it runs while any is mounted.
const subscribeFields = (fn: () => void) => {
  fieldsListeners.add(fn)
  fieldsPoll ??= setInterval(() => void refreshFields(), REFRESH_MS)
  return () => {
    fieldsListeners.delete(fn)
    if (!fieldsListeners.size && fieldsPoll !== undefined) { clearInterval(fieldsPoll); fieldsPoll = undefined }
  }
}
export const getWorkFields = () => fieldsState

// Reads the field definitions so a column added in Settings shows at once. A call that isn't forced
// waits FIELDS_DEBOUNCE_MS after the last one, so a burst of ITSA changes costs one read; a forced
// call (a save, a page load) reads now and drops the wait. The fields change only when the
// definitions do, or when a read newer than the one before succeeds (`fieldsStart`, the tick it
// started at). A failed read keeps the last good list.
export function refreshFields(force = false): Promise<void> {
  clearTimeout(fieldsTimer)
  fieldsTimer = undefined
  if (!force) {
    fieldsTimer = setTimeout(() => { fieldsTimer = undefined; void readFields() }, FIELDS_DEBOUNCE_MS)
    return Promise.resolve()
  }
  return readFields()
}

// A call during a read is run again after it, so a read requested after something happened always starts after it.
let fieldsInFlight = false
let fieldsAgain = false
async function readFields(): Promise<void> {
  if (fieldsInFlight) { fieldsAgain = true; return }
  fieldsInFlight = true
  try {
    do {
      fieldsAgain = false
      const started = nextTick()
      const fields = await fetchFields().catch(() => null)
      const cur = fieldsState
      if (fields) {
        const same = JSON.stringify(fields) === JSON.stringify(cur.fields)
        fieldsState = { fields: same ? cur.fields : fields, fieldsFailed: false, fieldsStart: started }
        notifyFields()
      } else if (!cur.fields && !cur.fieldsFailed) { fieldsState = { ...cur, fieldsFailed: true }; notifyFields() }
    } while (fieldsAgain)
  } finally {
    fieldsInFlight = false
  }
}

// Fetches the endpoints now, unless a fetch ran within the last minute and the costs are in the
// Settings unit. The watch answers per subject; one that fails is left out.
export async function refreshWorkExtras(force = false) {
  const stale = costsFor !== getData().costMode
  if (inFlight || (!force && !stale && Date.now() - last < REFRESH_MS)) return
  // A hidden tab reads nothing (S-2094); it catches up when it shows again.
  if (!force && typeof document !== 'undefined' && document.hidden) return
  inFlight = true
  last = Date.now()
  try {
    const unit = getData().costMode
    const costs = await api<IssueCosts>('GET', '/api/usage/issues?days=7').catch(() => null)
    costsFor = unit
    const due = force || Date.now() - lastActivity >= ACTIVITY_MS
    if (due) lastActivity = Date.now()
    const activity = due ? await api<ItsaActivityReport>('GET', '/api/activity?by=itsa').catch(() => extras.activity) : extras.activity
    const subjects = subjectsOf(getData().itsas)
    const pairs = await Promise.all(subjects.map(async (s) => {
      const w = await api<WatchState>('GET', `/api/watch/state?subject=${encodeURIComponent(s)}`).catch(() => null)
      return [s, w] as const
    }))
    const watch: Record<string, WatchState> = {}
    for (const [s, w] of pairs) if (w) watch[s] = w
    extras = { ...extras, costs, activity, watch }
    notify()
  } finally {
    inFlight = false
    // A unit switched while this fetch ran was missed by it: fetch again.
    if (costsFor !== getData().costMode) void refreshWorkExtras(true)
  }
}

// The instances whose view is on screen now: one shared poll runs while any is.
const shownUsers = new Set<object>()
let extrasPoll: ReturnType<typeof setInterval> | undefined
function wantExtras(me: object, on: boolean) {
  if (on) shownUsers.add(me)
  else shownUsers.delete(me)
  if (shownUsers.size && extrasPoll === undefined) extrasPoll = setInterval(() => void refreshWorkExtras(), REFRESH_MS)
  else if (!shownUsers.size && extrasPoll !== undefined) { clearInterval(extrasPoll); extrasPoll = undefined }
}
const subscribeExtras = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }

// The field definitions only, for a caller that never draws the costs, activity or PR states (the sidebar tree).
export function useWorkFields(): WorkFields {
  const { itsas } = useData()
  const snap = useSyncExternalStore(subscribeFields, getWorkFields)
  useEffect(() => { void refreshFields() }, [itsas])
  return snap
}

// The extras and the fields. The costs, activity and PR states are read only while the view that draws them
// is on screen, and not while the tab is hidden. That view is `viewKey`, else the view the component renders
// in (ViewKeyContext); outside any view (a story, a test) they are read while mounted.
export function useWorkExtras(viewKey?: string): WorkExtras {
  const { itsas, costMode } = useData()
  const inView = useViewKey()
  const shown = useViewShown(viewKey ?? inView)
  const snap = useSyncExternalStore(subscribeExtras, getWorkExtras)
  const fields = useWorkFields()
  useEffect(() => {
    if (!shown) return
    const me = {}
    wantExtras(me, true)
    void refreshWorkExtras()
    const visible = () => { if (!document.hidden) void refreshWorkExtras() }
    document.addEventListener('visibilitychange', visible)
    return () => { wantExtras(me, false); document.removeEventListener('visibilitychange', visible) }
  }, [shown])
  // The ITSAs and the cost unit change what the costs and PR states name: refresh them now, while shown.
  useEffect(() => { if (shown) void refreshWorkExtras() }, [itsas, costMode, shown])
  return useMemo(() => ({ ...snap, ...fields }), [snap, fields])
}
