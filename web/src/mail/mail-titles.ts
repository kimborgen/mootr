// Mail titles and summaries shown again (S-1843): a mail on screen whose title or summary was made with
// another model or prompt (or none) is asked for, through POST /api/mail-titles, once. The daemon answers
// with the mails still being made; until one lands its old text shows, and the view asks again for it while
// it is still on screen, then refreshes the mail list when it has landed. With the step off the daemon names
// none, so nothing waits or is asked.
import { useEffect, type RefObject } from 'react'
import { api } from '../api'
import { refreshSlow } from '../store'

// How long before a mail still being made is asked about again, and how many mails one request names.
const RETRY_MS = 3000
const BATCH = 40

// The mails already asked about in this session, and those the daemon said are still being made.
const asked = new Set<string>()
const pendingIds = new Set<string>()
const watched = new Map<Element, string>()
const visible = new Set<Element>()
let observer: IntersectionObserver | null = null
let timer: ReturnType<typeof setTimeout> | undefined
// One request at a time: a flush that comes while one is in flight runs again once it has answered.
let flushing = false
let again = false
const observable = () => typeof IntersectionObserver !== 'undefined'

// Watches the element that draws mail `id` while it is mounted; the mail is asked for once it shows.
export function useWatchMailTitle(id: string, el: RefObject<Element | null>): void {
  useEffect(() => {
    const node = el.current
    if (!node || !observable()) return
    observer ??= new IntersectionObserver(onIntersect)
    watched.set(node, id)
    observer.observe(node)
    return () => { observer?.unobserve(node); watched.delete(node); visible.delete(node) }
  }, [id, el])
}

function onIntersect(list: IntersectionObserverEntry[]): void {
  for (const x of list) {
    if (x.isIntersecting) visible.add(x.target)
    else visible.delete(x.target)
  }
  schedule(0)
}

// `retry`: this is the retry timer, so mails still pending are sent again with the fresh ones. Any other
// flush sends only mails never asked about, so a pending batch is never re-sent before its timer.
function schedule(ms: number, retry = false): void {
  clearTimeout(timer)
  timer = setTimeout(() => { timer = undefined; void flush(retry) }, ms)
}

// The mails on screen now, by id.
function onScreen(): Set<string> {
  const ids = new Set<string>()
  for (const el of visible) {
    const id = watched.get(el)
    if (id) ids.add(id)
  }
  return ids
}

// Asks for the mails on screen not yet asked about; on the retry timer, the mails still being made too.
async function flush(retry = false): Promise<void> {
  if (flushing) {
    again = true
    return
  }
  const shown = onScreen()
  // A mail that left the screen is no longer retried; it is asked again when it shows.
  for (const id of pendingIds) {
    if (!shown.has(id)) {
      pendingIds.delete(id)
      asked.delete(id)
    }
  }
  const fresh = [...shown].filter((id) => !asked.has(id))
  const sent = [...fresh, ...(retry ? pendingIds : [])].slice(0, BATCH)
  if (!sent.length) {
    if (pendingIds.size) schedule(RETRY_MS, true)
    return
  }
  for (const id of sent) asked.add(id)
  flushing = true
  let r: { enabled?: boolean; pending?: string[] }
  try {
    r = await api<{ enabled?: boolean; pending?: string[] }>('POST', '/api/mail-titles', { ids: sent })
  } catch {
    // Unreachable or refused: a mail still on screen is asked again when it next shows.
    for (const id of sent) { asked.delete(id); pendingIds.delete(id) }
    return
  } finally {
    flushing = false
  }
  const still = new Set(r.pending ?? [])
  // A mail that was being made, was asked about now, and isn't pending now has its new text stored.
  const landed = sent.some((id) => pendingIds.has(id) && !still.has(id))
  for (const id of sent) pendingIds.delete(id)
  for (const id of still) pendingIds.add(id)
  if (landed) void refreshSlow()
  // Mails on screen not yet asked go next, at once; the pending ones wait for the retry timer.
  const unasked = [...onScreen()].some((id) => !asked.has(id))
  if (unasked || again) {
    again = false
    schedule(0)
  } else if (pendingIds.size) schedule(RETRY_MS, true)
}

// The settings were saved: a mail not yet answered is asked for again once it shows (S-1843).
export function rearmMailTitles(): void {
  asked.clear()
  pendingIds.clear()
  if (visible.size) schedule(0)
}

// For tests: the state back to a fresh session.
export function resetMailTitles(): void {
  asked.clear()
  pendingIds.clear()
  watched.clear()
  visible.clear()
  observer?.disconnect()
  observer = null
  clearTimeout(timer)
  timer = undefined
  flushing = false
  again = false
}
