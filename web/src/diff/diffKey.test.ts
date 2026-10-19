import { describe, expect, it } from 'vitest'
import { diffHref, diffKey, diffTitle, parseDiffKey, parseDiffLink, parsePatchKey, patchKey } from './diffKey'
import { validKey, viewMeta } from '../views/registry'

describe('diff keys', () => {
  it('builds and parses diff:REPO#N', () => {
    expect(diffKey('stam2', 512)).toBe('diff:stam2#512')
    expect(parseDiffKey('diff:stam2#512')).toEqual({ repo: 'stam2', pr: 512 })
    expect(parseDiffKey('diff:my-repo.v2#7')).toEqual({ repo: 'my-repo.v2', pr: 7 })
  })
  it('refuses what is not a diff key', () => {
    for (const k of ['diff:', 'diff:stam2', 'diff:stam2#', 'diff:stam2#0', 'diff:stam2#x', 'diff:a/b#3', 'file:h:/x', 'diff:stam2#5#L3']) expect(parseDiffKey(k)).toBeNull()
  })
  it('the deep link is #diff=REPO:N', () => {
    expect(diffHref('stam2', 512)).toBe('#diff=stam2:512')
    expect(parseDiffLink('stam2:512')).toEqual({ repo: 'stam2', pr: 512 })
    expect(parseDiffLink('stam2')).toBeNull()
    expect(parseDiffLink('stam2:0')).toBeNull()
    expect(parseDiffLink('a%2Fb:7')).toBeNull()
    expect(parseDiffLink('a%3Ab:7')).toBeNull()
    expect(parseDiffLink('my%2Drepo:7')).toEqual({ repo: 'my-repo', pr: 7 })
  })
  it('is a valid view key titled "PR #N"', () => {
    expect(validKey('diff:stam2#512')).toBe(true)
    expect(validKey('diff:stam2')).toBe(false)
    expect(diffTitle(512)).toBe('PR #512')
    expect(viewMeta('diff:stam2#512').title).toBe('PR #512')
  })
})

describe('patch keys (S-2103)', () => {
  it('builds and parses patch:HASH', () => {
    expect(patchKey('1a2b3c4d5e6f7081')).toBe('patch:1a2b3c4d5e6f7081')
    expect(parsePatchKey('patch:1a2b3c4d5e6f7081')).toBe('1a2b3c4d5e6f7081')
  })
  it('refuses what is not a patch key', () => {
    for (const k of ['patch:', 'patch:xyz', 'patch:1A2B3C4D5E6F7081', 'patch:1a2b3c4d', 'patch:1a2b3c4d5', 'patch:1a2b3c4d5e6f7081a', 'patch:1a2b3c4d5e6f7081#2', 'diff:stam2#5']) expect(parsePatchKey(k)).toBeNull()
  })
  it('is a valid view key, titled with its hash', () => {
    expect(validKey('patch:1a2b3c4d5e6f7081')).toBe(true)
    expect(validKey('patch:nope')).toBe(false)
    expect(viewMeta('patch:1a2b3c4d5e6f7081').title).toBe('Patch 1a2b3c4d5e6f7081')
  })
})
