// Saved views kept in stam settings (S-293): a record of named values under one settings field,
// written as the human, so a view made on one device follows the user to the others. Each write is a
// partial patch the daemon applies to the file in one step, and a view record merges per id there,
// so a page sends only the views it changed and never overwrites another page's. Writes are
// debounced and serialized; a write still waiting when the page hides or closes is sent with
// keepalive. The first load moves this browser's old copy (its localStorage key) into settings,
// filling only the ids the server doesn't have, then never reads that copy again.
import { api, sendAsHuman } from './api'

export interface SettingsRecord<T> {
  // Every view in the record, from settings (after this browser's copy has moved in).
  load(): Promise<Record<string, T>>
  // This page's copy of one view, or null before load has read it.
  cached(key: string): T | null
  // This page's copy of every view.
  all(): Record<string, T>
  // Sets one view on this page now, and writes it to settings after a short pause. Nothing is
  // sent when the view is what settings already hold.
  save(key: string, value: T): void
  // Deletes one view, the same way.
  remove(key: string): void
  // Writes one view now only where settings lack its id (the daemon keeps an id it has), then reads what
  // settings hold, so this page's copy matches. For a seed that must not overwrite an edit.
  fill(key: string, value: T): Promise<void>
  // Reads the views again, so a change another page made shows here; a change this page has not sent yet stays.
  refresh(): Promise<void>
}

export interface SettingsRecordOptions<T> {
  // The settings field holding the record.
  field: string
  // The localStorage key of this browser's copy from before settings held the views.
  legacy: string
  // Turns a stored value into a T; anything it can't read takes its defaults. `key` is the view's id, for a record whose defaults differ by id.
  clean: (x: unknown, key: string) => T
  // Turns the browser's copy into a record of raw values; the default reads it as one.
  fromLegacy?: (raw: unknown) => Record<string, unknown>
  // Called once the browser's copy has moved in, with the copy as stored (for what stays on this device).
  migrated?: (raw: unknown) => void
}

const WRITE_DELAY_MS = 500
const SETTINGS = '/api/config/settings'

export function settingsRecord<T>(o: SettingsRecordOptions<T>): SettingsRecord<T> {
  const movedKey = `stam/moved:${o.field}`
  // What this page shows, once loaded; `dirty` holds the views not yet sent (null is a delete).
  let views: Record<string, T> | null = null
  let reading: Promise<Record<string, T>> | null = null
  const dirty = new Map<string, T | null>()
  // The last value of each view the daemon holds, as JSON (read or sent), so an unchanged view isn't sent again.
  const sent = new Map<string, string>()
  const asJson = (v: T | null) => (v === null ? null : JSON.stringify(v))
  // Records what a batch sent: the daemon holds it now.
  const holds = (batch: Map<string, T | null>) => { for (const [k, v] of batch) { if (v === null) sent.delete(k); else sent.set(k, JSON.stringify(v)) } }
  let timer: ReturnType<typeof setTimeout> | undefined
  // One write at a time, so two never interleave on the daemon.
  let queue: Promise<void> = Promise.resolve()

  const valuesIn = (settings: Record<string, unknown>): Record<string, T> => {
    const v = settings[o.field]
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, o.clean(x, k)]))
  }

  // This browser's storage can refuse access (private windows, blocked site data); then nothing is moved.
  const moved = () => { try { return localStorage.getItem(movedKey) !== null } catch { return true } }
  const readRaw = (): unknown => {
    try { return JSON.parse(localStorage.getItem(o.legacy) ?? 'null') } catch { return null }
  }
  const legacyRecord = (raw: unknown): Record<string, unknown> => {
    if (!raw || typeof raw !== 'object') return {}
    return o.fromLegacy ? o.fromLegacy(raw) : raw as Record<string, unknown>
  }
  const patch = (body: { patch: Record<string, unknown>; fill?: boolean }) => api('PATCH', SETTINGS, body)

  // Moves this browser's copy in, once. Ids the server already has keep the server's value.
  async function move(server: Record<string, T>): Promise<Record<string, T>> {
    if (moved()) return server
    const raw = readRaw()
    const legacy = legacyRecord(raw)
    const keys = Object.keys(legacy)
    if (keys.length) {
      const values = Object.fromEntries(keys.map((k) => [k, o.clean(legacy[k], k)]))
      try {
        await patch({ patch: { [o.field]: values }, fill: true })
      } catch (e) {
        // A non-home daemon refuses to add shared views (S-398): the move is marked done, so it isn't
        // retried on every load, and this browser keeps its copy and shows it.
        if ((e as { status?: number }).status !== 409) throw e
        try { localStorage.setItem(movedKey, '1') } catch {}
        return { ...Object.fromEntries(keys.map((k) => [k, o.clean(legacy[k], k)])), ...server }
      }
    }
    try { localStorage.setItem(movedKey, '1'); localStorage.removeItem(o.legacy) } catch {}
    if (raw) o.migrated?.(raw)
    return { ...Object.fromEntries(keys.map((k) => [k, o.clean(legacy[k], k)])), ...server }
  }

  async function fetchRecord(): Promise<Record<string, T>> {
    const merged = await move(valuesIn(JSON.parse((await api<{ text: string }>('GET', SETTINGS)).text)))
    // What the daemon holds now, moved-in views included: the base for the next unchanged check.
    sent.clear()
    holds(new Map(Object.entries(merged)))
    return merged
  }

  // A read queued behind the writes in flight, so its reply reflects them and can't rebuild the views from before them.
  function readQueued(): Promise<Record<string, T>> {
    const done = queue.then(fetchRecord)
    queue = done.then(() => {}, () => {})
    return done
  }

  // Sends what is waiting, as one patch of the view record.
  function enqueue(): Promise<void> {
    queue = queue.then(async () => {
      if (!dirty.size) return
      const batch = new Map(dirty)
      dirty.clear()
      // Recorded as sent before the response, so a change made while this is in flight is compared
      // with it, not with what the daemon held before.
      holds(batch)
      try {
        await patch({ patch: { [o.field]: Object.fromEntries(batch) } })
      } catch {
        // Unknown whether the daemon took it: the next change to these views sends them again.
        for (const [k, v] of batch) { sent.delete(k); if (!dirty.has(k)) dirty.set(k, v) }
      }
    })
    return queue
  }

  // The page is closing or hidden before the debounce ends: send what is waiting now.
  const leave = () => {
    clearTimeout(timer)
    if (!dirty.size) return
    const batch = new Map(dirty)
    dirty.clear()
    holds(batch)
    sendAsHuman('PATCH', SETTINGS, { patch: { [o.field]: Object.fromEntries(batch) } })
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', leave)
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') leave() })
  }

  const change = (key: string, value: T | null) => {
    if (views) { if (value === null) delete views[key]; else views[key] = value }
    // The daemon's value is what was last sent or read: a change back to it cancels a waiting write.
    if (asJson(value) === (sent.get(key) ?? null)) { dirty.delete(key); return }
    dirty.set(key, value)
    clearTimeout(timer)
    timer = setTimeout(() => void enqueue(), WRITE_DELAY_MS)
  }

  return {
    load() {
      reading ??= readQueued().then((v) => {
        // Changes made before the load finished stay on top of what settings had.
        views = { ...v }
        for (const [k, x] of dirty) { if (x === null) delete views[k]; else views[k] = x }
        return views
      }, (e) => { reading = null; throw e })
      return reading
    },
    async refresh() {
      const v = await readQueued()
      // Like load: what this page has not sent yet stays on top of what settings hold.
      views = { ...v }
      for (const [k, x] of dirty) { if (x === null) delete views[k]; else views[k] = x }
    },
    cached(key) {
      return views?.[key] ?? null;
    },
    all() {
      return views ?? {};
    },
    save(key, value) {
      change(key, value);
    },
    remove(key) {
      change(key, null);
    },
    fill(key, value) {
      // Queued behind the writes in flight, so the reply reflects them: a debounced batch still waiting
      // can't be lost by rebuilding the views from a reply that misses it.
      const done = queue.then(async () => {
        let reply: { text?: string } | undefined;
        try {
          reply = await patch({ patch: { [o.field]: { [key]: value } }, fill: true }) as { text?: string } | undefined;
        } catch (e) {
          // A peer daemon refuses until the home daemon has seeded (S-398): this page keeps what it has.
          if ((e as { status?: number }).status === 409) return;
          throw e;
        }
        if (!reply?.text) return;
        const now = valuesIn(JSON.parse(reply.text));
        sent.clear();
        holds(new Map(Object.entries(now)));
        views = { ...now };
        for (const [k, x] of dirty) { if (x === null) delete views[k]; else views[k] = x; }
      });
      queue = done.catch(() => {});
      return done;
    },
  };
}
