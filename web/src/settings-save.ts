// What a settings save leaves on the page (S-418). The daemon answers a PATCH of the settings
// with 200 and the file as it now stands, or with 202 {requested} when the caller is not the
// human: that is an ask to the human (S-362), and nothing was written.
import { splitPatch } from './settings-scope'

type Json = string | number | boolean | null | Json[] | { [k: string]: Json }
export type Obj = { [k: string]: Json }
export interface PatchReply { text?: string; requested?: string }

// The keys sent go back to what the daemon holds (base), so the controls don't show a value that isn't saved.
export function revertKeys(cur: Obj, base: Obj, keys: string[]): void {
  for (const k of keys) {
    if (k in base) cur[k] = JSON.parse(JSON.stringify(base[k]))
    else delete cur[k]
  }
}

// The view records the daemon merges per id (S-293): a removed view must go as a null for its id.
const VIEW_RECORDS = ['boardViews', 'workViews', 'sidebarCols', 'sidebarPanes', 'motion']
const isRec = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

// The patch for what changed from base to cur, and the top-level keys cur dropped. A view record
// carries a null for each id it dropped. The daemon has no top-level delete, so a dropped key is
// reported in `removed` and not sent.
export function buildPatch(cur: Obj, base: Obj): { patch: Obj; removed: string[] } {
  const patch: Obj = {}
  for (const k of Object.keys(cur)) {
    if (JSON.stringify(cur[k] ?? null) === JSON.stringify(base[k] ?? null)) continue
    patch[k] = cur[k]
    if (VIEW_RECORDS.includes(k) && isRec(cur[k]) && isRec(base[k])) {
      const next: Obj = { ...cur[k] }
      for (const id of Object.keys(base[k])) if (!(id in next)) next[id] = null
      patch[k] = next
    }
  }
  return { patch, removed: Object.keys(base).filter((k) => !(k in cur)) }
}

// Applies the daemon's answer to the patch sent. A 200 takes the file as it now stands: the keys
// the page didn't change take what the daemon holds, and the base becomes the file. A 202 changes
// nothing: the base stays, and the keys sent are put back to it. Returns the new base and the status.
export function settleSave(reply: PatchReply, cur: Obj, base: Obj, patch: Obj): { base: Obj; requested: boolean; requestId?: string } {
  if (reply.requested) {
    revertKeys(cur, base, Object.keys(patch))
    return { base, requested: true, requestId: reply.requested }
  }
  const now = JSON.parse(reply.text ?? 'null') as Obj | null
  if (now) for (const k of Object.keys(cur)) if (!(k in patch) && k in now) cur[k] = JSON.parse(JSON.stringify(now[k]))
  return { base: now ? JSON.parse(JSON.stringify(now)) : { ...base, ...patch }, requested: false }
}

// How a save ended: written, sent to the human as an ask (202), or refused or failed.
export type SaveOutcome = 'saved' | 'requested' | 'error'

// The note a settings editor shows after its save ends (S-418).
export function saveNote(outcome: SaveOutcome): string {
  if (outcome === 'requested') return 'Sent for approval.'
  if (outcome === 'error') return 'Not saved; see the error message.'
  return 'Saved.'
}

// A save on a peer whose page knows the home's (S-414): the shared part goes to the home first, then
// the local part to this daemon (localOnly). A home that refuses or can't be reached saves nothing.
// When the home took its part and this daemon's part fails or becomes an ask, the shared keys stay
// saved (the base moves for them, and this daemon fetches the home's copy) and the message says only
// the local part didn't save. A key mixing both parts counts as saved only when both sides took it.
export interface PeerSaveIo {
  home: (patch: Obj) => Promise<unknown>
  local: (patch: Obj) => Promise<PatchReply>
  sync: () => Promise<unknown>
}
export interface PeerSaveResult { base: Obj; outcome: SaveOutcome; message?: string; requestId?: string }
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
export async function savePeer(io: PeerSaveIo, cur: Obj, base: Obj, patch: Obj, local: string[], home: string): Promise<PeerSaveResult> {
  const parts = splitPatch(patch, base, local)
  const sharedKeys = Object.keys(parts.shared)
  const localKeys = Object.keys(parts.local)
  let next = base
  if (sharedKeys.length) {
    try {
      await io.home(parts.shared as Obj)
    } catch (e) {
      revertKeys(cur, base, Object.keys(patch))
      return { base, outcome: 'error', message: (e as Error).message }
    }
    next = { ...base }
    for (const k of sharedKeys) if (!localKeys.includes(k)) next[k] = clone(cur[k])
    await io.sync().catch(() => {})
  }
  if (!localKeys.length) {
    for (const k of sharedKeys) next[k] = clone(cur[k])
    return { base: next, outcome: 'saved' }
  }
  const partly = (why: string) => (sharedKeys.length ? `Saved on ${home}; this machine's settings ${why}` : why)
  try {
    const r = await io.local(parts.local as Obj)
    if (r.requested) {
      revertKeys(cur, next, localKeys)
      return { base: next, outcome: 'requested', requestId: r.requested, message: sharedKeys.length ? partly('were sent for approval.') : undefined }
    }
  } catch (e) {
    revertKeys(cur, next, localKeys)
    return { base: next, outcome: 'error', message: sharedKeys.length ? partly(`weren't: ${(e as Error).message}`) : (e as Error).message }
  }
  next = next === base ? { ...base } : next
  for (const k of [...sharedKeys, ...localKeys]) next[k] = clone(cur[k])
  return { base: next, outcome: 'saved' }
}
