// The diff view's CodeMirror 6 merge editor (S-1531), one per file. It reuses the file viewer's highlight, theme and
// language loading (files/codeEditor.ts), so there is one CodeMirror setup. This file and what it imports (including
// @codemirror/merge) is a lazy chunk: FileDiff.tsx loads it with import() when the first file scrolls into view.
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import { syntaxHighlighting } from '@codemirror/language'
import { getChunks, getOriginalDoc, MergeView, uncollapseUnchanged, unifiedMergeView } from '@codemirror/merge'
import { highlight, loadLanguage, theme } from '../files/codeEditor'
import { langForPath } from '../files/codeLang'
import { declBase, declClicks, flashAt, type DeclHit, type DeclSide } from '../decl/declExt'
import { deletedLines } from '../decl/declMerge'

export type DiffMode = 'split' | 'unified'

// What a caller (go to declaration, S-1532) gets for a drawn file: the EditorViews that show it. `head` is the PR's
// version (the one to read declarations from), and `base` is the merge-base version, present only in a split view. The
// language's syntax tree is `syntaxTree(head.state)`.
export interface DiffEditorViews { path: string; mode: DiffMode; head: EditorView; base?: EditorView }

export interface DiffEditorOptions {
  base: string
  head: string
  path: string
  mode: DiffMode
  // Collapse runs of unchanged lines (the default); false shows the whole file.
  collapse: boolean
  wrap: boolean
  // Go to declaration (S-1532): a Ctrl/Cmd-click or tap on an identifier, and whether a name has one (hover underline).
  onDecl?: (hit: DeclHit) => void
  hasDecl?: (name: string, side: DeclSide) => Promise<boolean>
}

export interface DiffEditor {
  views: DiffEditorViews
  // Expands, scrolls to and marks a line of one side. A base line in a unified view goes to where its chunk sits.
  reveal(line: number, side: DeclSide): void
  destroy(): void
}

// The collapsed run is a row to click; "expand" is its action.
const phrases = EditorState.phrases.of({ '$ unchanged lines': '$ unchanged lines · expand' })
const COLLAPSE = { margin: 3, minSize: 6 }

export async function createDiffEditor(parent: HTMLElement, o: DiffEditorOptions): Promise<DiffEditor> {
  const key = langForPath(o.path)
  let lang: Extension | null = null
  try { lang = key ? await loadLanguage(key) : null } catch { /* plain text */ }
  const common: Extension[] = [
    EditorState.readOnly.of(true), EditorView.editable.of(false),
    lineNumbers(), syntaxHighlighting(highlight), theme, phrases,
    lang ?? [], o.wrap ? EditorView.lineWrapping : [],
    EditorView.contentAttributes.of({ 'aria-readonly': 'true', tabindex: '0' }),
  ]
  const collapseUnchanged = o.collapse ? COLLAPSE : undefined
  const decl = (side: DeclSide): Extension => [declBase, o.onDecl ? declClicks({ path: o.path, side, onDecl: o.onDecl, has: o.hasDecl, deleted: deletedLines }) : []]
  if (o.mode === 'split') {
    const mv = new MergeView({ parent, a: { doc: o.base, extensions: [...common, decl('base')] }, b: { doc: o.head, extensions: [...common, decl('head')] }, gutter: true, highlightChanges: true, collapseUnchanged })
    return { views: { path: o.path, mode: 'split', head: mv.b, base: mv.a }, reveal: (line, side) => revealLine(side === 'base' ? mv.a : mv.b, line), destroy: () => mv.destroy() }
  }
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: o.head, extensions: [...common, decl('head'), unifiedMergeView({ original: o.base, mergeControls: false, gutter: true, highlightChanges: true, syntaxHighlightDeletions: true, collapseUnchanged })] }),
  })
  return { views: { path: o.path, mode: 'unified', head: view }, reveal: (line, side) => revealLine(view, side === 'base' ? baseLineInUnified(view, line) : line), destroy: () => view.destroy() }
}

// The head line a base line shows beside in a unified view: inside a changed chunk, the chunk's first line; otherwise
// the same distance past the chunk before it. Pure over the view's chunks.
export function baseLineInUnified(view: EditorView, line: number): number {
  const orig = getOriginalDoc(view.state)
  const posA = orig.line(Math.max(1, Math.min(line, orig.lines))).from
  const doc = view.state.doc
  let delta = 0
  for (const c of getChunks(view.state)?.chunks ?? []) {
    if (posA < c.fromA) break
    if (posA < Math.max(c.toA, c.fromA + 1)) return doc.lineAt(Math.min(c.fromB, doc.length)).number
    delta = c.toB - c.toA
  }
  return doc.lineAt(Math.min(Math.max(0, posA + delta), doc.length)).number
}

// Expands the collapsed run that holds a line, if one does, then scrolls to the line and marks it.
function revealLine(view: EditorView, line: number): void {
  const n = Math.max(1, Math.min(line, view.state.doc.lines))
  const at = view.state.doc.line(n)
  const block = view.lineBlockAt(at.from)
  if (block.from < at.from || block.to > at.to) view.dispatch({ effects: uncollapseUnchanged.of(block.from) })
  flashAt(view, at.from)
}
