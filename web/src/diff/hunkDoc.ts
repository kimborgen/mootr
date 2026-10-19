// The document a patch file the checkout could not resolve is drawn in (S-2103): its own hunks alone — the patch rows
// verbatim, markers included, so a copy gives back the patch lines — each with the gutter number the `@@` headers put
// it at. Pure, so it is tested alone; `hunkEditor.ts` draws it.
import type { PatchRow, PatchRowKind } from '../mail/parsePatch'

export interface HunkLine { text: string; kind: PatchRowKind; number: string }

// `@@ -a[,b] +c[,d] @@`'s two start lines; anything else leaves both unread.
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

// One line of the document per patch row. A hunk header restarts the counts and has no number of its own; a removed row
// takes the old file's next number, an added row the new file's, and a context row both. Rows before any header (a
// hand-written patch) have none.
export function hunkLines(rows: PatchRow[]): HunkLine[] {
  let old = 0, next = 0, seen = false
  return rows.map((r) => {
    if (r.kind === 'hunk') {
      const m = HUNK.exec(r.text)
      old = m ? Number(m[1]) : 0
      next = m ? Number(m[2]) : 0
      seen = !!m
      return { text: r.text, kind: r.kind, number: '' }
    }
    if (!seen) return { text: r.text, kind: r.kind, number: '' }
    if (r.kind === 'del') return { text: r.text, kind: r.kind, number: String(old++) }
    const number = String(next++)
    if (r.kind === 'ctx') old++
    return { text: r.text, kind: r.kind, number }
  })
}
