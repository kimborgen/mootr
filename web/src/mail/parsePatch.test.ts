import { describe, expect, it } from 'vitest'
import { indentOf, parsePatch } from './parsePatch'

describe('parsePatch', () => {
  it('splits files and counts', () => {
    const f = parsePatch('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n+z\ndiff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -1 +1 @@\n k')
    expect(f.map((x) => [x.path, x.add, x.del])).toEqual([['a', 2, 1], ['b', 0, 0]])
  })
  it('opens a headerless patch with an unnamed file', () => {
    expect(parsePatch('@@ -1 +1 @@\n+a')[0].path).toBe('')
  })
  it('measures indent', () => {
    expect(indentOf('\t  x')).toBe(6)
    expect(parsePatch('@@ -1 +1 @@\n+\tx')[0].rows.map((r) => r.ind)).toEqual([0, 4])
  })
})
