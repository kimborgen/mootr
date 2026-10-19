// The Files world, `w:files` (S-1526): a tree of the allowed roots for each machine (this one, then each
// peer), a path box, and the files opened lately (per viewer, kept in localStorage). A folder lists when it
// opens; a file opens in the file view. A stopped peer says so and offers Start, and never spins.
import { useCallback, useEffect, useState } from 'react'
import { Icon } from '../Icon'
import { formatSize } from '../format'
import { useData } from '../store'
import { Failure } from './FileView'
import { baseName, onRecent, parentOf, pathBoxTarget, readRecent, type FileRef } from './fileKey'
import { FilesFail, listFiles, type Entry, type Listing } from './filesApi'
import { onGoto, openFile, takeGoto } from './open'

type Load = { s: 'loading' } | { s: 'error'; err: FilesFail | Error } | { s: 'ok'; list: Listing }

function useListing(host: string, path: string, on: boolean) {
  const [st, setSt] = useState<Load>({ s: 'loading' })
  const [tries, setTries] = useState(0)
  useEffect(() => {
    if (!on) return
    const ctl = new AbortController()
    setSt({ s: 'loading' })
    listFiles(host, path, ctl.signal).then((list) => setSt({ s: 'ok', list }), (err) => { if (!ctl.signal.aborted) setSt({ s: 'error', err }) })
    return () => ctl.abort()
  }, [host, path, on, tries])
  return [st, () => setTries((n) => n + 1)] as const
}

function Row({ depth, kind, name, size, onClick, open }: { depth: number; kind: Entry['kind'] | 'root'; name: string; size?: number; onClick: () => void; open?: boolean }) {
  const folder = kind === 'dir' || kind === 'root'
  return (
    <button className="fl-row" style={{ paddingLeft: `calc(var(--space-2) + ${depth} * var(--space-4))` }} onClick={onClick} aria-expanded={folder ? !!open : undefined}>
      <span className="fl-caret">{folder && <Icon name={open ? 'chevron-down' : 'chevron-right'} size="xs" />}</span>
      <Icon name={folder ? 'folder' : 'file-text'} />
      <span className="fl-name">{name}</span>
      {kind === 'symlink' && <span className="muted fl-meta">link</span>}
      {!folder && size != null && <span className="muted fl-meta">{formatSize(size)}</span>}
    </button>
  )
}

function Dir({ host, path, name, depth, kind }: { host: string; path: string; name: string; depth: number; kind: Entry['kind'] | 'root' }) {
  const [open, setOpen] = useState(false)
  const [st, retry] = useListing(host, path, open)
  // A symlink may name a file: its listing is refused as "not a folder", so it opens as a file instead.
  const notFolder = st.s === 'error' && st.err instanceof FilesFail && st.err.status === 400
  useEffect(() => { if (notFolder) { setOpen(false); openFile(host, path) } }, [notFolder, host, path])
  return (
    <div>
      <Row depth={depth} kind={kind} name={name} onClick={() => setOpen((o) => !o)} open={open} />
      {open && st.s === 'loading' && <div className="fl-state muted" style={{ paddingLeft: `calc(var(--space-8) + ${depth + 1} * var(--space-4))` }}>Loading…</div>}
      {open && st.s === 'error' && !notFolder && <div className="fl-state"><Failure err={st.err} host={host} retry={retry} /></div>}
      {open && st.s === 'ok' && 'entries' in st.list && (st.list.entries.length === 0
        ? <div className="fl-state muted" style={{ paddingLeft: `calc(var(--space-8) + ${depth + 1} * var(--space-4))` }}>Empty folder</div>
        : st.list.entries.map((e) => <Node key={e.name} host={host} dir={path} e={e} depth={depth + 1} />))}
    </div>
  )
}

function Node({ host, dir, e, depth }: { host: string; dir: string; e: Entry; depth: number }) {
  const path = (dir === '/' ? '' : dir) + '/' + e.name
  // A link may point at a folder; opening it as a file would fail, so it lists like a folder and a read of a file falls back.
  return e.kind === 'file' ? <Row depth={depth} kind="file" name={e.name} size={e.size} onClick={() => openFile(host, path)} /> : <Dir host={host} path={path} name={e.name} depth={depth} kind={e.kind} />
}

function Machine({ host, here }: { host: string; here: boolean }) {
  const [open, setOpen] = useState(here)
  const [st, retry] = useListing(host, '', open)
  return (
    <section className="fl-machine" aria-label={`Files on ${host}`}>
      <button className="fl-machine-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size="xs" /><Icon name="server" /><span className="fl-name">{host}</span>{here && <span className="muted fl-meta">this machine</span>}
      </button>
      {open && st.s === 'loading' && <div className="fl-state muted">Loading…</div>}
      {open && st.s === 'error' && <div className="fl-state"><Failure err={st.err} host={host} retry={retry} /></div>}
      {open && st.s === 'ok' && 'roots' in st.list && (st.list.roots.length === 0
        ? <div className="fl-state muted">No folders are shared on {host}. Add some under Settings, Files.</div>
        : st.list.roots.map((r) => <Dir key={r.path} host={host} path={r.path} name={r.path} depth={1} kind="root" />))}
    </section>
  )
}

// A folder the path box or a breadcrumb names, listed flat with a row up to its parent.
function Browse({ host, path, close }: { host: string; path: string; close: () => void }) {
  const [at, setAt] = useState(path)
  useEffect(() => setAt(path), [path])
  const [st, retry] = useListing(host, at, true)
  // A link to a file lists as "not a folder": open it as a file and stay in its folder.
  const notFolder = st.s === 'error' && st.err instanceof FilesFail && st.err.status === 400
  useEffect(() => { if (notFolder) { openFile(host, at); setAt(parentOf(at)) } }, [notFolder, host, at])
  return (
    <section className="fl-browse" aria-label={`Folder ${at}`}>
      <div className="fl-browse-head"><span className="fl-name">{host}:{at}</span><button className="btn text fv-touch" onClick={close}>Close</button></div>
      {st.s === 'loading' && <div className="fl-state muted">Loading…</div>}
      {st.s === 'error' && !notFolder && <div className="fl-state"><Failure err={st.err} host={host} retry={retry} /></div>}
      {st.s === 'ok' && 'entries' in st.list && (
        <>
          {at !== '/' && <Row depth={0} kind="root" name=".." onClick={() => setAt(parentOf(at))} />}
          {st.list.entries.map((e) => {
            const p = (at === '/' ? '' : at) + '/' + e.name
            return e.kind === 'file' ? <Row key={e.name} depth={0} kind="file" name={e.name} size={e.size} onClick={() => openFile(host, p)} /> : <Row key={e.name} depth={0} kind={e.kind} name={e.name} onClick={() => setAt(p)} />
          })}
        </>
      )}
    </section>
  )
}

export function FilesView() {
  const { machine, machines } = useData()
  const here = machine || 'this machine'
  const peers = machines.map((m) => m.name).filter((n) => n !== machine)
  const [text, setText] = useState('')
  const [recent, setRecent] = useState<FileRef[]>(readRecent)
  const [browse, setBrowse] = useState<{ host: string; path: string } | null>(null)
  const [msg, setMsg] = useState('')
  const take = useCallback(() => { const g = takeGoto(); if (g) { setBrowse(g); setText(`${g.host}:${g.path}`) } setRecent(readRecent()) }, [])
  useEffect(() => { take(); const off = onGoto(take); const offRecent = onRecent(() => setRecent(readRecent())); return () => { off(); offRecent() } }, [take])
  const go = async () => {
    const t = pathBoxTarget(text, here)
    if (!t) { setMsg('Type an absolute path, like /home/you/projects, or HOST:/path.'); return }
    setMsg('')
    try {
      // The listing names the real path (the daemon expands `~`), so no key or child path ever holds a `~`.
      const l = await listFiles(t.host, t.path)
      if ('entries' in l) setBrowse({ host: t.host, path: l.path })
      else openFile(t.host, t.path)
    } catch (e) {
      // A path that names a file isn't a folder: open it, through its folder's real path when it starts with `~`.
      if (e instanceof FilesFail && e.status === 400) {
        try {
          if (!t.path.startsWith('~')) return openFile(t.host, t.path)
          const dir = await listFiles(t.host, t.path.replace(/\/[^/]*$/, '') || '~')
          if ('entries' in dir) openFile(t.host, (dir.path === '/' ? '' : dir.path) + '/' + baseName(t.path))
        } catch (e2) { setMsg((e2 as Error).message) }
      } else setMsg((e as Error).message)
    }
  }
  return (
    <div className="fl">
      <form className="fl-pathbox" onSubmit={(e) => { e.preventDefault(); void go() }}>
        <input className="fl-input" value={text} onChange={(e) => setText(e.target.value)} placeholder={`/path, or ${here}:/path`} aria-label="Path" spellCheck={false} autoCapitalize="off" autoCorrect="off" />
        <button className="btn primary fv-touch" type="submit">Go</button>
      </form>
      {msg && <div className="fl-msg" role="alert">{msg}</div>}
      {browse && <Browse host={browse.host} path={browse.path} close={() => setBrowse(null)} />}
      {recent.length > 0 && (
        <section className="fl-recent" aria-label="Recent files">
          <div className="eyebrow">Recent</div>
          {recent.map((r) => (
            <button key={r.host + r.path} className="fl-row" onClick={() => openFile(r.host, r.path)} title={`${r.host}:${r.path}`}>
              <span className="fl-caret" /><Icon name="file-text" /><span className="fl-name">{baseName(r.path)}</span><span className="muted fl-meta fl-where">{r.host}</span>
            </button>
          ))}
        </section>
      )}
      <Machine host={here} here />
      {peers.map((p) => <Machine key={p} host={p} here={false} />)}
    </div>
  )
}
