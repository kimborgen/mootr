// A tab in an agent's world: everything it receives, in the order it arrives — stam's
// rendered system-prompt parts, the files its harness loads itself, and its first prompt.
// Read-only, and an outline: every part starts collapsed so it fits on one screen, and
// stam's parts link into Settings while repo files are shown as they are.
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { agentAction, openWorld } from '../actions'
import { Glyph } from '../Glyph'
import { Icon } from '../Icon'
import { live } from '../format'
import { byId } from '../store'
import { Loading } from '../Loading'

interface Part {
  label: string
  source: 'stam' | 'stam-generated' | 'repo' | 'user-global'
  path?: string
  origin?: string
  format: 'markdown' | 'text'
  text: string
}
type Loaded = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ok'; parts: Part[] }

const SOURCE: Record<Part['source'], string> = { stam: 'mootr', 'stam-generated': 'mootr · generated', repo: 'repo', 'user-global': 'user-global' }
const md = (text: string) => DOMPurify.sanitize(marked.parse(text) as string)
const lines = (text: string) => (text ? text.split('\n').length : 0)
const size = (p: Part) => `${lines(p.text)} ${lines(p.text) === 1 ? 'line' : 'lines'}`

// Hand the part to Settings: the other developer's Instructions section reads these keys.
function editInSettings(origin: string) {
  try {
    localStorage.setItem('stam/settings-section', 'instructions')
    localStorage.setItem('stam/settings-item', origin)
  } catch {}
  openWorld('config')
}

export function InstructionsView({ id }: { id: string }) {
  const a = byId(id)
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  const [busy, setBusy] = useState(false)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let on = true
    setLoaded({ state: 'loading' })
    api<{ parts: Part[] }>('GET', `/api/agents/${id}/instructions`).then(
      (r) => on && setLoaded({ state: 'ok', parts: r.parts }),
      (e) => on && setLoaded({ state: 'error', message: (e as Error).message }),
    )
    return () => { on = false }
  }, [id])

  if (!a) return <div className="details pad"><div className="empty-pane"><p>This agent is gone.</p></div></div>

  const restart = async () => { setBusy(true); await agentAction(a, 'restart'); setBusy(false) }
  const setAll = (open: boolean) => { for (const d of list.current?.querySelectorAll<HTMLDetailsElement>('details') ?? []) d.open = open }

  return (
    <div className="details pad instructions">
      <h2><Glyph agent={a} />{a.name} · instructions</h2>
      <div className="sub">What {a.name} gets at its next start. Changes made since it started reach it after a restart.</div>
      <div className="actions-row">
        {live(a) ? <button className="btn" disabled={busy} onClick={() => void restart()}><Icon name="rotate-ccw" />Restart</button> : null}
        <button className="btn text" onClick={() => setAll(true)}>Expand all</button>
        <button className="btn text" onClick={() => setAll(false)}>Collapse all</button>
      </div>
      {loaded.state === 'loading' ? <Loading className="muted" />
        : loaded.state === 'error' ? <p className="muted">{loaded.message}</p>
        : (
          <div ref={list}>
            {loaded.parts.map((p, i) => (
              <details className="fold inst-part" key={i}>
                <summary>
                  <span className="inst-row">
                    <Icon name="chevron-right" size="xs" />
                    <span className="inst-label">{p.label}</span>
                    <span className="badge">{SOURCE[p.source]}</span>
                    <span className="inst-size" title={`${lines(p.text)} lines · about ${Math.ceil(p.text.length / 4)} tokens`}>{size(p)}</span>
                  </span>
                  {p.path ? <span className="inst-path mono" title={p.path}>{p.path}</span> : null}
                </summary>
                {p.origin ? <div className="inst-actions"><button className="btn" onClick={() => editInSettings(p.origin!)}><Icon name="settings" size="xs" />Edit in Settings</button></div> : null}
                {p.format === 'markdown'
                  ? <div className="md inst-text" dangerouslySetInnerHTML={{ __html: md(p.text) }} />
                  : <pre className="code">{p.text}</pre>}
              </details>
            ))}
          </div>
        )}
    </div>
  )
}
