import { beforeEach, describe, expect, it, vi } from 'vitest'
import { askFocus, doneFocus, focusIn, focusScrollTop, onFocus, openScrollTop, pendingFocus, settleFocus } from './mailFocus'

beforeEach(() => doneFocus())

describe('askFocus', () => {
  it('holds the asked mail and its thread until they are settled', () => {
    expect(pendingFocus()).toBeNull()
    askFocus('m3228ca5', 't1')
    expect(pendingFocus()).toEqual({ id: 'm3228ca5', tid: 't1' })
    doneFocus()
    expect(pendingFocus()).toBeNull()
  })

  it('tells the threads on screen about each ask', () => {
    const told = vi.fn()
    const off = onFocus(told)
    askFocus('m3228ca5', 't1')
    askFocus('m9f0c1d2', 't1')
    expect(told).toHaveBeenCalledTimes(2)
    off()
    askFocus('m3228ca5', 't1')
    expect(told).toHaveBeenCalledTimes(2)
  })
})

describe('settleFocus', () => {
  it('returns the asked mail in its thread and ends the ask', () => {
    askFocus('m3228ca5', 't1')
    expect(focusIn('t1', ['m1', 'm3228ca5'])).toBe('m3228ca5')
    expect(settleFocus('t1', ['m1', 'm3228ca5'])).toBe('m3228ca5')
    expect(pendingFocus()).toBeNull()
  })

  it('ends the ask when its thread loads without the mail, so a later thread never takes it', () => {
    askFocus('m3228ca5', 't1')
    expect(settleFocus('t1', ['m1', 'm2'])).toBeNull()
    expect(pendingFocus()).toBeNull()
    expect(settleFocus('t2', ['m3228ca5'])).toBeNull()
  })

  it('leaves the ask alone while another thread is shown or nothing has loaded', () => {
    askFocus('m3228ca5', 't1')
    expect(settleFocus('t2', ['m3228ca5'])).toBeNull()
    expect(settleFocus('t1', [])).toBeNull()
    expect(pendingFocus()).toEqual({ id: 'm3228ca5', tid: 't1' })
  })

  it('is cleared when Kim goes to another view', () => {
    askFocus('m3228ca5', 't1')
    doneFocus()
    expect(settleFocus('t1', ['m3228ca5'])).toBeNull()
  })
})

describe('focusScrollTop', () => {
  it('puts the mail at the top of the box when the header scrolls away', () => {
    // A mail 600 px below the box's top, with the box scrolled 100 px: its top is 700 px into the content.
    expect(focusScrollTop(600, 100, 0, 0)).toBe(700)
  })

  it('puts the mail under a sticky header with a gap', () => {
    expect(focusScrollTop(600, 100, 80, 8)).toBe(612)
  })

  it('never scrolls above the top', () => {
    expect(focusScrollTop(40, 0, 80, 8)).toBe(0)
  })
})

describe('openScrollTop', () => {
  it('opens at the bottom, so the latest message shows', () => {
    expect(openScrollTop(1500, 200, 1700, 800, 99)).toBe(900)
  })
  it('stays at the top when everything fits', () => {
    expect(openScrollTop(100, 200, 500, 800, 99)).toBe(0)
  })
  it('starts a latest message taller than the box at its own top', () => {
    expect(openScrollTop(1000, 900, 1900, 800, 99)).toBe(901)
  })
})
