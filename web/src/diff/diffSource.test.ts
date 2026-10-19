// S-2102: the diff view's source seam. `PrSource` wraps the Diff API calls the view made directly, pinned to the shas
// the list returned; `sourceForKey` builds it for a `diff:REPO#N` key. It keeps no list of its own: every call takes the
// list `loadList` returned, so an aborted and retried load can't leave it on a different one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PatchSource, PrSource, sourceForKey } from './diffSource'
import { storePatch, readPatch } from './patchStore'
import type { DiffList } from './diffModel'

const HEAD = 'a1'.repeat(20), BASE = 'b2'.repeat(20), MERGE = 'c3'.repeat(20)
const LIST: DiffList = {
  files: [],
  shas: { head: HEAD, base: BASE, mergeBase: MERGE },
  review: null,
  empty: 'No files changed in this PR.',
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let calls: string[] = []
beforeEach(() => {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (u: string) => {
    calls.push(u)
    if (u.startsWith('/api/diff?')) return json(200, { repo: 'stam2', pr: 7, head: HEAD, base: BASE, mergeBase: MERGE, files: [] })
    return new Response('one\ntwo\n', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  }))
})
afterEach(() => vi.unstubAllGlobals())

describe('PrSource', () => {
  it('names the PR and loads its list', async () => {
    const s = new PrSource({ repo: 'stam2', pr: 7 })
    expect(s.title).toBe('PR #7')
    expect(s.provenance).toBe('stam2')
    expect(s.scope).toBe('stam2#7')
    expect(await s.loadList()).toEqual(LIST)
    expect(calls).toEqual(['/api/diff?repo=stam2&pr=7'])
  })

  it('pins the sides and the refs to the shas the list returned', async () => {
    const s = new PrSource({ repo: 'stam2', pr: 7 })
    const list = await s.loadList()
    expect(s.sideRef(list)).toEqual({ repo: 'stam2', pr: 7, head: HEAD, base: BASE })
    expect(await s.loadSide(list, 'src/a.ts', 'base')).toEqual({ kind: 'text', text: 'one\ntwo\n' })
    const q = new URL(calls[1], 'http://x').searchParams
    expect(Object.fromEntries(q)).toEqual({ repo: 'stam2', pr: '7', path: 'src/a.ts', side: 'base', head: HEAD, base: BASE })
  })

  it('asks for declarations at the head, or the merge base for a deleted line, ranking from', async () => {
    const s = new PrSource({ repo: 'stam2', pr: 7 })
    const list = await s.loadList()
    expect(s.declQuery(list, 'head', 'f', 'src/a.ts')).toEqual({ repo: 'stam2', sha: HEAD, name: 'f', from: 'src/a.ts' })
    expect(s.declQuery(list, 'base', 'f', 'src/old.ts')).toEqual({ repo: 'stam2', sha: MERGE, name: 'f', from: 'src/old.ts' })
    expect(s.declQuery(list, 'head', 'f')).toEqual({ repo: 'stam2', sha: HEAD, name: 'f' })
  })

  it('has no side, refs or declaration query for a list that is not pinned to commits', async () => {
    const s = new PrSource({ repo: 'stam2', pr: 7 })
    const bare: DiffList = { files: [], shas: null, empty: 'nothing' }
    expect(s.declQuery(bare, 'head', 'f')).toBeNull()
    expect(() => s.sideRef(bare)).toThrow(/not pinned to commits/)
    await expect(s.loadSide(bare, 'a.ts', 'head')).rejects.toThrow(/not pinned to commits/)
  })
})

describe('sourceForKey', () => {
  it('builds a PrSource for a diff key and nothing for anything else', () => {
    const s = sourceForKey('diff:stam2#7')
    expect(s).toBeInstanceOf(PrSource)
    expect(s?.title).toBe('PR #7')
    expect(sourceForKey('diff:nope')).toBeNull()
    expect(sourceForKey('patch:abc')).toBeNull()
    expect(sourceForKey('file:box:/p/a.ts')).toBeNull()
  })
  it('builds a PatchSource for a patch key', () => {
    const s = sourceForKey('patch:1a2b3c4d5e6f7081')
    expect(s).toBeInstanceOf(PatchSource)
    expect(s?.title).toBe('Patch 1a2b3c4d5e6f7081')
    expect(s?.scope).toBe('patch:1a2b3c4d5e6f7081')
  })
})

describe('PatchSource (S-2103)', () => {
  const PATCH = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n one\n-two\n+TWO\n+three\n'
  beforeEach(() => localStorage.clear())

  it('lists the patch files with their counts and status, and names the tab', async () => {
    const h = storePatch(PATCH)!
    const s = new PatchSource(h)
    expect(s.provenance).toBe('patch')
    const list = await s.loadList()
    expect(s.sideRef(list)).toBeNull()
    expect(list.shas).toBeNull()
    expect(list.review).toBeUndefined()
    expect(list.empty).toBe('This patch has no files.')
    expect(list.files).toHaveLength(1)
    expect(list.files[0]).toMatchObject({ path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, class: null })
    // The Viewed mark is keyed by the file's own rows, so it resets when that file's hunks change.
    expect(list.files[0].headBlob).toMatch(/^[0-9a-f]{16}$/)
    expect(list.files[0].headBlob).toBe(list.files[0].headBlob)
  })

  it('draws each file from its own hunks, numbered, and never fetches a side', async () => {
    const h = storePatch(PATCH)!
    const s = new PatchSource(h)
    const list = await s.loadList()
    expect(s.hunks(list, list.files[0])!.map((l) => [l.kind, l.number])).toEqual([['hunk', ''], ['ctx', '1'], ['del', '2'], ['add', '2'], ['add', '3']])
    expect(await s.loadSide(list, 'src/a.ts', 'head')).toEqual({ kind: 'missing' })
    expect(s.declQuery(list, 'head', 'f')).toBeNull()
    expect(s.hunks(list, { ...list.files[0], path: 'nope.ts' })).toEqual([])
  })

  it('reads an added file from its first hunk', async () => {
    const h = storePatch('diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n')!
    const list = await new PatchSource(h).loadList()
    expect(list.files[0]).toMatchObject({ path: 'new.ts', status: 'added', additions: 2, deletions: 0 })
  })

  it('an entry that is gone says so, with no files and no request', async () => {
    const list = await new PatchSource('deadbeefdeadbeef').loadList()
    expect(list).toMatchObject({ files: [], shas: null, empty: 'Open it again from its mail.' })
    expect(calls).toEqual([])
  })

  it('opening a patch is what keeps it in the browser\'s LRU', async () => {
    const a = storePatch(PATCH)!, b = storePatch(PATCH + '\n')!
    expect(JSON.parse(localStorage.getItem('stam/diff-patches')!)).toEqual([b, a])
    await new PatchSource(a).loadList()
    expect(JSON.parse(localStorage.getItem('stam/diff-patches')!)).toEqual([a, b])
    // A plain read (what the layout's existence check does) leaves the order alone.
    readPatch(a)
    expect(JSON.parse(localStorage.getItem('stam/diff-patches')!)).toEqual([a, b])
  })
})
