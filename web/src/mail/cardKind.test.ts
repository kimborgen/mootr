import { describe, expect, it } from 'vitest'
import { cardKind } from './cardKind'

describe('cardKind', () => {
  it('calls a thread that waits on the human a decision, whatever the verdict says', () => {
    expect(cardKind({ waiting: true })).toBe('decision')
    expect(cardKind({ waiting: true, verdictKind: 'done' })).toBe('decision')
  })
  it('follows the verdict kind otherwise', () => {
    expect(cardKind({ waiting: false, verdictKind: 'decision' })).toBe('decision')
    expect(cardKind({ waiting: false, verdictKind: 'blocker' })).toBe('blocker')
    expect(cardKind({ waiting: false, verdictKind: 'done' })).toBe('done')
  })
  it('is general for any other kind or none', () => {
    expect(cardKind({ waiting: false, verdictKind: 'answer' })).toBe('general')
    expect(cardKind({ waiting: false, verdictKind: 'update' })).toBe('general')
    expect(cardKind({ waiting: false, verdictKind: null })).toBe('general')
    expect(cardKind({ waiting: false })).toBe('general')
  })
})
