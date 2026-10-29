// Reading an identifier and a file's own declarations from CodeMirror's syntax tree (S-1532), never by regex.
// Part of the editor's lazy chunk: only mergeEditor.ts and codeEditor.ts (through declExt.ts) import it.
import type { EditorState } from '@codemirror/state'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { Tree } from '@lezer/common'
import { declLangOf, IDENT_NODES, walkDecls } from '../../../src/decl-walk.ts'
import type { DeclMatch } from './declApi'

export interface Ident { name: string; from: number; to: number }

// The identifier at `pos` in a tree, or null: the node on either side of the position whose type is a name. `read`
// gives the text of a range (only the name's is read, so a click or a mousemove doesn't copy the document).
export function identInTree(tree: Tree, read: (from: number, to: number) => string, pos: number): Ident | null {
  for (const side of [1, -1] as const) {
    const n = tree.resolveInner(pos, side)
    if (IDENT_NODES.has(n.name) && n.from <= pos && pos <= n.to && n.to > n.from) return { name: read(n.from, n.to), from: n.from, to: n.to }
  }
  return null
}

export const identAt = (state: EditorState, pos: number): Ident | null => identInTree(syntaxTree(state), (a, b) => state.sliceDoc(a, b), pos)

// A file's own declarations of `name`, from its whole syntax tree: the file view's fallback outside a checkout.
export function localDecls(tree: Tree, text: string, path: string, name: string): DeclMatch[] {
  const lang = declLangOf(path)
  if (!lang) return []
  const starts = [0]
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  return walkDecls(lang.lang, tree.topNode, text).filter((d) => d.name === name).map((d) => {
    let line = 0
    while (line + 1 < starts.length && starts[line + 1] <= d.from) line++
    const end = text.indexOf('\n', starts[line])
    return { path, line: line + 1, col: d.from - starts[line] + 1, kind: d.kind, text: text.slice(starts[line], end < 0 ? text.length : end).trim().slice(0, 160) }
  })
}

// The whole tree of an editor's document (parsing the rest, briefly, if it isn't yet). `ensureSyntaxTree` gives up at
// the timeout and then this returns the partial tree, so the result depends on machine load; pass `Infinity` to parse
// to the end whatever the load (the tests do, S-3445). The editor keeps the 500 ms bound so a click never stalls.
export const wholeTree = (state: EditorState, timeout = 500): Tree => ensureSyntaxTree(state, state.doc.length, timeout) ?? syntaxTree(state)
