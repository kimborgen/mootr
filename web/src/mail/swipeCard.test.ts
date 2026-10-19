import { describe, expect, it } from 'vitest'
import { FLICK, keyAction, pinFront, pullAction, releaseAction, releaseVelocity, stackOrder, threshold } from './swipeCard'

const LIMIT = 100

describe('pullAction (S-1003)', () => {
  it('points left at archive, right at leave, and up at defer', () => {
    expect(pullAction(-50, 5, LIMIT)).toEqual({ action: 'archive', progress: 0.5 })
    expect(pullAction(50, -5, LIMIT)).toEqual({ action: 'leave', progress: 0.5 })
    expect(pullAction(10, -80, LIMIT)).toEqual({ action: 'defer', progress: 0.8 })
  })
  it('points at nothing when pulled mostly down, or not at all', () => {
    expect(pullAction(10, 60, LIMIT).action).toBeNull()
    expect(pullAction(0, 0, LIMIT).action).toBeNull()
  })
  it('caps progress at 1', () => {
    expect(pullAction(-400, 0, LIMIT).progress).toBe(1)
  })
})

describe('releaseAction (S-1003)', () => {
  it('fires past the threshold and springs back short of it', () => {
    expect(releaseAction(-100, 0, 0, 0, LIMIT)).toBe('archive')
    expect(releaseAction(120, 10, 0, 0, LIMIT)).toBe('leave')
    expect(releaseAction(0, -100, 0, 0, LIMIT)).toBe('defer')
    expect(releaseAction(-99, 0, 0, 0, LIMIT)).toBeNull()
    expect(releaseAction(0, 200, 0, 0, LIMIT)).toBeNull()
  })
  it('fires a fast flick along the pull past a third of the threshold', () => {
    expect(releaseAction(-40, 0, -FLICK, 0, LIMIT)).toBe('archive')
    expect(releaseAction(0, -40, 0, -FLICK, LIMIT)).toBe('defer')
    expect(releaseAction(40, 0, FLICK, 0, LIMIT)).toBe('leave')
  })
  it("doesn't fire a flick that is too short, too slow, or against the pull", () => {
    expect(releaseAction(-20, 0, -2, 0, LIMIT)).toBeNull()
    expect(releaseAction(-40, 0, -FLICK / 2, 0, LIMIT)).toBeNull()
    expect(releaseAction(-40, 0, 1, 0, LIMIT)).toBeNull()
  })
})

describe('releaseVelocity', () => {
  it('measures a flick over its time', () => {
    expect(releaseVelocity({ t: 0, x: 100, y: 0 }, { t: 60, x: 40, y: 0 })).toEqual({ vx: -1, vy: 0 })
  })
  it("doesn't read a slow pull as a flick when one move lands just before the lift", () => {
    const v = releaseVelocity({ t: 100, x: 54, y: 0 }, { t: 102, x: 52, y: 0 })
    expect(releaseAction(-48, 0, v.vx, v.vy, LIMIT)).toBeNull()
  })
})

describe('threshold and keys', () => {
  it('keeps the threshold between 72 and 120 px', () => {
    expect(threshold(200)).toBe(72)
    expect(threshold(300)).toBe(90)
    expect(threshold(1000)).toBe(120)
  })
  it('maps the arrows to the swipes, Enter to open, z to undo', () => {
    expect(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'Enter', 'z', 'ArrowDown', 'e'].map(keyAction)).toEqual(['archive', 'leave', 'defer', 'open', 'undo', null, null])
  })
})

describe('stackOrder', () => {
  const t = (id: string, at: string, last = 'm-' + id) => ({ thread_id: id, mails: [{ id: last, created_at: at }] })
  const a = t('a', '2026-10-15T09:00:00Z'), b = t('b', '2026-10-15T10:00:00Z'), c = t('c', '2026-10-15T08:00:00Z')
  it('puts the newest on top', () => {
    expect(stackOrder([a, b, c], new Map()).map((x) => x.thread_id)).toEqual(['b', 'a', 'c'])
  })
  it('sends the threads left to the back, in the order they were left', () => {
    const left = new Map([['b', 'm-b'], ['a', 'm-a']])
    expect(stackOrder([a, b, c], left).map((x) => x.thread_id)).toEqual(['c', 'b', 'a'])
  })
  it('brings a left thread back in line when new mail reaches it', () => {
    const left = new Map([['b', 'm-old']])
    expect(stackOrder([a, b, c], left).map((x) => x.thread_id)).toEqual(['b', 'a', 'c'])
  })
  it('forgets left threads no longer in the inbox', () => {
    expect(stackOrder([a, c], new Map([['b', 'm-b']])).map((x) => x.thread_id)).toEqual(['a', 'c'])
  })
})

describe('pinFront', () => {
  const l = ['n', 'a', 'b'].map((thread_id) => ({ thread_id }))
  it('keeps the pinned card on top', () => {
    expect(pinFront(l, 'a').map((t) => t.thread_id)).toEqual(['a', 'n', 'b'])
  })
  it('leaves the order alone when nothing is pinned, or the pinned card is gone', () => {
    expect(pinFront(l, null)).toBe(l)
    expect(pinFront(l, 'gone')).toBe(l)
  })
})
