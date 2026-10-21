// The "While you were away" digest (S-2822, the UI half of S-20): what the Inbox card shows. `useDigest` fetches
// `/api/digest` once the Inbox mounts, and sends `/api/presence` at most once a minute while the page is visible and
// the human interacts, so the server knows the window the human was away for. A failed or missing digest, a dismissed
// window and no window at all all give null: the card hides without a word.
import { useEffect, useState } from 'react'
import { api } from '../api'

export type DigestWindow = { since: string; until: string }
export type Listed<T> = T[]
export type Digest = {
  window: DigestWindow | null
  dismissedAt: string | null
  happened: {
    merged: Listed<{ pr: number; title: string; itsa?: string; at: string }>
    closed: Listed<{ itsa: string; title: string; at: string }>
    spawned: Listed<{ agent: string; at: string }>
    archived: Listed<{ agent: string; at: string }>
    spend: { usd: number; byHarness?: Record<string, number> }
    // How many more each list holds past what the server sent.
    more?: { merged?: number; closed?: number; spawned?: number; archived?: number }
  }
  needs: Listed<{ kind: string; ref: string; title: string; since: string; new: boolean }>
  needsMore?: number
  next: {
    itsas: Listed<{ key: string; title: string; status: string; owner?: string }>
    working: Listed<{ agent: string; itsa?: string; detail?: string }>
    more?: { itsas?: number; working?: number }
  }
}

// The window last dismissed, by its `until`: a dismissal survives offline, a reload, and a dismiss call that failed.
const DISMISSED = 'digest-dismissed'
const PRESENCE_MS = 60_000

function dismissedHere(d: Digest): boolean {
  try { return localStorage.getItem(DISMISSED) === d.window?.until } catch { return false }
}

// The digest the card shows, or null: no window, dismissed, or the server says so.
export function shown(d: Digest | null): Digest | null {
  if (!d || !d.window || d.dismissedAt || dismissedHere(d)) return null
  return d
}

async function fetchDigest(): Promise<Digest | null> {
  try { return await api<Digest>('GET', '/api/digest') } catch { return null }
}

// Dismisses the card for this window: at once here, then on the server with its `until` (a failure leaves the local mark in place).
function dismiss(d: Digest) {
  const until = d.window?.until ?? ''
  try { localStorage.setItem(DISMISSED, until) } catch { /* private window: the server call still runs */ }
  void api('POST', '/api/digest/dismiss', { until }).catch(() => {})
}

// The digest for the Inbox, and a dismiss that hides it. `null` hides the card: nothing loaded, failed, or dismissed.
export function useDigest(): [Digest | null, () => void] {
  const [digest, setDigest] = useState<Digest | null>(null)
  useEffect(() => {
    let live = true
    let until: string | undefined
    const load = () => void fetchDigest().then((d) => {
      if (!live) return
      until = d?.window?.until
      setDigest(shown(d))
    })
    // Presence goes first, so the window it returns is the one the digest holds. A presence answer with a window the digest
    // doesn't hold yet reloads it. Presence is sent at most once a minute, and only while the page is visible.
    let last = 0
    const presence = (force: boolean) => {
      if (document.visibilityState !== 'visible') return Promise.resolve(null)
      const now = Date.now()
      if (!force && now - last < PRESENCE_MS) return Promise.resolve(null)
      last = now
      return api<{ window: DigestWindow | null }>('POST', '/api/presence').catch(() => null)
    }
    const reloadIfNew = (p: { window: DigestWindow | null } | null) => { if (live && p?.window && p.window.until !== until) load() }
    void presence(true).then(() => { if (live) load() })
    const act = () => void presence(false).then(reloadIfNew)
    const back = () => { if (document.visibilityState === 'visible') void presence(false).then(reloadIfNew) }
    const events = ['pointerdown', 'keydown', 'touchstart'] as const
    for (const e of events) addEventListener(e, act, { passive: true })
    document.addEventListener('visibilitychange', back)
    return () => {
      live = false
      for (const e of events) removeEventListener(e, act)
      document.removeEventListener('visibilitychange', back)
    }
  }, [])
  const dismissCurrent = () => {
    if (!digest) return
    dismiss(digest)
    setDigest(null)
  }
  return [digest, dismissCurrent]
}
