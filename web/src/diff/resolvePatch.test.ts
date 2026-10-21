// S-2104: matching one of a patch's files against a checkout's copy of it. Pure, so every case is here.
import { describe, expect, it } from 'vitest'
import { parsePatch } from '../mail/parsePatch'
import { patchKind } from '../mail/parsePatch'
import { hunksOf, resolvePatch } from './resolvePatch'

// One file's patch, as a fence would carry it.
const fence = (...rows: string[]) => ['diff --git a/f.ts b/f.ts', '--- a/f.ts', '+++ b/f.ts', ...rows, ''].join('\n')
const one = (...rows: string[]) => parsePatch(fence(...rows))[0]
// A modification of one line in a three-line file.
const change = one('@@ -1,3 +1,3 @@', ' one', '-two', '+TWO', ' three')
// A `-U0` hunk: no context at all, so its other image is what says which side the file is.
const cut = one('@@ -2 +1,0 @@', '-two')
const ins = one('@@ -2,0 +3,1 @@', '+new')

describe('resolvePatch', () => {
  it('matches the post-image and reverse-applies for the base', () => {
    expect(resolvePatch(change, 'one\nTWO\nthree\n')).toEqual({ base: 'one\ntwo\nthree\n', head: 'one\nTWO\nthree\n' })
  })

  it('matches the pre-image and applies for the head', () => {
    expect(resolvePatch(change, 'one\ntwo\nthree\n')).toEqual({ base: 'one\ntwo\nthree\n', head: 'one\nTWO\nthree\n' })
  })

  it('allows lines above the hunk to differ', () => {
    expect(resolvePatch(change, 'zero\none\nTWO\nthree\n')).toEqual({ base: 'zero\none\ntwo\nthree\n', head: 'zero\none\nTWO\nthree\n' })
  })

  it('keeps a file\'s ending when the patch does not replace its last line', () => {
    // The hunk stops at line 2 of a three-line file: nothing says anything about the last line, so its own ending stays.
    const short = one('@@ -1,2 +1,2 @@', ' one', '-two', '+TWO')
    expect(resolvePatch(short, 'one\ntwo\nthree')).toEqual({ base: 'one\ntwo\nthree', head: 'one\nTWO\nthree' })
  })

  it('matches several hunks where their headers put them, with the lines between them kept', () => {
    const two = one('@@ -1,2 +1,2 @@', '-a', '+A', ' b', '@@ -10,2 +10,2 @@', '-c', '+C', ' d')
    expect(resolvePatch(two, 'A\nb\nx\nx\nx\nx\nx\nx\nx\nC\nd\n')).toEqual({ base: 'a\nb\nx\nx\nx\nx\nx\nx\nx\nc\nd\n', head: 'A\nb\nx\nx\nx\nx\nx\nx\nx\nC\nd\n' })
  })

  it('is unresolved when a hunk is missing, or out of order', () => {
    expect(resolvePatch(change, 'one\nthree\n')).toBeNull()
    expect(resolvePatch(change, 'TWO\none\nthree\n')).toBeNull()
  })

  it('is unresolved when the file read could not happen', () => {
    expect(resolvePatch(change, null)).toBeNull()
  })

  it('is unresolved for a patch with no hunks at all', () => {
    expect(resolvePatch(parsePatch('diff --git a/f.ts b/f.ts\n')[0], 'anything\n')).toBeNull()
  })

  it('is unresolved for a file with CRLF line endings, rather than matching nothing of it', () => {
    expect(resolvePatch(change, 'one\r\nTWO\r\nthree\r\n')).toBeNull()
    expect(resolvePatch(change, 'one\r\ntwo\r\nthree\r\n')).toBeNull()
  })

  // A `-U0` hunk has an empty image on one side: the other side is what matches, and the file is never taken for the
  // side whose image is nothing (S-2104 review).
  it('matches a -U0 deletion the other way round', () => {
    expect(resolvePatch(cut, 'one\ntwo\nthree\n')).toEqual({ base: 'one\ntwo\nthree\n', head: 'one\nthree\n' })
    // The line it deletes is gone already: neither side of the patch is this file.
    expect(resolvePatch(cut, 'one\nthree\n')).toBeNull()
  })

  it('matches a -U0 insertion the post-image way, and not against a file without the line', () => {
    expect(resolvePatch(ins, 'one\ntwo\nnew\nthree\n')).toEqual({ base: 'one\ntwo\nthree\n', head: 'one\ntwo\nnew\nthree\n' })
    expect(resolvePatch(ins, 'one\ntwo\nthree\n')).toBeNull()
  })

  // A `-U0` hunk with an image of no lines is anchored to the line the change comes after, not to that line itself
  // (S-2104 review): inserting `x` after line 3 of a four-line file puts it between `c` and `d`.
  it('places a -U0 insertion after the line its header names, in both directions', () => {
    const pair = one('@@ -1 +1 @@', '-a', '+A', '@@ -3,0 +4 @@', '+x')
    expect(resolvePatch(pair, 'a\nb\nc\nd\n')).toEqual({ base: 'a\nb\nc\nd\n', head: 'A\nb\nc\nx\nd\n' })
    expect(resolvePatch(pair, 'A\nb\nc\nx\nd\n')).toEqual({ base: 'a\nb\nc\nd\n', head: 'A\nb\nc\nx\nd\n' })
  })

  it('places a -U0 deletion after the line its header names, in both directions', () => {
    const pair = one('@@ -1 +1 @@', '-a', '+A', '@@ -4,1 +3,0 @@', '-d')
    expect(resolvePatch(pair, 'a\nb\nc\nd\n')).toEqual({ base: 'a\nb\nc\nd\n', head: 'A\nb\nc\n' })
    expect(resolvePatch(pair, 'A\nb\nc\n')).toEqual({ base: 'a\nb\nc\nd\n', head: 'A\nb\nc\n' })
  })

  // An insertion at the very top of an existing file carries a new file's `@@ -0,0 +1 @@`, so only the patch's own
  // headers can say a file is created (S-2104 review).
  it('does not take a file for added when only the hunk header looks like a new file\'s', () => {
    const top = one('@@ -0,0 +1 @@', '+x')
    expect(patchKind(top)).toBe('modified')
    expect(resolvePatch(top, 'x\na\nb\n')).toEqual({ base: 'a\nb\n', head: 'x\na\nb\n' })
    // Without the line there is no way to tell this file from any other: an image of no lines matches everything, so the
    // pre-image direction is not credible and the file stays unresolved.
    expect(resolvePatch(top, 'a\nb\n')).toBeNull()
    const created = parsePatch(['diff --git a/new.ts b/new.ts', 'new file mode 100644', '--- /dev/null', '+++ b/new.ts', '@@ -0,0 +1 @@', '+x', ''].join('\n'))[0]
    expect(patchKind(created)).toBe('added')
    const gone = parsePatch(['diff --git a/old.ts b/old.ts', 'deleted file mode 100644', '--- a/old.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-x', ''].join('\n'))[0]
    expect(patchKind(gone)).toBe('deleted')
  })

  it('trusts a deletion from the hunk header only in a hand-written patch', () => {
    // `@@ -1 +0,0 @@` is a `-U0` deletion of line 1: with a `diff --git` header it is a modification, not a removed file.
    const seen = one('@@ -1 +0,0 @@', '-x')
    expect(seen.header).toBe(true)
    expect(patchKind(seen)).toBe('modified')
    const hand = parsePatch('@@ -1 +0,0 @@\n-x\n')[0]
    expect(hand.header).toBeUndefined()
    expect(patchKind(hand)).toBe('deleted')
  })

  // A short hunk (`}` alone) occurs several times in a file: its header says which one it is.
  it('takes the hunk at its header, not an earlier copy of a short context', () => {
    const braces = one('@@ -11,2 +11,2 @@', ' }', '-x', '+y')
    // Earlier copies of `}x` at lines 1 and 5, and the hunk's own place at line 11, where its header says it is.
    const before = ['}', 'x', 'a', 'b', '}', 'x', 'c', 'd', 'e', 'f']
    const file = [...before, '}', 'x', 'tail'].join('\n') + '\n'
    expect(resolvePatch(braces, file)).toEqual({ base: file, head: [...before, '}', 'y', 'tail'].join('\n') + '\n' })
  })

  it('is unresolved when the two directions only fit away from their headers', () => {
    const braces = one('@@ -11,2 +11,2 @@', ' }', '-x', '+y')
    // `}y` at line 1 and `}x` at line 5, and nothing at line 11: which side this file is cannot be told.
    expect(resolvePatch(braces, '}\ny\na\nb\n}\nx\nc\nd\ne\nf\ng\nh\n')).toBeNull()
  })

  it('matches a file the patch creates, whole', () => {
    const added = parsePatch(['diff --git a/new.ts b/new.ts', 'new file mode 100644', '--- /dev/null', '+++ b/new.ts', '@@ -0,0 +1,2 @@', '+a', '+b', ''].join('\n'))[0]
    expect(resolvePatch(added, 'a\nb\n')).toEqual({ base: '', head: 'a\nb\n' })
    expect(resolvePatch(added, 'a\nb\nc\n')).toBeNull()
  })

  it('matches a file the patch deletes, whole', () => {
    const deleted = parsePatch(['diff --git a/gone.ts b/gone.ts', 'deleted file mode 100644', '--- a/gone.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-a', '-b', ''].join('\n'))[0]
    expect(deleted.path).toBe('gone.ts')
    expect(resolvePatch(deleted, 'a\nb\n')).toEqual({ base: 'a\nb\n', head: '' })
    expect(resolvePatch(deleted, 'a\n')).toBeNull()
  })

  it('matches a rename at either path, and names the old one', () => {
    const renamed = parsePatch(['diff --git a/old.ts b/new.ts', 'similarity index 80%', 'rename from old.ts', 'rename to new.ts', '--- a/old.ts', '+++ b/new.ts', '@@ -1,2 +1,2 @@', ' keep', '-was', '+is', ''].join('\n'))[0]
    expect(renamed.oldPath).toBe('old.ts')
    // The new path's content, when the rename has landed, and the old path's when it has not.
    expect(resolvePatch(renamed, 'keep\nis\n')).toEqual({ base: 'keep\nwas\n', head: 'keep\nis\n' })
    expect(resolvePatch(renamed, 'keep\nwas\n')).toEqual({ base: 'keep\nwas\n', head: 'keep\nis\n' })
    expect(resolvePatch(renamed, 'keep\nnothing like it\n')).toBeNull()
  })

  // `\ No newline at end of file` says which side ends without one, so a patch that adds or drops the file's last
  // newline draws both sides right (S-2104 review).
  it('adds a final newline: the file without one is the base, and the head gets one', () => {
    const add = parsePatch(['diff --git a/f.ts b/f.ts', '--- a/f.ts', '+++ b/f.ts', '@@ -1,2 +1,3 @@', ' one', '-two', '\\ No newline at end of file', '+two', '+three', ''].join('\n'))[0]
    // The writer's checkout has the patch not applied, and no newline at the end.
    expect(resolvePatch(add, 'one\ntwo')).toEqual({ base: 'one\ntwo', head: 'one\ntwo\nthree\n' })
    // Applied, with the newline: the base is the old text, still without one.
    expect(resolvePatch(add, 'one\ntwo\nthree\n')).toEqual({ base: 'one\ntwo', head: 'one\ntwo\nthree\n' })
  })

  it('drops a final newline: the side the patch marks ends without one', () => {
    const drop = parsePatch(['diff --git a/f.ts b/f.ts', '--- a/f.ts', '+++ b/f.ts', '@@ -1,2 +1,2 @@', ' one', '-two', '+two', '\\ No newline at end of file', ''].join('\n'))[0]
    // The file as read, without a newline, is the head the patch made.
    expect(resolvePatch(drop, 'one\ntwo')).toEqual({ base: 'one\ntwo\n', head: 'one\ntwo' })
    // With one, it is the base the patch was made against.
    expect(resolvePatch(drop, 'one\ntwo\n')).toEqual({ base: 'one\ntwo\n', head: 'one\ntwo' })
  })
})

describe('hunksOf', () => {
  it('reads each hunk as the lines it has before and after the patch, and where its header puts them', () => {
    expect(hunksOf(change.rows)).toEqual([{ pre: ['one', 'two', 'three'], post: ['one', 'TWO', 'three'], oldStart: 1, oldCount: 3, newStart: 1, newCount: 3, preNoEol: false, postNoEol: false }])
  })

  it('reads a header with no counts as one line, and one this cannot read at all as no position', () => {
    expect(hunksOf(one('@@ -7 +7 @@', ' x').rows)).toMatchObject([{ oldStart: 7, oldCount: 1, newStart: 7, newCount: 1 }])
    expect(hunksOf(one('@@ -9,0 +9,0 @@').rows)).toMatchObject([{ oldStart: 9, oldCount: 0, newStart: 9, newCount: 0 }])
    expect(hunksOf(one('@@ nope @@', ' x').rows)).toMatchObject([{ oldStart: 0, oldCount: 0, newStart: 0, newCount: 0 }])
  })

  it('takes a row above the first hunk as belonging to none', () => {
    expect(hunksOf([{ kind: 'ctx', text: ' stray', ind: 1 }])).toEqual([])
  })
})
