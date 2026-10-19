// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const opened = vi.hoisted(() => vi.fn())
vi.mock('../files/open', () => ({ openDiff: opened, openFile: vi.fn() }))

import { linkPrUrls, prLinkClick } from './prLinks'

const repos = [{ name: 'stam2', github: 'example/repo' }]
const PR = 'https://github.com/example/repo/pull/7'
const make = (html: string) => { const el = document.createElement('div'); el.innerHTML = html; document.body.append(el); return el }
beforeEach(() => { opened.mockReset(); document.body.innerHTML = '' })

describe('PR URLs in mail', () => {
  it('marks a served PR link and adds GitHub beside it', () => {
    const el = make(`<p>See <a href="${PR}">${PR}</a>.</p>`)
    linkPrUrls(el, repos)
    const a = el.querySelector<HTMLAnchorElement>('a.pr-link')!
    expect(a.dataset.prRepo).toBe('stam2')
    expect(a.dataset.prNumber).toBe('7')
    const gh = el.querySelector<HTMLAnchorElement>('a.pr-gh')!
    expect(gh.href).toBe(PR)
    expect(gh.target).toBe('_blank')
    expect(gh.getAttribute('rel')).toContain('noopener')
  })
  it('is idempotent', () => {
    const el = make(`<a href="${PR}">x</a>`)
    linkPrUrls(el, repos); linkPrUrls(el, repos)
    expect(el.querySelectorAll('a.pr-gh')).toHaveLength(1)
  })
  it('leaves other repos, other links, code spans and links around code alone', () => {
    const el = make(`<a href="https://github.com/o/r/pull/7">other</a> <a href="https://example.com">e</a> <code><a href="${PR}">c</a></code> <a href="${PR}"><code>#7</code></a> <pre><a href="${PR}">p</a></pre>`)
    linkPrUrls(el, repos)
    expect(el.querySelector('.pr-link')).toBeNull()
    expect(el.querySelector('.pr-gh')).toBeNull()
  })
  it('does nothing until the repos are known', () => {
    const el = make(`<a href="${PR}">x</a>`)
    linkPrUrls(el, [])
    expect(el.querySelector('.pr-link')).toBeNull()
  })
  it('a plain click opens the diff; a modifier or other button leaves the link to the browser', () => {
    const el = make(`<a href="${PR}">x</a>`)
    linkPrUrls(el, repos)
    const a = el.querySelector('a.pr-link')!
    const click = (init: MouseEventInit) => { const ev = new MouseEvent('click', { bubbles: true, cancelable: true, ...init }); const handled = prLinkClick({ ...ev, target: a, preventDefault: () => ev.preventDefault(), metaKey: ev.metaKey, ctrlKey: ev.ctrlKey, shiftKey: ev.shiftKey, altKey: ev.altKey, button: ev.button }); return { handled, prevented: ev.defaultPrevented } }
    expect(click({})).toEqual({ handled: true, prevented: true })
    expect(opened).toHaveBeenCalledWith('stam2', 7)
    opened.mockReset()
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }]) expect(click(init)).toEqual({ handled: false, prevented: false })
    expect(opened).not.toHaveBeenCalled()
    const gh = el.querySelector('a.pr-gh')!
    expect(prLinkClick({ target: gh, preventDefault() {} })).toBe(false)
  })
})
