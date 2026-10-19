// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearRefResolvers, refLinks, registerRefResolver } from './refs'
import { renderMail } from './mailblocks'

const html = (body: string) => { const el = document.createElement('div'); el.innerHTML = renderMail(body); return el }

describe('reference links', () => {
  beforeEach(() => {
    registerRefResolver({
      id: 'number', pattern: /(?<![\w&/#.-])#(\d{1,6})(?![\w-])/g,
      resolve: (m) => m[1] === '494' ? [{ label: 'a/b#494', hint: 'PR', url: 'https://github.com/a/b/pull/494' }]
        : m[1] === '7' ? [{ label: 'a/b#7', hint: 'PR', url: 'https://github.com/a/b/pull/7' }, { label: 'S-1 Thing', hint: 'ITSA', action: 'itsa:i1' }] : [],
    })
    registerRefResolver({ id: 'page', pattern: /\bSettings ›  ?Spending/g, resolve: () => [{ label: 'Settings › Spending', hint: 'Open', action: 'settings:spend' }] })
  })
  afterEach(clearRefResolvers)

  it('links one match plainly, in a new tab', () => {
    const a = html('See #494 now.').querySelector('a.reflink') as HTMLAnchorElement
    expect(a.textContent).toBe('#494')
    expect(a.getAttribute('href')).toBe('https://github.com/a/b/pull/494')
    expect(a.target).toBe('_blank')
  })
  it('makes several matches a picker link carrying all of them', () => {
    const a = html('Fixed in #7.').querySelector('a.reflink.multi') as HTMLElement
    expect(JSON.parse(a.dataset.refPick!).map((t: { label: string }) => t.label)).toEqual(['a/b#7', 'S-1 Thing'])
  })
  it('links an in-app page to its action', () => {
    expect((html('Open Settings › Spending.').querySelector('a.reflink') as HTMLElement).dataset.refAct).toBe('settings:spend')
  })
  it('leaves unknown numbers, code, links and headings alone', () => {
    expect(html('Issue #999 here.').querySelector('a.reflink')).toBeNull()
    expect(html('Run `git show #494`.').querySelector('a.reflink')).toBeNull()
    expect(html('[#494](https://example.com/x)').querySelectorAll('a.reflink').length).toBe(0)
    expect(html('## 494 notes\n\nurl.com/page#494').querySelector('a.reflink')).toBeNull()
  })
  it('escapes the text it links', () => {
    const el = document.createElement('div')
    el.append(document.createTextNode('x <b>#494</b> y'))
    refLinks(el)
    expect(el.querySelector('b')).toBeNull()
    expect(el.textContent).toBe('x <b>#494</b> y')
  })
})
