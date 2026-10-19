// Go to declaration on a unified diff's deleted lines (S-1532): they are widgets outside the document, so their
// identifiers are read from the original document's own tree. Only mergeEditor.ts imports this (with @codemirror/merge).
import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { language } from '@codemirror/language'
import { getChunks, getOriginalDoc } from '@codemirror/merge'
import type { Tree } from '@lezer/common'
import { identInTree, type Ident } from './declPick'

// The base document's tree in a unified diff, parsed once per document with the editor's language.
const baseTrees = new WeakMap<object, { tree: Tree; text: string }>()
export function baseTree(state: EditorState): { tree: Tree; text: string } | null {
  const lang = state.facet(language)
  if (!lang) return null
  const doc = getOriginalDoc(state)
  let hit = baseTrees.get(doc)
  if (!hit) { const text = doc.toString(); hit = { tree: lang.parser.parse(text), text }; baseTrees.set(doc, hit) }
  return hit
}

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const d = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null }
  if (d.caretPositionFromPoint) { const c = d.caretPositionFromPoint(x, y); return c ? { node: c.offsetNode, offset: c.offset } : null }
  const r = document.caretRangeFromPoint?.(x, y)
  return r ? { node: r.startContainer, offset: r.startOffset } : null
}

// An identifier under the point inside a unified diff's deleted chunk: the offset of the caret within the chunk's
// text (its lines joined by newlines), added to where the chunk starts in the original document.
export function deletedIdent(view: EditorView, chunkEl: HTMLElement, x: number, y: number): Ident | null {
  const caret = caretAt(x, y)
  if (!caret || !chunkEl.contains(caret.node)) return null
  const lines = [...chunkEl.querySelectorAll<HTMLElement>('.cm-deletedLine')]
  const at = lines.findIndex((l) => l.contains(caret.node))
  if (at < 0) return null
  const r = document.createRange()
  r.setStart(lines[at], 0)
  r.setEnd(caret.node, caret.offset)
  let offset = r.toString().length
  for (let i = 0; i < at; i++) offset += (lines[i].textContent ?? '').length + 1
  const pos = view.posAtDOM(chunkEl)
  const chunks = getChunks(view.state)?.chunks ?? []
  const chunk = chunks.find((c) => c.fromB === pos) ?? chunks.reduce<(typeof chunks)[number] | undefined>((best, c) => (Math.abs(c.fromB - pos) < Math.abs((best?.fromB ?? Infinity) - pos) ? c : best), undefined)
  const base = baseTree(view.state)
  if (!chunk || !base) return null
  return identInTree(base.tree, (a, b) => base.text.slice(a, b), chunk.fromA + offset)
}

export const deletedLines = { ident: deletedIdent, tree: baseTree }
