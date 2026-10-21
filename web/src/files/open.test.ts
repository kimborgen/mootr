// @vitest-environment jsdom
// S-1527: a click on a line number moves the file view's key to that line in place.
// S-2105: the landing an Open names — which view it belongs to, who clears it, and how an open tab is told to look.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const swap = vi.fn()
// The real layout, with the two shell moves these tests drive replaced: `swap` for a line click, `open` for a diff tab.
vi.mock('../shell/layout', async (orig) => ({ ...(await orig<typeof import('../shell/layout')>()), open: vi.fn(), swap }))
vi.mock('../actions', () => ({ openWorld: vi.fn() }))

const { clearDiffGoto, gotoLine, onDiffGoto, openDiff, openPatch, peekDiffGoto } = await import('./open')
const { diffKey, patchKey } = await import('../diff/diffKey')

describe('gotoLine', () => {
  beforeEach(() => swap.mockClear())

  it('swaps the key for the clicked line, in place', () => {
    gotoLine('file:h:/a.ts', 'h', '/a.ts', 7)
    expect(swap).toHaveBeenCalledWith('file:h:/a.ts', 'file:h:/a.ts#L7')
  })
  it('moves from one marked line to another', () => {
    gotoLine('file:h:/a.ts#L7', 'h', '/a.ts', 9)
    expect(swap).toHaveBeenCalledWith('file:h:/a.ts#L7', 'file:h:/a.ts#L9')
  })
  it('keeps the tab when the marked line is clicked again', () => {
    gotoLine('file:h:/a.ts#L7', 'h', '/a.ts', 7)
    expect(swap).not.toHaveBeenCalled()
  })
})

const KEYS = [patchKey('h1'), patchKey('h2'), diffKey('stam2', 7), diffKey('stam2', 9)]
beforeEach(() => { for (const k of KEYS) clearDiffGoto(k) })

describe('the landing an Open names', () => {
  it('is for the key it was opened with, and one at a time', () => {
    openPatch('h1', 'src/a.ts')
    expect(peekDiffGoto(patchKey('h1'))).toBe('src/a.ts')
    expect(peekDiffGoto(diffKey('stam2', 7))).toBeNull()
    openDiff('stam2', 7, 'src/b.ts')
    expect(peekDiffGoto(diffKey('stam2', 7))).toBe('src/b.ts')
    // The newest Open is the one a view lands on; an earlier one is dropped with it.
    expect(peekDiffGoto(patchKey('h1'))).toBeNull()
  })

  it('is cleared by the view that handled it, never by another view', () => {
    openPatch('h1', 'src/a.ts')
    clearDiffGoto(diffKey('stam2', 9))
    expect(peekDiffGoto(patchKey('h1'))).toBe('src/a.ts')
    clearDiffGoto(patchKey('h1'))
    expect(peekDiffGoto(patchKey('h1'))).toBeNull()
  })

  it('tells every open diff view when it is set, and never when there is none', () => {
    const seen = vi.fn()
    const off = onDiffGoto(seen)
    openPatch('h2')
    expect(seen).not.toHaveBeenCalled()
    openPatch('h2', 'src/a.ts')
    expect(seen).toHaveBeenCalledTimes(1)
    clearDiffGoto(patchKey('h2'))
    expect(seen).toHaveBeenCalledTimes(1)
    off()
    openPatch('h1', 'src/a.ts')
    expect(seen).toHaveBeenCalledTimes(1)
  })
})
