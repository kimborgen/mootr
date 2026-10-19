// The preview of a suggestion (S-1910): what a long press (a phone), a right click, Alt+P or the
// Preview button (a desktop) shows for a card, so the human can confirm it is the right one before
// picking. It is the menu layer's popover: a bottom sheet on a phone and a popover on a desktop, so
// back, Esc, and a tap outside close it and focus returns to the box. It reads what the store holds
// (the agent, the ITSA) and fetches only a mail thread's latest mail.
import { useEffect, useState } from 'react'
import { api } from './api'
import { KIND, kindIcon } from './CcPills'
import { stateOf } from './format'
import { statusLabel } from './itsa/itsa'
import { byId, useData } from './store'
import { hideMenu, showPopover } from './ui/menu'
import type { Mail, SearchResult } from './types'

// How many lines of a mail the preview shows.
export const PREVIEW_LINES = 6

export const firstLines = (body: string, n = PREVIEW_LINES) =>
  body.split('\n').map((l) => l.trimEnd()).filter((l, i, all) => l || (i > 0 && all[i - 1])).slice(0, n).join('\n').trim()

function Fact({ label, value }: { label: string; value?: string | null }) {
  return value ? <div className="sgp-fact"><dt>{label}</dt><dd>{value}</dd></div> : null
}

function ThreadBody({ r }: { r: SearchResult }) {
  const [mail, setMail] = useState<Mail | null | undefined>(undefined)
  useEffect(() => {
    const ctl = new AbortController()
    api<Mail[]>('GET', `/api/threads/${encodeURIComponent(r.id)}`, undefined, ctl.signal).then(
      (ms) => { if (!ctl.signal.aborted) setMail(ms.filter((m) => !m.superseded_by).at(-1) ?? null) },
      () => { if (!ctl.signal.aborted) setMail(null) })
    return () => ctl.abort()
  }, [r.id])
  const from = mail ? mail.from_name || (mail.from_id === 'human' ? 'you' : mail.from_id) : undefined
  const lines = mail ? firstLines(mail.body) : r.snippet ?? ''
  return <>
    <dl className="sgp-facts"><Fact label="From" value={from} /><Fact label="With" value={r.meta} /></dl>
    {mail === undefined && !lines ? <p className="sgp-body muted" role="status">Loading…</p>
      : lines ? <p className="sgp-body" data-preview-body>{lines}</p> : <p className="sgp-body muted">No text.</p>}
  </>
}

function PreviewBody({ r }: { r: SearchResult }) {
  const { agents, itsas } = useData()
  if (r.kind === 'thread') return <ThreadBody r={r} />
  if (r.kind === 'agent') {
    const a = agents.find((x) => x.id === r.id)
    return a ? <dl className="sgp-facts">
      <Fact label="Role" value={a.type || a.role || a.kind} />
      <Fact label="State" value={stateOf(a)} />
      <Fact label="Doing" value={a.activity_detail} />
      <Fact label="Runs on" value={[a.harness, a.model, a.machine].filter(Boolean).join(' · ')} />
    </dl> : <p className="sgp-body" data-preview-body>{r.snippet ?? ''}</p>
  }
  const it = itsas.find((x) => x.id === r.id)
  const owner = it?.owner ? byId(it.owner)?.name ?? it.owner : undefined
  return it ? <>
    <dl className="sgp-facts">
      <Fact label="Status" value={statusLabel(it.status)} />
      <Fact label="Owner" value={owner} />
    </dl>
    {it.summary ? <p className="sgp-body" data-preview-body>{it.summary}</p> : null}
  </> : <p className="sgp-body" data-preview-body>{[r.meta, r.snippet].filter(Boolean).join('\n')}</p>
}

function Preview({ r, onPick }: { r: SearchResult; onPick: (r: SearchResult) => void }) {
  const it = useData().itsas.find((x) => r.kind === 'itsa' && x.id === r.id)
  return <div className="sgp" data-preview={r.kind + ':' + r.id}>
    <div className="sgp-head">
      <span className="pal-ico">{kindIcon(r)}</span>
      <h3 className="sgp-title">{it ? <span className="ikey">{it.key}</span> : null}{r.title}</h3>
      <span className="sg-k">{KIND[r.kind] ?? r.kind}</span>
    </div>
    <PreviewBody r={r} />
    <div className="sgp-actions">
      <button type="button" className="btn" data-preview-close onClick={() => hideMenu(true)}>Close</button>
      <button type="button" className="btn primary" data-preview-pick onClick={() => { hideMenu(); onPick(r) }}>Pick</button>
    </div>
  </div>
}

// Opens the preview for `r` at a point. `onPick` is the row's own pick, so Pick does what a tap does.
export function openPreview(r: SearchResult, x: number, y: number, onPick: (r: SearchResult) => void) {
  showPopover(x, y, `Preview of ${r.title}`, <Preview r={r} onPick={onPick} />)
}

// Opens it beside the card on the page for `r`, for the keyboard and the Preview button.
export function openPreviewAt(r: SearchResult, onPick: (r: SearchResult) => void) {
  const card = [...document.querySelectorAll<HTMLElement>('[data-suggest]')].find((e) => e.dataset.suggest === r.kind + ':' + r.id)
  const b = card?.getBoundingClientRect()
  openPreview(r, (b?.left ?? 0) + 40, b?.bottom ?? 0, onPick)
}
