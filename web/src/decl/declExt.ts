// Go to declaration's editor side (S-1532): a Ctrl/Cmd-click (desktop) or a tap (touch) on an identifier reports it,
// and with Ctrl/Cmd held an identifier that has a declaration is underlined on hover. A unified diff's deleted lines
// (`deleted`, from declMerge.ts, so the file view's chunk doesn't load @codemirror/merge) report the base side.
// Part of the editor's lazy chunk (mergeEditor.ts and codeEditor.ts import it).
import { StateEffect, StateField, type Extension, type EditorState } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet } from '@codemirror/view'
import type { Tree } from '@lezer/common'
import { identAt, localDecls, wholeTree, type Ident } from './declPick'
import type { DeclMatch } from './declApi'

export type DeclSide = 'head' | 'base'
export interface DeclHit {
  name: string
  side: DeclSide
  // Where the identifier is on screen, for the desktop popover.
  x: number
  y: number
  top: number
  // The file's own declarations of the name, from the side's whole syntax tree.
  local: () => DeclMatch[]
}
export interface DeclOptions {
  // The file's path, for its language (a function when the editor shows another file later).
  path: string | (() => string)
  side: DeclSide
  onDecl: (hit: DeclHit) => void
  // Whether a name has a declaration, for the hover underline; without it nothing is underlined.
  has?: (name: string, side: DeclSide) => Promise<boolean>
  // A unified diff's deleted lines: the identifier under a point in a deleted chunk, and the base document's tree.
  deleted?: { ident(view: EditorView, chunk: HTMLElement, x: number, y: number): Ident | null; tree(state: EditorState): { tree: Tree; text: string } | null }
}

const TAP_MOVE = 10
const TAP_MS = 500
const HOVER_MS = 120

const setLink = StateEffect.define<{ from: number; to: number } | null>()
const linkMark = Decoration.mark({ class: 'cm-decl-link' })
const linkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(d, tr) {
    for (const e of tr.effects) if (e.is(setLink)) d = e.value ? Decoration.set([linkMark.range(e.value.from, e.value.to)]) : Decoration.none
    return d.map(tr.changes)
  },
  provide: (f) => EditorView.decorations.from(f),
})

// The identifier under a point, and the side it is on.
function hitAt(view: EditorView, x: number, y: number, target: EventTarget | null, o: DeclOptions): { id: Ident; side: DeclSide; inDoc: boolean } | null {
  const side = o.side
  const el = target instanceof Element ? target : null
  if (!el?.closest('.cm-content')) return null
  const chunk = el.closest<HTMLElement>('.cm-deletedChunk')
  if (chunk) { const id = o.deleted?.ident(view, chunk, x, y) ?? null; return id ? { id, side: 'base', inDoc: false } : null }
  const pos = view.posAtCoords({ x, y }, false)
  const id = identAt(view.state, pos)
  return id ? { id, side, inDoc: true } : null
}

export function declClicks(o: DeclOptions): Extension {
  const report = (view: EditorView, h: { id: Ident; side: DeclSide; inDoc: boolean }, x: number, y: number) => {
    let ax = x, ay = y, at = y
    if (h.inDoc) { const c = view.coordsAtPos(h.id.from); if (c) { ax = c.left; ay = c.bottom; at = c.top } }
    const local = () => {
      const path = typeof o.path === 'function' ? o.path() : o.path
      if (h.inDoc) return localDecls(wholeTree(view.state), view.state.doc.toString(), path, h.id.name)
      const b = o.deleted?.tree(view.state) ?? null
      return b ? localDecls(b.tree, b.text, path, h.id.name) : []
    }
    o.onDecl({ name: h.id.name, side: h.side, x: ax, y: ay, top: at, local })
  }
  let down: { x: number; y: number; t: number } | null = null
  const hover = ViewPlugin.fromClass(class {
    timer = 0
    at = ''
    view: EditorView
    constructor(view: EditorView) { this.view = view }
    clear() { clearTimeout(this.timer); this.at = ''; if (this.view.state.field(linkField).size) this.view.dispatch({ effects: setLink.of(null) }) }
    move(e: MouseEvent) {
      if (!o.has || !(e.ctrlKey || e.metaKey)) return this.clear()
      const h = hitAt(this.view, e.clientX, e.clientY, e.target, o)
      if (!h || !h.inDoc) return this.clear()
      const key = `${h.id.from}:${h.id.to}`
      if (key === this.at) return
      this.clear()
      this.at = key
      const { from, to, name } = h.id
      this.timer = window.setTimeout(() => {
        void o.has!(name, h.side).then((yes) => { if (yes && this.at === key) this.view.dispatch({ effects: setLink.of({ from, to }) }) })
      }, HOVER_MS)
    }
    destroy() { clearTimeout(this.timer) }
  }, {
    eventHandlers: {
      mousemove(e) { this.move(e) },
      mouseleave() { this.clear() },
    },
  })
  return [
    linkField,
    hover,
    EditorView.domEventHandlers({
      keyup(e, view) { if (e.key === 'Control' || e.key === 'Meta') view.plugin(hover)?.clear() },
      mousedown(e, view) {
        if (e.button !== 0 || !(e.ctrlKey || e.metaKey)) return false
        const h = hitAt(view, e.clientX, e.clientY, e.target, o)
        if (!h) return false
        e.preventDefault()
        report(view, h, e.clientX, e.clientY)
        return true
      },
      pointerdown(e) { down = e.pointerType === 'touch' ? { x: e.clientX, y: e.clientY, t: e.timeStamp } : null; return false },
      pointerup(e, view) {
        const d = down
        down = null
        if (!d || e.pointerType !== 'touch' || e.timeStamp - d.t > TAP_MS || Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_MOVE) return false
        const h = hitAt(view, e.clientX, e.clientY, e.target, o)
        if (!h) return false
        report(view, h, e.clientX, e.clientY)
        return false
      },
    }),
  ]
}

// The target of a jump: a line marked until the next jump, its mark fading in on the focus duration.
const setFlash = StateEffect.define<number | null>()
const flashMark = Decoration.line({ class: 'cm-decl-flash' })
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(d, tr) {
    for (const e of tr.effects) if (e.is(setFlash)) d = e.value === null ? Decoration.none : Decoration.set([flashMark.range(e.value)])
    return d.map(tr.changes)
  },
  provide: (f) => EditorView.decorations.from(f),
})

// Scrolls a line of the view to the middle of whatever scrolls it and marks it. `pos` is the line's start; the view
// has `declBase` in its extensions.
export function flashAt(view: EditorView, pos: number): void {
  view.dispatch({ effects: [EditorView.scrollIntoView(pos, { y: 'center' }), setFlash.of(pos)] })
}

export const declTheme = EditorView.baseTheme({
  '.cm-decl-link': { textDecoration: 'underline', cursor: 'pointer', color: 'var(--accent-text)' },
  '.cm-decl-flash': { backgroundColor: 'var(--highlight-1)', animation: 'cm-decl-flash var(--duration-focus) var(--ease-out)' },
  '@keyframes cm-decl-flash': { from: { backgroundColor: 'var(--highlight-3)' }, to: { backgroundColor: 'var(--highlight-1)' } },
})

// What every editor that can be jumped to carries: the flash mark and the link and flash styles.
export const declBase: Extension = [flashField, declTheme]
