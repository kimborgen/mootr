import { beforeEach, describe, expect, it } from 'vitest'
import type { TreeIn } from './layout'
import { admit, ancestors, boxOf, focusFolds, frame, inView, loadFolds, saveFolds, search, shownFolds, subtree, type Findable } from './scale'

// human > cos > (release, a > (a1, a2), b > (b1 > (b1x), b2))
const SMALL: TreeIn[] = [
  { id: 'human', parent: null },
  { id: 'cos', parent: 'human' },
  { id: 'release', parent: 'cos' },
  { id: 'a', parent: 'cos' },
  { id: 'a1', parent: 'a' },
  { id: 'a2', parent: 'a' },
  { id: 'b', parent: 'cos' },
  { id: 'b1', parent: 'b' },
  { id: 'b1x', parent: 'b1' },
  { id: 'b2', parent: 'b' },
]

describe('focus', () => {
  it('lists ancestors nearest first, and the whole subtree', () => {
    expect(ancestors(SMALL, 'b1x')).toEqual(['b1', 'b', 'cos', 'human'])
    expect(subtree(SMALL, 'b')).toEqual(['b1', 'b1x', 'b2'])
  })
  it('folds every manager outside the focus, and none on its path or under it', () => {
    expect([...focusFolds(SMALL, 'b')].sort()).toEqual(['a'])
    expect([...focusFolds(SMALL, 'a')].sort()).toEqual(['b', 'b1'])
  })
  it('lays toggles over the base, only within the focus when given', () => {
    const base = new Set(['a', 'b1'])
    expect([...shownFolds(base, { a: false, b: true })].sort()).toEqual(['b', 'b1'])
    expect([...shownFolds(base, { a: false, b1: false }, new Set(['b', 'b1']))].sort()).toEqual(['a'])
  })
})

describe('search', () => {
  const ENTRIES: Findable[] = [
    { id: '1', name: 'voice-dev1', itsas: [{ key: 'S-12', title: 'Push to talk' }] },
    { id: '2', name: 'dev-voice', itsas: [] },
    { id: '3', name: 'storage-ops', itsas: [{ key: 'S-120', title: 'Voice backups' }] },
    { id: '4', name: 'its-dev2', itsas: [{ key: 'S-7', title: 'Board columns' }] },
  ]
  it('ranks a name prefix, then a name match, then a title', () => {
    expect(search(ENTRIES, 'voice').map((f) => f.id)).toEqual(['1', '2', '3'])
    expect(search(ENTRIES, 'Voice')[2].why).toBe('S-120 Voice backups')
  })
  it('matches an ITSA key exactly or by its numeric prefix', () => {
    expect(search(ENTRIES, 's-12').map((f) => f.id)).toEqual(['1', '3'])
    expect(search(ENTRIES, 's-7').map((f) => f.id)).toEqual(['4'])
  })
  it('needs every word, and returns nothing for a blank query', () => {
    expect(search(ENTRIES, 'board columns').map((f) => f.id)).toEqual(['4'])
    expect(search(ENTRIES, 'board rows')).toEqual([])
    expect(search(ENTRIES, '  ')).toEqual([])
  })
  it('keeps at most `limit` results', () => {
    expect(search(ENTRIES, 'dev', 1).map((f) => f.id)).toEqual(['2'])
  })
})

describe('culling', () => {
  const pos = new Map([
    ['in', { x: 100, y: 100, w: 200 }],
    ['near', { x: 1200, y: 100, w: 200 }],
    ['far', { x: 3000, y: 100, w: 200 }],
    ['above', { x: 100, y: -600, w: 200 }],
  ])
  it('mounts the cards within the stage and its margin', () => {
    expect([...inView(pos, { x: 0, y: 0, k: 1 }, 1000, 800, 80, 300)].sort()).toEqual(['in', 'near'])
    expect([...inView(pos, { x: 0, y: 0, k: 1 }, 1000, 800, 80, 0)]).toEqual(['in'])
  })
  it('follows the pan and zoom', () => {
    expect([...inView(pos, { x: 0, y: 600, k: 1 }, 1000, 800, 80, 0)].sort()).toEqual(['above', 'in'])
    expect([...inView(pos, { x: 0, y: 0, k: 0.25 }, 1000, 800, 80, 0)].sort()).toEqual(['far', 'in', 'near'])
  })
  it('keeps a mounted card until it is twice the margin out', () => {
    // 'near' starts 200 px past the stage's right edge, 'far' 2000 px.
    expect([...inView(pos, { x: 0, y: 0, k: 1 }, 1000, 800, 80, 150)]).toEqual(['in'])
    expect([...inView(pos, { x: 0, y: 0, k: 1 }, 1000, 800, 80, 150, new Set(['near', 'far']))].sort()).toEqual(['in', 'near'])
  })
  it('mounts every card in the stage at once, and the margin\'s a few a frame', () => {
    const want = new Set(['a', 'b', 'c', 'd', 'e', 'f'])
    const seen = new Set(['d', 'e', 'f'])
    // Three fresh in the stage, past a cap of one: all three mount, and one of the margin's.
    expect(admit(want, seen, new Set(['a']), 1)).toEqual({ ids: new Set(['a', 'b', 'd', 'e', 'f']), more: true })
    expect(admit(want, seen, new Set(['a', 'b', 'd', 'e', 'f']), 1)).toEqual({ ids: want, more: false })
    expect(admit(want, seen, null, 1)).toEqual({ ids: new Set(['a', 'd', 'e', 'f']), more: true })
  })
  it('frames a box centred, fitted and clamped', () => {
    const box = boxOf([{ x: 0, y: 0, w: 200 }, { x: 400, y: 300, w: 200 }], 100)!
    expect(box).toEqual({ x: 0, y: 0, w: 600, h: 400 })
    expect(frame(box, 1000, 800, 50, 0.35, 2)).toEqual({ k: 1, x: 200, y: 200 })
    expect(frame(box, 400, 800, 50, 0.35, 2).k).toBe(0.5)
    expect(frame({ x: 0, y: 0, w: 10000, h: 10000 }, 1000, 800, 50, 0.35, 2)).toEqual({ k: 0.35, x: 500 - 5000 * 0.35, y: 50 })
    expect(boxOf([], 100)).toBeNull()
  })
})

describe('fold persistence', () => {
  beforeEach(() => localStorage.clear())
  it('keeps the desktop and phone folds apart', () => {
    saveFolds(false, { a: true })
    saveFolds(true, { b: false })
    expect(loadFolds(false)).toEqual({ a: true })
    expect(loadFolds(true)).toEqual({ b: false })
  })
  it('reads bad storage as no folds', () => {
    localStorage.setItem('stam/system-folds', '{bad')
    expect(loadFolds(false)).toEqual({})
  })
})
