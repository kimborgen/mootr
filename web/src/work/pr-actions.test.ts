import { describe, expect, it } from 'vitest'
import type { ItsaLink } from '../types'
import { prEntries } from './pr-actions'

const repos = [{ name: 'stam2', github: 'example/repo' }]
const gh = (n: number, url: string): ItsaLink => ({ n, system: 'github', external_id: null, url })

describe('the cell menu entries for a PR', () => {
  it('a served PR offers the diff and GitHub', () => {
    expect(prEntries([gh(1, 'https://github.com/example/repo/pull/14')], repos)).toEqual([
      { label: 'View diff', hint: 'PR #14', url: 'https://github.com/example/repo/pull/14', diff: { repo: 'stam2', pr: 14 } },
      { label: 'Open on GitHub', hint: 'PR #14', url: 'https://github.com/example/repo/pull/14' },
    ])
  })
  it('names each PR of a row, and skips issues and unserved repos', () => {
    const e = prEntries([gh(1, 'https://github.com/example/repo/pull/1'), gh(2, 'https://github.com/example/repo/issues/2'), gh(3, 'https://github.com/o/r/pull/3'), gh(4, 'https://github.com/example/repo/pull/4')], repos)
    expect(e.map((x) => `${x.label} ${x.hint}`)).toEqual(['View diff PR #1', 'Open on GitHub PR #1', 'View diff PR #4', 'Open on GitHub PR #4'])
  })
  it('offers nothing before the repos are known', () => expect(prEntries([gh(1, 'https://github.com/example/repo/pull/1')], [])).toEqual([]))
})
