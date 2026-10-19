import { useEffect, useRef, useState } from 'react'
import { DiffFileHead } from './DiffFileHead'
import { estimateLines, type DiffFileItem } from './diffModel'
import type { HunkLine } from './hunkDoc'

// One file of a pasted patch (S-2103): its own hunks in one unified CodeMirror document, with no merge view — a patch
// alone has no second side to show, and until the checkout resolves the file (S-2092 PR 6) its hunks are all there is.
// A pasted patch is a handful of files, so a file always draws; the draw-ahead and the teardown of a long PR's files
// (S-1916) are FileDiff's.
export interface PatchDiffProps {
  file: DiffFileItem
  // The file's rows, already numbered: the same array between renders (the source memoises it), since it feeds the
  // effect that draws the editor.
  lines: HunkLine[]
  wrap: boolean
  viewed: boolean
  onViewed: (on: boolean) => void
  onHide: () => void
  // Open even when marked viewed.
  forceOpen?: boolean
}

export function PatchDiff({ file, lines, wrap, viewed, onViewed, onHide, forceOpen }: PatchDiffProps) {
  const host = useRef<HTMLDivElement>(null)
  const [err, setErr] = useState('')
  const drew = lines.length > 0
  const open = (!viewed || !!forceOpen) && drew

  useEffect(() => {
    const el = host.current
    if (!el || !open) return
    let dead = false
    let made: { destroy(): void } | undefined
    void import('./hunkEditor').then((m) => m.createHunkEditor(el, lines, wrap)).then((e) => {
      if (dead) return e.destroy()
      made = e
    }, () => { if (!dead) setErr('Could not draw this file.') })
    return () => { dead = true; made?.destroy() }
  }, [open, lines, wrap])

  return (
    <section className="dv-file" data-dv-file={file.path} data-status={file.status} aria-label={file.path} style={{ ['--dv-lines' as string]: estimateLines(file) }}>
      <DiffFileHead file={file} viewed={viewed} onViewed={onViewed} onHide={onHide} />
      {open && err && <div className="dv-row" role="alert"><span className="dv-err">{err}</span></div>}
      {!drew && <div className="dv-row muted">No hunks in this patch.</div>}
      <div className="dv-code" ref={host} hidden={!open || !!err} />
    </section>
  )
}
