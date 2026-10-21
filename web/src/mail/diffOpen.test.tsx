// @vitest-environment jsdom
// S-2105: the Open button in a diff block's header — what it opens, what it leaves alone, and who takes focus back.
// The real `open` module is wrapped, so the landing it takes is the real one (`files/open.test.ts` and `DiffView.test.tsx`
// test taking it); the repos are driven through the store, as they arrive in the page.
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Rendered } from './Rendered'
import { cardClick, MailBody } from './ThreadPanel'
import { infoTarget, takeOpenFocus } from './diffOpen'
import { peekDiffGoto } from '../files/open'
import { patchHash, readBase } from '../diff/patchStore'
import { resetDiffRepos } from '../diff/diffRepos'
import { patchKey } from '../diff/diffKey'
import type { DiffRepo } from '../diff/diffApi'
import type { Mail } from '../types'

const opened = vi.hoisted(() => ({ patch: vi.fn(), diff: vi.fn() }))
// The shell's own `open` needs the app's view registry, which a unit test has not built; the openers and the button are
// what this file drives.
vi.mock('../shell/layout', async (orig) => ({ ...(await orig<typeof import('../shell/layout')>()), open: vi.fn() }))
vi.mock('../files/open', async (orig) => {
  const m = await orig<typeof import('../files/open')>()
  return {
    ...m,
    openPatch: (hash: string, path?: string) => { opened.patch(hash, path); m.openPatch(hash, path) },
    openDiff: (repo: string, pr: number, path?: string) => { opened.diff(repo, pr, path); m.openDiff(repo, pr, path) },
  }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList
})

const REPO: DiffRepo = { name: 'stam2', github: 'acme/widgets', path: '/projects/stam2', sha: 'a'.repeat(40) }
// Two files, so the button has a first one to land on, and a second fence as another mail would carry.
const PATCH = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n'
const OTHER = 'diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-x\n+X\n'
const fence = (info = '') => '```diff' + (info ? ' ' + info : '') + '\n' + PATCH + '```\n'
const message = (text: string) => '```diff\n' + text + '```\n'
const BASE = { host: 'storage', cwd: '/w/stam2' }
const MAIL: Mail = { id: 'm1', from_id: 'kid', body: '', recipients: [], created_at: '1' }

let host: HTMLElement
let root: Root
let cardCalls = 0
const click = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
const buttons = () => [...host.querySelectorAll<HTMLButtonElement>('.mb-dopen button')]
const textIn = (el: Element) => el.querySelector<HTMLElement>('.mb-diff')!.dataset.patch!

// A body drawn as the mail's own view draws it (`Rendered`), and as a thread card's does (`MailBody`, S-2105 review).
async function renderBody(jsx: React.ReactNode) {
  await act(async () => { root.render(<div onClick={(e) => { cardCalls += 1; cardClick(e, [MAIL], 'thread:m1') }}>{jsx}</div>) })
}
const renderMail = (text: string) => renderBody(<Rendered text={text} base={BASE} />)
const renderThread = (text: string) => renderBody(<MailBody m={{ ...MAIL, body: text }} thread={[]} canAnswer={false} />)

beforeEach(() => {
  localStorage.clear()
  resetDiffRepos([])
  opened.patch.mockClear(); opened.diff.mockClear()
  cardCalls = 0
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })))
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals() })

describe('infoTarget', () => {
  it('reads `REPO#N` when the diff API serves that repo, and nothing otherwise', () => {
    expect(infoTarget('stam2#512', [REPO])).toEqual({ repo: 'stam2', pr: 512 })
    expect(infoTarget('nope#512', [REPO])).toBeNull()
    expect(infoTarget('stam2', [REPO])).toBeNull()
    expect(infoTarget(undefined, [REPO])).toBeNull()
    expect(infoTarget('stam2#512', [])).toBeNull()
  })
})

describe('the Open button', () => {
  it('shows at rest in a mail and in a thread body, and opens its own patch without reaching the card', async () => {
    await renderThread(fence())
    const b = buttons()
    expect(b).toHaveLength(1)
    expect(b[0].textContent).toBe('Open')
    expect(host.querySelector('.mb-dopen')?.hasAttribute('hidden')).toBe(false)
    await click(b[0])
    expect(cardCalls).toBe(0)
    expect(opened.patch).toHaveBeenCalledWith(patchHash(textIn(host)), 'src/a.ts')
    // The same block in a mail's own view (an ITSA body, stam's own view of an agent) is wired the same way.
    await renderMail(fence())
    expect(buttons()).toHaveLength(1)
  })

  it('stores the patch with the writer\'s base, lands on the first file, and takes focus back only for its own view', async () => {
    await renderMail(fence())
    await click(buttons()[0])
    const h = patchHash(textIn(host))
    expect(readBase(h)).toEqual({ host: 'storage', cwd: '/w/stam2' })
    expect(peekDiffGoto(patchKey(h))).toBe('src/a.ts')
    // A click in another pane's view leaves the button for that view's own focus handle.
    expect(takeOpenFocus(document.createElement('div'))).toBeNull()
    await click(buttons()[0])
    expect(takeOpenFocus(host)).toBe(buttons()[0])
    // Taken once: a return without an Open before it focuses the view itself.
    expect(takeOpenFocus(host)).toBeNull()
  })

  it('opens the PR its info string names instead, with the landing file, when the repo is served', async () => {
    resetDiffRepos([REPO], true)
    await renderMail(fence('stam2#512'))
    await click(buttons()[0])
    expect(opened.diff).toHaveBeenCalledWith('stam2', 512, 'src/a.ts')
    expect(opened.patch).not.toHaveBeenCalled()
  })

  it('falls back to the patch view for a repo the daemon does not serve', async () => {
    resetDiffRepos([REPO], true)
    await renderMail(fence('someone-else#7'))
    await click(buttons()[0])
    expect(opened.diff).not.toHaveBeenCalled()
    expect(opened.patch).toHaveBeenCalledWith(patchHash(textIn(host)), 'src/a.ts')
  })

  it('wires every fence in one mail, each to its own patch', async () => {
    await renderMail(message(PATCH) + '\n' + message(OTHER))
    const b = buttons()
    expect(b).toHaveLength(2)
    await click(b[1])
    const second = host.querySelectorAll<HTMLElement>('.mb-diff')[1].dataset.patch!
    expect(opened.patch).toHaveBeenCalledWith(patchHash(second), 'src/b.ts')
  })

  it('rebinds the click when the repos arrive, rather than adding another button', async () => {
    await renderMail(fence('stam2#512'))
    expect(buttons()).toHaveLength(1)
    await act(async () => { resetDiffRepos([REPO], true) })
    expect(buttons()).toHaveLength(1)
    await click(buttons()[0])
    expect(opened.diff).toHaveBeenCalledWith('stam2', 512, 'src/a.ts')
  })
})
