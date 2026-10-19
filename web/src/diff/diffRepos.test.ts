import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ItsaLink } from '../types'
import { currentDiffRepos, linkTargets, loadDiffRepos, prUrlTarget, resetDiffRepos, targetOf, type DiffRepo } from './diffRepos'

const repos: DiffRepo[] = [{ name: 'stam2', github: 'example/repo' }, { name: 'local', github: null }]
const link = (n: number, system: string, url: string, extra: Partial<ItsaLink> = {}): ItsaLink => ({ n, system, external_id: null, url, ...extra })
const pr7 = link(1, 'github', 'https://github.com/example/repo/pull/7')
const branch = link(2, 'branch', '', { external_id: 'stam/x', meta: { repo: 'stam2' } })

describe('PR URLs the diff view can open', () => {
  it.each([
    ['https://github.com/example/repo/pull/7', { repo: 'stam2', pr: 7 }],
    ['https://github.com/example/repo/pull/7/files', { repo: 'stam2', pr: 7 }],
    ['https://github.com/example/repo/pull/7#issuecomment-1', { repo: 'stam2', pr: 7 }],
    ['https://www.github.com/Example/Repo/pull/12?x=1', { repo: 'stam2', pr: 12 }],
  ])('%s', (url, ref) => expect(prUrlTarget(repos, url)).toEqual(ref))
  it.each([
    ['a PR of a repo the API does not serve', 'https://github.com/other/thing/pull/7'],
    ['an issue', 'https://github.com/example/repo/issues/7'],
    ['another host', 'https://gitlab.com/example/repo/pull/7'],
    ['a repo-only URL', 'https://github.com/example/repo'],
    ['PR 0', 'https://github.com/example/repo/pull/0'],
    ['a longer number path', 'https://github.com/example/repo/pull/7x'],
    ['http', 'http://github.com/example/repo/pull/7'],
  ])('is no diff: %s', (_n, url) => expect(prUrlTarget(repos, url)).toBeNull())
  it('serves nothing before the repos are known', () => expect(prUrlTarget([], pr7.url)).toBeNull())
})

describe('an ITSA\'s links that open a diff', () => {
  it('a PR link opens its own PR, and a branch link borrows the ITSA\'s PR in its repo', () => {
    expect(linkTargets([branch, pr7], repos).map((t) => [t.link.n, t.ref])).toEqual([[2, { repo: 'stam2', pr: 7 }], [1, { repo: 'stam2', pr: 7 }]])
    expect(targetOf(branch, [branch, pr7], repos)).toEqual({ repo: 'stam2', pr: 7 })
  })
  it('a branch with no PR, or with two, or in another repo has no diff', () => {
    expect(targetOf(branch, [branch], repos)).toBeNull()
    const pr8 = link(3, 'github', 'https://github.com/example/repo/pull/8')
    expect(targetOf(branch, [branch, pr7, pr8], repos)).toBeNull()
    expect(targetOf({ ...branch, meta: { repo: 'local' } }, [{ ...branch, meta: { repo: 'local' } }, pr7], repos)).toBeNull()
  })
  it('a PR of an unserved repo gets no action', () => {
    const other = link(4, 'github', 'https://github.com/other/thing/pull/3')
    expect(linkTargets([other], repos)).toEqual([])
    expect(targetOf(other, [other], repos)).toBeNull()
  })
  it('a plain URL link or a missing link list gets none', () => {
    expect(linkTargets([link(5, 'url', 'https://example.com')], repos)).toEqual([])
    expect(linkTargets(undefined, repos)).toEqual([])
  })
})

describe('the repos store', () => {
  afterEach(() => { vi.unstubAllGlobals(); resetDiffRepos() })
  it('fetches once and keeps the answer; a failure is retried only after a pause', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ repos }), { status: 200 }))
    vi.stubGlobal('fetch', f)
    loadDiffRepos(); loadDiffRepos()
    await vi.waitFor(() => expect(currentDiffRepos()).toEqual(repos))
    loadDiffRepos()
    expect(f).toHaveBeenCalledTimes(1)
    expect(f.mock.calls[0]).toEqual(['/api/diff/repos', expect.objectContaining({ headers: expect.objectContaining({ 'x-stam-human': '1' }) })])
    resetDiffRepos()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    loadDiffRepos()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    await Promise.resolve(); await Promise.resolve()
    loadDiffRepos()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(currentDiffRepos()).toEqual([])
  })
})
