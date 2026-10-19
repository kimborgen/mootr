import './CodeView.css'
import { useEffect, useRef, useState } from 'react'
import type { CodeEditor } from './codeEditor'
import type { DeclHit, DeclSide } from '../decl/declExt'
import { CodePrefButtons, useCodePrefs } from './codePrefs'

// A read-only code viewer: CodeMirror 6, loaded as its own chunk on first use (like mermaid in
// mail/mailblocks.ts), coloured on stam's syntax tokens. `line` scrolls to and marks a line; a
// click on a line number reports it through `onLineLink`, for the caller to write a #L link.
export interface CodeViewProps {
  text: string
  // Selects the language only; nothing is read from it.
  path: string
  line?: number
  onLineLink?: (line: number) => void
  // Go to declaration (S-1532): an identifier clicked or tapped, and whether a name has a declaration.
  onDecl?: (hit: DeclHit) => void
  hasDecl?: (name: string, side: DeclSide) => Promise<boolean>
}

export function CodeView({ text, path, line, onLineLink, onDecl, hasDecl }: CodeViewProps) {
  const host = useRef<HTMLDivElement>(null)
  const ed = useRef<CodeEditor | null>(null)
  const link = useRef(onLineLink)
  link.current = onLineLink
  const decl = useRef({ onDecl, hasDecl })
  decl.current = { onDecl, hasDecl }
  const first = useRef({ text, path, line })
  const prefs = useCodePrefs()
  const { size, wrap } = prefs
  const wrapNow = useRef(wrap)
  wrapNow.current = wrap
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let dead = false
    let made: CodeEditor | null = null
    void import('./codeEditor').then(m => {
      if (dead || !host.current) return
      const f = first.current
      const d = decl.current.onDecl ? { onDecl: (h: DeclHit) => decl.current.onDecl?.(h), hasDecl: (n: string, s: DeclSide) => decl.current.hasDecl?.(n, s) ?? Promise.resolve(false) } : {}
      made = m.createCodeEditor(host.current, { text: f.text, path: f.path, line: f.line, wrap: wrapNow.current, onLineLink: n => link.current?.(n), ...d })
      ed.current = made
      setReady(true)
    })
    return () => { dead = true; made?.destroy(); ed.current = null }
  }, [])

  useEffect(() => { void ed.current?.setText(text, path) }, [text, path, ready])
  useEffect(() => { ed.current?.setLine(line ?? null) }, [line, ready, text])
  useEffect(() => { ed.current?.setWrap(wrap) }, [wrap, ready])

  return (
    <div className="codeview" style={{ ['--code-font-size' as string]: `var(${size})` }}>
      <div className="codeview-bar" role="toolbar" aria-label="Code view">
        <button type="button" onClick={() => ed.current?.openSearch()} disabled={!ready}>Find</button>
        <CodePrefButtons prefs={prefs} />
      </div>
      {text === '' && <div className="codeview-empty muted">This file is empty.</div>}
      <div className="codeview-host" ref={host} hidden={text === ''} data-ready={ready ? '1' : '0'} />
    </div>
  )
}
