// S-1527: a click on a line number moves the file view's key to that line in place.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const swap = vi.fn()
vi.mock('../shell/layout', () => ({ swap, open: vi.fn() }))
vi.mock('../actions', () => ({ openWorld: vi.fn() }))

const { gotoLine } = await import('./open')

beforeEach(() => swap.mockClear())

describe('gotoLine', () => {
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
