// The file view, `file:HOST:PATH[#Lline]` (S-1526, step 2 of the file viewer S-1017): one file from this
// machine or a peer, by type. Images open in the image viewer, a PDF in PdfView (Download when over the
// cap), Markdown renders with a Source toggle, text and code show in CodeView, and anything else is a Download link. A breadcrumb names the path; each part
// opens the Files world at that folder.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../Icon'
import { openImage } from '../ImageViewer'
import { Rendered } from '../mail/Rendered'
import { CodeView } from './CodeView'
import { PdfView } from './PdfView'
import { gotoLine, openFile, openFiles } from './open'
import { DeclPicker, isPhone, type DeclPickState } from '../decl/DeclPicker'
import { DeclFail, hasDecl, lookupDecl, type DeclMatch } from '../decl/declApi'
import type { DeclHit } from '../decl/declExt'
import { baseName, crumbs, kindOf, parentOf, parseFileKey, pushRecent, type Kind } from './fileKey'
import { downloadBlob, FilesFail, readFile, startMachine, type Body } from './filesApi'

// Above this, Load all would freeze the tab: the file is offered as a download.
export const LOAD_ALL_MAX = 50 * 1024 * 1024

type State = { s: 'loading' } | { s: 'error'; err: FilesFail | Error } | { s: 'ok'; body: Body; kind: Kind; src?: string }

export function Crumbs({ host, path }: { host: string; path: string }) {
  return (
    <nav className="fv-crumbs" aria-label="Path">
      <button className="fv-crumb" onClick={() => openFiles(host, '/')} title={`Files on ${host}`}>{host}</button>
      {crumbs(path).map((c, i, all) => (
        <span key={c.path} className="fv-crumb-part">
          <span className="fv-sep" aria-hidden>/</span>
          {i === all.length - 1 ? <span className="fv-crumb cur">{c.name}</span> : <button className="fv-crumb" onClick={() => openFiles(host, c.path)}>{c.name}</button>}
        </span>
      ))}
    </nav>
  )
}

// What a failed read says, with the action it offers: Start for a stopped peer, a link to the machine's own page for a strict-mode refusal.
export function Failure({ err, host, retry }: { err: FilesFail | Error; host: string; retry: () => void }) {
  const f = err instanceof FilesFail ? err : null
  const [starting, setStarting] = useState(false)
  const [startErr, setStartErr] = useState('')
  const start = () => {
    setStarting(true)
    setStartErr('')
    startMachine(host).then(retry, (e) => { setStartErr(e.message); setStarting(false) })
  }
  if (f?.stopped) {
    return (
      <div className="fv-note" role="status">
        <p>{host} is stopped.</p>
        <button className="btn primary fv-touch" onClick={start} disabled={starting}>{starting ? 'Starting…' : 'Start'}</button>
        {startErr && <p className="fv-err">{startErr}</p>}
      </div>
    )
  }
  if (f?.page) {
    return (
      <div className="fv-note" role="status">
        <p>{f.page.machine} needs its own page for this.</p>
        {f.page.origin ? <a className="btn primary fv-touch" href={f.page.origin} target="_blank" rel="noreferrer">Open {f.page.machine}</a> : <p className="muted">Open mootr on {f.page.machine}.</p>}
      </div>
    )
  }
  return <div className="fv-note" role="alert"><p className="fv-err">{err.message}</p><button className="btn fv-touch" onClick={retry}>Try again</button></div>
}

// Go to declaration in the file view (S-1532): a file in a checkout of `settings.itsa.repos` is looked up in the index
// at that checkout's HEAD (so uncommitted edits can put a line off); any other file in its own syntax tree.
type DeclUi = { name: string; anchor: { x: number; y: number; top: number }; phone: boolean; state: DeclPickState; root?: { host: string; path: string } }

function useFileDecl(viewKey: string, host: string, path: string) {
  const [decl, setDecl] = useState<DeclUi | null>(null)
  const ctl = useRef<AbortController | null>(null)
  useEffect(() => () => ctl.current?.abort(), [])
  useEffect(() => { ctl.current?.abort(); setDecl(null) }, [host, path])
  // Index paths are inside the checkout; the file's own matches carry its absolute path.
  const absOf = (m: DeclMatch, root?: { path: string }) => (root ? `${root.path}/${m.path}` : m.path)
  const go = (m: DeclMatch, ui: DeclUi) => {
    const abs = absOf(m, ui.root)
    setDecl(null)
    if (abs === path) gotoLine(viewKey, host, path, m.line)
    else openFile(ui.root?.host ?? host, abs, m.line)
  }
  const onDecl = (hit: DeclHit) => {
    ctl.current?.abort()
    const c = new AbortController()
    ctl.current = c
    const ui: DeclUi = { name: hit.name, anchor: { x: hit.x, y: hit.y, top: hit.top }, phone: isPhone(), state: { s: 'loading' } }
    setDecl(ui)
    lookupDecl({ host, file: path, name: hit.name }, { signal: c.signal, onBuilding: () => setDecl((d) => (d?.state.s === 'loading' ? { ...d, state: { s: 'building' } } : d)) }).then((r) => {
      if (c.signal.aborted) return
      const ready = r.state === 'ready' && r.matches.length > 0
      const at: DeclUi = { ...ui, root: ready && r.state === 'ready' ? r.root : undefined }
      const matches = ready && r.state === 'ready' ? r.matches : hit.local()
      if (!matches.length) setDecl({ ...at, state: { s: 'none' } })
      else if (matches.length === 1) go(matches[0], at)
      else setDecl({ ...at, state: { s: 'list', matches, total: ready && r.state === 'ready' ? r.total : matches.length } })
    }, (e) => {
      if (c.signal.aborted) return
      // The index is out of reach (a stopped home, an error): the file's own tree still answers.
      const matches = hit.local()
      if (matches.length === 1) return go(matches[0], ui)
      setDecl({ ...ui, state: matches.length ? { s: 'list', matches, total: matches.length } : { s: 'error', message: e instanceof DeclFail ? e.message : 'Could not look up the declaration.' } })
    })
  }
  const has = (name: string) => hasDecl({ host, file: path, name })
  const close = useCallback(() => { ctl.current?.abort(); setDecl(null) }, [])
  const picker = decl && (
    <DeclPicker name={decl.name} state={decl.state} anchor={decl.anchor} phone={decl.phone} onClose={close} onPick={(m) => go(m, decl)} />
  )
  return { onDecl, has, picker }
}

export function FileView({ viewKey }: { viewKey: string }) {
  const ref = useMemo(() => parseFileKey(viewKey), [viewKey])
  const [st, setSt] = useState<State>({ s: 'loading' })
  const [tries, setTries] = useState(0)
  const [all, setAll] = useState(false)
  const [source, setSource] = useState(false)
  const [dl, setDl] = useState('')
  const host = ref?.host ?? ''
  const path = ref?.path ?? ''
  const decl = useFileDecl(viewKey, host, path)
  useEffect(() => {
    if (!ref) return
    const ctl = new AbortController()
    let src: string | undefined
    setSt({ s: 'loading' })
    readFile(host, path, all, ctl.signal).then(
      (body) => {
        const kind = kindOf(baseName(path), body.type)
        if (body.blob) src = URL.createObjectURL(body.blob)
        pushRecent({ host, path })
        setSt({ s: 'ok', body, kind, src })
      },
      (err) => { if (!ctl.signal.aborted) setSt({ s: 'error', err }) })
    return () => { ctl.abort(); if (src) URL.revokeObjectURL(src) }
  }, [host, path, all, tries])
  if (!ref) return <div className="fv"><div className="fv-note">Not a file link.</div></div>
  const download = async () => {
    setDl('Preparing…')
    try {
      const a = document.createElement('a')
      const u = URL.createObjectURL(await downloadBlob(host, path))
      a.href = u
      a.download = baseName(path)
      a.click()
      setTimeout(() => URL.revokeObjectURL(u), 10_000)
      setDl('')
    } catch (e) { setDl((e as Error).message) }
  }
  return (
    <div className="fv">
      <header className="fv-head">
        <Crumbs host={host} path={path} />
        {st.s === 'ok' && st.kind === 'markdown' && (
          <div className="seg fv-toggle" role="group" aria-label="View">
            <button className={source ? '' : 'on'} aria-pressed={!source} onClick={() => setSource(false)}>Rendered</button>
            <button className={source ? 'on' : ''} aria-pressed={source} onClick={() => setSource(true)}>Source</button>
          </div>
        )}
      </header>
      <div className="fv-main">
        {st.s === 'loading' && <div className="fv-note muted">Loading…</div>}
        {st.s === 'error' && <Failure err={st.err} host={host} retry={() => setTries((n) => n + 1)} />}
        {st.s === 'ok' && st.kind === 'image' && st.src && (
          <div className="fv-image"><img src={st.src} alt={baseName(path)} onClick={() => openImage(st.src!, baseName(path))} /></div>
        )}
        {st.s === 'ok' && st.kind === 'pdf' && <PdfView src={st.src} name={baseName(path)} size={st.body.size} onDownload={download} downloadNote={dl} />}
        {st.s === 'ok' && st.kind === 'markdown' && !source && <div className="fv-md"><Rendered text={st.body.text ?? ''} base={{ host, cwd: parentOf(path) }} /></div>}
        {st.s === 'ok' && (st.kind === 'text' || (st.kind === 'markdown' && source)) && (
          <>
            {st.body.truncated && (
              <div className="fv-trunc" role="status">
                Showing the first part of a {Math.round(st.body.size / 1024 / 1024)} MB file.{' '}
                {st.body.size > LOAD_ALL_MAX ? <button className="btn text fv-touch" onClick={download}>Download it instead</button> : <button className="btn text fv-touch" onClick={() => setAll(true)}>Load all</button>}
                {dl && <span className="muted"> {dl}</span>}
              </div>
            )}
            <CodeView text={st.body.text ?? ''} path={ref.path} line={ref.line} onLineLink={(n) => gotoLine(viewKey, host, path, n)} onDecl={decl.onDecl} hasDecl={decl.has} />
          </>
        )}
        {decl.picker}
        {st.s === 'ok' && st.kind === 'download' && (
          <div className="fv-note">
            <p>{baseName(path)} <span className="muted">({st.body.type}{st.body.size ? `, ${Math.max(1, Math.round(st.body.size / 1024))} KB` : ''})</span> has no viewer yet.</p>
            <button className="btn primary fv-touch" onClick={download}><Icon name="download" /> Download</button>
            {dl && <p className="muted">{dl}</p>}
          </div>
        )}
      </div>
    </div>
  )
}
