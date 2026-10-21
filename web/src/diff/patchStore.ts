// The pasted patches a `patch:HASH` tab shows (S-2103). The text lives in this browser's localStorage: at most
// PATCH_MAX of them, the most recently used first, each at most PATCH_MAX_BYTES. The hash is of the text, so the same
// fence is always the same tab and a reload works while its entry lasts; when the entry is gone the view says so and
// the reader opens the patch again from its mail. Everything goes through try/catch: a private window just loses
// patches.
export const PATCH_MAX = 20
export const PATCH_MAX_BYTES = 256 * 1024
const INDEX = 'stam/diff-patches'
const textKey = (hash: string) => `stam/diff-patch/${hash}`
const baseKey = (hash: string) => `stam/diff-base/${hash}`

// Where a patch's paths sit on the writer's machine (S-2104): their host and cwd, so the viewer can read their checkout
// and match the patch against it. Optional by design — a patch stored before this existed has none, and the repo
// checkouts answer for it instead — and kept beside the text, under the same hash, so the LRU drops the two together.
export interface PatchBase { host: string; cwd: string }

// FNV-1a, 64-bit, over the text's code units: 16 hex digits, so the same content is always the same key, and two
// different patches sharing one — one silently shown under the other's tab — takes a 64-bit collision rather than the
// 32-bit one the first version left to chance. Not a cryptographic guarantee: the key only has to tell this browser's
// patches apart. BigInt, and not `crypto.subtle`, which needs a secure context the viewer may not have (a plain http
// host).
const OFFSET = 0xcbf29ce484222325n, PRIME = 0x100000001b3n, MASK64 = (1n << 64n) - 1n
export function patchHash(text: string): string {
  let h = OFFSET
  for (let i = 0; i < text.length; i++) h = ((h ^ BigInt(text.charCodeAt(i))) * PRIME) & MASK64
  return h.toString(16).padStart(16, '0')
}

// The patch's size as it is stored: its UTF-8 bytes, so a patch of non-ASCII text is measured by what it really takes,
// never by its UTF-16 units.
export const patchBytes = (text: string): number => new TextEncoder().encode(text).length

// The hashes kept, most recently used first.
function readIndex(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(INDEX) || '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}
const writeIndex = (hashes: string[]): boolean => {
  try { localStorage.setItem(INDEX, JSON.stringify(hashes)); return true } catch { return false }
}
const writeText = (hash: string, text: string): boolean => {
  try { localStorage.setItem(textKey(hash), text); return true } catch { return false }
}
// Both keys of an entry: its text and its writer's base (S-2104).
const removeEntry = (hash: string): void => {
  try { localStorage.removeItem(textKey(hash)); localStorage.removeItem(baseKey(hash)) } catch { /* private window */ }
}

// The index gains one name (16 hex digits and its JSON punctuation) when a patch is stored; freeing more than that and
// still failing to write the index means the size of the index is not what is in the way.
const NAME_BYTES = 24

// Keeps `text` and returns its hash, or null when it is over the cap or the browser refuses to store it.
//
// The browser's own quota, not PATCH_MAX, is the real ceiling (20 patches of the full 256 KB is more than a browser
// holds), and everything the app stores shares it: both the text and the index can meet it. Room is made before a
// write, and both kinds of failure are answered the same way — drop our own oldest and retry, the count's victims
// first — while what they freed is less than the write needs. Past that the failure is not the store's own size
// (another part of the app may hold the quota), so the rest of the store is left alone.
//
// The index is written before the text: a text the index never named would hold a slot no eviction ever reaches. The
// new name may outrun its text by a moment, which costs nothing — a name with no text is a tab that has gone — and
// every exit path leaves the index naming what is really stored. An entry already in the index whose text has gone (a
// failed write, another tab clearing this storage) is swept here too.
export function storePatch(text: string, base?: PatchBase | null): string | null {
  const size = patchBytes(text)
  if (size > PATCH_MAX_BYTES) return null
  const hash = patchHash(text)
  // Besides the new patch, the entries the index names that still have their text, most recently used first: one whose
  // text is gone (a failed write, another tab clearing this storage) would hold a slot no eviction ever reaches.
  const alive = readIndex().filter((h) => h !== hash && readPatch(h) !== null)
  // Newest first: the count keeps PATCH_MAX - 1 of them, and the rest are its own victims, dropped oldest first.
  const keep = alive.slice(0, PATCH_MAX - 1)
  const drop = alive.slice(PATCH_MAX - 1)
  let freed = 0
  // Evict the oldest entry there is: the count's victims first, then the oldest of the rest. Its text goes, and the
  // names it left are still in `keep` and `drop`, so the next index write — or `giveUp` — drops them. False when
  // there is nothing left to evict.
  const evict = (): boolean => {
    const h = drop.length ? drop.shift() : keep.pop()
    if (h === undefined) return false
    freed += patchBytes(readPatch(h) ?? '')
    removeEntry(h)
    return true
  }
  // Name exactly what is still stored, so an eviction never leaves the index pointing at a text that has gone. Best
  // effort: if even this write fails, the next store's sweep drops the stale names.
  const giveUp = (): null => {
    writeIndex([...keep, ...drop])
    return null
  }
  for (;;) {
    // The index goes first: a text it never named would be an entry no eviction reaches.
    if (!writeIndex([hash, ...keep])) {
      // The index gained one name and shrinks only by what is dropped, so one eviction answers its size; freeing more
      // than that name and failing again means the size of the index is not what is in the way.
      if (freed >= NAME_BYTES || !evict()) return giveUp()
      continue
    }
    if (writeText(hash, text)) {
      // The count's own victims go whether or not the text needed room: the index above no longer names them.
      for (const h of drop) removeEntry(h)
      // The writer's base (S-2104) goes in after the text, best effort: a patch that loses it is still matched against a
      // repo checkout, so a refusal here costs a read, never the patch.
      if (base) writeBase(hash, base)
      return hash
    }
    // The text did not fit: drop our own oldest while what they freed is still less than this patch.
    if (freed >= size || !evict()) return giveUp()
  }
}

const writeBase = (hash: string, base: PatchBase): void => {
  try { localStorage.setItem(baseKey(hash), JSON.stringify(base)) } catch { /* private window, or no room */ }
}

// The writer's base kept for `hash`, or null when the entry has none.
export function readBase(hash: string): PatchBase | null {
  try {
    const v = JSON.parse(localStorage.getItem(baseKey(hash)) || 'null') as Partial<PatchBase> | null
    return v && typeof v.host === 'string' && typeof v.cwd === 'string' ? { host: v.host, cwd: v.cwd } : null
  } catch { return null }
}

// The text stored under `hash`, or null when the entry is gone (evicted, or another browser). Passive: it never changes
// the order, so the layout's `keepKey` existence check can ask as often as it likes.
export function readPatch(hash: string): string | null {
  try { return localStorage.getItem(textKey(hash)) } catch { return null }
}

// Moves `hash` to the most recently used, for a patch that is actually being opened (`PatchSource.loadList`): opening
// a patch is what keeps it. Does nothing for an entry the index doesn't name.
export function touchPatch(hash: string): void {
  const index = readIndex()
  if (index[0] === hash || !index.includes(hash)) return
  writeIndex([hash, ...index.filter((h) => h !== hash)])
}
