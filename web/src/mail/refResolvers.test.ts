// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDiffRepos } from '../diff/diffRepos'
import { setData } from '../store'
import { githubRepos, itsasForNumber, numberTargets, registerAppRefResolvers } from './refResolvers'
import { clearRefResolvers, refLinks } from './refs'

const itsa = (id: string, key: string, links: object[]) => ({ id, key, title: 'Title ' + key, links }) as never

describe('the app resolvers', () => {
  beforeEach(() => { resetDiffRepos([{ name: 'stam2', github: 'example/repo' }], true); setData({ itsas: [
    itsa('i1', 'S-1', [{ n: 1, system: 'github', external_id: '494', url: 'https://github.com/example/repo/pull/494' }]),
    itsa('i2', 'S-2', [{ n: 1, system: 'github', external_id: '12', url: 'https://github.com/other/repo/pull/12' }]),
  ] }) })

  it('names the repos the ITSA links carry, the stam repo first', () => {
    expect(githubRepos()).toEqual(['example/repo', 'other/repo'])
  })
  it('finds the ITSA that carries a PR number', () => {
    expect(itsasForNumber('494').map((i) => i.key)).toEqual(['S-1'])
    expect(itsasForNumber('12').map((i) => i.key)).toEqual(['S-2'])
  })
  it('offers the repos the matching links name and each ITSA, so several make a picker', () => {
    const t = numberTargets('494')
    expect(t.map((x) => x.label)).toEqual(['example/repo#494', 'View diff example/repo#494', 'S-1 Title S-1'])
    expect(t.at(-1)?.action).toBe('itsa:i1')
  })
  it('adds View diff for a pull request of a served repo, never for another repo (S-1918)', () => {
    expect(numberTargets('494')[1]).toMatchObject({ label: 'View diff example/repo#494', action: 'diff:stam2#494' })
    expect(numberTargets('12').map((x) => x.label)).toEqual(['other/repo#12', 'S-2 Title S-2'])
  })
  it('leaves a number no ITSA carries alone', () => {
    expect(numberTargets('999999')).toEqual([])
    expect(numberTargets('1')).toEqual([])
  })
})

describe('a number whose ITSA link names no repo', () => {
  beforeEach(() => setData({ itsas: [itsa('i3', 'S-3', [{ n: 1, system: 'github', external_id: '77', url: null }])] }))
  it('offers only the ITSA while the repos are unknown', () => {
    resetDiffRepos([], false)
    expect(numberTargets('77').map((x) => x.label)).toEqual(['S-3 Title S-3'])
  })
  it('adds the own repo once the repos are loaded', () => {
    resetDiffRepos([{ name: 'stam2', github: 'example/repo' }], true)
    expect(numberTargets('77').map((x) => x.label)).toEqual(['example/repo#77', 'S-3 Title S-3'])
  })
})

describe('the app resolvers in rendered mail', () => {
  beforeEach(() => {
    resetDiffRepos([], false)
    clearRefResolvers()
    registerAppRefResolvers()
    setData({ itsas: [itsa('i1', 'S-1', [{ n: 1, system: 'github', external_id: '494', url: 'https://github.com/example/repo/pull/494' }])] })
  })
  const render = (html: string) => { const d = document.createElement('div'); d.innerHTML = html; refLinks(d); return d }
  it('links a number an ITSA carries and nothing else', () => {
    expect(render('<p>see #494, #1 priority, #000000, step #3 and #999999</p>').querySelectorAll('a.reflink')).toHaveLength(1)
  })
  it('skips headings', () => {
    expect(render('<h2>Fixes #494</h2>').querySelector('a')).toBeNull()
  })
})
