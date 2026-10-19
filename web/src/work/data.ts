// The Work page's extra facts, polled apart from the ITSAs: the issue costs (GET
// /api/usage/issues, at most once a minute), the activity per ITSA (GET /api/activity?by=itsa,
// S-226), and the PR state of each GitHub link (GET /api/watch/state per subject). A failed or
// missing endpoint leaves its cells empty.
import { useEffect, useSyncExternalStore } from 'react'
import { api } from '../api'
import { fetchFields, type Field } from '../itsa/fields'
import { getData, useData } from '../store'
import { githubSubject, type IssueCosts, type ItsaActivityReport, type WatchState } from './links'

export interface WorkExtras { costs: IssueCosts | null; activity: ItsaActivityReport | null; watch: Record<string, WatchState>
  // The ITSA field definitions (S-369): null until the first read, and the last good list after a failed one.
  fields: Field[] | null
  // The fields could not be read and none are known: the page opens its saves, keeping what it can't see.
  fieldsFailed: boolean
  // The tick the last successful read of the fields started at (see nextTick).
  fieldsStart: number
}

const REFRESH_MS = 60_000
// The activity report blocks the daemon for seconds at today's scale (S-2094), so it is read at most every ten minutes, and on a forced refresh.
const ACTIVITY_MS = 10 * 60_000
let lastActivity = 0
let extras: WorkExtras = { costs: null, activity: null, watch: {}, fields: null, fieldsFailed: false, fieldsStart: 0 }
const listeners = new Set<() => void>()
const notify = () => { for (const fn of listeners) fn() }
let last = 0
let inFlight = false

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

// Reads the field definitions: whenever the ITSAs change (so a column added in Settings shows at
// once), unthrottled since the list is small. A failed read keeps the last good list; the extras
// change only when the definitions do, or when a read newer than the one before succeeds
// (`fieldsStart`, the tick it started at). A call during a read is run again after it, so a read
// requested after something happened always starts after it.
let fieldsInFlight = false
let fieldsAgain = false
export async function refreshFields(): Promise<void> {
  if (fieldsInFlight) { fieldsAgain = true; return }
  fieldsInFlight = true
  try {
    do {
      fieldsAgain = false
      const started = nextTick()
      const fields = await fetchFields().catch(() => null)
      if (fields) {
        const same = JSON.stringify(fields) === JSON.stringify(extras.fields)
        extras = { ...extras, fields: same ? extras.fields : fields, fieldsFailed: false, fieldsStart: started }
        notify()
      } else if (!extras.fields && !extras.fieldsFailed) { extras = { ...extras, fieldsFailed: true }; notify() }
    } while (fieldsAgain)
  } finally {
    fieldsInFlight = false
  }
}

// Fetches the endpoints now, unless a fetch ran within the last minute. The watch answers
// per subject; one that fails is left out.
export async function refreshWorkExtras(force = false) {
  if (inFlight || (!force && Date.now() - last < REFRESH_MS)) return
  // A hidden tab reads nothing (S-2094); it catches up when it shows again.
  if (!force && typeof document !== 'undefined' && document.hidden) return
  inFlight = true
  last = Date.now()
  try {
    const costs = await api<IssueCosts>('GET', '/api/usage/issues?days=7').catch(() => null)
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
  }
}

// The extras, and a refresh started when the page mounts and whenever the ITSAs change.
export function useWorkExtras(): WorkExtras {
  const { itsas } = useData()
  const snap = useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn) }, getWorkExtras)
  useEffect(() => { void refreshWorkExtras(); void refreshFields() }, [itsas])
  useEffect(() => {
    const t = setInterval(() => { void refreshWorkExtras(); void refreshFields() }, REFRESH_MS)
    const shown = () => { if (!document.hidden) void refreshWorkExtras() }
    document.addEventListener('visibilitychange', shown)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', shown) }
  }, [])
  return snap
}
