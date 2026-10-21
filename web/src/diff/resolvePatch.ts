// Matching one of a bare patch's files against a checkout (S-2104, PR 6 of the S-2092 redesign). Pure: the caller has
// read a candidate file text — the writer's `cwd/path`, or that path in a repo checkout — and this says whether it is the
// file's post-image (the writer has the patch applied) or its pre-image (they do not), and what the other side then is.
// Anything else is unresolved, and the view draws the file's hunks on their own.
//
// Every hunk is looked for where its `@@` header says it is, plus the drift the hunks before it showed, and only then a
// little either side: the same file with a few of the writer's own lines added above still matches, while a short hunk
// (its context is often one `}`) cannot latch onto an earlier copy of that text.
import { patchKind, type PatchFile, type PatchRow } from '../mail/parsePatch'

// The two sides of a file, as text. `''` is a side that does not exist, which is how the merge view draws a file the
// patch creates or deletes; every other side is how it reads, a trailing newline included or not.
export interface PatchSides { base: string; head: string }

// How far from its header line (either way) a hunk may sit: a checkout with a few lines the writer added above a hunk
// still matches, and one whose hunk only fits further away is not the file the patch was made against.
const WINDOW = 10

// One hunk's two images, without their markers: the lines it has before the patch and after it, where its header says
// each starts and how many lines it has there (0 when the header is not one this reads, such as a hand-written patch),
// and `\ No newline at end of file` for either image.
interface Hunk {
  pre: string[]
  post: string[]
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  preNoEol: boolean
  postNoEol: boolean
}

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
// A missing count is one line; an explicit `,0` is an image of no lines, which unified diff anchors to the line the
// change comes after rather than to a line of its own.
const count = (n: string | undefined): number => (n === undefined ? 1 : Number(n))
// The marker line a patch writes after the last line of a side that has no newline of its own.
const NO_NEWLINE = '\\'

export function hunksOf(rows: PatchRow[]): Hunk[] {
  const out: Hunk[] = []
  let last: PatchRow | null = null
  for (const r of rows) {
    if (r.kind === 'hunk') {
      const m = HEADER.exec(r.text)
      out.push({ pre: [], post: [], oldStart: m ? Number(m[1]) : 0, oldCount: m ? count(m[2]) : 0, newStart: m ? Number(m[3]) : 0, newCount: m ? count(m[4]) : 0, preNoEol: false, postNoEol: false })
      last = null
      continue
    }
    const h = out[out.length - 1]
    // Rows above the first `@@` (a hand-written patch of new text is one) belong to no hunk.
    if (!h) continue
    // `\ No newline at end of file` is no line of an image: it says the line above it ends the file without a newline.
    if (r.text.startsWith(NO_NEWLINE)) {
      if (!last || last.kind === 'ctx') { h.preNoEol = true; h.postNoEol = true }
      else if (last.kind === 'del') h.preNoEol = true
      else if (last.kind === 'add') h.postNoEol = true
      continue
    }
    const line = r.text.slice(1)
    if (r.kind !== 'add') h.pre.push(line)
    if (r.kind !== 'del') h.post.push(line)
    last = r
  }
  return out
}

// The file's lines, without the empty tail a trailing newline leaves.
const splitLines = (text: string): string[] => (text === '' ? [] : text.replace(/\n$/, '').split('\n'))
const joinLines = (lines: string[], eol: boolean): string => (lines.length ? lines.join('\n') + (eol ? '\n' : '') : '')
const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((l, i) => l === b[i])

// Where one hunk sits in the file: `[start, end)`, in the file's own line numbers.
interface Range { start: number; end: number }
// A hunk's places, whether every one of them was exactly where its header put it, and whether the patch marks that side
// as ending without a final newline.
interface Found { ranges: Range[]; exact: boolean; noEol: boolean }

function fits(lines: string[], img: string[], at: number): boolean {
  return at >= 0 && at + img.length <= lines.length && img.every((l, j) => lines[at + j] === l)
}

// Every image where its header (plus the drift so far) says it is, or, when it is not there, the nearest place within
// WINDOW either way — a line below before a line above. An empty image (a pure insertion or deletion) takes no lines and
// so sits at its header line. Any other miss is no match: the file is not the one the patch was made against.
function findHunks(lines: string[], hunks: Hunk[], dir: 'pre' | 'post'): Found | null {
  const ranges: Range[] = []
  let drift = 0
  let exact = true
  let after = 0
  for (const h of hunks) {
    const img = dir === 'post' ? h.post : h.pre
    const start = dir === 'post' ? h.newStart : h.oldStart
    const size = dir === 'post' ? h.newCount : h.oldCount
    // Where the header puts the image: line `start` itself, and for an image of no lines the line the change comes after.
    // A header this cannot read leaves the hunk to follow the one before it.
    const at0 = size === 0 ? start : start - 1
    const want = start > 0 ? Math.min(Math.max(at0 + drift, 0), lines.length) : after
    const at = start > 0 ? nearest(lines, img, want) : want
    if (at < 0 || !fits(lines, img, at)) return null
    if (at !== want) exact = false
    ranges.push({ start: at, end: at + img.length })
    if (start > 0) drift = at - at0
    after = at + img.length
  }
  return { ranges, exact, noEol: hunks.some((h) => (dir === 'post' ? h.postNoEol : h.preNoEol)) }
}

function nearest(lines: string[], img: string[], want: number): number {
  for (let d = 0; d <= WINDOW; d++) {
    if (fits(lines, img, want + d)) return want + d
    if (d > 0 && fits(lines, img, want - d)) return want - d
  }
  return -1
}

// The file with each hunk's lines replaced by the other side of it.
function replace(lines: string[], ranges: Range[], withs: string[][]): string[] {
  const out: string[] = []
  let at = 0
  ranges.forEach((r, i) => { out.push(...lines.slice(at, r.start), ...withs[i]); at = r.end })
  out.push(...lines.slice(at))
  return out
}

// Which direction to take, or null when neither fits or the two are too alike to tell apart. `eol` is whether the file
// read ends with a newline.
function pick(asPost: Found | null, asPre: Found | null, eol: boolean): 'post' | 'pre' | null {
  if (!asPre) return asPost ? 'post' : null
  if (!asPost) return 'pre'
  // Both matched: the one whose hunks sat exactly where their headers put them.
  if (asPost.exact !== asPre.exact) return asPost.exact ? 'post' : 'pre'
  // Both only fitted away from their headers: the file may be neither side, so the hunks are drawn alone.
  if (!asPost.exact) return null
  // Both exact. The patch's own ending can tell them apart — a side it marks as having no final newline is the file read
  // without one — and a tie goes to the post-image, since a writer's checkout usually has their own patch applied.
  const matchesEnding = (f: Found) => f.noEol === !eol
  if (matchesEnding(asPost) !== matchesEnding(asPre)) return matchesEnding(asPost) ? 'post' : 'pre'
  return 'post'
}

// The two sides of `file` matched against `text`, or null when `text` is neither its post-image nor its pre-image (or
// there is no text at all: the file could not be read).
export function resolvePatch(file: PatchFile, text: string | null): PatchSides | null {
  if (text === null) return null
  const hunks = hunksOf(file.rows)
  if (!hunks.length) return null
  const lines = splitLines(text)
  // The read file's own ending. The other side's is the patch's to say: it ends without a newline when the patch marks
  // its last line so.
  const eol = text.endsWith('\n')
  const kind = patchKind(file)
  // A file the patch creates or deletes is matched whole: the reader's file is that content, or the patch is not theirs.
  if (kind === 'added') return same(lines, hunks.flatMap((h) => h.post)) ? { base: '', head: joinLines(lines, eol) } : null
  if (kind === 'deleted') return same(lines, hunks.flatMap((h) => h.pre)) ? { base: joinLines(lines, eol), head: '' } : null
  const asPost = hunks.some((h) => h.post.length) ? findHunks(lines, hunks, 'post') : null
  const asPre = hunks.some((h) => h.pre.length) ? findHunks(lines, hunks, 'pre') : null
  const took = pick(asPost, asPre, eol)
  if (!took) return null
  const found = took === 'post' ? asPost! : asPre!
  const derived = replace(lines, found.ranges, hunks.map((h) => (took === 'post' ? h.pre : h.post)))
  // The derived side ends the way the patch says it does when the patch replaces the file's last line, and the way the
  // file itself ends otherwise (that line is in both sides, unchanged).
  const toEnd = found.ranges.length > 0 && found.ranges[found.ranges.length - 1].end === lines.length
  const marked = hunks.some((h) => (took === 'post' ? h.preNoEol : h.postNoEol))
  const other = joinLines(derived, toEnd ? !marked : eol)
  const whole = joinLines(lines, eol)
  return took === 'post' ? { base: other, head: whole } : { base: whole, head: other }
}
