import { describe, expect, it } from 'vitest'
import type { Ask } from '../types'
import { askKindLabel, askOutcomeLabel, askRows, openAskCount } from './needsYou'

const ask = (over: Partial<Ask> & Pick<Ask, 'key' | 'state'>): Ask => ({
  kind: 'request', outcome: null, what: 'Permission request', agent_id: 'a1', agent_name: 'fixture-dev', machine: 'fixture-home',
  thread_id: 't1', itsa_id: null, since: '2026-10-24T10:00:00.000Z', settled_at: null, ...over,
})

describe('Needs you list', () => {
  // Out of order on purpose: the list must not trust the order it was sent in.
  const asks: Ask[] = [
    ask({ key: 'settled-new', state: 'settled', outcome: 'approved', since: '2026-10-24T09:00:00.000Z', settled_at: '2026-10-24T11:00:00.000Z' }),
    ask({ key: 'open-new', state: 'open', since: '2026-10-24T12:00:00.000Z' }),
    ask({ key: 'settled-old', state: 'settled', outcome: 'denied', since: '2026-10-24T08:00:00.000Z', settled_at: '2026-10-24T08:30:00.000Z' }),
    ask({ key: 'open-old', state: 'open', since: '2026-10-24T10:00:00.000Z' }),
  ]

  it('lists open asks oldest first, then settled ones newest first', () => {
    expect(askRows(asks).map((a) => a.key)).toEqual(['open-old', 'open-new', 'settled-new', 'settled-old'])
  })

  it('counts the open asks, and the count is the open rows', () => {
    expect(openAskCount(asks)).toBe(2)
    expect(askRows(asks).filter((a) => a.state === 'open')).toHaveLength(openAskCount(asks))
  })

  it('counts nothing when nothing is open', () => {
    expect(openAskCount([ask({ key: 'done', state: 'settled', outcome: 'typed', settled_at: '2026-10-24T11:00:00.000Z' })])).toBe(0)
  })

  it('labels the kind and the outcome', () => {
    expect(askKindLabel(ask({ key: 'x', state: 'open', kind: 'input' }))).toBe('Suggested input')
    expect(askOutcomeLabel(ask({ key: 'x', state: 'settled', outcome: 'withdrawn' }))).toBe('Withdrawn')
  })
})
