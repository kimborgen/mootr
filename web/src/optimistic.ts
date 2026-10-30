// An optimistic change: the UI shows `apply` at once, while `send` runs. The overlay stays on
// top of each poll until the request has succeeded and a poll's data agrees (`settled`), or
// until HOLD_MS passes. A failed request drops the overlay at once and shows the error as a
// toast; the polled data then shows the truth.
import { getPolled, setOverlay, subscribe, type Data } from './store'
import { toast } from './ui/menu'

// How long a succeeded change waits for a poll to agree before its overlay is dropped anyway.
const HOLD_MS = 8000
let seq = 0

export interface Change {
  // Patches the data at once. It runs on top of the polled data, so it applies again on each poll.
  apply: (d: Data) => Data
  // The request. It throws when the daemon refuses it or can't be reached.
  send: () => Promise<unknown>
  // Whether the polled data (not the overlay) already shows the change.
  settled: (polled: Data) => boolean
  // Starts the error toast; the reason follows it, as in "Couldn't archive: <reason>". Empty: no toast, the caller reports it.
  failed: string
  // Runs once when the overlay goes: settled, failed, or timed out.
  done?: () => void
}

// Resolves true when the request succeeded, false when it failed.
export function optimistic(c: Change): Promise<boolean> {
  const id = ++seq
  setOverlay(id, c.apply)
  let off: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let dropped = false
  const drop = () => {
    off?.(); off = undefined
    clearTimeout(timer)
    setOverlay(id, null)
    if (!dropped) { dropped = true; c.done?.() }
  }
  return c.send().then(
    () => {
      if (c.settled(getPolled())) { drop(); return true }
      off = subscribe(() => { if (c.settled(getPolled())) drop() })
      timer = setTimeout(drop, HOLD_MS)
      return true
    },
    (e: unknown) => {
      drop()
      if (c.failed) toast(`${c.failed}: ${(e as Error).message}`, true)
      return false
    },
  )
}
