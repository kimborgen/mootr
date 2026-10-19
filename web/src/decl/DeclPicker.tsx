import './DeclPicker.css'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DeclMatch } from './declApi'

// Go to declaration's picker (S-1532): what a click on an identifier found, when it isn't a plain jump. A popover by
// the identifier on desktop, a bottom sheet on the phone. It lists several matches as path:line and the line's text,
// shows one declaration's lines when its file can't be jumped to in the view, or says quietly that there is none.
export type DeclPickState =
  | { s: 'loading' }
  | { s: 'building' }
  | { s: 'none' }
  | { s: 'error'; message: string }
  | { s: 'list'; matches: DeclMatch[]; total: number }
  // One declaration outside the view: its lines from the indexed commit (null while they load), and an Open file action.
  | { s: 'one'; match: DeclMatch; lines: string[] | null; openNote?: string }

export interface DeclPickerProps {
  name: string
  state: DeclPickState
  // Where the identifier is on screen: its left, bottom and top (the popover sits below it, or above); ignored on the phone.
  anchor: { x: number; y: number; top?: number }
  phone: boolean
  onPick: (m: DeclMatch) => void
  onOpen?: (m: DeclMatch) => void
  onClose: () => void
  // Drawn on the document body (the default) or in place (a story's frame, where the frame is the page).
  inPlace?: boolean
}

// The phone layout, as the code editor's own touch rules choose it.
export const PHONE_QUERY = '(pointer: coarse), (max-width: 480px)'
export const isPhone = (): boolean => typeof matchMedia === 'function' && matchMedia(PHONE_QUERY).matches

export function DeclPicker({ name, state, anchor, phone, onPick, onOpen, onClose, inPlace }: DeclPickerProps) {
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  // The popover stays inside the window: below the identifier, or above it when there is no room below.
  useLayoutEffect(() => {
    if (phone || !box.current) return
    const r = box.current.getBoundingClientRect()
    const gap = 4
    const left = Math.max(gap, Math.min(anchor.x, innerWidth - r.width - gap))
    const below = anchor.y + gap
    const top = below + r.height > innerHeight - gap ? Math.max(gap, (anchor.top ?? anchor.y) - r.height - gap) : below
    setPos({ left, top })
  }, [phone, anchor.x, anchor.y, anchor.top, state])

  // The scrim closes the sheet on a click that also pressed on it: the click a browser sends after the tap that opened
  // the sheet lands on the new scrim without a press and is ignored, and the scrim stays until the click, so a closing
  // tap never falls through to what is under it.
  const armed = useRef(false)
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', key)
    // The popover has no scrim: a press outside it closes it. The click that opened it is over by now.
    const out = (e: PointerEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose() }
    const t = phone ? 0 : setTimeout(() => window.addEventListener('pointerdown', out, true), 0)
    return () => { clearTimeout(t); window.removeEventListener('keydown', key); window.removeEventListener('pointerdown', out, true) }
  }, [onClose, phone])

  const title = state.s === 'list' ? `${state.total} declarations of ${name}` : state.s === 'one' ? `${name}` : name
  const body = (() => {
    switch (state.s) {
      case 'loading': return <p className="decl-note muted" role="status">Looking up {name}…</p>
      case 'building': return <p className="decl-note muted" role="status">Indexing the repo for declarations…</p>
      case 'none': return <p className="decl-note muted" role="status">No declaration of <code>{name}</code> found.</p>
      case 'error': return <p className="decl-note decl-err" role="alert">{state.message}</p>
      case 'list': return (
        <ul className="decl-list" aria-label={`Declarations of ${name}`}>
          {state.matches.map((m) => (
            <li key={`${m.path}:${m.line}:${m.col}`}>
              <button type="button" className="decl-row" onClick={() => onPick(m)}>
                <span className="decl-row-at"><span className="decl-path">{m.path}:{m.line}</span><span className="decl-kind muted">{m.kind}</span></span>
                <span className="decl-text">{m.text}</span>
              </button>
            </li>
          ))}
          {state.total > state.matches.length && <li className="decl-note muted">and {state.total - state.matches.length} more</li>}
        </ul>
      )
      case 'one': return (
        <div className="decl-one">
          <div className="decl-row-at"><span className="decl-path">{state.match.path}:{state.match.line}</span><span className="decl-kind muted">{state.match.kind}</span></div>
          {state.lines === null
            ? <p className="decl-note muted" role="status">Loading the lines…</p>
            : <pre className="decl-lines">{state.lines.map((l, i) => <span key={i} className={i === 0 ? 'decl-line cur' : 'decl-line'}><span className="decl-ln">{state.match.line + i}</span>{l}{'\n'}</span>)}</pre>}
          {onOpen && <button type="button" className="decl-btn" onClick={() => onOpen(state.match)}>Open file</button>}
          {state.openNote && <p className="decl-note muted">{state.openNote}</p>}
        </div>
      )
    }
  })()

  // On the document body, so the sheet covers the phone's bottom bar and no pane's stacking clips the popover.
  const out = (
    <>
      {phone && <div className="decl-scrim" onPointerDown={() => { armed.current = true }} onClick={(e) => { e.stopPropagation(); if (armed.current) onClose(); armed.current = false }} />}
      <div
        ref={box}
        className={phone ? 'decl-pick decl-sheet' : 'decl-pick decl-pop'}
        role="dialog"
        aria-label={`Go to declaration: ${name}`}
        data-state={state.s}
        style={phone ? undefined : { left: pos?.left ?? anchor.x, top: pos?.top ?? anchor.y, visibility: pos ? 'visible' : 'hidden' }}
      >
        <div className="decl-head">
          <strong className="decl-title">{title}</strong>
          <button type="button" className="decl-btn decl-close" aria-label="Close" onClick={onClose}>{phone ? 'Close' : '×'}</button>
        </div>
        {body}
      </div>
    </>
  )
  return inPlace ? out : createPortal(out, document.body)
}
