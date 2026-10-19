// @vitest-environment jsdom
// "View diff" on an ITSA's links (S-1533): a button for a PR link or a branch link with a known PR in a served repo, and
// nothing for any other link.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const opened = vi.hoisted(() => vi.fn())
vi.mock('../files/open', () => ({ openDiff: opened, openFile: vi.fn() }))

import type { ItsaLink } from '../types'
import { resetDiffRepos } from './diffRepos'
import { ViewDiff } from './ViewDiff'

const pr: ItsaLink = { n: 1, system: 'github', external_id: '7', url: 'https://github.com/example/repo/pull/7' }
const branch: ItsaLink = { n: 2, system: 'branch', external_id: 'stam/x', url: '', meta: { repo: 'stam2' } }
const other: ItsaLink = { n: 3, system: 'github', external_id: '9', url: 'https://github.com/o/r/pull/9' }
const issue: ItsaLink = { n: 4, system: 'github', external_id: '2', url: 'https://github.com/example/repo/issues/2' }
const links = [pr, branch, other, issue]

let host: HTMLElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); opened.mockReset() })
afterEach(() => { act(() => root.unmount()); host.remove(); resetDiffRepos() })

const show = (l: ItsaLink) => act(async () => { root.render(<ViewDiff link={l} links={links} />) })

describe('View diff on an ITSA link', () => {
  it('shows nothing before the served repos are known', async () => {
    resetDiffRepos([], false)
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    await show(pr)
    expect(host.querySelector('button')).toBeNull()
    vi.unstubAllGlobals()
  })
  it('a PR link opens its diff', async () => {
    resetDiffRepos([{ name: 'stam2', github: 'example/repo' }], true)
    await show(pr)
    const b = host.querySelector<HTMLButtonElement>('button[data-diff="stam2#7"]')!
    expect(b.textContent).toBe('View diff')
    act(() => b.click())
    expect(opened).toHaveBeenCalledWith('stam2', 7)
  })
  it('a branch link with a known PR opens that PR', async () => {
    resetDiffRepos([{ name: 'stam2', github: 'example/repo' }], true)
    await show(branch)
    act(() => host.querySelector<HTMLButtonElement>('button')!.click())
    expect(opened).toHaveBeenCalledWith('stam2', 7)
  })
  it('a PR of an unserved repo, or an issue, has no button', async () => {
    resetDiffRepos([{ name: 'stam2', github: 'example/repo' }], true)
    await show(other)
    expect(host.querySelector('button')).toBeNull()
    await show(issue)
    expect(host.querySelector('button')).toBeNull()
  })
})
