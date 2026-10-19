import { describe, expect, it } from 'vitest'
import { targetOf, moveMember, patchRing, setReviewer, setReviewsAs, typePayload, type TypeDef } from './type-form'

const plain: TypeDef = { harness: 'codex', model: 'gpt-5', effort: 'low', description: 'x' }

describe('type form state', () => {
  it('a reviewer toggle adds and removes the review block', () => {
    const on = setReviewer(plain, true)
    expect(on.review).toEqual({ fallback: null, ring: null })
    expect(setReviewer(on, false).review).toBeNull()
  })
  it('a ring has no harness, model, or effort, and one agent brings a harness back', () => {
    const ring = setReviewsAs(setReviewer(plain, true), true, ['a', 'b', 'c'], 'claude')
    expect(ring).toMatchObject({ harness: '', model: null, effort: null, review: { ring: { format: 'rounds', members: ['a', 'b'], maxRounds: 3 } } })
    expect(typePayload(ring, false)).toMatchObject({ harness: '', model: null, effort: null })
    const back = setReviewsAs(ring, false, [], 'claude')
    expect(back.harness).toBe('claude')
    expect(back.review?.ring).toBeNull()
  })
  it('Ring and back restores the harness, model, and effort', () => {
    const rv = setReviewer(plain, true)
    const ring = setReviewsAs(rv, true, ['a', 'b'], 'claude')
    const back = setReviewsAs(ring, false, [], 'claude', targetOf(rv))
    expect(back).toMatchObject({ harness: 'codex', model: 'gpt-5', effort: 'low' })
  })
  it('moves a member up and down and stops at the ends', () => {
    expect(moveMember(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b'])
    expect(moveMember(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c'])
    expect(moveMember(['a', 'b'], 0, -1)).toEqual(['a', 'b'])
    expect(moveMember(['a', 'b'], 1, 1)).toEqual(['a', 'b'])
  })
  it('patches the ring only when there is one', () => {
    expect(patchRing(plain, { maxRounds: 5 })).toBe(plain)
    const ring = setReviewsAs(setReviewer(plain, true), true, ['a', 'b'], 'claude')
    expect(patchRing(ring, { maxRounds: 5 }).review?.ring?.maxRounds).toBe(5)
  })
  it('sends default: true only when switched on, and keeps the review block', () => {
    const rv = setReviewer(plain, true)
    expect(typePayload(rv, true)).toMatchObject({ default: true, review: { fallback: null, ring: null } })
    expect(typePayload(rv, false)).not.toHaveProperty('default')
    expect(typePayload(plain, true)).not.toHaveProperty('default')
  })
})
