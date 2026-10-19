// The seam between the diff view and where its diff comes from (S-2102, PR 4 of the S-2092 redesign). `DiffView` asks a
// source for its list of files, one side of a file, where go-to-declaration looks a name up, and the refs a file's
// sides are fetched with, and takes its header and the scope of its Viewed marks from the source and its list — so
// nothing PR-specific is read by the view itself. A PR's diff is a `PrSource`; a patch pasted in mail is the
// `PatchSource` beside it (S-2103), whose files are drawn from their own hunks.
import type { DeclQuery } from '../decl/declApi'
import type { DeclSide } from '../decl/declExt'
import { parsePatch, type PatchFile } from '../mail/parsePatch'
import { fetchDiffList, fetchSide, type Side, type SideRef } from './diffApi'
import { parseDiffKey, parsePatchKey, patchKey, type DiffRef } from './diffKey'
import { hunkLines, type HunkLine } from './hunkDoc'
import { patchHash, readPatch, touchPatch } from './patchStore'
import type { DiffFileItem, DiffList, DiffShas, DiffStatus } from './diffModel'

export interface DiffSource {
  // What the header names: the diff's title ("PR #7", "Patch 1a2b3c4d") and where it came from.
  title: string
  provenance: string
  // The id the Viewed marks are keyed by (`viewedKey`): `REPO#N` for a PR, `patch:HASH` for a patch.
  scope: string
  // The changed files, with the shas a side is pinned to and what an empty diff says.
  loadList(signal?: AbortSignal): Promise<DiffList>
  // The refs a file's two commit-pinned sides are fetched with, or null when this diff has no such sides (a pasted
  // patch, whose files are drawn from their own hunks until the checkout resolves them).
  sideRef(list: DiffList): SideRef | null
  // One side of one file of `list`; the absent side of an added or deleted file is `missing`.
  loadSide(list: DiffList, path: string, side: 'base' | 'head', signal?: AbortSignal): Promise<Side>
  // Where go-to-declaration looks `name` up at `side` of this diff, ranking `from` first, or null when this source has
  // no declaration lookup (a patch file the checkout could not resolve).
  declQuery(list: DiffList, side: DeclSide, name: string, from?: string): DeclQuery | null
  // One file drawn as a single document of its own rows, or null when this diff's files have fetched sides instead.
  hunks(list: DiffList, file: DiffFileItem): HunkLine[] | null
}

// One PR's diff (`diff:REPO#N`): the Diff API's list and files, the shas the list pinned them to, and declarations at
// that head (or at the merge base for a deleted line). Wraps `diffApi` exactly as the view called it before the seam: a
// side is fetched with that list's `head` and `base`, so a push after the list does not change what is shown. Holds no
// list of its own — the caller keeps the one `loadList` returned — so a load that is aborted and retried cannot leave
// the source and the view on different lists.
export class PrSource implements DiffSource {
  title: string
  provenance: string
  scope: string
  private ref: DiffRef

  constructor(ref: DiffRef) {
    this.ref = ref
    this.title = `PR #${ref.pr}`
    this.provenance = ref.repo
    this.scope = `${ref.repo}#${ref.pr}`
  }

  async loadList(signal?: AbortSignal): Promise<DiffList> {
    const l = await fetchDiffList(this.ref.repo, this.ref.pr, signal)
    return {
      files: l.files,
      shas: { head: l.head, base: l.base, mergeBase: l.mergeBase },
      // `null`, not absent: a PR's diff has a reviewer's verdict, though there may be none yet.
      review: l.review ?? null,
      empty: 'No files changed in this PR.',
    }
  }

  sideRef(list: DiffList): SideRef {
    const s = shasOf(list)
    return { repo: this.ref.repo, pr: this.ref.pr, head: s.head, base: s.base }
  }

  async loadSide(list: DiffList, path: string, side: 'base' | 'head', signal?: AbortSignal): Promise<Side> {
    const s = shasOf(list)
    return fetchSide({ repo: this.ref.repo, pr: this.ref.pr, head: s.head, base: s.base }, path, side, signal)
  }

  declQuery(list: DiffList, side: DeclSide, name: string, from?: string): DeclQuery | null {
    const s = list.shas
    if (!s) return null
    return { repo: this.ref.repo, sha: side === 'base' ? s.mergeBase : s.head, name, ...(from ? { from } : {}) }
  }

  hunks(_list: DiffList, _file: DiffFileItem): null { return null }
}

// A PR's list always carries the shas its sides are pinned to; only its own source ever sees one without them.
function shasOf(list: DiffList): DiffShas {
  if (!list.shas) throw new Error('this diff is not pinned to commits')
  return list.shas
}

// A patch pasted in mail (`patch:HASH`, S-2103): the text is kept in this browser's LRU under its own hash
// (patchStore.ts), and its files are the ones `parsePatch` finds. A patch alone has no second side, so every file is
// drawn from its own hunks until the checkout resolves it (S-2092 PR 6), and nothing here fetches: a patch tab makes no
// API call at all. The entry may be gone (evicted, or another browser): then the list is empty and says so.
export class PatchSource implements DiffSource {
  title: string
  provenance: string
  scope: string
  private hash: string
  // The parsed patch, by hash, with the rows of each file worked out once: `hunks` is called for every drawn file on
  // every render, and its result feeds PatchDiff's effect, which needs the same array each time.
  private memo: { hash: string; files: PatchFile[]; lines: Map<string, HunkLine[]> } | null = null

  constructor(hash: string) {
    this.hash = hash
    this.title = `Patch ${hash}`
    this.provenance = 'patch'
    this.scope = patchKey(hash)
  }

  private parsed(): { files: PatchFile[]; lines: Map<string, HunkLine[]> } {
    if (this.memo?.hash !== this.hash) this.memo = { hash: this.hash, files: parsePatch(readPatch(this.hash) ?? ''), lines: new Map() }
    return this.memo
  }

  async loadList(): Promise<DiffList> {
    if (readPatch(this.hash) === null) return { files: [], shas: null, empty: 'Open it again from its mail.' }
    // Opening the patch is what keeps it in the browser's LRU: a mere existence check (`keepKey`) never reorders it.
    touchPatch(this.hash)
    const files = this.parsed().files.map(fileItem)
    return { files, shas: null, empty: 'This patch has no files.' }
  }

  sideRef(_list: DiffList): null { return null }
  async loadSide(_list: DiffList, _path: string, _side: 'base' | 'head', _signal?: AbortSignal): Promise<Side> { return { kind: 'missing' } }
  declQuery(_list: DiffList, _side: DeclSide, _name: string, _from?: string): DeclQuery | null { return null }

  hunks(_list: DiffList, file: DiffFileItem): HunkLine[] {
    const m = this.parsed()
    let hit = m.lines.get(file.path)
    if (!hit) {
      const p = m.files.find((x) => (x.path || 'diff') === file.path)
      hit = p ? hunkLines(p.rows) : []
      m.lines.set(file.path, hit)
    }
    return hit
  }
}

// One file of a parsed patch as the view lists it. Its head blob is the hash of its own rows, so a Viewed mark resets
// when that file's hunks change, the way a PR's resets on a new head.
function fileItem(p: PatchFile): DiffFileItem {
  return {
    path: p.path || 'diff',
    status: patchStatus(p),
    additions: p.add,
    deletions: p.del,
    binary: false,
    class: null,
    headBlob: patchHash(p.rows.map((r) => r.text).join('\n')),
  }
}

// A patch file's status from its own hunks: a first hunk starting at old line 0 adds the file, one ending at new line 0
// removes it. A bare patch carries no rename header, so anything else is a modification (S-2092 PR 6 resolves renames).
function patchStatus(p: PatchFile): DiffStatus {
  const first = p.rows.find((r) => r.kind === 'hunk')?.text ?? ''
  if (/^@@ -0,0 /.test(first)) return 'added'
  if (/\+0,0 @@/.test(first)) return 'deleted'
  return 'modified'
}

// The source a view key names, or null when it names no diff: `diff:REPO#N` builds a `PrSource`, `patch:HASH` a
// `PatchSource`.
export function sourceForKey(key: string): DiffSource | null {
  const ref = parseDiffKey(key)
  if (ref) return new PrSource(ref)
  const hash = parsePatchKey(key)
  return hash ? new PatchSource(hash) : null
}
