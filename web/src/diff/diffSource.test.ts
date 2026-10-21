// S-2102: the diff view's source seam. `PrSource` wraps the Diff API calls the view made directly, pinned to the shas
// the list returned; `sourceForKey` builds it for a `diff:REPO#N` key. It keeps no list of its own: every call takes the
// list `loadList` returned, so an aborted and retried load can't leave it on a different one. `PatchSource` (S-2103) is
// the patch beside it, whose files are matched against a checkout (S-2104).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NO_CHECKOUT, PatchSource, PrSource, sourceForKey } from './diffSource'
import { readPatch, storePatch } from './patchStore'
import type { DiffFileItem, DiffList } from './diffModel'

const HEAD = 'a1'.repeat(20), BASE = 'b2'.repeat(20), MERGE = 'c3'.repeat(20)
const LIST: DiffList = {
  files: [],
  shas: { head: HEAD, base: BASE, mergeBase: MERGE },
  review: null,
  empty: 'No files changed in this PR.',
}
const FILE = (over: Partial<DiffFileItem> = {}): DiffFileItem => ({ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1, binary: false, class: null, ...over })
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const text = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } })

let calls: string[] = []
// The routes a test adds on top of the PR list and a readable file: `stub({ '/api/files/read': () => text('…') })`.
const stub = (routes: Record<string, (u: string) => Response> = {}) => {
  vi.stubGlobal('fetch', vi.fn(async (u: string) => {
    calls.push(u)
    for (const [pre, make] of Object.entries(routes)) if (u.startsWith(pre)) return make(u)
    if (u.startsWith('/api/diff?')) return json(200, { repo: 'stam2', pr: 7, head: HEAD, base: BASE, mergeBase: MERGE, files: [] })
    if (u.startsWith('/api/diff/file')) return text('one\ntwo\n')
    if (u.startsWith('/api/files/read')) return text('one\ntwo\n')
    return json(404, { error: 'no such route' })
  }))
}
beforeEach(() => { calls = []; stub() })
afterEach(() => vi.unstubAllGlobals())

describe('PrSource', () => {
  it('names the PR and loads its list', async () => {
    const s = new PrSource({ repo: 'stam2', pr: 7 })
    expect(s.title).toBe('PR #7')
    expect(s.provenance).toBe('stam2')
    expect(s.scope).toBe('stam2#7')
    expect(s.twoSided(0)).toBe(true)
    expect(await s.loadList()).toEqual(LIST)
    expect(calls).toEqual(['/api/diff?repo=stam2&pr=7'])
  })

  it('pins the sides and the file loads to the shas the list returned', async () => {
    const s = new PrSource({ repo: 'stam2', pr: 7 })
    const list = await s.loadList()
    expect(await s.loadSide(list, 'src/a.ts', 'base')).toEqual({ kind: 'text', text: 'one\ntwo\n' })
    const q = new URL(calls[1], 'http://x').searchParams
    expect(Object.fromEntries(q)).toEqual({ repo: 'stam2', pr: '7', path: 'src/a.ts', side: 'base', head: HEAD, base: BASE })
    expect(await s.loadFile(list, FILE())).toEqual({ s: 'text', base: 'one\ntwo\n', head: 'one\ntwo\n' })
    // A rename's base side is at its old path, and an added file has no base to ask for.
    await s.loadFile(list, FILE({ path: 'src/new.ts', oldPath: 'src/old.ts', status: 'renamed' }))
    expect(calls.slice(-2).map((u) => new URL(u, 'http://x').searchParams.get('path'))).toEqual(['src/old.ts', 'src/new.ts'])
  })

  it('asks for declarations at the head, or the merge base for a deleted line, ranking from the file', async () => {
    const s = new PrSource({ repo: 'stam2', pr: 7 })
    const list = await s.loadList()
    expect(s.declQuery(list, FILE(), 'head', 'f')).toEqual({ repo: 'stam2', sha: HEAD, name: 'f', from: 'src/a.ts' })
    expect(s.declQuery(list, FILE({ oldPath: 'src/old.ts' }), 'base', 'f')).toEqual({ repo: 'stam2', sha: MERGE, name: 'f', from: 'src/old.ts' })
    expect(s.declQuery(list, FILE({ oldPath: 'src/old.ts', status: 'renamed' }), 'head', 'f')).toEqual({ repo: 'stam2', sha: HEAD, name: 'f', from: 'src/a.ts' })
  })

  it('has no declaration query for a list that is not pinned to commits', async () => {
    const s = new PrSource({ repo: 'stam2', pr: 7 })
    const bare: DiffList = { files: [], shas: null, empty: 'nothing' }
    expect(s.declQuery(bare, FILE(), 'head', 'f')).toBeNull()
    await expect(s.loadFile(bare, FILE())).rejects.toThrow(/not pinned to commits/)
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

describe('PatchSource (S-2103, and its checkout resolution S-2104)', () => {
  const PATCH = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n one\n-two\n+TWO\n+three\n'
  const POST = 'one\nTWO\nthree\n'
  const PRE = 'one\ntwo\n'
  const path = (s: string) => new URL(s, 'http://x').searchParams.get('path')
  beforeEach(() => localStorage.clear())

  it('lists the patch files with their counts and status, and names the tab', async () => {
    const h = storePatch(PATCH)!
    const s = new PatchSource(h)
    expect(s.provenance).toBe('patch')
    // Only once a file turned out to have two sides (S-2104): until then a patch tab is one document per file.
    expect(s.twoSided(0)).toBe(false)
    expect(s.twoSided(1)).toBe(true)
    const list = await s.loadList()
    expect(list.shas).toBeNull()
    expect(list.review).toBeUndefined()
    expect(list.empty).toBe('This patch has no files.')
    expect(list.files).toHaveLength(1)
    expect(list.files[0]).toMatchObject({ path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, class: null })
    // The Viewed mark is keyed by the file's own rows, so it resets when that file's hunks change.
    expect(list.files[0].headBlob).toMatch(/^[0-9a-f]{16}$/)
  })

  it('draws a file nothing has as its own hunks, numbered, and offers no declarations', async () => {
    const h = storePatch(PATCH)!
    const s = new PatchSource(h)
    const list = await s.loadList()
    const sides = await s.loadFile(list, list.files[0])
    expect(sides).toMatchObject({ s: 'hunks', note: NO_CHECKOUT })
    expect(sides.s === 'hunks' && sides.lines.map((l) => [l.kind, l.number])).toEqual([['hunk', ''], ['ctx', '1'], ['del', '2'], ['add', '2'], ['add', '3']])
    expect(await s.loadSide(list, 'src/a.ts', 'head')).toEqual({ kind: 'missing' })
    expect(s.declQuery(list, list.files[0], 'head', 'f')).toBeNull()
    // Nowhere to read from, so nothing was read: no repo checkout (the daemon listed none) and no writer's base.
    expect(calls).toEqual(['/api/diff/repos'])
  })

  it('resolves against the writer\'s checkout, at the base the entry carries', async () => {
    const h = storePatch(PATCH, { host: 'storage', cwd: '/w/stam2-x' })!
    const s = new PatchSource(h)
    const list = await s.loadList()
    const sides = await s.loadFile(list, list.files[0])
    expect(sides).toEqual({ s: 'text', base: PRE, head: POST, note: 'Live checkout · storage:/w/stam2-x' })
    expect(path(calls[0])).toBe('/w/stam2-x/src/a.ts')
    expect(new URL(calls[0], 'http://x').searchParams.get('host')).toBe('storage')
    // The writer's checkout answered, so the repo checkouts were never asked for.
    expect(calls.filter((u) => u.startsWith('/api/diff/repos'))).toEqual([])
  })

  it('reverse-applies when the checkout has the patch applied, and applies when it does not', async () => {
    const h = storePatch(PATCH, { host: 'storage', cwd: '/w/stam2-x' })!
    const list = await new PatchSource(h).loadList()
    stub({ '/api/files/read': () => text(POST) })
    expect(await new PatchSource(h).loadFile(list, list.files[0])).toMatchObject({ s: 'text', base: PRE, head: POST })
    stub({ '/api/files/read': () => text(PRE) })
    expect(await new PatchSource(h).loadFile(list, list.files[0])).toMatchObject({ s: 'text', base: PRE, head: POST })
  })

  it('falls back to a repo checkout on the ITSA home, which is not this daemon', async () => {
    const h = storePatch(PATCH)!
    const list = await new PatchSource(h).loadList()
    stub({
      '/api/diff/repos': () => json(200, { machine: 'home-box', repos: [{ name: 'stam2', github: 'example/stam2', path: '/home/user/projects/stam2', sha: 'a1b2c3d4e5f6a7b8' }] }),
      '/api/files/read': () => text(POST),
    })
    const s = new PatchSource(h)
    const sides = await s.loadFile(list, list.files[0])
    expect(sides).toEqual({ s: 'text', base: PRE, head: POST, note: 'Live checkout · home-box:/home/user/projects/stam2 @ a1b2c3d' })
    // The checkout is the home's, so the home reads it, and a name in it is looked up there too.
    expect(path(calls[1])).toBe('/home/user/projects/stam2/src/a.ts')
    expect(new URL(calls[1], 'http://x').searchParams.get('host')).toBe('home-box')
    expect(s.declQuery(list, list.files[0], 'head', 'f')).toEqual({ host: 'home-box', file: '/home/user/projects/stam2/src/a.ts', name: 'f' })
  })

  it('marks a file the writer\'s checkout has changed, after trying the repo checkouts too', async () => {
    const h = storePatch(PATCH, { host: 'storage', cwd: '/w/stam2-x' })!
    const list = await new PatchSource(h).loadList()
    stub({
      '/api/files/read': () => text('not this file at all\n'),
      '/api/diff/repos': () => json(200, { repos: [{ name: 'stam2', github: null, path: '/home/user/projects/stam2', sha: null }] }),
    })
    const s = new PatchSource(h)
    expect(await s.loadFile(list, list.files[0])).toMatchObject({ s: 'hunks', note: NO_CHECKOUT })
    expect(s.declQuery(list, list.files[0], 'head', 'f')).toBeNull()
    // Both the writer's base and the repo checkout were read, and a checkout with no HEAD still labels without one.
    expect(calls.filter((u) => u.startsWith('/api/files/read')).map(path)).toEqual(['/w/stam2-x/src/a.ts', '/home/user/projects/stam2/src/a.ts'])
  })

  it('treats a file it cannot read as unresolved, and never throws', async () => {
    const h = storePatch(PATCH, { host: 'gone', cwd: '/w/x' })!
    const list = await new PatchSource(h).loadList()
    stub({ '/api/files/read': () => json(404, { error: 'no such file' }) })
    const s = new PatchSource(h)
    expect(await s.loadFile(list, list.files[0])).toMatchObject({ s: 'hunks', note: NO_CHECKOUT })
  })

  it('reads an added file, and a rename at both of its paths', async () => {
    const added = storePatch('diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n', { host: 'storage', cwd: '/w/x' })!
    const list = await new PatchSource(added).loadList()
    expect(list.files[0]).toMatchObject({ path: 'new.ts', status: 'added', additions: 2, deletions: 0 })
    stub({ '/api/files/read': () => text('a\nb\n') })
    expect(await new PatchSource(added).loadFile(list, list.files[0])).toMatchObject({ s: 'text', base: '', head: 'a\nb\n' })

    const renamed = storePatch('diff --git a/old.ts b/new.ts\nsimilarity index 80%\nrename from old.ts\nrename to new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1,2 +1,2 @@\n keep\n-was\n+is\n', { host: 'storage', cwd: '/w/x' })!
    calls.length = 0
    const rs = new PatchSource(renamed)
    const rl = await rs.loadList()
    expect(rl.files[0]).toMatchObject({ path: 'new.ts', oldPath: 'old.ts', status: 'renamed' })
    // The checkout does not have the rename yet: the new path is not there, and the old one answers.
    stub({ '/api/files/read': (u) => (decodeURIComponent(u).includes('/old.ts') ? text('keep\nwas\n') : json(404, { error: 'no such file' })) })
    expect(await rs.loadFile(rl, rl.files[0])).toMatchObject({ s: 'text', base: 'keep\nwas\n', head: 'keep\nis\n' })
    expect(calls.filter((u) => u.startsWith('/api/files/read')).map(path)).toEqual(['/w/x/new.ts', '/w/x/old.ts'])
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
