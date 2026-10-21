// What a file's two sides are, however its source got them (S-2104): a PR's sides are fetched with the list's shas, a
// patch file's are read from a checkout and matched against the patch. `hunks` is a patch file no checkout matched: its
// own rows, drawn alone. `note` is what the file's header says about where its sides came from.
import { fetchSide, fetchWhole, type Side, type SideRef } from './diffApi'
import type { DiffFileItem } from './diffModel'
import type { HunkLine } from './hunkDoc'

export type FileSides =
  | { s: 'text'; base: string; head: string; note?: string }
  | { s: 'hunks'; lines: HunkLine[]; note?: string }
  | { s: 'binary'; size: number }
  | { s: 'large'; size: number }

export const sideText = (s: Side): string => (s.kind === 'text' ? s.text : '')

// Fetches both sides of a PR file with the list's shas. An added file has no base, a deleted one no head, and a rename's
// base side is at its old path.
export async function loadPrFile(f: DiffFileItem, refs: SideRef, signal?: AbortSignal): Promise<FileSides> {
  const none: Side = { kind: 'missing' }
  const [base, head] = await Promise.all([
    f.status === 'added' ? none : fetchSide(refs, f.oldPath ?? f.path, 'base', signal),
    f.status === 'deleted' ? none : fetchSide(refs, f.path, 'head', signal),
  ])
  for (const s of [head, base]) {
    if (s.kind === 'large') return { s: 'large', size: s.size }
    if (s.kind === 'binary') return { s: 'binary', size: s.size }
  }
  return { s: 'text', base: sideText(base), head: sideText(head) }
}

// The whole head side of a PR file, for the download of one too large to diff (a patch's sides are already read).
export const downloadPrSide = (refs: SideRef, f: DiffFileItem): Promise<Blob> =>
  fetchWhole(refs, f.path, f.status === 'deleted' ? 'base' : 'head')
