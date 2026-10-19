import { describe, expect, it } from 'vitest'
import { isLocalKey, readOnly, scopeOf, splitPatch, staleNote, writesToHome } from './settings-scope'

const local = ['home', 'peers', 'itsa.home', 'resourceWarn.lastWarned']
describe('settings scope', () => {
  it('the home is not a peer, and a daemon with no home field is not either', () => {
    expect(scopeOf({ text: '{}', home: 'alpha', local }, 'alpha').peer).toBe(false)
    expect(scopeOf({ text: '{}' }, 'alpha').peer).toBe(false)
    expect(scopeOf({ text: '{}', home: 'alpha', local, stale: false }, 'storage').peer).toBe(true)
  })
  it('matches local keys and what is inside them', () => {
    expect(isLocalKey('peers.0.url', local)).toBe(true)
    expect(isLocalKey('peers', local)).toBe(true)
    expect(isLocalKey('itsa', local)).toBe(true)
    expect(isLocalKey('cost.dailyWarnUsd', local)).toBe(false)
    expect(isLocalKey('homeless', local)).toBe(false)
  })
  it('makes shared keys read-only on a peer only', () => {
    const peer = scopeOf({ text: '{}', home: 'a', local }, 'b')
    expect(readOnly('cost.dailyWarnUsd', peer)).toBe(true)
    expect(readOnly('peers.0.name', peer)).toBe(false)
    expect(readOnly('cost.dailyWarnUsd', scopeOf({ text: '{}', home: 'a', local }, 'a'))).toBe(false)
    expect(readOnly('x', null)).toBe(false)
  })
  it('words the stale note from fetchedAt', () => {
    const now = Date.parse('2026-10-13T12:00:00Z')
    const s = scopeOf({ text: '{}', home: 'a', local, stale: true, fetchedAt: '2026-10-13T11:30:00Z' }, 'b')
    expect(staleNote(s, now)).toBe("Can't reach a; showing the last copy from 30 min ago.")
    expect(staleNote({ ...s, fetchedAt: null }, now)).toContain('no copy')
    expect(staleNote({ ...s, stale: false }, now)).toBeNull()
  })
  it('a peer that knows the home\'s page edits shared keys and sends them there (S-414)', () => {
    const peer = scopeOf({ text: '{}', home: 'a', local, homeWeb: 'https://a.example.com' }, 'b')
    expect(readOnly('cost.dailyWarnUsd', peer)).toBe(false)
    expect(writesToHome(peer)).toBe(true)
    expect(writesToHome(scopeOf({ text: '{}', home: 'a', local }, 'b'))).toBe(false)
    expect(writesToHome(scopeOf({ text: '{}', home: 'a', local, homeWeb: 'https://a.example.com' }, 'a'))).toBe(false)
  })
  it('splits a patch: local keys here, shared keys to the home, a mixed key to the side that changed', () => {
    const base = { peers: [], cost: { a: 1 }, itsa: { home: 'a', wip: 1 } }
    expect(splitPatch({ peers: [{ name: 'x' }] }, base, local)).toEqual({ local: { peers: [{ name: 'x' }] }, shared: {} })
    expect(splitPatch({ cost: { a: 2 } }, base, local)).toEqual({ local: {}, shared: { cost: { a: 2 } } })
    expect(splitPatch({ itsa: { home: 'b', wip: 1 } }, base, local)).toEqual({ local: { itsa: { home: 'b', wip: 1 } }, shared: {} })
    expect(splitPatch({ itsa: { home: 'a', wip: 2 } }, base, local)).toEqual({ local: {}, shared: { itsa: { home: 'a', wip: 2 } } })
    const both = { itsa: { home: 'b', wip: 2 } }
    expect(splitPatch(both, base, local)).toEqual({ local: both, shared: both })
  })
})
