// S-2103: the document an unresolved patch file is drawn from: its rows verbatim, and the number each one shows.
import { describe, expect, it } from 'vitest'
import { parsePatch } from '../mail/parsePatch'
import { hunkLines } from './hunkDoc'

const lines = (text: string) => hunkLines(parsePatch(text)[0].rows)

describe('hunkLines', () => {
  it('numbers a removed row from the old file and the rest from the new one', () => {
    const rows = lines('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -10,3 +10,4 @@\n one\n-two\n+TWO\n+extra\n three\n')
    expect(rows.map((r) => [r.kind, r.number])).toEqual([['hunk', ''], ['ctx', '10'], ['del', '11'], ['add', '11'], ['add', '12'], ['ctx', '13']])
  })

  it('restarts at each hunk header', () => {
    expect(lines('@@ -1 +1 @@\n-a\n+b\n@@ -50,0 +60 @@\n+c\n').map((r) => r.number)).toEqual(['', '1', '1', '', '60'])
  })

  it('numbers an added file from 1, as its header says', () => {
    expect(lines('--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n').map((r) => r.number)).toEqual(['', '1', '2'])
  })

  it('a hand-written patch with no header has no numbers', () => {
    expect(lines('+a\n+b\n').map((r) => r.number)).toEqual(['', ''])
  })

  it('keeps the rows verbatim, markers and all', () => {
    expect(lines('@@ -1 +1 @@\n-a\n+b\n').map((r) => r.text)).toEqual(['@@ -1 +1 @@', '-a', '+b'])
  })
})
