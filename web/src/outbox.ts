// The outbox (S-373): a prompt input clears the moment the human sends, and the message waits
// here as a row while its request runs. Rows to one target go out in order, one at a time. A
// network error, a timeout or a 5xx retries with backoff while the row stays pending; a 4xx,
// or RETRY_WINDOW_MS of failed attempts, makes it failed, and the human can click it to put
// the message back in the box. Each row carries the send function bound at submit and a
// client id the daemon dedups on, so a retry after a lost answer doesn't send twice. Rows live
// in IndexedDB so a reload keeps them; no send function survives a reload, so a row that was
// pending comes back failed (sending it blind could type the prompt twice). Each row is its own
// record and names the tab that owns it: a tab only adopts rows of its own earlier page (same
// tab id, kept in sessionStorage) or of a tab that has closed, never those of a live tab.
import { useMemo, useSyncExternalStore } from 'react'
import { ApiError } from './api'
import type { UploadFile } from './types'

export interface OutboxFile extends UploadFile { url: string }
export type RowKind = 'pending' | 'failed' | 'draft'
export interface OutboxRow {
  id: string
  // The prompt input's target key; a strip shows the rows of its box's current key.
  key: string
  // `draft` is reserved for a draft kept aside by hand (S-374).
  kind: RowKind
  text: string
  files: OutboxFile[]
  mode: 'direct' | 'mail' | 'note'
  // Agent ids a mail also goes to (Mail mode's cc row); kept so a put-back or a reload keeps them.
  cc?: string[]
  // The ITSA the mail is filed on, picked as a cc pill (S-1464); kept for a put-back as cc is.
  itsa?: { id: string; title: string }
  // The tab that owns the row (tabId below).
  tab?: string
  // The target's name.
  target?: string
  // When it failed.
  failedAt?: number
  // Shown instead of the first line once known (a mail's title).
  title?: string
  // What the box that made the row wants back with it on a put-back (the Alt+A prompt's pick).
  meta?: unknown
  error?: string
  created: number
  attempts: number
}
// Sends once; `clientId` goes into the request body as `client_id`. It throws to say it failed.
export type SendFn = (clientId: string) => Promise<unknown>
// Storage: one record per row. `live` says whether a tab id belongs to an open tab.
export interface Persist {
  load(): Promise<OutboxRow[]>
  apply(puts: OutboxRow[], removes: string[]): Promise<void>
  live?(tab: string): Promise<boolean>
}

// Thrown for an attempt that got no answer in time; it retries like a lost connection.
export class AttemptTimeout extends Error {}

export const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000]
export const RETRY_WINDOW_MS = 60_000
export const ATTEMPT_TIMEOUT_MS = 30_000

let rows: OutboxRow[] = []
const sends = new Map<string, SendFn>()
const failedHooks = new Map<string, () => void>()
const busy = new Set<string>()
const subs = new Set<() => void>()
let persist: Persist | undefined = idbPersist()
let seq = 0
// This tab's id: kept across reloads (sessionStorage) so a reload finds its own rows again, and
// held as a Web Lock for as long as the page lives so other tabs can tell it is open.
let tabId = ''
const TAB_KEY = 'stam/outbox-tab'
const LOCK = 'stam-outbox-tab-'
const fresh = () => globalThis.crypto?.randomUUID?.() ?? `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
async function claimTab() {
  let id = ''
  try { id = sessionStorage.getItem(TAB_KEY) ?? '' } catch {}
  const locks = (globalThis.navigator as Navigator | undefined)?.locks
  for (let i = 0; i < 2; i++) {
    id ||= fresh()
    if (!locks) break
    // A duplicated tab copies sessionStorage: if another page holds this id, take a new one.
    const got = await new Promise<boolean>((ok) => { void locks.request(LOCK + id, { ifAvailable: true }, (l) => (l ? (ok(true), new Promise(() => {})) : (ok(false), undefined))) })
    if (got) break
    id = ''
  }
  try { sessionStorage.setItem(TAB_KEY, id) } catch {}
  tabId = id
  // Rows made before the id was known belong to this tab too.
  if (rows.some((r) => !r.tab)) change(rows.map((r) => (r.tab ? r : { ...r, tab: tabId })))
}

const emit = () => { for (const f of subs) f() }
let stored = new Map<string, OutboxRow>()
const change = (next: OutboxRow[]) => {
  rows = next
  emit()
  if (!persist) return
  const puts = rows.filter((r) => stored.get(r.id) !== r)
  const removes = [...stored.keys()].filter((id) => !rows.some((r) => r.id === id))
  if (!puts.length && !removes.length) return
  for (const r of puts) stored.set(r.id, r)
  for (const id of removes) stored.delete(id)
  void persist.apply(puts, removes).catch(() => {})
}
const patch = (id: string, p: Partial<OutboxRow>) => change(rows.map((r) => (r.id === id ? { ...r, ...p } : r)))
const newId = () => (globalThis.crypto?.randomUUID?.() ?? `o${Date.now().toString(36)}${(++seq).toString(36)}${Math.random().toString(36).slice(2, 8)}`)

export function getRows(key?: string): OutboxRow[] { return key === undefined ? rows : rows.filter((r) => r.key === key) }
export function subscribeOutbox(f: () => void) { subs.add(f); return () => { subs.delete(f) } }
export function useOutbox(key: string | null): OutboxRow[] {
  const all = useSyncExternalStore(subscribeOutbox, () => rows)
  return useMemo(() => all.filter((r) => r.key === key), [all, key])
}

// `id`: sends again a message put back from a failed row under its old client id, so the daemon
// answers from the first try instead of typing it twice.
export interface Submit { id?: string; key: string; target?: string; text: string; files: OutboxFile[]; mode: OutboxRow['mode']; cc?: string[]; itsa?: OutboxRow['itsa']; title?: string; meta?: unknown; send: SendFn
  // Called once if the row ends failed (not when the message is put back or succeeds).
  onFailed?: () => void }
// Adds a pending row and starts sending it (after the rows already waiting for its target).
export function submit(s: Submit): string {
  const id = s.id && !rows.some((r) => r.id === s.id) ? s.id : newId()
  sends.set(id, s.send)
  if (s.onFailed) failedHooks.set(id, s.onFailed)
  change([...rows, { id, key: s.key, target: s.target, kind: 'pending', text: s.text, files: s.files, mode: s.mode, ...(s.cc?.length ? { cc: s.cc } : {}), ...(s.itsa ? { itsa: s.itsa } : {}), ...(s.meta !== undefined ? { meta: s.meta } : {}), title: s.title, created: Date.now(), attempts: 0, tab: tabId }])
  void pump(s.key)
  return id
}
// Sets a draft aside in a target's strip. The composer's Save as draft button calls this; the
// mode is the one the box was in, so a click puts the message back in that mode.
export function addDraft(key: string, text: string, files: OutboxFile[] = [], mode: 'direct' | 'mail' = 'direct', cc: string[] = [], itsa?: OutboxRow['itsa']): string {
  const id = newId()
  change([...rows, { id, key, kind: 'draft', text, files, mode, ...(cc.length ? { cc } : {}), ...(itsa ? { itsa } : {}), created: Date.now(), attempts: 0, tab: tabId }])
  return id
}
export function setTitle(id: string, title: string) { if (rows.some((r) => r.id === id)) patch(id, { title }) }
// Takes a failed (or draft) row out, for putting it back in the box. Null if it isn't there or still pending.
export function take(id: string): OutboxRow | null {
  const r = rows.find((x) => x.id === id)
  if (!r || r.kind === 'pending') return null
  change(rows.filter((x) => x.id !== id))
  return r
}
export function dismiss(id: string) { change(rows.filter((x) => x.id !== id)) }

function fail(id: string, error: string) {
  sends.delete(id)
  patch(id, { kind: 'failed', error, failedAt: Date.now() })
  const hook = failedHooks.get(id)
  failedHooks.delete(id)
  try { hook?.() } catch {}
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
// Worth another try: a lost connection (fetch's TypeError), no answer in time, or a 5xx. Anything
// else, a 4xx or an error thrown before a request went out ("Select an agent first"), is final.
const retryable = (e: unknown) => e instanceof TypeError || e instanceof AttemptTimeout || (e instanceof ApiError && e.status >= 500)
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)) || 'Failed'

function attempt(send: SendFn, id: string): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout>
  const late = new Promise<never>((_, no) => { timer = setTimeout(() => no(new AttemptTimeout('The daemon did not answer in time')), ATTEMPT_TIMEOUT_MS) })
  return Promise.race([send(id), late]).finally(() => clearTimeout(timer))
}

// Bumped by resetOutbox: a pump or run that began before it belongs to the old outbox, so it stops
// instead of sending (a retry still sleeping would otherwise fire into the new one) or touching its rows.
let epoch = 0

// Sends one target's pending rows, oldest first. A single worker per key keeps the order.
async function pump(key: string) {
  if (busy.has(key)) return
  busy.add(key)
  const mine = epoch
  try {
    for (;;) {
      if (mine !== epoch) return
      const row = rows.find((r) => r.key === key && r.kind === 'pending')
      if (!row) return
      await run(row.id)
    }
  } finally { if (mine === epoch) busy.delete(key) }
}
async function run(id: string) {
  const send = sends.get(id)
  const started = Date.now()
  const mine = epoch
  for (let i = 0; ; i++) {
    if (mine !== epoch) return
    if (!send) return fail(id, 'Not sent: the page reloaded first')
    patch(id, { attempts: (rows.find((r) => r.id === id)?.attempts ?? 0) + 1 })
    try {
      await attempt(send, id)
      if (mine !== epoch) return
      sends.delete(id)
      failedHooks.delete(id)
      change(rows.filter((r) => r.id !== id))
      return
    } catch (e) {
      if (mine !== epoch) return
      if (!retryable(e) || Date.now() - started >= RETRY_WINDOW_MS) return fail(id, reason(e))
      patch(id, { error: reason(e) })
      await sleep(BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)])
    }
  }
}

// Starts the outbox on page load: claims this tab's id and brings back the stored rows that
// belong to it (an earlier page of this tab) or to a tab that has closed; what was pending is
// failed now. A live tab's rows stay with that tab.
export async function loadOutbox() {
  await claimTab()
  // One tab at a time looks through the stored rows and takes the ones it adopts, so two tabs
  // starting together don't both adopt a closed tab's rows.
  const locks = (globalThis.navigator as Navigator | undefined)?.locks
  if (locks) await locks.request('stam-outbox-adopt', adopt)
  else await adopt()
}
async function adopt() {
  let all: OutboxRow[] = []
  try { all = (await persist?.load()) ?? [] } catch {}
  const have = new Set(rows.map((r) => r.id))
  const liveTabs = new Map<string, boolean>()
  const mine: OutboxRow[] = []
  for (const r of all) {
    if (have.has(r.id)) continue
    const owner = r.tab ?? ''
    if (owner !== tabId) {
      if (!liveTabs.has(owner)) liveTabs.set(owner, !!owner && !!(await persist?.live?.(owner).catch(() => false)))
      if (liveTabs.get(owner)) continue
    }
    mine.push({ ...r, tab: tabId, ...(r.kind === 'pending' ? { kind: 'failed' as const, error: 'Not sent: the page reloaded first', failedAt: Date.now() } : {}) })
  }
  if (mine.length) change([...mine, ...rows])
}

// Tests: a fresh outbox with the given storage (none by default).
export function resetOutbox(p?: Persist, tab = '') {
  epoch++; rows = []; sends.clear(); failedHooks.clear(); busy.clear(); persist = p; stored = new Map(); tabId = tab; emit()
}

function idbPersist(): Persist | undefined {
  if (typeof indexedDB === 'undefined') return undefined
  const open = () => new Promise<IDBDatabase>((ok, no) => {
    const q = indexedDB.open('stam-outbox', 2)
    q.onupgradeneeded = () => {
      // Version 1 kept every row in one record; rows are records of their own now.
      if (q.result.objectStoreNames.contains('kv')) q.result.deleteObjectStore('kv')
      if (!q.result.objectStoreNames.contains('rows')) q.result.createObjectStore('rows', { keyPath: 'id' })
    }
    q.onsuccess = () => ok(q.result)
    q.onerror = () => no(q.error)
  })
  return {
    async load() {
      const db = await open()
      return new Promise<OutboxRow[]>((ok, no) => { const q = db.transaction('rows').objectStore('rows').getAll(); q.onsuccess = () => ok(q.result as OutboxRow[]); q.onerror = () => no(q.error) })
    },
    async apply(puts, removes) {
      const db = await open()
      return new Promise<void>((ok, no) => {
        const tx = db.transaction('rows', 'readwrite')
        const os = tx.objectStore('rows')
        for (const r of puts) os.put(r)
        for (const id of removes) os.delete(id)
        tx.oncomplete = () => ok()
        tx.onerror = () => no(tx.error)
      })
    },
    async live(tab) {
      const held = await (globalThis.navigator as Navigator | undefined)?.locks?.query()
      return !!held?.held?.some((l) => l.name === LOCK + tab)
    },
  }
}
