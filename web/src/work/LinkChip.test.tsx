// @vitest-environment jsdom
// The Work table's PR chip (S-1533): a plain click or tap opens the diff view for a served repo; a modifier-click keeps the
// GitHub link, and any other link or repo behaves as before.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const opened = vi.hoisted(() => vi.fn())
vi.mock('../files/open', () => ({ openDiff: opened, openFile: vi.fn() }))

import { resetDiffRepos } from '../diff/diffRepos'
import type { ItsaLink } from '../types'
import { LinkChip } from './columns'
import { clearPress, markPress, PRESS_MS } from './press-flag'

const gh = (n: number, url: string): ItsaLink => ({ n, system: 'github', external_id: null, url })
let host: HTMLElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); opened.mockReset(); resetDiffRepos([{ name: 'stam2', github: 'example/repo' }], true) })
afterEach(() => { act(() => root.unmount()); host.remove(); resetDiffRepos() })

const chip = async (l: ItsaLink) => { await act(async () => { root.render(<LinkChip l={l} className="w-link-body" cell="github" />) }); return host.querySelector<HTMLAnchorElement>('a')! }
const click = (a: Element, init: MouseEventInit = {}) => { const ev = new MouseEvent('click', { bubbles: true, cancelable: true, ...init }); act(() => { a.dispatchEvent(ev) }); return ev }

describe('the Work PR chip', () => {
  it('opens the diff of a served PR on a plain click and keeps the GitHub link', async () => {
    const a = await chip(gh(1, 'https://github.com/example/repo/pull/14'))
    expect(a.href).toBe('https://github.com/example/repo/pull/14')
    expect(a.dataset.diff).toBe('stam2#14')
    expect(a.title).toContain('Ctrl-click for GitHub')
    expect(click(a).defaultPrevented).toBe(true)
    expect(opened).toHaveBeenCalledWith('stam2', 14)
  })
  it('a modifier-click is left to the browser, so GitHub opens', async () => {
    const a = await chip(gh(1, 'https://github.com/example/repo/pull/14'))
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) expect(click(a, init).defaultPrevented).toBe(false)
    expect(opened).not.toHaveBeenCalled()
  })
  it('a PR of another repo, an issue and a plain link open as before', async () => {
    for (const url of ['https://github.com/o/r/pull/3', 'https://github.com/example/repo/issues/3', 'https://linear.app/x']) {
      const a = await chip(gh(2, url))
      expect(a.dataset.diff).toBeUndefined()
      expect(click(a).defaultPrevented).toBe(false)
    }
    expect(opened).not.toHaveBeenCalled()
  })
  it('the click that ends a long-press opens nothing, once', async () => {
    const a = await chip(gh(1, 'https://github.com/example/repo/pull/14'))
    markPress()
    expect(click(a).defaultPrevented).toBe(true)
    expect(opened).not.toHaveBeenCalled()
    // The next click is an ordinary tap again.
    expect(click(a).defaultPrevented).toBe(true)
    expect(opened).toHaveBeenCalledWith('stam2', 14)
    clearPress()
  })
  it('a long-press with no lift click does not swallow a later tap', async () => {
    vi.useFakeTimers()
    try {
      const a = await chip(gh(1, 'https://github.com/example/repo/pull/14'))
      markPress()
      vi.advanceTimersByTime(PRESS_MS + 1)
      expect(click(a).defaultPrevented).toBe(true)
      expect(opened).toHaveBeenCalledWith('stam2', 14)
    } finally { vi.useRealTimers() }
  })
  it('at scale: 400 rows of chips mark the served ones, and the repos arriving later updates them all at once', async () => {
    resetDiffRepos([], true)
    const links = Array.from({ length: 400 }, (_, i) => gh(i, `https://github.com/${i % 4 === 3 ? 'o/r' : 'example/repo'}/pull/${i + 1}`))
    await act(async () => { root.render(<>{links.map((l) => <LinkChip key={l.n} l={l} className="w-link-body" cell="github" />)}</>) })
    expect(host.querySelectorAll('a[data-diff]')).toHaveLength(0)
    await act(async () => { resetDiffRepos([{ name: 'stam2', github: 'example/repo' }], true) })
    expect(host.querySelectorAll('a')).toHaveLength(400)
    expect(host.querySelectorAll('a[data-diff]')).toHaveLength(300)
  })
})
