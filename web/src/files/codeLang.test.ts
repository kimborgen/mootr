import { describe, expect, it } from 'vitest'
import { langForPath } from './codeLang'

describe('langForPath', () => {
  it.each([
    ['src/a.ts', 'ts'], ['web/src/App.tsx', 'tsx'], ['x/y.mjs', 'js'], ['a.jsx', 'jsx'],
    ['tool.py', 'python'], ['style.css', 'css'], ['index.html', 'html'], ['data.json', 'json'],
    ['README.md', 'markdown'], ['ci.yml', 'yaml'], ['ci.YAML', 'yaml'], ['lib.rs', 'rust'],
    ['main.go', 'go'], ['run.sh', 'shell'], ['/home/u/.bashrc', 'shell'], ['C:\\p\\a.py', 'python'],
  ])('%s is %s', (path, key) => expect(langForPath(path)).toBe(key))

  it.each(['Makefile', 'notes.txt', 'a.unknown', 'dir.d/file', '.gitignore', ''])('%s has no language', path => {
    expect(langForPath(path)).toBeNull()
  })
})
