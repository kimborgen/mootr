// S-1532: identifiers read from the syntax tree, not by regex, and a file's own declarations from its whole tree.
import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { identAt, localDecls, wholeTree } from './declPick'

const ts = (doc: string) => EditorState.create({ doc, extensions: [javascript({ typescript: true, jsx: true })] })
const at = (state: EditorState, needle: string, k = 1) => state.doc.toString().indexOf(needle) + k

describe('identAt', () => {
  const src = "import { helper } from './util'\nconst s = 'helper in a string' // helper in a comment\nexport function run(opts: Opts) { return helper(opts.port) + <Panel /> }\n"
  const st = ts(src)
  wholeTree(st)
  it('reads a call, a type, a property and a JSX tag', () => {
    expect(identAt(st, at(st, 'helper(opts'))?.name).toBe('helper')
    expect(identAt(st, at(st, 'Opts)'))?.name).toBe('Opts')
    expect(identAt(st, at(st, 'port)'))?.name).toBe('port')
    expect(identAt(st, at(st, 'Panel'))?.name).toBe('Panel')
  })
  it('gives the range of the whole name, from either edge', () => {
    const p = src.indexOf('helper(opts')
    expect(identAt(st, p)).toEqual({ name: 'helper', from: p, to: p + 6 })
    expect(identAt(st, p + 6)).toEqual({ name: 'helper', from: p, to: p + 6 })
  })
  it('a name inside a string or a comment, a keyword, or a space is not an identifier', () => {
    expect(identAt(st, at(st, "helper in a string"))).toBeNull()
    expect(identAt(st, at(st, 'helper in a comment'))).toBeNull()
    expect(identAt(st, at(st, 'return'))).toBeNull()
    expect(identAt(st, at(st, ' + ', 1))).toBeNull()
  })
  it('Python names', () => {
    const p = EditorState.create({ doc: 'def run(x):\n    return helper(x)\n', extensions: [python()] })
    wholeTree(p)
    expect(identAt(p, at(p, 'helper'))?.name).toBe('helper')
    expect(identAt(p, at(p, 'run'))?.name).toBe('run')
  })
})

describe('localDecls', () => {
  it("finds a file's own declarations with their lines", () => {
    const src = 'const a = 1\nfunction go() {}\nclass K { go() {} }\n'
    const st = ts(src)
    expect(localDecls(wholeTree(st), src, '/x/f.ts', 'go')).toEqual([
      { path: '/x/f.ts', line: 2, col: 10, kind: 'function', text: 'function go() {}' },
      { path: '/x/f.ts', line: 3, col: 11, kind: 'method', text: 'class K { go() {} }' },
    ])
    expect(localDecls(wholeTree(st), src, '/x/f.css', 'go')).toEqual([])
  })
})
