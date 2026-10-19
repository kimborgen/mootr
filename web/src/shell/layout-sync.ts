// The web's copy of the daemon's layout (src/layout.ts): worlds, panes, tabs, and the
// current world, shared by every client. A change applies to the copy at once and goes to
// the daemon as ops; the daemon's layout, from its stream or a reply, is the truth, and
// replaces the copy whenever no change of ours is still on its way. Ops are intents ("open
// usage beside pane X"), applied to whatever the daemon has then, so they're sent without
// a base: a refused base would only make us send the same op again. An op that no longer
// applies there (its pane went) is refused, and the daemon's layout shows instead.
// While the daemon can't be reached, changes wait in order and go when the stream is back.
// No DOM and no fetch here: layout.ts gives it a way to send.
import { apply, type Layout, type LayoutOp } from '../../../src/layout-ops.ts'

// The daemon refused a request (HTTP 4xx): it's dropped, not sent again. Any other failure
// (no network, a 5xx) means the daemon couldn't take it: the queue waits and sends it again.
export class Refused extends Error {}

export interface SyncDeps {
  // Sends a batch of ops with its id; resolves to the daemon's layout after them. A batch
  // the daemon already applied (its reply was lost) is answered without applying it again.
  send: (ops: LayoutOp[], batch: string) => Promise<Layout>
  // Called whenever the copy changes.
  changed: (l: Layout) => void
  newId: () => string
}

// One request in the queue: a batch of ops, or another call (the one-time move). `done`
// hears whether the daemon took it or refused it.
interface Item { task: () => Promise<Layout>; done?: (ok: boolean) => void }

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))

export class LayoutSync {
  // The newest layout the daemon sent (highest version); null before the first.
  server: Layout | null = null
  // What the UI shows: the daemon's layout, plus our changes it hasn't confirmed yet.
  view: Layout
  online = false
  // Our requests, oldest first. The head is sent; the rest wait for it, so a batch never
  // overtakes one it builds on. A failed head stays, and the queue waits for the stream.
  private queue: Item[] = []
  private sending = false
  // After a failed send, the next try waits this long (doubling, up to 10 s); 0 when the
  // last send went through.
  private backoff = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private deps: SyncDeps
  constructor(start: Layout, deps: SyncDeps) { this.view = clone(start); this.deps = deps }

  // Applies ops to the copy and queues them. New panes get ids from newId, and the ops carry
  // them, so the daemon's panes get the same ids. Returns false, changing nothing, when an
  // op doesn't apply.
  exec(ops: LayoutOp[]): boolean {
    let next = this.view
    const sent: LayoutOp[] = []
    try {
      for (const op of ops) {
        const ids: string[] = []
        next = apply(next, op, () => { const id = this.deps.newId(); ids.push(id); return id })
        sent.push(ids.length ? { ...op, ids } : op)
      }
    } catch (e) {
      console.warn('layout:', (e as Error).message)
      return false
    }
    this.view = next
    this.deps.changed(next)
    const batch = 'b' + this.deps.newId()
    this.run(() => this.deps.send(sent, batch))
    return true
  }

  // Queues a request to the daemon behind ours. The copy keeps our changes until the queue
  // is empty.
  run(task: () => Promise<Layout>, done?: (ok: boolean) => void) {
    this.queue.push({ task, done })
    void this.pump()
  }
  pending() { return this.queue.length }

  private async pump() {
    if (this.sending) return
    this.sending = true
    try {
      while (this.online && this.queue.length) {
        const head = this.queue[0]
        try {
          this.take(await head.task())
          this.backoff = 0
          this.queue.shift()
          head.done?.(true)
        } catch (e) {
          if (!(e instanceof Refused)) { this.later(); break }
          // It no longer applies there: drop it; the daemon's layout shows once the queue empties.
          console.warn('layout: refused:', e.message)
          this.queue.shift()
          head.done?.(false)
        }
      }
    } finally {
      this.sending = false
    }
    this.settle()
  }

  // The head failed: try again later, or when the stream comes back.
  private later() {
    this.backoff = Math.min(this.backoff ? this.backoff * 2 : 1000, 10_000)
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; void this.pump() }, this.backoff)
  }

  // A layout from the daemon's stream. The first after a break sends what waited.
  receive(l: Layout) {
    this.take(l)
    if (!this.online) {
      this.online = true
      this.backoff = 0
      void this.pump()
    }
    this.settle()
  }
  disconnected() { this.online = false }

  private take(l: Layout) {
    if (!this.server || l.version >= this.server.version) this.server = l
  }
  private settle() {
    if (this.queue.length || this.sending || !this.server) return
    if (JSON.stringify(this.view) === JSON.stringify(this.server)) return
    this.view = clone(this.server)
    this.deps.changed(this.view)
  }
}

// Server-sent events: the `layout` events complete in `buf`, and what's left to read.
export function parseEvents(buf: string): { layouts: Layout[]; rest: string } {
  const layouts: Layout[] = []
  let i: number
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const block = buf.slice(0, i)
    buf = buf.slice(i + 2)
    const lines = block.split('\n')
    if (!lines.includes('event: layout')) continue
    const data = lines.filter((x) => x.startsWith('data: ')).map((x) => x.slice(6)).join('\n')
    try { layouts.push(JSON.parse(data)) } catch {}
  }
  return { layouts, rest: buf }
}
