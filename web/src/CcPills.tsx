// The cc pills of a prompt input (S-1464): the suggestions for what the human is typing, as small
// pills straddling the box's top border. Asks as the Alt+A prompt does (on a space, or once the
// typing pauses; a new ask aborts the one in flight), and shows only what `ccPills` lets through.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from './api'
import { live } from './format'
import { Glyph, PlainGlyph } from './Glyph'
import { Icon } from './Icon'
import { recentIds } from './nav-history'
import { byId } from './store'
import { IDLE_MS, asksNow, queryOf, suggestPath, useRescore } from './suggest-pick'
import type { SearchResult } from './types'

export const KIND: Record<string, string> = { agent: 'Agent', thread: 'Mail', itsa: 'Issue' }
export const kindIcon = (r: { kind: string; id: string }): ReactNode => {
  if (r.kind === 'agent') { const a = byId(r.id); return a ? <Glyph agent={a} /> : <PlainGlyph name="bot" /> }
  return <span className="pal-plain"><Icon name={r.kind === 'thread' ? 'mail' : 'list-checks'} /></span>
}
// An agent a pill may cc: one this page knows, and live.
export const ccable = (id: string) => { const a = byId(id); return !!a && live(a) }

// The suggestions for `text` while `on`; empty text, or off, asks nothing and shows nothing.
export function useCcSuggest(text: string, on: boolean): SearchResult[] {
  const [rs, setRs] = useState<SearchResult[]>([])
  const asked = useRef('')
  // The query whose embedding order is on screen: a rescored list is only shown for it (S-1465).
  const shown = useRef('')
  const inflight = useRef<AbortController | null>(null)
  useEffect(() => () => inflight.current?.abort(), [])
  useEffect(() => {
    const q = on ? queryOf(text) : ''
    if (!q) { inflight.current?.abort(); asked.current = ''; shown.current = ''; setRs([]); return }
    if (q === asked.current) return
    const go = () => {
      inflight.current?.abort()
      const ctl = (inflight.current = new AbortController())
      asked.current = q
      api<SearchResult[]>('GET', suggestPath(q, recentIds()), undefined, ctl.signal).then(
        (got) => { if (!ctl.signal.aborted) { shown.current = q; setRs(Array.isArray(got) ? got : []) } },
        () => { if (!ctl.signal.aborted) setRs([]) })
    }
    if (asksNow(text)) { go(); return }
    const t = window.setTimeout(go, IDLE_MS)
    return () => clearTimeout(t)
  }, [text, on])
  useRescore(text, on, (q, got) => { if (q === shown.current) setRs(got) })
  return rs
}

// The pills: an icon and a short title each. Pressing one keeps the caret in the box, so a phone's
// keyboard stays up. `pills` comes from `ccPills`, so the box knows whether to make room for them.
export function CcPills({ pills, onPick }: { pills: SearchResult[]; onPick: (r: SearchResult) => void }) {
  if (!pills.length) return null
  return (
    <div className="cmp-pills" role="group" aria-label="Suggested cc">
      {pills.map((r) => (
        <button key={r.kind + ':' + r.id} type="button" className="cmp-pill" data-cc-suggest={r.kind + ':' + r.id}
          title={r.kind === 'itsa' ? `cc: file it on ${r.title}` : r.kind === 'thread' ? `cc the people in ${r.title}` : `cc ${r.title}`}
          aria-label={`cc ${KIND[r.kind]?.toLowerCase() ?? r.kind} ${r.title}`}
          onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(r)}>
          <span className="cmp-pill-face"><span className="pal-ico">{kindIcon(r)}</span><span className="cmp-pill-t">{r.title}</span></span>
        </button>
      ))}
    </div>
  )
}
