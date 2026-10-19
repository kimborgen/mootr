// The code viewer's CodeMirror 6 editor, read-only. This file and everything it imports is one
// lazy chunk: CodeView.tsx loads it with import() on first use, as mailblocks.ts does mermaid.
import { Compartment, EditorState, StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, drawSelection, gutter, GutterMarker, lineNumbers, type DecorationSet } from '@codemirror/view'
import { HighlightStyle, StreamLanguage, syntaxHighlighting, type LanguageSupport } from '@codemirror/language'
import { closeSearchPanel, highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search'
import { keymap } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { langForPath, type LangKey } from './codeLang'
import { declBase, declClicks, type DeclHit, type DeclSide } from '../decl/declExt'

export { openSearchPanel, closeSearchPanel }

// Coloured by kind on stam's syntax tokens only (docs/design-system.md, "Code in mail").
export const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.modifier, t.self, t.null, t.bool, t.atom], color: 'var(--syntax-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character, t.docString], color: 'var(--syntax-string)' },
  { tag: [t.number, t.integer, t.float], color: 'var(--syntax-number)' },
  { tag: [t.attributeName, t.propertyName, t.tagName, t.labelName, t.className], color: 'var(--syntax-attr)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: t.heading, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.link, textDecoration: 'underline' },
])

export const theme = EditorView.theme({
  '&': { backgroundColor: 'var(--code-bg)', color: 'var(--code-fg)', height: '100%', fontSize: 'var(--code-font-size, var(--type-chrome-md))' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.5', overflow: 'auto' },
  '.cm-content': { caretColor: 'transparent' },
  '.cm-gutters': { backgroundColor: 'var(--code-bg)', color: 'var(--text-muted)', border: 'none', borderRight: '1px solid var(--border-subtle)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 var(--space-3) 0 var(--space-2)', minWidth: '3ch', cursor: 'pointer' },
  '.cm-lineNumbers .cm-gutterElement:hover': { color: 'var(--accent-text)' },
  '.cm-selectedLine': { backgroundColor: 'var(--highlight-1)' },
  '.cm-selectedLineGutter': { color: 'var(--accent-text)' },
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { backgroundColor: 'var(--highlight-2)' },
  '.cm-searchMatch': { backgroundColor: 'var(--highlight-2)' },
  '.cm-searchMatch-selected': { backgroundColor: 'var(--highlight-3)' },
  '.cm-panels': { backgroundColor: 'var(--surface-raised, var(--code-bg))', color: 'var(--code-fg)', borderColor: 'var(--border-default)' },
  '.cm-panels input, .cm-panels button, .cm-panels label': { fontFamily: 'var(--font-mono)', fontSize: 'inherit' },
  '.cm-search': { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', alignItems: 'center', padding: 'var(--space-2)' },
  '.cm-search input, .cm-search button': { minHeight: 'var(--size-control)' },
  '.cm-search [name=close]': { position: 'static', order: '-1', marginLeft: 'auto' },
  '@media (pointer: coarse), (max-width: 480px)': {
    '.cm-search input, .cm-search button, .cm-search [name=close]': { minHeight: 'var(--size-hit-touch)', minWidth: 'var(--size-hit-touch)' },
    '.cm-search label': { minHeight: 'var(--size-hit-touch)', display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)' },
    '.cm-lineNumbers .cm-gutterElement': { minWidth: 'calc(3ch + var(--space-3))' },
  },
}, { dark: false })

// The selected line: a line decoration set by `line` and moved by a gutter click.
const setLine = StateEffect.define<number | null>()
const selectedLine = StateField.define<number | null>({
  create: () => null,
  update: (v, tr) => { for (const e of tr.effects) if (e.is(setLine)) v = e.value; return v },
})
const lineMark = Decoration.line({ class: 'cm-selectedLine' })
const lineDeco = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(d, tr) {
    const n = tr.state.field(selectedLine)
    if (!tr.docChanged && !tr.effects.some(e => e.is(setLine))) return d
    return n && n >= 1 && n <= tr.state.doc.lines ? Decoration.set([lineMark.range(tr.state.doc.line(n).from)]) : Decoration.none
  },
  provide: f => EditorView.decorations.from(f),
})

class NoMark extends GutterMarker { elementClass = 'cm-selectedLineGutter' }
const gutterMark = new NoMark()
const selectedGutter = gutter({
  class: 'cm-selectedGutter',
  lineMarker: (view, block) => view.state.field(selectedLine) === view.state.doc.lineAt(block.from).number ? gutterMark : null,
  lineMarkerChange: u => u.transactions.some(tr => tr.effects.some(e => e.is(setLine))),
})

export async function loadLanguage(key: LangKey): Promise<Extension | null> {
  switch (key) {
    case 'ts': return (await import('@codemirror/lang-javascript')).javascript({ typescript: true })
    case 'tsx': return (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true })
    case 'js': return (await import('@codemirror/lang-javascript')).javascript()
    case 'jsx': return (await import('@codemirror/lang-javascript')).javascript({ jsx: true })
    case 'python': return (await import('@codemirror/lang-python')).python()
    case 'css': return (await import('@codemirror/lang-css')).css()
    case 'html': return (await import('@codemirror/lang-html')).html()
    case 'json': return (await import('@codemirror/lang-json')).json()
    case 'markdown': return (await import('@codemirror/lang-markdown')).markdown()
    case 'yaml': return (await import('@codemirror/lang-yaml')).yaml() as LanguageSupport
    case 'rust': return (await import('@codemirror/lang-rust')).rust()
    case 'go': return (await import('@codemirror/lang-go')).go()
    case 'shell': return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/shell')).shell)
  }
}

export interface CodeEditor {
  setText(text: string, path: string): Promise<void>
  setLine(line: number | null, scroll?: boolean): void
  setWrap(on: boolean): void
  openSearch(): void
  destroy(): void
}

export interface CodeEditorOptions {
  text: string; path: string; line?: number; wrap: boolean; onLineLink?: (line: number) => void
  // Go to declaration (S-1532): a Ctrl/Cmd-click or tap on an identifier, and whether a name has one (hover underline).
  onDecl?: (hit: DeclHit) => void
  hasDecl?: (name: string, side: DeclSide) => Promise<boolean>
}

export function createCodeEditor(parent: HTMLElement, o: CodeEditorOptions): CodeEditor {
  const wrap = new Compartment(), lang = new Compartment()
  let shown = o.path
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: o.text,
      extensions: [
        EditorState.readOnly.of(true), EditorView.editable.of(false),
        lineNumbers({ domEventHandlers: { mousedown: (v, block) => { const n = v.state.doc.lineAt(block.from).number; v.dispatch({ effects: setLine.of(n) }); o.onLineLink?.(n); return true } } }),
        selectedGutter, selectedLine, lineDeco,
        drawSelection(), highlightSelectionMatches(),
        syntaxHighlighting(highlight), theme,
        search({ top: true }), keymap.of(searchKeymap),
        wrap.of(o.wrap ? EditorView.lineWrapping : []), lang.of([]),
        declBase, o.onDecl ? declClicks({ path: () => shown, side: 'head', onDecl: o.onDecl, has: o.hasDecl }) : [],
        EditorView.contentAttributes.of({ 'aria-readonly': 'true', tabindex: '0' }),
      ],
    }),
  })
  const reveal = (n: number) => {
    if (n < 1 || n > view.state.doc.lines) return
    view.dispatch({ effects: [setLine.of(n), EditorView.scrollIntoView(view.state.doc.line(n).from, { y: 'center' })] })
  }
  let gen = 0
  const api: CodeEditor = {
    async setText(text, path) {
      const mine = ++gen
      shown = path
      if (view.state.doc.toString() !== text) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
      const key = langForPath(path)
      let ext: Extension | null = null
      try { ext = key ? await loadLanguage(key) : null } catch { /* plain text */ }
      if (mine !== gen) return
      view.dispatch({ effects: lang.reconfigure(ext ?? []) })
    },
    setLine(line, scroll = true) {
      if (line == null) view.dispatch({ effects: setLine.of(null) })
      else if (scroll) reveal(line)
      else view.dispatch({ effects: setLine.of(line) })
    },
    setWrap(on) { view.dispatch({ effects: wrap.reconfigure(on ? EditorView.lineWrapping : []) }) },
    openSearch() { view.focus(); openSearchPanel(view) },
    destroy() { view.destroy() },
  }
  void api.setText(o.text, o.path).then(() => { if (o.line) reveal(o.line) })
  return api
}
