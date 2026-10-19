import { describe, expect, it } from 'vitest'
import { nextMail } from './actions'

// The inbox, top to bottom.
const list = ['a', 'b', 'c', 'd'].map((thread_id) => ({ thread_id }))

describe('nextMail', () => {
  it('opens the one below when Kim came from above', () => {
    expect(nextMail(list, 'b', 'a')).toBe('c')
  })
  it('opens the one above when Kim came from below (working bottom up)', () => {
    expect(nextMail(list, 'c', 'd')).toBe('b')
  })
  it('falls back to the one below when there is no prior mail', () => {
    expect(nextMail(list, 'b', null)).toBe('c')
  })
  it('takes the other neighbour at the bottom end', () => {
    expect(nextMail(list, 'd', null)).toBe('c')
    expect(nextMail(list, 'd', 'c')).toBe('c')
  })
  it('takes the other neighbour at the top end', () => {
    expect(nextMail(list, 'a', 'b')).toBe('b')
  })
  it('is null when no mail is left, or the mail is not in the list', () => {
    expect(nextMail([{ thread_id: 'x' }], 'x', null)).toBeNull()
    expect(nextMail(list, 'z', 'a')).toBeNull()
  })
})
