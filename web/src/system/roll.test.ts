import { describe, expect, it } from 'vitest'
import { frameText, NO_RISE, riseNext, rollSpan } from './roll'
import { cardTransform, parseBezier, spring, SPRINGS, tween } from './springs'

describe('rollSpan: a roll never lags the data', () => {
  it('runs a full roll when none is running', () => {
    expect(rollSpan(null, 1000, 440)).toEqual({ ms: 440, run: { end: 1440 } })
  })
  it('keeps the running roll\'s end when a new value arrives mid-roll, skipping the frames between', () => {
    const a = rollSpan(null, 1000, 440)
    const b = rollSpan(a.run, 1300, 440)
    expect(b).toEqual({ ms: 140, run: { end: 1440 } })
    // Updates faster than the roll all finish by the first one's end.
    expect(rollSpan(b.run, 1400, 440).ms).toBe(40)
  })
  it('snaps when less than a frame is left, and starts afresh after the end', () => {
    expect(rollSpan({ end: 1440 }, 1430, 440)).toEqual({ ms: 0, run: null })
    expect(rollSpan({ end: 1440 }, 1500, 440)).toEqual({ ms: 440, run: { end: 1940 } })
  })
  it('is instant under reduced motion', () => {
    expect(rollSpan({ end: 9999 }, 1000, 0)).toEqual({ ms: 0, run: null })
  })
})

describe('frameText: a frame writes only a changed text', () => {
  const fmt = (v: number) => '$' + v.toFixed(2)
  it('skips a frame whose text is already shown', () => {
    expect(frameText('$1.20', 1.201, fmt)).toBeNull()
    expect(frameText('$1.20', 1.21, fmt)).toBe('$1.21')
    expect(frameText(null, 3, fmt)).toBe('$3.00')
  })
})

describe('riseNext: the "+$" over a growing cost', () => {
  it('takes the first value as its base, without a rise', () => {
    expect(riseNext(NO_RISE, 2, 0, 500)).toMatchObject({ key: 0, base: 2 })
  })
  it('rises by the growth, and a growth soon after adds to the same rise', () => {
    let r = riseNext(NO_RISE, 2, 0, 500)
    r = riseNext(r, 2.4, 100, 500)
    expect(r).toMatchObject({ key: 1, base: 2.4, t0: 100 })
    expect(r.amount).toBeCloseTo(0.4)
    r = riseNext(r, 2.5, 300, 500)
    expect(r.key).toBe(1)
    expect(r.amount).toBeCloseTo(0.5)
    // Past the merge window, a new rise.
    r = riseNext(r, 3, 900, 500)
    expect(r).toMatchObject({ key: 2, t0: 900 })
    expect(r.amount).toBeCloseTo(0.5)
  })
  it('lets small growth add up, and resets on a drop or no value', () => {
    let r = riseNext(NO_RISE, 1, 0, 500)
    r = riseNext(r, 1.004, 10, 500)
    expect(r.key).toBe(0)
    r = riseNext(r, 1.012, 20, 500)
    expect(r.key).toBe(1)
    expect(r.amount).toBeCloseTo(0.012)
    expect(riseNext(r, 0.5, 30, 500)).toMatchObject({ key: 1, base: 0.5 })
    expect(riseNext(r, null, 30, 500)).toBe(r)
  })
})

describe('springs: timed by --duration-slow', () => {
  it('scales each preset by the token, bounce 0.2 or less', () => {
    expect(spring(SPRINGS.move, 220)).toEqual({ type: 'spring', bounce: 0.1, visualDuration: 0.44 })
    for (const p of Object.values(SPRINGS)) expect(p.bounce).toBeLessThanOrEqual(0.2)
  })
  it('is instant when reduced motion zeroes the token', () => {
    expect(spring(SPRINGS.grow, 0)).toEqual({ duration: 0 })
    expect(tween(0, null)).toEqual({ duration: 0 })
  })
  it('reads the ease-out token\'s curve', () => {
    expect(parseBezier(' cubic-bezier(0.2, 0, 0, 1)')).toEqual([0.2, 0, 0, 1])
    expect(parseBezier('ease')).toBeNull()
    expect(tween(440, [0.2, 0, 0, 1])).toEqual({ duration: 0.44, ease: [0.2, 0, 0, 1] })
  })
  it('places a card by one transform string, never at scale 0', () => {
    expect(cardTransform(10, 20)).toBe('translate(10px, 20px) scale(1)')
    expect(cardTransform(10, 20, 0.96)).toBe('translate(10px, 20px) scale(0.96)')
  })
})
