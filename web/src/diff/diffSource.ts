// The seam between the diff view and where its diff comes from (S-2102, PR 4 of the S-2092 redesign). `DiffView` asks a
// source for its list of files, one file's two sides, where go-to-declaration looks a name up, and one side's text, and
// takes its header and the scope of its Viewed marks from the source and its list — so nothing PR-specific is read by the
// view itself. A PR's diff is a `PrSource`; a patch pasted in mail is the `PatchSource` beside it (S-2103), whose files
// are matched against a checkout (S-2104) and drawn from their own hunks when nothing matches.
import type { DeclQuery } from '../decl/declApi'
import type { DeclSide } from '../decl/declExt'
import { readFile } from '../files/filesApi'
import { parsePatch, patchKind, type PatchFile } from '../mail/parsePatch'
import { fetchDiffList, fetchDiffRepos, fetchSide, type DiffRepo, type Side, type SideRef } from './diffApi'
import { downloadPrSide, loadPrFile, type FileSides } from './fileSides'
import { parseDiffKey, parsePatchKey, patchKey, type DiffRef } from './diffKey'
import { hunkLines, type HunkLine } from './hunkDoc'
import { fetchMachineName, joinPath, places, type Place } from './patchCheckout'
import { patchHash, readBase, readPatch, touchPatch, type PatchBase } from './patchStore'
import { resolvePatch, type PatchSides } from './resolvePatch'
import type { DiffFileItem, DiffList, DiffShas, DiffStatus } from './diffModel'

// What a patch file's header says when no checkout matched it (S-2104).
export const NO_CHECKOUT = 'Declarations unavailable · file changed or not found'

export interface DiffSource {
  // What the header names: the diff's title ("PR #7", "Patch 1a2b3c4d") and where it came from.
  title: string
  provenance: string
  // The id the Viewed marks are keyed by (`viewedKey`): `REPO#N` for a PR, `patch:HASH` for a patch.
  scope: string
  // Whether the Split/Unified toggle applies: a PR's diff always has two sides, a patch's only once one of its files
  // has been matched against a checkout. `resolved` is how many of this source's files the view has loaded as sides.
  twoSided(resolved: number): boolean
  // The changed files, with the shas a side is pinned to and what an empty diff says.
  loadList(signal?: AbortSignal): Promise<DiffList>
  // One file's two sides: a PR's fetched with that list's shas, a patch's read from a checkout and matched against the
  // patch — `hunks` (that file's own rows) when nothing read matched it.
  loadFile(list: DiffList, file: DiffFileItem, signal?: AbortSignal): Promise<FileSides>
  // One side of one file of `list` as text, for showing the lines of a declaration outside the diff. The absent side of
  // an added or deleted file is `missing`.
  loadSide(list: DiffList, path: string, side: 'base' | 'head', signal?: AbortSignal): Promise<Side>
  // Where go-to-declaration looks `name` up for `file` at `side`, or null when this source has no lookup there (a patch
  // file no checkout matched).
  declQuery(list: DiffList, file: DiffFileItem, side: DeclSide, name: string): DeclQuery | null
  // The whole head side of a file as a blob, for the download of one too large to diff. A PR's only: a patch's sides are
  // already read, and a patch file has no whole-file page to download.
  download?(list: DiffList, file: DiffFileItem): Promise<Blob>
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
  twoSided: (resolved: number) => boolean = () => true
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

  private refs(list: DiffList): SideRef {
    const s = shasOf(list)
    return { repo: this.ref.repo, pr: this.ref.pr, head: s.head, base: s.base }
  }

  async loadFile(list: DiffList, file: DiffFileItem, signal?: AbortSignal): Promise<FileSides> {
    return loadPrFile(file, this.refs(list), signal)
  }

  async loadSide(list: DiffList, path: string, side: 'base' | 'head', signal?: AbortSignal): Promise<Side> {
    return fetchSide(this.refs(list), path, side, signal)
  }

  declQuery(list: DiffList, file: DiffFileItem, side: DeclSide, name: string): DeclQuery | null {
    const s = list.shas
    if (!s) return null
    // A deleted line's declaration is looked up at the merge base, at the path the file had before the diff.
    const from = side === 'base' ? file.oldPath ?? file.path : file.path
    return { repo: this.ref.repo, sha: side === 'base' ? s.mergeBase : s.head, name, from }
  }

  download(list: DiffList, file: DiffFileItem): Promise<Blob> {
    return downloadPrSide(this.refs(list), file)
  }
}

// A PR's list always carries the shas its sides are pinned to; only its own source ever sees one without them.
function shasOf(list: DiffList): DiffShas {
  if (!list.shas) throw new Error('this diff is not pinned to commits')
  return list.shas
}

// What one of a patch's files was read from: the machine, the checkout directory and the file's path in it, and that
// checkout's HEAD when it is a commit a label can name.
interface ReadFile { host: string; dir: string; file: string; sha: string | null }

// A patch pasted in mail (`patch:HASH`, S-2103): the text is kept in this browser's LRU under its own hash
// (patchStore.ts), and its files are the ones `parsePatch` finds. A patch alone names no commit, so each file is read
// from a checkout and matched against the patch (S-2104) — the writer's base first (the entry may carry one), then the
// same path in each repo checkout the diff API serves — and drawn from its own hunks when nothing matched. The entry may
// be gone (evicted, or another browser): then the list is empty and says so.
export class PatchSource implements DiffSource {
  title: string
  provenance: string
  scope: string
  // A patch tab has two sides to show only where a checkout matched: until then every file is one document.
  twoSided = (resolved: number) => resolved > 0
  private hash: string
  private base: PatchBase | null
  // The parsed patch, by hash, with the rows of each file worked out once: `loadFile` is called for every drawn file on
  // every load, and its result can feed an effect that needs the same array each time.
  private memo: { hash: string; files: PatchFile[]; lines: Map<string, HunkLine[]> } | null = null
  // What each resolved file was read from, so its label can name it and its declarations know where to look.
  private reads = new Map<string, ReadFile | null>()
  private repos: Promise<DiffRepo[]> | null = null
  private machine: Promise<string> | null = null

  constructor(hash: string, base: PatchBase | null = readBase(hash)) {
    this.hash = hash
    this.base = base
    this.title = `Patch ${hash}`
    this.provenance = 'patch'
    this.scope = patchKey(hash)
  }

  private parsed(): { files: PatchFile[]; lines: Map<string, HunkLine[]> } {
    if (this.memo?.hash !== this.hash) this.memo = { hash: this.hash, files: parsePatch(readPatch(this.hash) ?? ''), lines: new Map() }
    return this.memo
  }

  private fileOf(file: DiffFileItem): PatchFile | undefined {
    return this.parsed().files.find((x) => (x.path || 'diff') === file.path)
  }

  private hunks(file: DiffFileItem): HunkLine[] {
    const m = this.parsed()
    let hit = m.lines.get(file.path)
    if (!hit) {
      const p = this.fileOf(file)
      hit = p ? hunkLines(p.rows) : []
      m.lines.set(file.path, hit)
    }
    return hit
  }

  // The repo checkouts the diff API serves, with their paths and HEADs. Asked once per source; a failure is remembered
  // as none, since a patch tab opened without repos still draws its hunks.
  private repoList(): Promise<DiffRepo[]> {
    return (this.repos ??= fetchDiffRepos().catch(() => []))
  }

  private machineName(): Promise<string> {
    return (this.machine ??= fetchMachineName())
  }

  // The file's text at `file` on `host`, or null when it is not there, not text, or not readable at all.
  private async text(host: string, file: string, signal?: AbortSignal): Promise<string | null> {
    try {
      const b = await readFile(host, file, false, signal)
      return b.text !== undefined && !b.truncated ? b.text : null
    } catch (e) {
      if (signal?.aborted) throw e
      return null
    }
  }

  // The first place and path that hold a copy of this file the patch matches: the writer's checkout first, then each
  // repo checkout (asked for only when the writer's has nothing). A rename is tried at both of its paths, since a
  // checkout may not have the rename yet.
  private async read(p: PatchFile, paths: string[], signal?: AbortSignal): Promise<{ sides: PatchSides; read: ReadFile } | null> {
    const look = async (tryAt: Place[]): Promise<{ sides: PatchSides; read: ReadFile } | null> => {
      for (const place of tryAt) {
        for (const rel of paths) {
          const file = joinPath(place.dir, rel)
          const text = await this.text(place.host, file, signal)
          if (text === null) continue
          const sides = resolvePatch(p, text)
          if (sides) return { sides, read: { host: place.host || (await this.machineName()), dir: place.dir, file, sha: place.sha } }
        }
      }
      return null
    }
    const writer = this.base ? places(this.base, []) : []
    return (writer.length ? await look(writer) : null) ?? look(places(null, await this.repoList()))
  }

  async loadList(): Promise<DiffList> {
    if (readPatch(this.hash) === null) return { files: [], shas: null, empty: 'Open it again from its mail.' }
    // Opening the patch is what keeps it in the browser's LRU: a mere existence check (`keepKey`) never reorders it.
    touchPatch(this.hash)
    const files = this.parsed().files.map(fileItem)
    return { files, shas: null, empty: 'This patch has no files.' }
  }

  async loadFile(_list: DiffList, file: DiffFileItem, signal?: AbortSignal): Promise<FileSides> {
    const p = this.fileOf(file)
    const paths = p ? [p.path, p.oldPath].filter((x): x is string => !!x && x !== 'diff') : []
    const found = p && paths.length ? await this.read(p, paths, signal) : null
    this.reads.set(file.path, found?.read ?? null)
    if (!found || !p) return { s: 'hunks', lines: this.hunks(file), note: NO_CHECKOUT }
    const { host, dir, sha } = found.read
    return { s: 'text', base: found.sides.base, head: found.sides.head, note: `Live checkout · ${host}:${dir}${sha ? ` @ ${sha.slice(0, 7)}` : ''}` }
  }

  async loadSide(_list: DiffList, _path: string, _side: 'base' | 'head', _signal?: AbortSignal): Promise<Side> { return { kind: 'missing' } }

  declQuery(_list: DiffList, file: DiffFileItem, _side: DeclSide, name: string): DeclQuery | null {
    const r = this.reads.get(file.path)
    // A file no checkout matched has no place to look a name up: the view says so and offers nothing.
    return r ? { host: r.host, file: r.file, name } : null
  }
}

// One file of a parsed patch as the view lists it. Its head blob is the hash of its own rows, so a Viewed mark resets
// when that file's hunks change, the way a PR's resets on a new head.
function fileItem(p: PatchFile): DiffFileItem {
  return {
    path: p.path || 'diff',
    ...(p.oldPath ? { oldPath: p.oldPath } : {}),
    status: patchStatus(p),
    additions: p.add,
    deletions: p.del,
    binary: false,
    class: null,
    headBlob: patchHash(p.rows.map((r) => r.text).join('\n')),
  }
}

// A patch file's status from its own hunks, with a rename's old path (S-2092 PR 6) counted as one.
function patchStatus(p: PatchFile): DiffStatus {
  const kind = patchKind(p)
  return kind === 'added' ? 'added' : kind === 'deleted' ? 'deleted' : p.oldPath ? 'renamed' : 'modified'
}

// The source a view key names, or null when it names no diff: `diff:REPO#N` builds a `PrSource`, `patch:HASH` a
// `PatchSource`.
export function sourceForKey(key: string): DiffSource | null {
  const ref = parseDiffKey(key)
  if (ref) return new PrSource(ref)
  const hash = parsePatchKey(key)
  return hash ? new PatchSource(hash) : null
}
