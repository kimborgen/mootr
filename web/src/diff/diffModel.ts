// The diff view's logic without the DOM (S-1531): the file classes ("Meat" mode) and their chips, per-file overrides,
// the viewed marks and their keys, the file list's order, and the j/k and n/p moves. Pure, so it is tested alone.

export type FileClass = 'tests' | 'lockfiles' | 'generated' | 'docs'
export type DiffStatus = 'added' | 'modified' | 'deleted' | 'renamed'

// One file of `GET /api/diff`. A denied path has no counts and never a diff; the blobs are git ids at the head and the merge base.
export interface DiffFileItem {
  path: string
  oldPath?: string
  status: DiffStatus
  additions: number
  deletions: number
  binary: boolean
  class: FileClass | null
  denied?: true
  headBlob?: string
  baseBlob?: string
}
export interface DiffList { repo: string; pr: number; head: string; base: string; mergeBase: string; files: DiffFileItem[] }

export const CLASSES: FileClass[] = ['tests', 'lockfiles', 'generated', 'docs']
export const CLASS_LABEL: Record<FileClass, string> = { tests: 'Tests', lockfiles: 'Lockfiles', generated: 'Generated', docs: 'Docs' }

// Tests, lockfiles and generated files start hidden; docs start shown.
export const DEFAULT_HIDDEN: Record<FileClass, boolean> = { tests: true, lockfiles: true, generated: true, docs: false }

export interface Filter {
  // Meat mode: off shows every file, whatever its class.
  meat: boolean
  // Which classes are hidden while Meat is on.
  hidden: Record<FileClass, boolean>
  // A file hidden or shown by hand wins over its class, keyed by path.
  override: Record<string, 'show' | 'hide'>
}

export const startFilter = (): Filter => ({ meat: true, hidden: { ...DEFAULT_HIDDEN }, override: {} })

// Whether a file's diff is shown: a hand override first, then its class under Meat mode.
export function isShown(f: DiffFileItem, flt: Filter): boolean {
  const o = flt.override[f.path]
  if (o) return o === 'show'
  return !(flt.meat && f.class && flt.hidden[f.class])
}

export const shownFiles = (files: DiffFileItem[], flt: Filter): DiffFileItem[] => files.filter((f) => isShown(f, flt))

export interface Chip { cls: FileClass; label: string; count: number; hidden: boolean }
// One chip per class that has files, with its count and whether the class is hidden now. A class whose files are all
// shown by hand still counts them; `hidden` follows the class toggle, not the overrides.
export function chips(files: DiffFileItem[], flt: Filter): Chip[] {
  return CLASSES.flatMap((cls) => {
    const count = files.filter((f) => f.class === cls).length
    return count ? [{ cls, label: CLASS_LABEL[cls], count, hidden: flt.meat && flt.hidden[cls] }] : []
  })
}

// "Tests 6 · Lockfiles 1 · Generated 2 hidden": the hidden classes' counts, or '' when none is hidden.
export function hiddenSummary(files: DiffFileItem[], flt: Filter): string {
  const hidden = chips(files, flt).filter((c) => c.hidden)
  return hidden.length ? hidden.map((c) => `${c.label} ${c.count}`).join(' \u00b7 ') + ' hidden' : ''
}

// The next filter after a hand toggle on one file: showing a file the class hides, or hiding one it shows, is an
// override; toggling it back to what its class says drops the override.
export function toggleFile(f: DiffFileItem, flt: Filter): Filter {
  const want = !isShown(f, flt)
  const override = { ...flt.override }
  delete override[f.path]
  if (isShown(f, { ...flt, override }) !== want) override[f.path] = want ? 'show' : 'hide'
  return { ...flt, override }
}

export const toggleClass = (cls: FileClass, flt: Filter): Filter => ({ ...flt, hidden: { ...flt.hidden, [cls]: !flt.hidden[cls] } })

// --- Viewed marks ---------------------------------------------------------------------------------------------------
// Kept in this viewer's localStorage. A mark is keyed by repo, PR, path and the file's head blob, so it resets only
// when that file changes (a deleted file has no head blob: its base blob stands in, with a marker).
export function viewedKey(repo: string, pr: number, f: Pick<DiffFileItem, 'path' | 'headBlob' | 'baseBlob'>): string {
  return `${repo}#${pr}:${f.path}@${f.headBlob ?? (f.baseBlob ? 'deleted-' + f.baseBlob : 'none')}`
}

const VIEWED = 'stam/diff-viewed'
const VIEWED_MAX = 4000
export function readViewed(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(VIEWED) || '[]')
    return new Set(Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : [])
  } catch { return new Set() }
}
export function writeViewed(s: Set<string>): void {
  try { localStorage.setItem(VIEWED, JSON.stringify([...s].slice(-VIEWED_MAX))) } catch { /* private window: marks last for this page only */ }
}
// The set with one key marked or cleared (a new set, so state updates).
export function withViewed(s: Set<string>, key: string, on: boolean): Set<string> {
  const next = new Set(s)
  if (on) { next.delete(key); next.add(key) } else next.delete(key)
  return next
}

// --- Moves ----------------------------------------------------------------------------------------------------------
// The file the view is at: the last one whose top is at or above the scroll position (`tops` ascending, relative to the
// scroll container's top). -1 before the first.
export function currentFile(tops: number[], slack = 8): number {
  let at = -1
  for (let i = 0; i < tops.length; i++) if (tops[i] <= slack) at = i
  return at
}
// j/k: the next or previous index among `count` files, staying inside the list.
export function stepFile(at: number, dir: 1 | -1, count: number): number {
  if (!count) return -1
  return Math.min(count - 1, Math.max(0, at + dir))
}
// n/p: the next or previous change among the tops of every change start drawn now (ascending). Null when there is none
// that way, so the caller moves to the next file.
export function stepChange(tops: number[], dir: 1 | -1, slack = 8): number | null {
  if (dir === 1) { const i = tops.findIndex((t) => t > slack); return i < 0 ? null : i }
  for (let i = tops.length - 1; i >= 0; i--) if (tops[i] < -slack) return i
  return null
}

// A file list row: the folder dimmed, the name plain.
export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf('/')
  return { dir: i < 0 ? '' : path.slice(0, i + 1), name: path.slice(i + 1) }
}

// Roughly how tall a file's diff is before it draws, so scrolling past files not drawn yet doesn't jump.
export const estimateLines = (f: DiffFileItem): number => (f.denied || f.binary ? 2 : Math.min(400, Math.max(4, f.additions + f.deletions + 8)))
