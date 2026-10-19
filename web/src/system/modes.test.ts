import { afterEach, describe, expect, it } from 'vitest'
import { asMode, modeOf, MODE_KEY, MODES, PHONE_MODE_KEY, pickMode, saveMode, storedMode } from './modes'

describe('modes', () => {
  it('starts from the link, then the stored choice, then Tree', () => {
    expect(pickMode('cards', 'tree')).toBe('cards')
    expect(pickMode(null, 'cards')).toBe('cards')
    expect(pickMode(undefined, null)).toBe('tree')
    expect(pickMode('nonsense', 'cards')).toBe('cards')
  })
  it('only takes a mode that has a layout', () => {
    for (const m of MODES) expect(asMode(m.id)).toBe(m.layout ? m.id : null)
    expect(asMode('outline')).toBe(null)
  })
  it('lays the Tree the same on the phone, with its stacks out past the corner (S-1067)', () => {
    const px = { card: 200, cardH: 80, gapX: 16, gapY: 40, indent: 20, rowGap: 8 } as Parameters<NonNullable<ReturnType<typeof modeOf>['layout']>>[1]
    const nodes = [{ id: 'h', parent: null }, { id: 'c', parent: 'h' }, { id: 'a', parent: 'c' }, { id: 'b', parent: 'c' }]
    const wide = modeOf('tree').layout!(nodes, px, new Set()), tall = modeOf('tree').layout!(nodes, px, new Set(), true)
    expect([...tall.pos]).toEqual([...wide.pos])
    expect(tall.wires.map((w) => w.d)).toEqual(wide.wires.map((w) => w.d))
    expect(wide.stacksOut).toBeUndefined()
    expect(tall.stacksOut).toBe(true)
  })
  afterEach(() => localStorage.clear())
  it('keeps the phone\'s choice apart from the desktop\'s (S-606)', () => {
    saveMode('stars', true)
    saveMode('cards')
    expect(storedMode(true)).toBe('stars')
    expect(storedMode()).toBe('cards')
    expect(localStorage.getItem(PHONE_MODE_KEY)).toBe('stars')
    expect(localStorage.getItem(MODE_KEY)).toBe('cards')
  })
})
