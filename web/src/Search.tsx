// The search palette: one box (Ctrl+K or Cmd+K on a desktop, the phone's Search button)
// over agents, the human's mail threads, ITSAs, and Settings. Results come ranked from
// `GET /api/search` and are grouped by kind; arrows move, Enter or a tap opens the agent's
// world, the thread, the issue, or the Settings section. The overlay reuses the top world's
// pattern: a raised panel over the scrim, the same on the phone but full screen.
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { openAssistant, openWorld, selectAgent, selectThread } from './actions'
import { api } from './api'
import { Glyph, PlainGlyph } from './Glyph'
import { Icon } from './Icon'
import * as shell from './shell/layout'
import { byId, useData } from './store'
import { getUi, setUi, useUi } from './ui/state'
import type { SearchKind, SearchResult } from './types'

const ORDER: SearchKind[] = ['agent', 'thread', 'itsa', 'setting']
const LABEL: Record<SearchKind, string> = { agent: 'Agents', thread: 'Mail', itsa: 'Issues', setting: 'Settings' }

export const openSearch = () => { openAssistant(false); shell.closePhoneOverlay(); setUi({ searchOpen: true, suggestOpen: false }) }
export const closeSearch = () => setUi({ searchOpen: false })
export const toggleSearch = () => (getUi().searchOpen ? closeSearch() : openSearch())

// Opens what a result names, the way the tree, the mail list, and Settings already do.
function openResult(r: SearchResult) {
  if (r.kind === 'agent') return selectAgent(r.id)
  if (r.kind === 'thread') return selectThread(r.id)
  if (r.kind === 'itsa') return shell.showAgentWorld('w:itsa:' + r.id)
  // Settings: the same keys InstructionsView uses to hand a section or item to ConfigView,
  // plus an event for the case where Settings is already on screen.
  try {
    localStorage.setItem('stam/settings-section', r.section ?? '')
    if (r.item) localStorage.setItem('stam/settings-item', r.item)
    else localStorage.removeItem('stam/settings-item')
  } catch {}
  openWorld('config')
  window.dispatchEvent(new CustomEvent('stam:open-setting', { detail: { section: r.section, item: r.item } }))
}

function ResultRow({ r, at, sel, onPick, onHover }: { r: SearchResult; at: number; sel: boolean; onPick: (r: SearchResult) => void; onHover: (n: number) => void }) {
  const a = r.kind === 'agent' ? byId(r.id) : undefined
  const icon: ReactNode = r.kind === 'agent' ? (a ? <Glyph agent={a} /> : <PlainGlyph name="bot" />)
    : r.kind === 'thread' ? <span className="pal-plain"><Icon name="mail" /></span>
    : r.kind === 'itsa' ? <span className="pal-plain"><Icon name="list-checks" /></span>
    : <span className="pal-plain"><Icon name="settings" /></span>
  return (
    <button type="button" role="option" className={'pal-result' + (sel ? ' sel' : '')} data-kind={r.kind} data-result={r.kind + ':' + r.id}
      aria-selected={sel} onMouseEnter={() => onHover(at)} onMouseMove={() => onHover(at)} onClick={() => onPick(r)}>
      <span className="pal-ico">{icon}</span>
      <span className="pal-text">
        <span className="pal-t">{r.title}</span>
        {r.snippet ? <span className="pal-s">{r.snippet}</span> : <span className="pal-s" />}
      </span>
      {r.meta ? <span className="pal-m">{r.meta}</span> : null}
    </button>
  )
}

export function SearchPalette() {
  const { searchOpen } = useUi()
  useData()
  const [q, setQ] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [sel, setSel] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  // Opening starts fresh and puts the caret in the box, which raises a phone's keyboard.
  useEffect(() => {
    if (!searchOpen) return
    setQ(''); setResults([]); setSel(0)
    const raf = requestAnimationFrame(() => input.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [searchOpen])

  // The query is debounced; a later keystroke drops the earlier request's answer.
  useEffect(() => {
    if (!searchOpen) return
    const s = q.trim()
    if (!s) { setResults([]); setSel(0); return }
    let on = true
    const t = setTimeout(async () => {
      try {
        const r = await api<SearchResult[]>('GET', `/api/search?q=${encodeURIComponent(s)}&limit=24`)
        if (on) { setResults(r); setSel(0) }
      } catch { if (on) setResults([]) }
    }, 120)
    return () => { on = false; clearTimeout(t) }
  }, [q, searchOpen])

  // Keep the selected row on screen.
  useEffect(() => {
    list.current?.querySelector('.pal-result.sel')?.scrollIntoView({ block: 'nearest' })
  }, [sel, results])

  if (!searchOpen) return null

  const groups = ORDER.map((kind) => ({ kind, items: results.filter((r) => r.kind === kind) })).filter((g) => g.items.length)
  const flat = groups.flatMap((g) => g.items)
  const pick = (r: SearchResult) => { closeSearch(); openResult(r) }
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((n) => Math.min(n + 1, flat.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((n) => Math.max(n - 1, 0)) }
    else if (e.key === 'Home') { e.preventDefault(); setSel(0) }
    else if (e.key === 'End') { e.preventDefault(); setSel(flat.length - 1) }
    else if (e.key === 'Enter') { const r = flat[sel]; if (r) { e.preventDefault(); pick(r) } }
    else if (e.key === 'Escape') { e.preventDefault(); closeSearch() }
  }

  return <>
    <div id="search-scrim" onClick={closeSearch} />
    <section id="search-palette" aria-label="Search" onKeyDown={key}>
      <div className="pal-input">
        <Icon name="search" />
        <input ref={input} id="search-all" placeholder="Search agents, mail, issues, settings" autoComplete="off" spellCheck={false}
          value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search mootr" />
        <button className="icon-btn" title="Close (Esc)" aria-label="Close search" onClick={closeSearch}><Icon name="x" /></button>
      </div>
      <div className="pal-list" ref={list} role="listbox" aria-label="Results">
        {!q.trim() ? <p className="pal-hint">Search across your agents, mail, issues, and settings.</p>
          : !flat.length ? <p className="pal-hint">No matches for “{q.trim()}”.</p>
          : flat.map((r, i) => (
            <Fragment key={r.kind + ':' + r.id}>
              {i === 0 || flat[i - 1].kind !== r.kind ? <div className="pal-group eyebrow">{LABEL[r.kind]}</div> : null}
              <ResultRow r={r} at={i} sel={i === sel} onPick={pick} onHover={setSel} />
            </Fragment>
          ))}
      </div>
    </section>
  </>
}
