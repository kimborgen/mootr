import './DiffView.css'
import '../files/CodeView.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CodePrefButtons, useCodePrefs } from '../files/codePrefs'
import { openFile } from '../files/open'
import { DeclPicker, isPhone, type DeclPickState } from '../decl/DeclPicker'
import { DeclFail, hasDecl, lookupDecl, type DeclMatch } from '../decl/declApi'
import type { DeclHit, DeclSide } from '../decl/declExt'
import { fetchDiffList, fetchSide } from './diffApi'
import { parseDiffKey } from './diffKey'
import {
  chips, currentFile, isShown, readViewed, shownFiles, splitPath, startFilter, stepChange, stepFile, toggleClass, toggleFile, viewedKey, withViewed, writeViewed,
  type DiffFileItem, type DiffList, type Filter,
} from './diffModel'
import { FileDiff } from './FileDiff'
import type { DiffEditorViews, DiffMode } from './mergeEditor'

// The PR diff view, `diff:REPO#N` (S-1531, the web half of the PR diff viewer S-1019): a header with the shas and the Meat
// chips, a file list (a left column on a wide pane, a sheet on a narrow one), and each file's diff. Entry points are S-1533.
// `onEditor` receives each drawn file's CodeMirror views (and null when they go). Go to declaration (S-1532) is built in:
// a Ctrl/Cmd-click or tap on an identifier looks it up at the head (or, on deleted lines, the merge base) and jumps with
// `goTo`, shows a picker, or shows the lines of a declaration outside the PR with Open file.
export interface DiffViewProps {
  viewKey: string
  onEditor?: (views: DiffEditorViews | null, path: string) => void
  // Receives the view's `goTo`, for callers (and tests) that jump without a click.
  apiRef?: (api: DiffViewApi | null) => void
}

export interface DiffViewApi {
  // Shows a file of the PR (un-hiding it), scrolls to it, and once its editor draws expands, scrolls to and marks the line.
  // False when the path isn't in the PR.
  goTo(path: string, line: number, side?: DeclSide): boolean
}

type DeclUi = { name: string; side: DeclSide; anchor: { x: number; y: number; top: number }; phone: boolean; state: DeclPickState; root?: { host: string; path: string } }
// How many lines of a declaration outside the PR the picker shows.
const DECL_LINES = 8

type State = { s: 'loading' } | { s: 'error'; err: Error } | { s: 'ok'; list: DiffList }

const MODE_KEY = 'stam.diff.mode'
const readMode = (): DiffMode => { try { return localStorage.getItem(MODE_KEY) === 'unified' ? 'unified' : 'split' } catch { return 'split' } }
const short = (sha: string) => sha.slice(0, 7)
// A pane at least this wide keeps the file list beside the diffs, and one at least this wide can show both sides.
export const LIST_MIN = 720
export const SPLIT_MIN = 900
// Where a change lands below the top of the scrolling column: under the file's sticky header.
const CHANGE_OFFSET = 56

export function DiffView({ viewKey, onEditor, apiRef }: DiffViewProps) {
  const ref = useMemo(() => parseDiffKey(viewKey), [viewKey])
  const [st, setSt] = useState<State>({ s: 'loading' })
  const [tries, setTries] = useState(0)
  const [flt, setFlt] = useState<Filter>(startFilter)
  const [viewed, setViewed] = useState<Set<string>>(readViewed)
  const [pref, setPref] = useState<DiffMode>(readMode)
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 0 : window.innerWidth))
  const [sheet, setSheet] = useState(false)
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const main = useRef<HTMLDivElement>(null)
  const prefs = useCodePrefs()

  useEffect(() => {
    if (!ref) return
    const ctl = new AbortController()
    setSt({ s: 'loading' })
    setFlt(startFilter())
    fetchDiffList(ref.repo, ref.pr, ctl.signal).then(
      (list) => setSt({ s: 'ok', list }),
      (err) => { if (!ctl.signal.aborted) setSt({ s: 'error', err }) })
    return () => ctl.abort()
  }, [ref, tries])

  // The pane's width, not the window's: a narrow pane in a wide window gets the narrow layout.
  useEffect(() => {
    const el = root.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [st.s])
  const wide = width >= LIST_MIN
  const splitOk = width >= SPLIT_MIN
  const mode: DiffMode = splitOk && pref === 'split' ? 'split' : 'unified'
  const pickMode = (m: DiffMode) => { setPref(m); try { localStorage.setItem(MODE_KEY, m) } catch { /* private window */ } }

  const list = st.s === 'ok' ? st.list : null
  const files = list?.files ?? []
  const shown = useMemo(() => shownFiles(files, flt), [files, flt])
  const refs = useMemo(() => (list ? { repo: list.repo, pr: list.pr, head: list.head, base: list.base } : null), [list])

  const mark = (f: DiffFileItem, on: boolean) => {
    if (!list) return
    // Read, change, write: another tab's marks made since this one loaded are kept.
    const next = withViewed(readViewed(), viewedKey(list.repo, list.pr, f), on)
    writeViewed(next)
    setViewed(next)
  }
  const isViewed = (f: DiffFileItem) => !!list && viewed.has(viewedKey(list.repo, list.pr, f))

  // Go to declaration: the file and line a jump goes to, files a jump opened although viewed, and the picker.
  const [target, setTarget] = useState<{ path: string; line: number; side: DeclSide; n: number } | null>(null)
  const [forced, setForced] = useState<ReadonlySet<string>>(new Set())
  const [decl, setDecl] = useState<DeclUi | null>(null)
  const declCtl = useRef<AbortController | null>(null)
  const jumps = useRef(0)
  const landed = useRef(0)
  useEffect(() => () => declCtl.current?.abort(), [])
  useEffect(() => { setTarget(null); setForced(new Set()); setDecl(null) }, [list])

  const els = () => [...(main.current?.querySelectorAll<HTMLElement>('[data-dv-file]') ?? [])]
  const topOf = (el: HTMLElement) => el.getBoundingClientRect().top - (main.current?.getBoundingClientRect().top ?? 0)
  const scrollToEl = (el: HTMLElement, offset = 0) => { const m = main.current; if (m) m.scrollTop += topOf(el) - offset }
  // Files above the target draw as they come near and change height, which moves the target; hold it in place for a moment
  // after a jump, unless the reader scrolls on their own.
  const pin = useRef<(() => void) | null>(null)
  useEffect(() => () => pin.current?.(), [])
  const scrollToFile = (path: string) => {
    pin.current?.()
    const m = main.current
    if (!m) return
    const align = () => { const el = els().find((e) => e.dataset.dvFile === path); if (el) scrollToEl(el) }
    align()
    const timer = setInterval(align, 100)
    const stop = () => { clearInterval(timer); clearTimeout(end); for (const ev of ['wheel', 'touchstart', 'keydown', 'pointerdown']) m.removeEventListener(ev, stop); pin.current = null }
    const end = setTimeout(stop, 1500)
    for (const ev of ['wheel', 'touchstart', 'keydown', 'pointerdown']) m.addEventListener(ev, stop, { passive: true, once: true })
    pin.current = stop
  }

  // The file at the top of the column, tracked as it scrolls.
  useEffect(() => {
    const m = main.current
    if (!m) return
    let raf = 0
    const on = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => setActive(Math.max(0, currentFile(els().map(topOf)))) ) }
    m.addEventListener('scroll', on, { passive: true })
    return () => { m.removeEventListener('scroll', on); cancelAnimationFrame(raf) }
  }, [st.s])

  const goFile = useCallback((path: string) => {
    scrollToFile(path)
    setSheet(false)
  }, [])
  const openFromList = (f: DiffFileItem) => {
    if (!isShown(f, flt)) setFlt((x) => toggleFile(f, x))
    // The file draws on the next render; scroll once it is in the column.
    requestAnimationFrame(() => requestAnimationFrame(() => goFile(f.path)))
    setSheet(false)
  }
  const stepTo = (dir: 1 | -1) => {
    const all = els()
    const at = stepFile(Math.max(0, currentFile(all.map(topOf))), dir, all.length)
    if (at >= 0) { scrollToFile(all[at].dataset.dvFile!); setActive(at) }
  }
  const stepChanged = (dir: 1 | -1) => {
    const m = main.current
    if (!m) return
    const marks = [...m.querySelectorAll<HTMLElement>('.cm-changedLine, .cm-deletedChunk')].filter((e) => {
      const p = e.previousElementSibling
      return !(p && (p.classList.contains('cm-changedLine') || p.classList.contains('cm-deletedChunk')))
    })
    const tops = marks.map((e) => topOf(e) - CHANGE_OFFSET).sort((a, b) => a - b)
    const i = stepChange(tops, dir)
    if (i === null) return stepTo(dir)
    m.scrollTop += tops[i]
  }

  const goTo = (path: string, line: number, side: DeclSide = 'head'): boolean => {
    const f = files.find((x) => x.path === path)
    if (!f || f.denied) return false
    setFlt((x) => (isShown(f, x) ? x : toggleFile(f, x)))
    setForced((s) => (s.has(path) ? s : new Set(s).add(path)))
    const n = ++jumps.current
    setTarget({ path, line, side, n })
    // The file draws on the next render; hold it at the top until its editor draws and scrolls to the line (onTarget).
    requestAnimationFrame(() => requestAnimationFrame(() => { if (landed.current !== n) scrollToFile(path) }))
    return true
  }
  const goToRef = useRef(goTo)
  goToRef.current = goTo
  useEffect(() => {
    if (!apiRef) return
    apiRef({ goTo: (p, l, s) => goToRef.current(p, l, s) })
    return () => apiRef(null)
  }, [apiRef])

  // A declaration found: a file of the PR is jumped to; any other shows its lines from the same commit, with Open file.
  const land = (m: DeclMatch, side: DeclSide, ui: DeclUi) => {
    const f = side === 'head'
      ? files.find((x) => x.path === m.path && x.status !== 'deleted' && !x.denied)
      : files.find((x) => (x.oldPath ?? x.path) === m.path && x.status !== 'added' && !x.denied)
    if (f) { setDecl(null); goTo(f.path, m.line, side); return }
    setDecl({ ...ui, state: { s: 'one', match: m, lines: null, openNote: ui.root ? `Opens the live checkout on ${ui.root.host}, which can differ from the PR.` : undefined } })
    if (!refs) return
    const ctl = declCtl.current
    fetchSide(refs, m.path, side, ctl?.signal).then((sd) => {
      const lines = sd.kind === 'text' ? sd.text.split('\n').slice(m.line - 1, m.line - 1 + DECL_LINES) : [m.text]
      setDecl((d) => (d && d.state.s === 'one' && d.state.match === m ? { ...d, state: { ...d.state, lines } } : d))
    }, () => setDecl((d) => (d && d.state.s === 'one' && d.state.match === m ? { ...d, state: { ...d.state, lines: [m.text] } } : d)))
  }
  const onDecl = (f: DiffFileItem, hit: DeclHit) => {
    if (!list) return
    declCtl.current?.abort()
    const ctl = new AbortController()
    declCtl.current = ctl
    const ui: DeclUi = { name: hit.name, side: hit.side, anchor: { x: hit.x, y: hit.y, top: hit.top }, phone: isPhone(), state: { s: 'loading' } }
    setDecl(ui)
    const sha = hit.side === 'base' ? list.mergeBase : list.head
    const from = hit.side === 'base' ? f.oldPath ?? f.path : f.path
    lookupDecl({ repo: list.repo, sha, name: hit.name, from }, { signal: ctl.signal, onBuilding: () => setDecl((d) => (d === ui || d?.state.s === 'loading' ? { ...ui, state: { s: 'building' } } : d)) }).then((r) => {
      if (ctl.signal.aborted) return
      const found = r.state === 'ready' ? r.matches : []
      const at: DeclUi = { ...ui, root: r.state === 'ready' ? r.root : undefined }
      // An index that has nothing still has the file's own tree.
      const matches = found.length ? found : hit.local()
      if (!matches.length) setDecl({ ...at, state: { s: 'none' } })
      else if (matches.length === 1) land(matches[0], hit.side, at)
      else setDecl({ ...at, state: { s: 'list', matches, total: r.state === 'ready' && found.length ? r.total : matches.length } })
    }, (e) => {
      if (ctl.signal.aborted) return
      setDecl({ ...ui, state: { s: 'error', message: e instanceof DeclFail ? e.message : 'Could not look up the declaration.' } })
    })
  }
  const hasName = (name: string, side: DeclSide) => (list ? hasDecl({ repo: list.repo, sha: side === 'base' ? list.mergeBase : list.head, name }) : Promise.resolve(false))
  const closeDecl = useCallback(() => { declCtl.current?.abort(); setDecl(null) }, [])

  // j/k and n/p, when the keyboard isn't in a field or another pane.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || !root.current) return
      const t = e.target as HTMLElement | null
      if (t && (t.closest('input, textarea, select, [contenteditable="true"]') || t.closest('.cm-panels'))) return
      if (t && t !== document.body && !root.current.contains(t)) return
      if (root.current.checkVisibility?.() === false) return
      const k = e.key
      if (k === 'j') stepTo(1)
      else if (k === 'k') stepTo(-1)
      else if (k === 'n') stepChanged(1)
      else if (k === 'p') stepChanged(-1)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  })

  useEffect(() => {
    if (!sheet) return
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape') setSheet(false) }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [sheet])

  if (!ref) return <div className="dv"><div className="dv-note">Not a diff link.</div></div>

  const total = files.length
  const fileList = (
    <ul className="dv-list" aria-label="Files">
      {files.map((f) => {
        const { dir, name } = splitPath(f.path)
        const off = !isShown(f, flt)
        const cur = !off && shown[active]?.path === f.path
        return (
          <li key={f.path}>
            <button type="button" className={'dv-li' + (cur ? ' cur' : '') + (off ? ' off' : '')} aria-current={cur || undefined} onClick={() => openFromList(f)} title={off ? `${f.path} (hidden: click to show)` : f.path}>
              <span className="dv-li-check" aria-hidden>{isViewed(f) ? '✓' : ''}</span>
              <span className="dv-li-path"><span className="dv-li-dir">{dir}</span>{name}</span>
              {f.denied ? <span className="dv-li-n muted">protected</span> : <span className="dv-li-n"><span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span></span>}
            </button>
          </li>
        )
      })}
    </ul>
  )

  return (
    <div className="dv" ref={root} data-wide={wide ? '1' : '0'} data-mode={mode} style={{ ['--code-font-size' as string]: `var(${prefs.size})` }}>
      <header className="dv-head">
        <div className="dv-title">
          <strong>PR #{ref.pr}</strong>
          <span className="dv-repo muted">{ref.repo}</span>
          {list && <span className="dv-shas mono muted">head {short(list.head)} · base {short(list.base)}</span>}
          {list && <span className="dv-count" aria-live="polite">{shown.length} of {total} files</span>}
          {list && !wide && <button type="button" className="dv-btn dv-files-btn" aria-expanded={sheet} onClick={() => setSheet((s) => !s)}>Files ({total}) ▾</button>}
        </div>
        {list && (
          <div className="dv-controls">
            <button type="button" className="dv-btn dv-meat" aria-pressed={flt.meat} onClick={() => setFlt((x) => ({ ...x, meat: !x.meat }))} title="Hide tests, lockfiles and generated files">Meat {flt.meat ? '●' : '○'}</button>
            {chips(files, flt).map((c) => (
              <button key={c.cls} type="button" className="dv-btn dv-chip" aria-pressed={c.hidden} disabled={!flt.meat} onClick={() => setFlt((x) => toggleClass(c.cls, x))} title={c.hidden ? `Show ${c.label.toLowerCase()}` : `Hide ${c.label.toLowerCase()}`}>
                {c.label} {c.count}{c.hidden ? ' hidden' : ''}
              </button>
            ))}
            <span className="dv-spacer" />
            {splitOk && (
              <span className="seg dv-mode" role="group" aria-label="Diff layout">
                <button type="button" className={mode === 'split' ? 'on' : ''} aria-pressed={mode === 'split'} onClick={() => pickMode('split')}>Split</button>
                <button type="button" className={mode === 'unified' ? 'on' : ''} aria-pressed={mode === 'unified'} onClick={() => pickMode('unified')}>Unified</button>
              </span>
            )}
            <span className="codeprefs"><CodePrefButtons prefs={prefs} /></span>
          </div>
        )}
      </header>
      <div className="dv-body">
        {wide && list && total > 0 && <nav className="dv-side" aria-label="Changed files">{fileList}</nav>}
        <div className="dv-main" ref={main}>
          {st.s === 'loading' && <div className="dv-note muted" role="status">Loading the diff…</div>}
          {st.s === 'error' && (
            <div className="dv-note" role="alert">
              <p className="dv-err">{st.err.message}</p>
              <button type="button" className="dv-btn dv-touch" onClick={() => setTries((n) => n + 1)}>Try again</button>
            </div>
          )}
          {list && total === 0 && <div className="dv-note muted">No files changed in this PR.</div>}
          {list && total > 0 && shown.length === 0 && <div className="dv-note muted">All {total} files are hidden. Turn Meat off or show a class above.</div>}
          {list && refs && shown.map((f) => (
            <FileDiff
              key={f.path} file={f} refs={refs} mode={mode} wrap={prefs.wrap} viewed={isViewed(f)} onViewed={(on) => mark(f, on)} onHide={() => setFlt((x) => toggleFile(f, x))} onEditor={onEditor}
              onDecl={(hit) => onDecl(f, hit)} hasDecl={hasName} forceOpen={forced.has(f.path)} target={target?.path === f.path ? target : undefined} onTarget={(n) => { landed.current = n; pin.current?.() }}
            />
          ))}
        </div>
      </div>
      {list && total > 0 && !wide && (
        <div className="dv-pager" role="toolbar" aria-label="Files">
          <button type="button" className="dv-btn dv-touch" onClick={() => stepTo(-1)} disabled={shown.length === 0}>‹ prev file</button>
          <button type="button" className="dv-btn dv-touch" onClick={() => stepTo(1)} disabled={shown.length === 0}>next file ›</button>
        </div>
      )}
      {decl && (
        <DeclPicker
          name={decl.name} state={decl.state} anchor={decl.anchor} phone={decl.phone} onClose={closeDecl}
          onPick={(m) => land(m, decl.side, decl)}
          onOpen={decl.root ? (m) => { const r = decl.root!; closeDecl(); openFile(r.host, `${r.path}/${m.path}`, m.line) } : undefined}
        />
      )}
      {sheet && !wide && (
        <>
          <div className="dv-scrim" onClick={() => setSheet(false)} />
          <div className="dv-sheet" role="dialog" aria-label="Changed files">
            <div className="dv-sheet-head"><strong>Files ({total})</strong><button type="button" className="dv-btn dv-touch" onClick={() => setSheet(false)}>Close</button></div>
            {fileList}
          </div>
        </>
      )}
    </div>
  )
}
