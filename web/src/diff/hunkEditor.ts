// The one-document editor an unresolved patch file is drawn in (S-2103): the file's hunks alone, never a merge view.
// Read-only, with the same theme and wrap as the rest of the diff view; added and removed rows are tinted and the
// gutter shows the file's own line numbers from the `@@` headers. Its own lazy chunk, so a patch view never loads
// @codemirror/merge, and no language: a patch is not source.
import { EditorState, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, lineNumbers, type DecorationSet } from '@codemirror/view'
import { theme } from '../files/codeEditor'
import type { HunkLine } from './hunkDoc'
import type { PatchRowKind } from '../mail/parsePatch'

const CLASS_OF: Partial<Record<PatchRowKind, string>> = { add: 'cm-patchAdd', del: 'cm-patchDel', hunk: 'cm-patchHunk' }

export interface HunkEditor {
  view: EditorView
  destroy(): void
}

export function createHunkEditor(parent: HTMLElement, lines: HunkLine[], wrap: boolean): HunkEditor {
  // Where each line starts in the document, for its tint.
  const starts: number[] = []
  let at = 0
  for (const l of lines) { starts.push(at); at += l.text.length + 1 }
  const marks: DecorationSet = Decoration.set(lines.flatMap((l, i) => {
    const cls = CLASS_OF[l.kind]
    return cls ? [Decoration.line({ class: cls }).range(starts[i])] : []
  }))
  // The document never changes, so its tints are made once.
  const tints = StateField.define<DecorationSet>({ create: () => marks, update: (d) => d, provide: (f) => EditorView.decorations.from(f) })
  const extensions: Extension[] = [
    EditorState.readOnly.of(true), EditorView.editable.of(false),
    lineNumbers({ formatNumber: (n) => lines[n - 1]?.number ?? '' }),
    theme, tints,
    wrap ? EditorView.lineWrapping : [],
    EditorView.contentAttributes.of({ 'aria-readonly': 'true', tabindex: '0' }),
  ]
  const view = new EditorView({ parent, state: EditorState.create({ doc: lines.map((l) => l.text).join('\n'), extensions }) })
  return { view, destroy: () => view.destroy() }
}
