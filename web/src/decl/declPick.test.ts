// S-1532: identifiers read from the syntax tree, not by regex, and a file's own declarations from its whole tree.
import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { identAt, localDecls, wholeTree } from './declPick'

const ts = (doc: string) => EditorState.create({ doc, extensions: [javascript({ typescript: true, jsx: true })] })
// identAt reads syntaxTree(state), whatever the editor has parsed by now, and ensureSyntaxTree doesn't update it, so under
// load that tree can be partial (S-3445). wholeTree parses to the end; the next state (LanguageState.apply) carries it.
const parsed = (state: EditorState) => { wholeTree(state, Infinity); return state.update({}).state }
const at = (state: EditorState, needle: string, k = 1) => state.doc.toString().indexOf(needle) + k

describe('identAt', () => {
  const src = "import { helper } from './util'\nconst s = 'helper in a string' // helper in a comment\nexport function run(opts: Opts) { return helper(opts.port) + <Panel /> }\n"
  const st = parsed(ts(src))
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
    const p = parsed(EditorState.create({ doc: 'def run(x):\n    return helper(x)\n', extensions: [python()] }))
    expect(identAt(p, at(p, 'helper'))?.name).toBe('helper')
    expect(identAt(p, at(p, 'run'))?.name).toBe('run')
  })
})

describe('wholeTree', () => {
  it('parses to the end of a long document whatever the load, so identAt past the first screen finds its name', () => {
    const body = 'function f() { return 1 }\n'.repeat(2000)
    const st = parsed(ts(body + 'const last = helper(1)\n'))
    expect(syntaxTree(st).length).toBe(st.doc.length)
    expect(identAt(st, at(st, 'helper'))?.name).toBe('helper')
  })
})

describe('localDecls', () => {
  it("finds a file's own declarations with their lines", () => {
    const src = 'const a = 1\nfunction go() {}\nclass K { go() {} }\n'
    const st = ts(src)
    expect(localDecls(wholeTree(st, Infinity), src, '/x/f.ts', 'go')).toEqual([
      { path: '/x/f.ts', line: 2, col: 10, kind: 'function', text: 'function go() {}' },
      { path: '/x/f.ts', line: 3, col: 11, kind: 'method', text: 'class K { go() {} }' },
    ])
    expect(localDecls(wholeTree(st, Infinity), src, '/x/f.css', 'go')).toEqual([])
  })
})
