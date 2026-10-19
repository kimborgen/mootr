import { beforeEach, describe, expect, it } from 'vitest'
import {
  chips, currentFile, reviewChip, estimateLines, hiddenSummary, isShown, readViewed, shownFiles, splitPath, startFilter, stepChange, stepFile, toggleClass, toggleFile, viewedKey, withViewed, writeViewed,
  type DiffFileItem,
} from './diffModel'

const f = (path: string, cls: DiffFileItem['class'] = null, extra: Partial<DiffFileItem> = {}): DiffFileItem =>
  ({ path, status: 'modified', additions: 3, deletions: 1, binary: false, class: cls, headBlob: 'h-' + path, baseBlob: 'b-' + path, ...extra })

const files = [
  f('src/a.ts'), f('src/b.ts'),
  ...Array.from({ length: 6 }, (_, i) => f(`test/t${i}.test.ts`, 'tests')),
  f('package-lock.json', 'lockfiles'),
  f('dist/x.js', 'generated'), f('dist/y.js', 'generated'),
  f('docs/readme.md', 'docs'),
]

describe('Meat mode', () => {
  it('starts with tests, lockfiles and generated hidden, docs shown', () => {
    const flt = startFilter()
    expect(shownFiles(files, flt).map((x) => x.path)).toEqual(['src/a.ts', 'src/b.ts', 'docs/readme.md'])
  })
  it('chips carry the counts of each class that has files', () => {
    expect(chips(files, startFilter()).map((c) => [c.label, c.count, c.hidden])).toEqual([['Tests', 6, true], ['Lockfiles', 1, true], ['Generated', 2, true], ['Docs', 1, false]])
    expect(chips([f('a.ts'), f('b.test.ts', 'tests')], startFilter()).map((c) => c.cls)).toEqual(['tests'])
  })
  it('summarises the hidden classes', () => {
    expect(hiddenSummary(files, startFilter())).toBe('Tests 6 · Lockfiles 1 · Generated 2 hidden')
    expect(hiddenSummary(files, toggleClass('tests', startFilter()))).toBe('Lockfiles 1 · Generated 2 hidden')
    expect(hiddenSummary(files, { ...startFilter(), meat: false })).toBe('')
  })
  it('a class chip toggles its files', () => {
    const flt = toggleClass('tests', startFilter())
    expect(shownFiles(files, flt).filter((x) => x.class === 'tests')).toHaveLength(6)
    expect(shownFiles(files, toggleClass('docs', startFilter())).some((x) => x.class === 'docs')).toBe(false)
  })
  it('Meat off shows every file', () => {
    expect(shownFiles(files, { ...startFilter(), meat: false })).toHaveLength(files.length)
  })
})

describe('per-file overrides', () => {
  const test0 = files[2]
  it('showing a hidden file overrides its class', () => {
    const flt = toggleFile(test0, startFilter())
    expect(isShown(test0, flt)).toBe(true)
    expect(isShown(files[3], flt)).toBe(false)
    expect(flt.override).toEqual({ [test0.path]: 'show' })
  })
  it('hiding a shown file overrides, and toggling back drops the override', () => {
    const a = files[0]
    const hidden = toggleFile(a, startFilter())
    expect(isShown(a, hidden)).toBe(false)
    expect(hidden.override[a.path]).toBe('hide')
    expect(toggleFile(a, hidden).override).toEqual({})
  })
  it('an override survives the class toggle', () => {
    const flt = toggleClass('tests', toggleFile(test0, startFilter()))
    expect(isShown(test0, flt)).toBe(true)
    expect(isShown(files[3], flt)).toBe(true)
    expect(isShown(test0, { ...flt, meat: false })).toBe(true)
  })
  it('hiding a file that Meat off shows keeps it hidden', () => {
    const off = { ...startFilter(), meat: false }
    const flt = toggleFile(test0, off)
    expect(isShown(test0, flt)).toBe(false)
  })
})

describe('viewed marks', () => {
  beforeEach(() => localStorage.clear())
  it('are keyed by repo, PR, path and head blob', () => {
    const a = f('src/a.ts')
    expect(viewedKey('stam2', 5, a)).toBe('stam2#5:src/a.ts@h-src/a.ts')
    expect(viewedKey('stam2', 6, a)).not.toBe(viewedKey('stam2', 5, a))
    expect(viewedKey('other', 5, a)).not.toBe(viewedKey('stam2', 5, a))
    expect(viewedKey('stam2', 5, { ...a, headBlob: 'changed' })).not.toBe(viewedKey('stam2', 5, a))
  })
  it('a deleted file is keyed by its base blob', () => {
    expect(viewedKey('r', 1, { path: 'x', baseBlob: 'bb' })).toBe('r#1:x@deleted-bb')
  })
  it('persist per viewer and reset when the file changes', () => {
    const a = f('src/a.ts')
    writeViewed(withViewed(readViewed(), viewedKey('r', 1, a), true))
    expect(readViewed().has(viewedKey('r', 1, a))).toBe(true)
    expect(readViewed().has(viewedKey('r', 1, { ...a, headBlob: 'new' }))).toBe(false)
    writeViewed(withViewed(readViewed(), viewedKey('r', 1, a), false))
    expect(readViewed().size).toBe(0)
  })
  it('survive a storage that throws', () => {
    const real = Object.getOwnPropertyDescriptor(window, 'localStorage')!
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('blocked') } })
    try {
      expect(readViewed().size).toBe(0)
      expect(() => writeViewed(new Set(['a']))).not.toThrow()
    } finally { Object.defineProperty(window, 'localStorage', real) }
  })
  it('ignore garbage', () => {
    localStorage.setItem('stam/diff-viewed', '{"x":1}')
    expect(readViewed().size).toBe(0)
    localStorage.setItem('stam/diff-viewed', '["a",3,"b"]')
    expect([...readViewed()]).toEqual(['a', 'b'])
  })
})

describe('key navigation', () => {
  it('j/k stay inside the list', () => {
    expect(stepFile(0, 1, 3)).toBe(1)
    expect(stepFile(2, 1, 3)).toBe(2)
    expect(stepFile(0, -1, 3)).toBe(0)
    expect(stepFile(1, -1, 3)).toBe(0)
    expect(stepFile(0, 1, 0)).toBe(-1)
  })
  it('the current file is the last one at or above the top', () => {
    expect(currentFile([0, 300, 900])).toBe(0)
    expect(currentFile([-400, -10, 500])).toBe(1)
    expect(currentFile([20, 300])).toBe(-1)
    expect(currentFile([])).toBe(-1)
  })
  it('n goes to the first change below the top, p to the last one above it', () => {
    const tops = [-300, -50, 120, 600]
    expect(stepChange(tops, 1)).toBe(2)
    expect(stepChange(tops, -1)).toBe(1)
    expect(stepChange([-300, -50], 1)).toBeNull()
    expect(stepChange([4, 120], -1)).toBeNull()
  })
})

describe('small helpers', () => {
  it('splits a path into folder and name', () => {
    expect(splitPath('web/src/a.ts')).toEqual({ dir: 'web/src/', name: 'a.ts' })
    expect(splitPath('README.md')).toEqual({ dir: '', name: 'README.md' })
  })
  it('estimates a short row for a denied or binary file and caps a big one', () => {
    expect(estimateLines(f('x', null, { binary: true }))).toBe(2)
    expect(estimateLines(f('x', null, { additions: 5000 }))).toBe(400)
    expect(estimateLines(f('x', null, { additions: 2, deletions: 0 }))).toBe(10)
  })
})

describe('reviewChip (S-1917)', () => {
  const r = (x: object = {}) => ({ verdict: 'approve' as const, by: 'rev-1', summary: 'ok', at: null, head: 'a'.repeat(40), stale: false, ...x })
  it('maps each state', () => {
    expect(reviewChip(r()).tone).toBe('ok')
    expect(reviewChip(r({ verdict: 'changes' })).tone).toBe('bad')
    const old = reviewChip(r({ stale: true }))
    expect(old.tone).toBe('none')
    expect(old.label).toContain('another head')
    expect(reviewChip(null)).toMatchObject({ tone: 'none', label: 'no review' })
    expect(reviewChip(undefined).label).toBe('no review')
  })
  it('names the reviewer only when known', () => {
    expect(reviewChip(r({ by: null })).detail).not.toContain(' by ')
  })
})
