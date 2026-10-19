// S-2103: the patches a `patch:HASH` tab reads, kept in this browser's localStorage.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PATCH_MAX, PATCH_MAX_BYTES, patchBytes, patchHash, readPatch, storePatch, touchPatch } from './patchStore'

const patch = (n: number) => `diff --git a/f${n} b/f${n}\n--- a/f${n}\n+++ b/f${n}\n@@ -1 +1 @@\n-a${n}\n+b${n}\n`
const index = (): string[] => JSON.parse(localStorage.getItem('stam/diff-patches') ?? '[]')
// Every hash the index names has its text, and every stored text is in the index: the two can never drift.
const consistent = () => {
  const named = index()
  const texts: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!
    if (k.startsWith('stam/diff-patch/')) texts.push(k.slice('stam/diff-patch/'.length))
  }
  return { named, texts: texts.sort(), ok: named.every((h) => texts.includes(h)) && texts.length === named.length }
}

beforeEach(() => localStorage.clear())
afterEach(() => { localStorage.clear(); vi.restoreAllMocks() })

describe('patchHash', () => {
  it('is the same for the same text, different for another, and 64 bits wide', () => {
    expect(patchHash('one')).toBe(patchHash('one'))
    expect(patchHash('one')).not.toBe(patchHash('two'))
    expect(patchHash('')).toMatch(/^[0-9a-f]{16}$/)
    // The empty text's value, pinned: a change of hash would re-key every patch this browser holds.
    expect(patchHash('')).toBe('cbf29ce484222325')
  })
})

describe('patchBytes', () => {
  it('measures the stored bytes, not the UTF-16 units', () => {
    expect(patchBytes('abc')).toBe(3)
    expect(patchBytes('é')).toBe(2)
    expect(patchBytes('日本語')).toBe(9)
  })
})

describe('the patch store', () => {
  it('keeps a patch under its hash; the same text again is one entry', () => {
    const h = storePatch(patch(1))
    expect(h).toBe(patchHash(patch(1)))
    expect(readPatch(h!)).toBe(patch(1))
    storePatch(patch(1))
    expect(index()).toEqual([h])
  })

  it('two fences of one mail are two entries', () => {
    const a = storePatch(patch(1))!, b = storePatch(patch(2))!
    expect(a).not.toBe(b)
    expect(readPatch(a)).toBe(patch(1))
    expect(readPatch(b)).toBe(patch(2))
    expect(index()).toEqual([b, a])
  })

  it('a reload hits while the entry is there, and misses once it is gone', () => {
    const h = storePatch(patch(3))!
    expect(readPatch(h)).toBe(patch(3))
    localStorage.clear()
    expect(readPatch(h)).toBeNull()
  })

  it('keeps at most PATCH_MAX, dropping the least recently used', () => {
    const hashes = Array.from({ length: PATCH_MAX + 1 }, (_, i) => storePatch(patch(i))!)
    expect(readPatch(hashes[0])).toBeNull()
    expect(readPatch(hashes[PATCH_MAX])).toBe(patch(PATCH_MAX))
    expect(index()).toHaveLength(PATCH_MAX)
    expect(consistent().ok).toBe(true)
  })

  it('storing a patch again makes it the most recent, so a newer one drops another', () => {
    const hashes = Array.from({ length: PATCH_MAX }, (_, i) => storePatch(patch(i))!)
    storePatch(patch(0))
    storePatch(patch(99))
    expect(readPatch(hashes[0])).toBe(patch(0))
    expect(readPatch(hashes[1])).toBeNull()
    expect(readPatch(hashes[2])).toBe(patch(2))
  })

  it('reading a patch is passive: opening it, and only opening it, keeps it', () => {
    const hashes = Array.from({ length: PATCH_MAX }, (_, i) => storePatch(patch(i))!)
    // A plain read (what `keepKey` does) leaves the order alone, so the oldest is still the one a new patch drops.
    readPatch(hashes[0])
    storePatch(patch(50))
    expect(readPatch(hashes[0])).toBeNull()
    // An open touches it: the second oldest goes instead.
    touchPatch(hashes[1])
    storePatch(patch(51))
    expect(readPatch(hashes[1])).toBe(patch(1))
    expect(readPatch(hashes[2])).toBeNull()
    expect(consistent().ok).toBe(true)
  })

  it('refuses a patch over the cap, in bytes', () => {
    expect(storePatch('x'.repeat(PATCH_MAX_BYTES))).toBe(patchHash('x'.repeat(PATCH_MAX_BYTES)))
    const over = 'x'.repeat(PATCH_MAX_BYTES + 1)
    expect(storePatch(over)).toBeNull()
    expect(readPatch(patchHash(over))).toBeNull()
    // A non-ASCII patch of half as many units is still the full 256 KB of bytes, and one unit more is not.
    const wide = 'é'.repeat(PATCH_MAX_BYTES / 2)
    expect(patchBytes(wide)).toBe(PATCH_MAX_BYTES)
    expect(storePatch(wide)).toBe(patchHash(wide))
    const wider = wide + 'é'
    expect(patchBytes(wider)).toBeGreaterThan(PATCH_MAX_BYTES)
    expect(storePatch(wider)).toBeNull()
  })

  it('a storage that throws loses the patch, and never throws itself', () => {
    const real = Object.getOwnPropertyDescriptor(window, 'localStorage')!
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('blocked') } })
    try {
      expect(storePatch(patch(1))).toBeNull()
      expect(readPatch('cbf29ce484222325')).toBeNull()
      expect(() => touchPatch('cbf29ce484222325')).not.toThrow()
    } finally { Object.defineProperty(window, 'localStorage', real) }
  })
})

describe('a browser that refuses the writes', () => {
  // jsdom's localStorage has no quota, so the refusals are planted. `block` is a storage that never takes a write at
  // all; `withBudget` is one byte budget shared by the index and the texts, the way a browser's quota is shared by
  // everything the app stores.
  const block = (match: (key: string) => boolean) => {
    const real = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (match(k)) throw new DOMException('QuotaExceededError', 'QuotaExceededError')
      return real.call(this, k, v)
    })
  }

  const withBudget = (budget: number) => {
    const real = window.localStorage
    // The original methods, taken before the spies go on: calling them through the storage object would re-enter the
    // spies.
    const set = Storage.prototype.setItem, remove = Storage.prototype.removeItem
    const size = (entries: Map<string, string>) =>
      [...entries].reduce((n, [k, v]) => n + patchBytes(k) + patchBytes(v), 0)
    const copy = new Map<string, string>()
    for (let i = 0; i < real.length; i++) { const k = real.key(i)!; copy.set(k, real.getItem(k)!) }
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      const next = new Map(copy)
      next.set(k, v)
      if (size(next) > budget) throw new DOMException('QuotaExceededError', 'QuotaExceededError')
      copy.set(k, v)
      set.call(real, k, v)
    })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, k: string) {
      copy.delete(k)
      remove.call(real, k)
    })
  }
  const usage = () => {
    let n = 0
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!
      n += patchBytes(k) + patchBytes(localStorage.getItem(k) ?? '')
    }
    return n
  }
  // Equal-sized patches, so what one eviction frees is exactly what another of them needs.
  const big = (n: number) => patch(n) + 'b'.repeat(2000)

  it('makes room before writing, so a full store still takes the new patch', () => {
    const hashes = Array.from({ length: PATCH_MAX }, (_, i) => storePatch(patch(i))!)
    const oldest = hashes[0]
    // The quota is full while the oldest patch is still stored: evicting it is what lets the new one in.
    const real = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k.startsWith('stam/diff-patch/') && localStorage.getItem(`stam/diff-patch/${oldest}`) !== null) throw new DOMException('QuotaExceededError', 'QuotaExceededError')
      return real.call(this, k, v)
    })
    const h = storePatch(patch(90))
    expect(h).not.toBeNull()
    expect(readPatch(h!)).toBe(patch(90))
    expect(readPatch(oldest)).toBeNull()
    expect(readPatch(hashes[1])).toBe(patch(1))
    expect(index()).toHaveLength(PATCH_MAX)
    expect(consistent().ok).toBe(true)
  })

  it('gives up without emptying the store when the text cannot be written at all', () => {
    const hashes = Array.from({ length: 3 }, (_, i) => storePatch(patch(i))!)
    block((k) => k.startsWith('stam/diff-patch/'))
    expect(storePatch(patch(9))).toBeNull()
    expect(readPatch(hashes[2])).toBe(patch(2))
    expect(readPatch(hashes[1])).toBe(patch(1))
    expect(readPatch(hashes[0])).toBeNull()
    expect(consistent().ok).toBe(true)
  })

  it('evicts for the index itself when the budget is spent, and the patch still lands', () => {
    const hashes = [0, 1, 2].map((i) => storePatch(big(i))!)
    // Exactly at the quota, with fewer than PATCH_MAX entries: the index's own new name is what does not fit.
    withBudget(usage())
    // A small patch, so evicting one big entry leaves room for the text and for the name it adds.
    const h = storePatch(patch(9))
    expect(h).not.toBeNull()
    expect(readPatch(h!)).toBe(patch(9))
    expect(readPatch(hashes[0])).toBeNull()
    expect(readPatch(hashes[1])).toBe(big(1))
    expect(readPatch(hashes[2])).toBe(big(2))
    expect(index()).toEqual([h, hashes[2], hashes[1]])
    expect(consistent().ok).toBe(true)
  })

  it('keeps the index true when the text write fails after an eviction', () => {
    const hashes = [0, 1, 2].map((i) => storePatch(big(i))!)
    // A browser that refuses the text twice: once while the oldest patch is still stored, and again after that patch
    // has been evicted for this one — room was made, and something else took it. The store gives up, and what it says
    // it holds is what it holds.
    let refusals = 2
    const real = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k.startsWith('stam/diff-patch/') && refusals-- > 0) throw new DOMException('QuotaExceededError', 'QuotaExceededError')
      return real.call(this, k, v)
    })
    expect(storePatch(patch(9))).toBeNull()
    expect(readPatch(hashes[0])).toBeNull()
    expect(readPatch(hashes[1])).toBe(big(1))
    expect(readPatch(hashes[2])).toBe(big(2))
    expect(index()).toEqual([hashes[2], hashes[1]])
    expect(consistent().ok).toBe(true)
  })

  it('evicts for a patch bigger than the one it replaces, when the budget has room', () => {
    const hashes = [storePatch(patch(0) + 'b'.repeat(1000))!]
    // The budget is 1,500 bytes short of the new, bigger patch, but not short of what evicting the stored one frees:
    // its text goes and the patch lands. Space already free counts, so the store does not refuse before trying.
    withBudget(usage() + 1500)
    const h = storePatch(patch(9) + 'c'.repeat(2000))
    expect(h).not.toBeNull()
    expect(readPatch(h!)).toBe(patch(9) + 'c'.repeat(2000))
    expect(readPatch(hashes[0])).toBeNull()
    expect(index()).toEqual([h])
    expect(consistent().ok).toBe(true)
  })

  it('sweeps an index entry whose text is gone, so it stops holding a slot', () => {
    const hashes = Array.from({ length: 3 }, (_, i) => storePatch(patch(i))!)
    localStorage.removeItem(`stam/diff-patch/${hashes[0]}`)
    const h = storePatch(patch(9))!
    expect(index()).toEqual([h, hashes[2], hashes[1]])
    expect(consistent().ok).toBe(true)
  })
})
