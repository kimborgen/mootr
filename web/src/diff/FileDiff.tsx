import { useEffect, useRef, useState, type RefObject } from 'react'
import { Icon } from '../Icon'
import { DiffFileHead } from './DiffFileHead'
import type { DiffEditor, DiffEditorViews, DiffMode } from './mergeEditor'
import type { DeclHit, DeclSide } from '../decl/declExt'
import { DiffFail, fetchSide, fetchWhole, type Side, type SideRef } from './diffApi'
import { estimateLines, type DiffFileItem } from './diffModel'

// One file of the PR diff (S-1531): its header (path, counts, Hide, Expand all, Viewed) and, once the file scrolls into
// view, its diff in a CodeMirror merge view. Binary, over-cap, denied and unchanged-content files get a row, never a diff.
export interface FileDiffProps {
  // The scroll container the file sits in, the root of the draw-ahead observer; the viewport when absent.
  scroller?: RefObject<HTMLElement | null>
  file: DiffFileItem
  refs: SideRef
  mode: DiffMode
  wrap: boolean
  viewed: boolean
  onViewed: (on: boolean) => void
  onHide: () => void
  // The EditorViews of a drawn file, and null when they go.
  onEditor?: (views: DiffEditorViews | null, path: string) => void
  // Go to declaration (S-1532): an identifier clicked or tapped in this file, and whether a name has a declaration.
  onDecl?: (hit: DeclHit) => void
  hasDecl?: (name: string, side: DeclSide) => Promise<boolean>
  // Open even when marked viewed: a jump landed here.
  forceOpen?: boolean
  // A line to expand, scroll to and mark once the editor draws; `n` changes per jump.
  target?: { line: number; side: DeclSide; n: number }
  // The editor drew for jump `n` and is about to scroll to its line.
  onTarget?: (n: number) => void
}

type Data =
  | { s: 'loading' }
  | { s: 'error'; message: string }
  | { s: 'text'; base: string; head: string }
  | { s: 'binary'; size: number }
  | { s: 'large'; size: number }

// A file draws within DRAW_MARGIN of the scroller and tears its editor down beyond FAR_MARGIN; the gap keeps a file at the
// edge from drawing and tearing down on every scroll tick. About three screens of a phone.
const DRAW_MARGIN = 800
export const FAR_MARGIN = 3000
// The server serves nothing above this, `all=1` included; an unknown size (a 413) offers no download either.
const BINARY_CAP = 50 * 1024 * 1024
const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`
const sideText = (s: Side): string => (s.kind === 'text' ? s.text : '')

// Fetches both sides of a file with the list's shas. An added file has no base, a deleted one no head, and a rename's
// base side is at its old path.
export async function loadFile(f: DiffFileItem, refs: SideRef, signal?: AbortSignal): Promise<Data> {
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

export function FileDiff({ scroller, file, refs, mode, wrap, viewed, onViewed, onHide, onEditor, onDecl, hasDecl, forceOpen, target, onTarget }: FileDiffProps) {
  const root = useRef<HTMLElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined')
  const [data, setData] = useState<Data>({ s: 'loading' })
  const [tries, setTries] = useState(0)
  const [whole, setWhole] = useState(false)
  const [note, setNote] = useState('')
  const noDiff = file.denied || (file.status === 'renamed' && !file.additions && !file.deletions && !file.binary)
  const open = (!viewed || !!forceOpen) && !noDiff
  // The latest callbacks, so a new closure from the parent doesn't redraw the editor.
  const cb = useRef({ onDecl, hasDecl, onTarget })
  cb.current = { onDecl, hasDecl, onTarget }
  const ed = useRef<DiffEditor | null>(null)
  const [drawn, setDrawn] = useState(0)
  const revealed = useRef(0)

  // A jump here draws the file now, wherever it is.
  useEffect(() => { if (target) setNear(true) }, [target?.n])

  // Draw only what is near the viewport, so a 100-file PR stays fast.
  useEffect(() => {
    const el = root.current
    if (near || !el) return
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setNear(true); io.disconnect() } }, { root: scroller?.current ?? null, rootMargin: `${DRAW_MARGIN}px 0px` })
    io.observe(el)
    return () => io.disconnect()
  }, [near])

  // Tear a drawn editor down once its section leaves the far margin, so scrolling a long PR doesn't keep every EditorView
  // alive. The section keeps its measured height meanwhile (`pinned`), so nothing above the viewport shifts.
  const [pinned, setPinned] = useState(0)
  const farOut = useRef(false)
  // A jump to this file holds its editor from the new `target.n` until the far observer has seen the file in range:
  // CodeMirror applies the scroll a frame after `reveal`, so a file jumped to from far away is still out of range at first.
  const jumpHold = useRef(false)
  useEffect(() => { if (target) jumpHold.current = true }, [target?.n])
  useEffect(() => {
    const el = root.current
    if (!near || !drawn || !el || typeof IntersectionObserver === 'undefined') return
    farOut.current = false
    // Focus or a selection inside the file, or a jump still to land here, keeps the editor. `next` is where focus is going.
    const held = (next: Node | null) => {
      if (jumpHold.current) return true
      if (next && host.current?.contains(next)) return true
      const sel = document.getSelection()
      return !!sel && !sel.isCollapsed && !!sel.anchorNode && el.contains(sel.anchorNode)
    }
    const tear = (next: Node | null = document.activeElement) => {
      if (!farOut.current || !ed.current || held(next)) return
      setPinned(el.offsetHeight)
      setNear(false)
    }
    const io = new IntersectionObserver((es) => {
      farOut.current = !es.some((e) => e.isIntersecting)
      if (!farOut.current) jumpHold.current = false
      tear()
    }, { root: scroller?.current ?? null, rootMargin: `${FAR_MARGIN}px 0px` })
    io.observe(el)
    // A file held when it left tears down once the hold ends.
    const onSel = () => tear()
    // Alt-tab blurs the editor with a null `relatedTarget`; the caret is still there, so `activeElement` says where focus is.
    const onOut = (e: FocusEvent) => tear((e.relatedTarget as Node | null) ?? document.activeElement)
    document.addEventListener('selectionchange', onSel)
    el.addEventListener('focusout', onOut)
    return () => { io.disconnect(); document.removeEventListener('selectionchange', onSel); el.removeEventListener('focusout', onOut) }
  }, [near, drawn])

  const fetching = near && open
  // What was fetched, so closing a file (Viewed) and opening it again keeps its data instead of fetching both sides again.
  const loadedFor = useRef('')
  useEffect(() => {
    if (!fetching) return
    const id = [refs.repo, refs.pr, refs.head, refs.base, file.path, tries].join('\0')
    if (loadedFor.current === id) return
    const ctl = new AbortController()
    setData({ s: 'loading' })
    loadFile(file, refs, ctl.signal).then((d) => { loadedFor.current = id; setData(d) }, (e) => { if (!ctl.signal.aborted) setData({ s: 'error', message: e instanceof DiffFail || e instanceof Error ? e.message : 'Could not load this file.' }) })
    return () => ctl.abort()
  }, [fetching, file, refs.repo, refs.pr, refs.head, refs.base, tries])

  const text = data.s === 'text' ? data : null
  useEffect(() => {
    if (!text || !host.current || !open || !near) return
    let dead = false
    let made: DiffEditor | undefined
    const el = host.current
    const decl = cb.current.onDecl ? { onDecl: (h: DeclHit) => cb.current.onDecl?.(h), hasDecl: (n: string, s: DeclSide) => cb.current.hasDecl?.(n, s) ?? Promise.resolve(false) } : {}
    void import('./mergeEditor').then((m) => m.createDiffEditor(el, { base: text.base, head: text.head, path: file.path, mode, collapse: !whole, wrap, ...decl })).then((e) => {
      if (dead) return e.destroy()
      made = e
      ed.current = e
      setDrawn((n) => n + 1)
      setPinned(0)
      onEditor?.(e.views, file.path)
    }, () => { if (!dead) setData({ s: 'error', message: 'Could not draw this file.' }) })
    return () => { dead = true; if (made) { ed.current = null; onEditor?.(null, file.path); made.destroy() } }
  }, [text, open, near, mode, whole, wrap, file.path])

  // Once the editor is drawn, a pending jump expands, scrolls to and marks its line, once per jump.
  useEffect(() => {
    if (!target || !ed.current || revealed.current === target.n) return
    revealed.current = target.n
    const e = ed.current
    cb.current.onTarget?.(target.n)
    // CodeMirror scrolls a frame after `reveal`. Once it has, a file in range of the far margin ends its jump hold: no
    // observer callback comes for a file that never left the range, so the hold would outlast the jump.
    requestAnimationFrame(() => {
      if (ed.current !== e) return
      e.reveal(target.line, target.side)
      requestAnimationFrame(() => {
        const el = root.current
        if (ed.current !== e || !el) return
        const r = el.getBoundingClientRect()
        const s = scroller?.current?.getBoundingClientRect()
        const top = s ? s.top : 0, bottom = s ? s.bottom : window.innerHeight
        if (r.bottom > top - FAR_MARGIN && r.top < bottom + FAR_MARGIN) jumpHold.current = false
      })
    })
  }, [target?.n, drawn])

  const download = async () => {
    setNote('Preparing…')
    try {
      const b = await fetchWhole(refs, file.path, file.status === 'deleted' ? 'base' : 'head')
      const a = document.createElement('a')
      const u = URL.createObjectURL(b)
      a.href = u
      a.download = file.path.slice(file.path.lastIndexOf('/') + 1)
      a.click()
      setTimeout(() => URL.revokeObjectURL(u), 10_000)
      setNote('')
    } catch (e) { setNote((e as Error).message) }
  }

  return (
    <section ref={root} className="dv-file" data-dv-file={file.path} data-status={file.status} aria-label={file.path} style={{ ['--dv-lines' as string]: estimateLines(file), ...(pinned && open && data.s === 'text' ? { minHeight: pinned } : {}) }}>
      <DiffFileHead file={file} viewed={viewed} onViewed={onViewed} onHide={onHide}>
        {text && open && <button type="button" className="dv-btn" aria-pressed={whole} onClick={() => setWhole((w) => !w)}>{whole ? 'Collapse' : 'Expand all'}</button>}
      </DiffFileHead>
      {file.denied && <div className="dv-row muted"><Icon name="lock" /> hidden: protected file</div>}
      {!file.denied && file.status === 'renamed' && noDiff && <div className="dv-row muted">Renamed, no content changes.</div>}
      {open && data.s === 'loading' && <div className="dv-row muted dv-loading">{near ? 'Loading…' : ''}</div>}
      {open && data.s === 'error' && <div className="dv-row" role="alert"><span className="dv-err">{data.message}</span> <button type="button" className="dv-btn" onClick={() => setTries((n) => n + 1)}>Try again</button></div>}
      {open && data.s === 'binary' && <div className="dv-row muted">binary, {kb(data.size)}</div>}
      {open && data.s === 'large' && (
        <div className="dv-row muted">
          too large to show{data.size ? ` (${kb(data.size)})` : ''}.{' '}
          {data.size > 0 && data.size <= BINARY_CAP && <button type="button" className="dv-btn" onClick={download}><Icon name="download" /> Download file</button>}
          {note && <span> {note}</span>}
        </div>
      )}
      {open && data.s === 'text' && (file.additions + file.deletions === 0 && data.base === data.head) && <div className="dv-row muted">No line changes.</div>}
      <div className="dv-code" ref={host} hidden={!(open && data.s === 'text')} />
    </section>
  )
}
