// The daemon's live event stream (GET /api/live, S-456): one SSE connection per web client,
// read with a fetch like the layout stream (shell/layout.ts) because EventSource can't send
// the token header. Events reach the store (store.ts) for the system view (epic S-445). A
// break reconnects with exponential backoff: 1 s up to 30 s, reset when a connection opens.
import { token } from './api'

// One event off the stream: its `event:` name and the JSON of its `data:` lines.
export interface LiveEvent { type: string; data: unknown }

const MIN_WAIT = 1000
const MAX_WAIT = 30_000

// The server-sent events complete in `buf`, and what's left to read. A block with no
// `event:` line is a comment (`: connected`, `: ping`) and is dropped; several `data:`
// lines join with a newline, as the format says. CRLF and lone CR line endings normalise
// to LF first, so a proxy that rewrites them doesn't break a block.
export function parseLiveEvents(buf: string): { events: LiveEvent[]; rest: string } {
  const events: LiveEvent[] = []
  buf = buf.replace(/\r\n?/g, '\n')
  let i: number
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const block = buf.slice(0, i)
    buf = buf.slice(i + 2)
    let type = ''
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) type = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
    if (!type) continue
    const raw = data.join('\n')
    let parsed: unknown = {}
    if (raw) {
      try { parsed = JSON.parse(raw) } catch { continue }
    }
    events.push({ type, data: parsed })
  }
  return { events, rest: buf }
}

export interface LiveOptions {
  // A fetch to use instead of the global one (the tests drive the backoff with this).
  fetch?: typeof fetch
  minWait?: number
  maxWait?: number
}

// A live stream. `start` opens it once and keeps it open; `connected` says whether a
// connection is open now; the listeners hear events and connection changes.
export interface Live {
  start(): void
  stop(): void
  connected(): boolean
  onEvent(cb: (e: LiveEvent) => void): () => void
  onConnection(cb: (connected: boolean) => void): () => void
}

export function createLive(opts: LiveOptions = {}): Live {
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const minWait = opts.minWait ?? MIN_WAIT
  const maxWait = opts.maxWait ?? MAX_WAIT
  let connected = false
  let started = false
  let stopped = false
  const eventListeners = new Set<(e: LiveEvent) => void>()
  const connListeners = new Set<(connected: boolean) => void>()
  // The open request (to abort it) and the backoff timer (to clear it), both for stop().
  let controller: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let wake: (() => void) | undefined

  const setConnected = (next: boolean) => {
    if (next === connected) return
    connected = next
    for (const fn of connListeners) fn(next)
  }

  // Wait before the next attempt, waking at once if stop() arrives.
  function sleep(ms: number): Promise<void> {
    return new Promise((res) => {
      wake = res
      timer = setTimeout(() => { timer = undefined; wake = undefined; res() }, ms)
    })
  }

  // Opens the stream and keeps it open, reconnecting after a break. A connection resets the
  // wait to `minWait`; a failure doubles it, capped at `maxWait`.
  async function follow(): Promise<void> {
    let wait = minWait
    while (!stopped) {
      const abort = new AbortController()
      controller = abort
      try {
        const r = await doFetch('/api/live', { headers: { authorization: 'Bearer ' + token, 'x-stam-human': '1' }, signal: abort.signal })
        if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`)
        const reader = r.body.pipeThrough(new TextDecoderStream()).getReader()
        setConnected(true)
        wait = minWait
        let buf = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done || stopped) break
          const { events, rest } = parseLiveEvents(buf + value)
          buf = rest
          for (const e of events) for (const fn of eventListeners) fn(e)
        }
      } catch {}
      setConnected(false)
      if (stopped) return
      await sleep(wait)
      wait = Math.min(wait * 2, maxWait)
    }
  }

  return {
    start() { if (started) return; started = true; void follow() },
    stop() {
      stopped = true
      controller?.abort()
      if (timer) { clearTimeout(timer); timer = undefined }
      const w = wake; wake = undefined; w?.()
      setConnected(false)
    },
    connected: () => connected,
    onEvent(cb) { eventListeners.add(cb); return () => { eventListeners.delete(cb) } },
    onConnection(cb) { connListeners.add(cb); return () => { connListeners.delete(cb) } },
  }
}

// The page's one stream. `startLive` at boot (main.tsx); `liveConnected` tells the fallback
// polls whether to slow down; `onLiveEvent` hands every event to the store.
const live = createLive()
export const startLive = () => live.start()
export const liveConnected = () => live.connected()
export const onLiveEvent = (cb: (e: LiveEvent) => void) => live.onEvent(cb)
export const onLiveConnection = (cb: (connected: boolean) => void) => live.onConnection(cb)
