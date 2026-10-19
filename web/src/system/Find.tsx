// Find an agent in the system view (S-540): by name, or by the key or title of an ITSA it owns.
// A button in the header opens it: on the desktop the box takes the header's room while open (the
// instruments it hides come back when it closes); on the phone it opens over the outline. The
// results drop over the stage (the header clips), and picking one shows its card.
import { useState } from 'react'
import { Icon } from '../Icon'
import { type Findable, type Found, search } from './scale'

export interface Find { q: string; open: boolean; hi: number; results: Found[]; set: (q: string) => void; show: (open: boolean) => void; key: (e: React.KeyboardEvent) => void; pick: (id: string) => void }

export function useFind(entries: readonly Findable[], onPick: (id: string) => void): Find {
  const [q, setQ] = useState('')
  const [open, show] = useState(false)
  const [hi, setHi] = useState(0)
  const results = open ? search(entries, q) : []
  // The highlighted result, kept in range as the results change under it.
  const at = Math.min(hi, Math.max(0, results.length - 1))
  const pick = (id: string) => { setQ(''); show(false); onPick(id) }
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (results.length) setHi((at + (e.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length)
    } else if (e.key === 'Enter' && results[at]) { e.preventDefault(); pick(results[at].id) }
    else if (e.key === 'Escape') { e.preventDefault(); setQ(''); show(false); (e.target as HTMLElement).blur() }
  }
  return { q, open, hi: at, results, set: (v) => { setQ(v); setHi(0); show(true) }, show, key, pick }
}

// The box: in the header on the desktop, at the top of the drop on the phone.
export function FindBox({ f, autoFocus }: { f: Find; autoFocus?: boolean }) {
  return (
    <label className="sv-find">
      <Icon name="search" size="xs" />
      <input type="search" value={f.q} placeholder="Find an agent or ITSA" aria-label="Find an agent or ITSA" autoFocus={autoFocus}
        role="combobox" aria-expanded={f.results.length > 0} aria-controls="sv-found" aria-activedescendant={f.results.length ? `sv-found-${f.hi}` : undefined}
        onChange={(e) => f.set(e.target.value)} onFocus={() => f.show(true)} onBlur={() => f.show(false)} onKeyDown={f.key} />
    </label>
  )
}

// The button that opens it: an icon on the phone, an icon and a word on the desktop, as Fit is.
export function FindButton({ f, label }: { f: Find; label?: boolean }) {
  return label
    ? <button type="button" className="btn text sv-find-btn" onClick={() => f.show(true)} aria-expanded={f.open} title="Find an agent or ITSA"><Icon name="search" />Find</button>
    : <button type="button" className="icon-btn sv-find-btn" onPointerDown={(e) => e.preventDefault()} onClick={() => f.show(!f.open)} aria-label="Find an agent or ITSA" aria-expanded={f.open}><Icon name="search" /></button>
}

// The drop over the stage: on the phone the box too, while it is open.
export function FindDrop({ f, narrow }: { f: Find; narrow: boolean }) {
  if (!f.open || (!narrow && !f.q.trim())) return null
  return (
    <div className={'sv-drop' + (narrow ? ' narrow' : '')}>
      {narrow ? <FindBox f={f} autoFocus /> : null}
      {f.q.trim() ? <div id="sv-found" className="sv-found" role="listbox" aria-label="Agents found">
        {!f.results.length ? <p className="pal-hint">No agent or ITSA matches “{f.q.trim()}”.</p>
          : f.results.map((r, i) => (
            // A press keeps the box's focus, so its blur doesn't close the list before the click.
            <button key={r.id} id={`sv-found-${i}`} type="button" role="option" tabIndex={-1} aria-selected={i === f.hi} className={'pal-result' + (i === f.hi ? ' sel' : '')} data-found={r.id}
              onPointerDown={(e) => e.preventDefault()} onClick={() => f.pick(r.id)}>
              <span className="pal-text"><span className="pal-t">{r.name}</span><span className="pal-s">{r.why}</span></span>
            </button>))}
      </div> : null}
    </div>
  )
}
