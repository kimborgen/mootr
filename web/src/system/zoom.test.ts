import { describe, expect, it } from 'vitest'
import { chipWidth, roomsRight, shownLabels } from './zoom'

const p = { card: 200, cardH: 80, gapX: 20, chipMax: 192, chipClear: 4, stackOver: 12, stackOut: 12 }

describe('roomsRight', () => {
  it('measures to the nearest card level with it, or with its stack above', () => {
    const pos = new Map([
      ['a', { x: 0, y: 0, w: 200 }],
      ['b', { x: 260, y: 40, w: 200 }],
      ['c', { x: 230, y: -70, w: 200 }],
      ['d', { x: 220, y: 200, w: 200 }],
    ])
    const r = roomsRight(pos, 80)
    // c rests above a, close enough for a's stack: it counts; d is a row down: it doesn't.
    expect(r.get('a')).toBe(30)
    expect(r.get('b')).toBe(Infinity)
    expect(r.get('d')).toBe(Infinity)
  })
})

describe('chipWidth', () => {
  it('grows into the room to its right, up to the cap, never under its place', () => {
    expect(chipWidth(0.4, 150, 20, p)).toBe(200 * 0.4)
    expect(chipWidth(0.4, 150, 300, p)).toBe(150)
    expect(chipWidth(0.4, 300, Infinity, p)).toBe(192)
    // Cards' stack sits further out, so its chip stops shorter.
    expect(chipWidth(0.4, 300, 140, p, 12)).toBe(340 * 0.4 - 4 - 12 - 12)
  })
})

describe('shownLabels', () => {
  // Two orbs side by side on a ring, and the hub above them.
  const stars = [
    { id: 'hub', x: 100, y: 0, w: 40, depth: 0, lw: 60, lh: 16 },
    { id: 'a', x: 40, y: 200, w: 20, depth: 1, lw: 60, lh: 16 },
    { id: 'b', x: 110, y: 200, w: 20, depth: 1, lw: 60, lh: 16 },
  ]
  it('shows every label with room at its own size', () => {
    expect(shownLabels(stars, 1, 4)).toEqual(new Set(['hub', 'a', 'b']))
  })
  it('zoomed out, hides the label drawn later that would cover one before it', () => {
    // At half zoom each label covers twice the world: a's and b's meet, and a was placed first.
    expect(shownLabels(stars, 0.5, 4)).toEqual(new Set(['hub', 'a']))
  })
  it('hides a label that would cover an orb', () => {
    const under = [...stars, { id: 'c', x: 50, y: 226, w: 20, depth: 2, lw: 60, lh: 16 }]
    expect(shownLabels(under, 1, 4).has('a')).toBe(false)
  })
})
