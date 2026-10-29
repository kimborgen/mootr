// @vitest-environment jsdom
// S-1531: the diff view against a mocked API: header, Meat chips and per-file overrides, the states of a file, viewed marks, and the keys.
import { EditorView } from '@codemirror/view'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DiffView, type DiffViewApi } from './DiffView'
import { openDiff, peekDiffGoto } from '../files/open'

// The shell's own `open` needs the app's view registry, which a unit test has not built; a landing reaches an open view
// through `onDiffGoto`, which is what this file drives (S-2105 review).
vi.mock('../shell/layout', async (orig) => ({ ...(await orig<typeof import('../shell/layout')>()), open: vi.fn() }))
import type { DiffSource } from './diffSource'
import { storePatch } from './patchStore'
import type { DiffFileItem } from './diffModel'
import type { DeclOptions } from '../decl/declExt'

// The editors' go-to-declaration hooks, by path and side, so a test can report a click without a layout.
const declHooks = vi.hoisted(() => new Map<string, unknown>())
vi.mock('../decl/declExt', async (orig) => {
  const m = await orig<typeof import('../decl/declExt')>()
  return { ...m, declClicks: (o: DeclOptions) => { declHooks.set(`${o.path}:${o.side}`, o); return m.declClicks(o) } }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HEAD = 'a1'.repeat(20), BASE = 'b2'.repeat(20)
const file = (path: string, extra: Partial<DiffFileItem> = {}): DiffFileItem => ({ path, status: 'modified', additions: 2, deletions: 1, binary: false, class: null, headBlob: 'h-' + path, baseBlob: 'b-' + path, ...extra })
const FILES: DiffFileItem[] = [
  file('src/a.ts'), file('src/b.ts'),
  file('src/new.ts', { status: 'added', additions: 3, deletions: 0, baseBlob: undefined }),
  file('src/new-name.ts', { status: 'renamed', oldPath: 'src/old-name.ts' }),
  file('img/logo.png', { binary: true, additions: 0, deletions: 0 }),
  file('test/a.test.ts', { class: 'tests' }), file('test/b.test.ts', { class: 'tests' }),
  file('package-lock.json', { class: 'lockfiles' }),
  file('.env', { denied: true, additions: 0, deletions: 0 }),
]
const text = (t: string) => new Response(t, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } })
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let root: Root | undefined
let calls: string[] = []
let route: (url: string) => Response = () => json(404, { error: 'no route' })
beforeEach(() => {
  localStorage.clear()
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (u: string) => { calls.push(u); return route(u) }))
  route = (u) => {
    if (u.startsWith('/api/diff?')) return json(200, { repo: 'stam2', pr: 7, head: HEAD, base: BASE, mergeBase: BASE, files: FILES })
    const q = new URL(u, 'http://x').searchParams
    if (q.get('path') === 'img/logo.png') return new Response('png', { status: 200, headers: { 'content-type': 'image/png', 'x-stam-size': '2048' } })
    return text(q.get('side') === 'base' ? 'one\ntwo\nthree\n' : 'one\nTWO\nthree\nfour\n')
  }
})
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals() })

async function mount(key = 'diff:stam2#7') {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(<DiffView viewKey={key} />))
  await vi.waitFor(() => expect(host.querySelector('.dv-note.muted[role=status]')).toBeNull())
  return host
}
const click = (el: Element | null | undefined) => { act(() => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })) }) }
const byText = (host: Element, sel: string, t: string) => [...host.querySelectorAll(sel)].find((e) => e.textContent?.includes(t))
const paths = (host: Element) => [...host.querySelectorAll('.dv-main [data-dv-file]')].map((e) => (e as HTMLElement).dataset.dvFile)

describe('the diff view', () => {
  it('shows the PR number, the short shas, and "N of M files"', async () => {
    const host = await mount()
    expect(host.querySelector('.dv-title')?.textContent).toContain('PR #7')
    expect(host.querySelector('.dv-shas')?.textContent).toBe('head a1a1a1a · base b2b2b2b')
    expect(host.querySelector('.dv-count')?.textContent).toBe('6 of 9 files')
  })

  it('hides tests and lockfiles by default and counts them on chips', async () => {
    const host = await mount()
    expect(paths(host)).toEqual(['src/a.ts', 'src/b.ts', 'src/new.ts', 'src/new-name.ts', 'img/logo.png', '.env'])
    const chips = [...host.querySelectorAll('.dv-chip')].map((e) => e.textContent)
    expect(chips).toEqual(['Tests 2 hidden', 'Lockfiles 1 hidden'])
    click(byText(host, '.dv-chip', 'Tests'))
    expect(host.querySelector('.dv-count')?.textContent).toBe('8 of 9 files')
    expect(paths(host)).toContain('test/a.test.ts')
    expect(byText(host, '.dv-chip', 'Tests')?.textContent).toBe('Tests 2')
  })

  it('Meat off shows everything, and a per-file Hide overrides the class', async () => {
    const host = await mount()
    click(host.querySelector('.dv-meat'))
    expect(host.querySelector('.dv-count')?.textContent).toBe('9 of 9 files')
    click(host.querySelector('[data-dv-file="src/a.ts"] .dv-file-actions .dv-btn:last-of-type'))
    // that button is Hide for src/a.ts
    expect(paths(host)).not.toContain('src/a.ts')
    expect(host.querySelector('.dv-count')?.textContent).toBe('8 of 9 files')
  })

  it('a hidden file in the list shows on click', async () => {
    const host = await mount()
    const row = byText(host, '.dv-li', 'a.test.ts')!
    expect(row.className).toContain('off')
    click(row)
    expect(paths(host)).toContain('test/a.test.ts')
  })

  it('fetches both sides with the shas from the list', async () => {
    const host = await mount()
    await vi.waitFor(() => expect(host.querySelector('[data-dv-file="src/a.ts"] .cm-line')).not.toBeNull())
    const a = calls.filter((u) => u.includes('path=src%2Fa.ts'))
    expect(a).toHaveLength(2)
    for (const u of a) expect(u).toContain(`head=${HEAD}&base=${BASE}`)
    expect(a.some((u) => u.includes('side=base'))).toBe(true)
    expect(a.some((u) => u.includes('side=head'))).toBe(true)
  })

  it('an added file fetches only its head; a rename reads its base at the old path', async () => {
    const host = await mount()
    await vi.waitFor(() => expect(host.querySelector('[data-dv-file="src/new-name.ts"] .cm-line')).not.toBeNull())
    const added = calls.filter((u) => u.includes('path=src%2Fnew.ts'))
    expect(added.map((u) => /side=(\w+)/.exec(u)![1])).toEqual(['head'])
    const renamed = calls.filter((u) => u.includes('side=base') && u.includes('old-name.ts'))
    expect(renamed).toHaveLength(1)
    expect(host.querySelector('[data-dv-file="src/new-name.ts"] .dv-path')?.textContent).toBe('src/old-name.ts → src/new-name.ts')
  })

  it('a binary shows its size and no diff; a denied file shows a protected row and is never fetched', async () => {
    const host = await mount()
    await vi.waitFor(() => expect(host.querySelector('[data-dv-file="img/logo.png"] .dv-row')?.textContent).toBe('binary, 2 KB'))
    expect(host.querySelector('[data-dv-file="img/logo.png"] .cm-editor')).toBeNull()
    expect(host.querySelector('[data-dv-file=".env"] .dv-row')?.textContent).toContain('hidden: protected file')
    expect(calls.some((u) => u.includes('.env'))).toBe(false)
  })

  it('a file over the cap says it is too large and offers a download', async () => {
    const base = route
    route = (u) => (u.includes('path=src%2Fb.ts') && u.includes('side=head') ? new Response('x', { status: 200, headers: { 'content-type': 'text/plain', 'x-stam-truncated': '1', 'x-stam-size': String(8 * 1024 * 1024) } }) : base(u))
    const host = await mount()
    await vi.waitFor(() => expect(host.querySelector('[data-dv-file="src/b.ts"] .dv-row')?.textContent).toContain('too large to show'))
    expect(host.querySelector('[data-dv-file="src/b.ts"] .dv-row button')?.textContent).toContain('Download file')
  })

  it('a failed file fetch offers Try again', async () => {
    const base = route
    let n = 0
    route = (u) => (u.includes('path=src%2Fa.ts') && n++ < 2 ? json(500, { error: 'git failed' }) : base(u))
    const host = await mount()
    await vi.waitFor(() => expect(host.querySelector('[data-dv-file="src/a.ts"] [role=alert]')?.textContent).toContain('git failed'))
    click(host.querySelector('[data-dv-file="src/a.ts"] [role=alert] button'))
    await vi.waitFor(() => expect(host.querySelector('[data-dv-file="src/a.ts"] .cm-line')).not.toBeNull())
  })

  it('a 404 on a side (the head left the cache) is an error with Try again, not a whole-file add or delete', async () => {
    const base = route
    let gone = true
    route = (u) => (u.includes('path=src%2Fa.ts') && u.includes('side=base') && gone ? json(404, { error: 'the head or base asked for is not in the cache for PR 7 of stam2; reload the diff' }) : base(u))
    const host = await mount()
    await vi.waitFor(() => expect(host.querySelector('[data-dv-file="src/a.ts"] [role=alert]')?.textContent).toContain('reload the diff'))
    expect(host.querySelector('[data-dv-file="src/a.ts"] .cm-editor')).toBeNull()
    gone = false
    click(host.querySelector('[data-dv-file="src/a.ts"] [role=alert] button'))
    await vi.waitFor(() => expect(host.querySelector('[data-dv-file="src/a.ts"] .cm-line')).not.toBeNull())
  })

  it('a 413 offers no download, since the whole file is refused too', async () => {
    const base = route
    route = (u) => (u.includes('path=src%2Fb.ts') && u.includes('side=head') ? json(413, { error: 'too big' }) : base(u))
    const host = await mount()
    await vi.waitFor(() => expect(host.querySelector('[data-dv-file="src/b.ts"] .dv-row')?.textContent).toContain('too large to show'))
    expect(host.querySelector('[data-dv-file="src/b.ts"] .dv-row button')).toBeNull()
  })

  it('unmarking Viewed keeps the loaded data instead of fetching both sides again', async () => {
    const host = await mount()
    await vi.waitFor(() => expect(host.querySelector('[data-dv-file="src/a.ts"] .cm-line')).not.toBeNull())
    const n = () => calls.filter((u) => u.includes('path=src%2Fa.ts')).length
    expect(n()).toBe(2)
    const box = () => host.querySelector<HTMLInputElement>('[data-dv-file="src/a.ts"] .dv-viewed input')!
    click(box())
    await vi.waitFor(() => expect(host.querySelector('[data-dv-file="src/a.ts"] .cm-editor')).toBeNull())
    click(box())
    await vi.waitFor(() => expect(host.querySelector('[data-dv-file="src/a.ts"] .cm-line')).not.toBeNull())
    expect(n()).toBe(2)
  })

  it('two views open at once keep each other\'s Viewed marks', async () => {
    const a = await mount()
    const second = document.createElement('div')
    document.body.append(second)
    const root2 = createRoot(second)
    act(() => root2.render(<DiffView viewKey="diff:stam2#7" />))
    await vi.waitFor(() => expect(second.querySelector('.dv-count')).not.toBeNull())
    click(a.querySelector('[data-dv-file="src/a.ts"] .dv-viewed input'))
    click(second.querySelector('[data-dv-file="src/b.ts"] .dv-viewed input'))
    expect(JSON.parse(localStorage.getItem('stam/diff-viewed')!).sort()).toEqual(['stam2#7:src/a.ts@h-src/a.ts', 'stam2#7:src/b.ts@h-src/b.ts'])
    act(() => root2.unmount())
  })

  it('"Expand all" shows the whole file', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`)
    route = (u) => (u.startsWith('/api/diff?') ? json(200, { repo: 'stam2', pr: 7, head: HEAD, base: BASE, mergeBase: BASE, files: [file('src/a.ts')] })
      : text((u.includes('side=base') ? lines : lines.map((l, i) => (i === 20 ? 'CHANGED' : l))).join('\n') + '\n'))
    const host = await mount()
    await vi.waitFor(() => expect(host.querySelector('.cm-collapsedLines')).not.toBeNull())
    const before = host.querySelectorAll('.cm-line').length
    click(byText(host, '.dv-btn', 'Expand all'))
    await vi.waitFor(() => expect(host.querySelectorAll('.cm-line').length).toBeGreaterThan(before))
    expect(host.querySelector('.cm-collapsedLines')).toBeNull()
  })

  it('exposes the EditorViews of a drawn file', async () => {
    const onEditor = vi.fn()
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root!.render(<DiffView viewKey="diff:stam2#7" onEditor={onEditor} />))
    await vi.waitFor(() => expect(onEditor).toHaveBeenCalled())
    const [views, path] = onEditor.mock.calls.find((c) => c[0])!
    expect(path).toMatch(/^src\//)
    expect(views.head.state.doc.length).toBeGreaterThan(0)
    expect(views.mode).toBe('split')
    expect(views.base).toBeDefined()
  })

  it('marks a file viewed, keyed by its head blob, and remembers it', async () => {
    const host = await mount()
    const box = host.querySelector<HTMLInputElement>('[data-dv-file="src/a.ts"] .dv-viewed input')!
    click(box)
    expect(JSON.parse(localStorage.getItem('stam/diff-viewed')!)).toEqual(['stam2#7:src/a.ts@h-src/a.ts'])
    expect(host.querySelector('[data-dv-file="src/a.ts"] .cm-editor')).toBeNull()
    act(() => root!.unmount())
    document.body.innerHTML = ''
    const again = await mount()
    expect(again.querySelector<HTMLInputElement>('[data-dv-file="src/a.ts"] .dv-viewed input')!.checked).toBe(true)
    expect(again.querySelector<HTMLInputElement>('[data-dv-file="src/b.ts"] .dv-viewed input')!.checked).toBe(false)
  })

  it('j/k move between files and n/p between changes', async () => {
    const host = await mount()
    const main = host.querySelector<HTMLElement>('.dv-main')!
    // Lay the files out 1000 px apart, so scrolling has somewhere to go.
    const rect = (top: number) => ({ top, bottom: top + 1000, left: 0, right: 0, width: 0, height: 1000, x: 0, y: top, toJSON() {} }) as DOMRect
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this === main) return rect(0)
      const i = paths(host).indexOf((this as HTMLElement).dataset?.dvFile ?? '\0')
      return i >= 0 ? rect(i * 1000 - main.scrollTop) : rect(0)
    })
    const press = (key: string) => act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })
    press('j'); expect(main.scrollTop).toBe(1000)
    press('j'); expect(main.scrollTop).toBe(2000)
    press('k'); expect(main.scrollTop).toBe(1000)
    for (let i = 0; i < 10; i++) press('j')
    expect(main.scrollTop).toBe(5000)
    for (let i = 0; i < 10; i++) press('k')
    expect(main.scrollTop).toBe(0)
  })

  it('a narrow pane folds Wrap and the text size into one control that shows the wrap state (S-1918)', async () => {
    const was = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 })
    try {
      const host = await mount()
      expect(host.querySelector('.codeprefs')).toBeNull()
      const b = host.querySelector<HTMLElement>('.dv-text')!
      expect(b.textContent).toBe('Aa · Wrap ○')
      click(b)
      const pop = host.querySelector('.dv-text-pop')!
      expect(byText(pop, 'button', 'Wrap')).toBeTruthy()
      expect(pop.querySelector('[aria-label="Larger text"]')).toBeTruthy()
      click(byText(pop, 'button', 'Wrap'))
      expect(host.querySelector('.dv-text')?.textContent).toBe('Aa · Wrap ●')
      click(byText(pop, 'button', 'Close'))
      expect(host.querySelector('.dv-text-pop')).toBeNull()
    } finally { Object.defineProperty(window, 'innerWidth', { configurable: true, value: was }) }
  })

  it('with two views open, j/k move only the one last pointed at (S-1918)', async () => {
    const one = await mount()
    const rootOne = root!
    const hostTwo = document.createElement('div')
    document.body.append(hostTwo)
    const rootTwo = createRoot(hostTwo)
    act(() => rootTwo.render(<DiffView viewKey="diff:stam2#7" />))
    await vi.waitFor(() => expect(hostTwo.querySelector('.dv-file')).not.toBeNull())
    const mains = [one.querySelector<HTMLElement>('.dv-main')!, hostTwo.querySelector<HTMLElement>('.dv-main')!]
    const rect = (top: number) => ({ top, bottom: top + 1000, left: 0, right: 0, width: 0, height: 1000, x: 0, y: top, toJSON() {} }) as DOMRect
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const m = mains.find((x) => x === this || x.contains(this))
      if (!m || m === this) return rect(0)
      const i = [...m.querySelectorAll('[data-dv-file]')].indexOf(this as Element)
      return i >= 0 ? rect(i * 1000 - m.scrollTop) : rect(0)
    })
    const press = () => act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true })) })
    act(() => { hostTwo.querySelector('.dv-main')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    press()
    expect([mains[0].scrollTop, mains[1].scrollTop]).toEqual([0, 1000])
    act(() => { mains[0].dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    press()
    expect([mains[0].scrollTop, mains[1].scrollTop]).toEqual([1000, 1000])
    act(() => rootTwo.unmount())
    act(() => rootOne.unmount())
  })

  it('ignores keys typed into a field', async () => {
    const host = await mount()
    const main = host.querySelector<HTMLElement>('.dv-main')!
    const input = document.createElement('input')
    host.append(input)
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true })) })
    expect(main.scrollTop).toBe(0)
  })
})

describe('the states', () => {
  it('shows loading while the list is fetched', async () => {
    route = () => new Response(new ReadableStream())
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root!.render(<DiffView viewKey="diff:stam2#7" />))
    expect(host.querySelector('[role=status]')?.textContent).toContain('Loading')
  })

  it('says so for an empty list', async () => {
    route = () => json(200, { repo: 'stam2', pr: 7, head: HEAD, base: BASE, mergeBase: BASE, files: [] })
    const host = await mount()
    expect(host.textContent).toContain('No files changed in this PR.')
    expect(host.querySelector('.dv-count')?.textContent).toBe('0 of 0 files')
  })

  it.each([
    [404, 'unknown repo nope: it is not in settings.itsa.repos', 'unknown repo nope'],
    [404, 'no PR 7 in stam2', 'no PR 7'],
    [502, 'fetching failed: auth', 'Fetching the PR failed'],
    [504, 'timed out', 'timed out'],
  ])('shows a %i from the list as an error with Try again', async (status, error, shown) => {
    route = () => json(status, { error })
    const host = await mount()
    expect(host.querySelector('[role=alert]')?.textContent).toContain(shown)
    route = () => json(200, { repo: 'stam2', pr: 7, head: HEAD, base: BASE, mergeBase: BASE, files: [] })
    click(host.querySelector('[role=alert] button'))
    await vi.waitFor(() => expect(host.textContent).toContain('No files changed'))
  })

  it('a key that is not a diff says so', async () => {
    const host = await mount('diff:nope')
    expect(host.textContent).toContain('Not a diff link.')
  })
})

describe('go to declaration', () => {
  const MATCH = (path: string, line: number) => ({ path, line, col: 1, kind: 'function', text: `function f${line}() {}` })
  const ready = (matches: ReturnType<typeof MATCH>[]) => json(200, { state: 'ready', repo: 'stam2', sha: HEAD, name: 'f', matches, total: matches.length, root: { host: 'box', path: '/p/stam2' } })
  let decl: (u: URL) => Response = () => ready([])
  beforeEach(() => {
    declHooks.clear()
    const base = route
    route = (u) => (u.startsWith('/api/decl?') ? decl(new URL(u, 'http://x')) : base(u))
  })
  const hook = async (path: string, side = 'head') => {
    await vi.waitFor(() => expect(declHooks.get(`${path}:${side}`)).toBeTruthy())
    return declHooks.get(`${path}:${side}`) as DeclOptions
  }
  const tap = (o: DeclOptions, name: string, side: 'head' | 'base' = 'head', local: () => ReturnType<typeof MATCH>[] = () => []) => act(() => o.onDecl({ name, side, x: 5, y: 10, top: 2, local }))
  const flashed = (host: Element, path: string) => host.querySelector(`[data-dv-file="${path}"] .cm-decl-flash`)

  async function mountApi() {
    let api: DiffViewApi | null = null
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root!.render(<DiffView viewKey="diff:stam2#7" apiRef={(a) => { api = a }} />))
    await vi.waitFor(() => expect(host.querySelector('.dv-note.muted[role=status]')).toBeNull())
    return { host, api: () => api! }
  }

  it('goTo shows a hidden file, opens a viewed one, and marks the line once the editor draws', async () => {
    const { host, api } = await mountApi()
    expect(paths(host)).not.toContain('test/a.test.ts')
    expect(api().goTo('nope.ts', 1)).toBe(false)
    expect(api().goTo('.env', 1)).toBe(false)
    act(() => { expect(api().goTo('test/a.test.ts', 2)).toBe(true) })
    expect(paths(host)).toContain('test/a.test.ts')
    await vi.waitFor(() => expect(flashed(host, 'test/a.test.ts')?.textContent).toBe('TWO'))
    // A file marked viewed is closed; a jump opens it without unmarking it.
    const viewed = host.querySelector('[data-dv-file="src/b.ts"] .dv-viewed input') as HTMLInputElement
    act(() => { viewed.click() })
    await vi.waitFor(() => expect(host.querySelector('[data-dv-file="src/b.ts"] .cm-editor')).toBeNull())
    act(() => { api().goTo('src/b.ts', 4) })
    await vi.waitFor(() => expect(flashed(host, 'src/b.ts')?.textContent).toBe('four'))
    expect((host.querySelector('[data-dv-file="src/b.ts"] .dv-viewed input') as HTMLInputElement).checked).toBe(true)
  })

  it('lands on the file a mail block\'s Open names, on a fresh mount and in place when its tab is already open (S-2105 review)', async () => {
    // Set before the view exists: a mount takes it.
    act(() => { openDiff('stam2', 7, 'src/b.ts') })
    const { host } = await mountApi()
    await vi.waitFor(() => expect(flashed(host, 'src/b.ts')?.textContent).toBe('one'))
    expect(peekDiffGoto('diff:stam2#7')).toBeNull()
    // The same tab, opened again from another mail: shell.open only brings it forward, so the view is told and jumps
    // to a file it was hiding.
    expect(paths(host)).not.toContain('test/a.test.ts')
    act(() => { openDiff('stam2', 7, 'test/a.test.ts') })
    await vi.waitFor(() => expect(flashed(host, 'test/a.test.ts')?.textContent).toBe('one'))
    // Handled: nothing is left to jump this view later, on a retry.
    expect(peekDiffGoto('diff:stam2#7')).toBeNull()
  })

  it('one match in a file of the PR jumps there, asking at the head with the file as from', async () => {
    decl = () => ready([MATCH('src/b.ts', 3)])
    const host = await mount()
    tap(await hook('src/a.ts'), 'f')
    await vi.waitFor(() => expect(flashed(host, 'src/b.ts')?.textContent).toBe('three'))
    expect(host.querySelector('.decl-pick')).toBeNull()
    const q = new URL(calls.find((u) => u.startsWith('/api/decl?'))!, 'http://x').searchParams
    expect(Object.fromEntries(q)).toEqual({ repo: 'stam2', sha: HEAD, name: 'f', from: 'src/a.ts' })
  })

  it("several matches show the picker; a row outside the PR shows that declaration's lines and Open file", async () => {
    decl = () => ready([MATCH('src/b.ts', 2), MATCH('lib/far.ts', 2)])
    const base = route
    route = (u) => (u.includes('path=lib%2Ffar.ts') ? text('// far\nfunction f2() {}\n  body\n') : base(u))
    const host = await mount()
    tap(await hook('src/a.ts'), 'f')
    await vi.waitFor(() => expect(document.querySelectorAll('.decl-row')).toHaveLength(2))
    expect(document.querySelector('.decl-pop')).not.toBeNull()
    act(() => { (byText(document.body, '.decl-row', 'lib/far.ts') as HTMLElement).click() })
    await vi.waitFor(() => expect(document.querySelector('.decl-line.cur')?.textContent).toBe('2function f2() {}\n'))
    expect(byText(document.body, '.decl-btn', 'Open file')).toBeTruthy()
    expect(calls.some((u) => u.startsWith('/api/diff/file?') && u.includes('path=lib%2Ffar.ts') && u.includes('side=head'))).toBe(true)
    // A row in the PR jumps.
    decl = () => ready([MATCH('src/b.ts', 2), MATCH('lib/far.ts', 2)])
    tap(await hook('src/a.ts'), 'f')
    await vi.waitFor(() => expect(document.querySelectorAll('.decl-row')).toHaveLength(2))
    act(() => { (byText(document.body, '.decl-row', 'src/b.ts') as HTMLElement).click() })
    await vi.waitFor(() => expect(flashed(host, 'src/b.ts')?.textContent).toBe('TWO'))
    expect(document.querySelector('.decl-pick')).toBeNull()
  })

  it('no match is a quiet note; an empty index still has the file\'s own tree', async () => {
    decl = () => ready([])
    const host = await mount()
    const o = await hook('src/a.ts')
    tap(o, 'zzz')
    await vi.waitFor(() => expect(document.querySelector('.decl-pick[data-state=none]')?.textContent).toContain('No declaration of zzz found.'))
    tap(o, 'f', 'head', () => [MATCH('src/a.ts', 3)])
    await vi.waitFor(() => expect(flashed(host, 'src/a.ts')?.textContent).toBe('three'))
  })

  it('a deleted line asks at the merge base, with the old path of a rename', async () => {
    decl = () => ready([MATCH('src/old-name.ts', 1)])
    const host = await mount()
    tap(await hook('src/new-name.ts'), 'f', 'base')
    await vi.waitFor(() => expect(flashed(host, 'src/new-name.ts')).not.toBeNull())
    const q = new URL(calls.find((u) => u.startsWith('/api/decl?'))!, 'http://x').searchParams
    expect(q.get('sha')).toBe(BASE)
    expect(q.get('from')).toBe('src/old-name.ts')
  })

  it('an error says what went wrong', async () => {
    decl = () => json(404, { error: 'commit a1a1a1a1a1a1 is not in stam2; open the diff again' })
    await mount()
    tap(await hook('src/a.ts'), 'f')
    await vi.waitFor(() => expect(document.querySelector('.decl-pick [role=alert]')?.textContent).toContain('open the diff again'))
  })

  // S-2103: a source that cannot look a name up (a patch file the checkout could not resolve) says so quietly, with no
  // request at all. The stub still offers fetched sides, so the file draws and its identifier hooks exist.
  it('a source with no declaration lookup answers quietly and asks nothing', async () => {
    const stub: DiffSource = {
      title: 'Patch deadbeefdeadbeef', provenance: 'patch', scope: 'patch:deadbeefdeadbeef', twoSided: () => true,
      loadList: async () => ({ files: FILES, shas: { head: HEAD, base: BASE, mergeBase: BASE }, review: null, empty: 'This patch has no files.' }),
      loadFile: () => Promise.resolve({ s: 'text', base: 'one\ntwo\nthree\n', head: 'one\nTWO\nthree\nfour\n' }),
      loadSide: () => Promise.resolve({ kind: 'missing' }),
      declQuery: () => null,
    }
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root!.render(<DiffView viewKey="patch:deadbeefdeadbeef" source={stub} />))
    await vi.waitFor(() => expect(host.querySelector('.dv-count')?.textContent).toBe('6 of 9 files'))
    tap(await hook('src/a.ts'), 'f')
    await vi.waitFor(() => expect(document.querySelector('.decl-pick[data-state=none]')?.textContent).toContain('No declaration of f found.'))
    expect(calls.some((u) => u.startsWith('/api/decl?'))).toBe(false)
  })

  // S-1820: .dv-main scrolls, so the draw-ahead observer takes it as its root and its 800 px margin is not clipped.
  it('observes files from the .dv-main scroll container', async () => {
    const opts: IntersectionObserverInit[] = []
    vi.stubGlobal('IntersectionObserver', class { constructor(_cb: unknown, o: IntersectionObserverInit) { opts.push(o) } observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } })
    const host = await mount()
    const main = host.querySelector<HTMLElement>('.dv-main')!
    // The observer is made in an effect after the list draws, so mount() returning does not mean it exists yet.
    await vi.waitFor(() => {
      expect(opts.length).toBeGreaterThan(0)
      for (const o of opts) {
        expect(o.root).toBe(main)
        expect(o.rootMargin).toBe('800px 0px')
      }
    })
  })
})

describe('the review verdict chip (S-1917)', () => {
  const review = (extra: object = {}) => ({ verdict: 'approve', by: 'rev-1', summary: 'Looks <b>good</b>', at: '2026-10-19T10:00:00Z', head: HEAD, stale: false, ...extra })
  const withReview = (r: unknown) => {
    const base = route
    route = (u) => (u.startsWith('/api/diff?') ? json(200, { repo: 'stam2', pr: 7, head: HEAD, base: BASE, mergeBase: BASE, files: FILES, ...(r === undefined ? {} : { review: r }) }) : base(u))
  }
  const chip = (host: Element) => host.querySelector<HTMLElement>('.dv-review')!

  it('approve on the shown head: success look, reviewer, summary as text in the title', async () => {
    withReview(review())
    const c = chip(await mount())
    expect(c.dataset.tone).toBe('ok')
    expect(c.textContent).toContain('approved')
    expect(c.textContent).toContain('rev-1')
    expect(c.title).toContain('Looks <b>good</b>')
  })
  it('changes requested: the error look', async () => {
    withReview(review({ verdict: 'changes' }))
    const c = chip(await mount())
    expect(c.dataset.tone).toBe('bad')
    expect(c.textContent).toContain('changes requested')
  })
  it('a verdict on another head is muted and says so, never the success look', async () => {
    withReview(review({ stale: true, head: 'c3'.repeat(20) }))
    const c = chip(await mount())
    expect(c.dataset.tone).toBe('none')
    expect(c.textContent).toContain('another head')
    expect(c.title).toContain('another head')
  })
  it('carries a short label for a narrow pane, with the full text in the title', async () => {
    withReview(review({ verdict: 'changes', stale: true, head: 'c3'.repeat(20) }))
    const c = chip(await mount())
    expect(c.querySelector('.dv-review-long')?.textContent).toBe('changes requested · another head')
    expect(c.querySelector('.dv-review-short')?.textContent).toBe('changes · other head')
    expect(c.title).toContain('Changes requested')
    // Whichever label shows, the accessible name carries the verdict, the reviewer and the stale head.
    expect(c.getAttribute('aria-label')).toBe(c.title)
    expect(c.getAttribute('aria-label')).toMatch(/Changes requested by rev-1 on another head/)
  })
  it('no review, or a list without the field: a muted "no review"', async () => {
    withReview(null)
    expect(chip(await mount()).textContent).toContain('no review')
    act(() => root?.unmount())
    withReview(undefined)
    const c = chip(await mount())
    expect(c.dataset.tone).toBe('none')
    expect(c.textContent).toContain('no review')
  })
  it('a tap opens the summary as text, and Close shuts it', async () => {
    withReview(review())
    const host = await mount()
    click(chip(host))
    const pop = host.querySelector('.dv-review-pop')!
    expect(pop.textContent).toContain('Looks <b>good</b>')
    expect(pop.querySelector('b')).toBeNull()
    click(byText(pop, 'button', 'Close'))
    expect(host.querySelector('.dv-review-pop')).toBeNull()
  })
})

describe('the patch view (S-2103)', () => {
  // One file's hunks: a context row, a two-for-one change, and no second side anywhere.
  const PATCH = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n one\n-two\n+TWO\n+three\n'

  it('draws a patch:HASH tab from its own hunks, with no diff request and no PR chrome', async () => {
    localStorage.clear()
    const h = storePatch(PATCH)!
    const host = await mount(`patch:${h}`)
    expect(host.querySelector('.dv-title strong')?.textContent).toBe(`Patch ${h}`)
    expect(host.querySelector('.dv-repo')?.textContent).toBe('patch')
    expect(host.querySelector('.dv-shas')).toBeNull()
    expect(host.querySelector('.dv-review')).toBeNull()
    expect(host.querySelector('.dv-count')?.textContent).toBe('1 of 1 files')
    // No file has two sides yet, so there is no Split to offer (S-2104 review).
    expect(host.querySelector('.dv-mode')).toBeNull()
    await vi.waitFor(() => expect(host.querySelector('[data-dv-file="src/a.ts"] .cm-line')).not.toBeNull())
    expect(host.querySelectorAll('[data-dv-file="src/a.ts"] .cm-line')).toHaveLength(5)
    expect(paths(host)).toEqual(['src/a.ts'])
    // A patch tab asks the diff API nothing; it reads its files from checkouts (S-2104), and the repos answer says which.
    expect(calls).toEqual(['/api/diff/repos'])
  })

  // S-2104: a file the writer's checkout holds is matched, drawn with both sides, and labelled with where it came from.
  it('matches a file against the writer\'s checkout and says where it came from', async () => {
    localStorage.clear()
    const h = storePatch(PATCH, { host: 'storage', cwd: '/w/stam2-x' })!
    route = (u) => (u.startsWith('/api/files/read') ? text('one\nTWO\nthree\n') : json(404, { error: 'no route' }))
    const host = await mount(`patch:${h}`)
    await vi.waitFor(() => expect(host.querySelector('[data-dv-file="src/a.ts"] .cm-line')).not.toBeNull())
    const row = host.querySelector('[data-dv-file="src/a.ts"]')!
    expect(row.querySelector('.dv-row.muted')?.textContent).toBe('Live checkout · storage:/w/stam2-x')
    // This file has two sides, so the tab offers Split on a wide pane.
    expect(host.querySelector('.dv-mode')).not.toBeNull()
    // Both sides of the patch, drawn from one file: the file itself, and the file reverse-applied. Never the hunk doc.
    expect(row.textContent).toContain('TWO')
    expect(row.textContent).toContain('two')
    expect(row.textContent).not.toContain('@@')
    expect(new URL(calls.find((u) => u.startsWith('/api/files/read'))!, 'http://x').searchParams.get('path')).toBe('/w/stam2-x/src/a.ts')
  })

  it('keeps the hunk-only view and says so when nothing matched', async () => {
    localStorage.clear()
    const h = storePatch(PATCH, { host: 'storage', cwd: '/w/stam2-x' })!
    route = (u) => (u.startsWith('/api/files/read') ? text('not this file at all\n') : json(404, { error: 'no route' }))
    const host = await mount(`patch:${h}`)
    await vi.waitFor(() => expect(host.querySelector('[data-dv-file="src/a.ts"] .cm-line')).not.toBeNull())
    const row = host.querySelector('[data-dv-file="src/a.ts"]')!
    expect(row.querySelector('.dv-row.muted')?.textContent).toBe('Declarations unavailable · file changed or not found')
    expect(row.textContent).toContain('@@ -1,2 +1,3 @@')
  })

  it('an entry that is gone says to open it again from its mail', async () => {
    localStorage.clear()
    const host = await mount('patch:deadbeefdeadbeef')
    expect(host.textContent).toContain('Open it again from its mail.')
    expect(host.querySelector('.dv-count')?.textContent).toBe('0 of 0 files')
    expect(calls).toEqual([])
  })

  // A patch is text from a mail: a line that looks like HTML must render as the characters it is, never as markup.
  it('HTML-looking patch lines render as text', async () => {
    localStorage.clear()
    const html = '<img src=x onerror="alert(1)"> & <b>bold</b>'
    const h = storePatch(`diff --git a/x.html b/x.html\n--- a/x.html\n+++ b/x.html\n@@ -1 +1,2 @@\n-plain\n+${html}\n`)!
    const host = await mount(`patch:${h}`)
    await vi.waitFor(() => expect(host.querySelector('[data-dv-file="x.html"] .cm-line')).not.toBeNull())
    expect(host.querySelector('[data-dv-file="x.html"] img, [data-dv-file="x.html"] b')).toBeNull()
    expect(host.textContent).toContain(html)
    expect(calls).toEqual(['/api/diff/repos'])
  })

  // A realistic pasted patch: 20 files and about 2,000 lines, as a review-size fence arrives.
  it('draws a realistic patch: 20 files, 2,000 lines', async () => {
    localStorage.clear()
    const big = Array.from({ length: 20 }, (_, f) => {
      const path = `src/mod${String(f).padStart(2, '0')}.ts`
      const rows = Array.from({ length: 100 }, (_, i) => (i === 50 ? `-export const v${f} = ${i}` : i === 51 ? `+export const v${f} = ${i + 1}` : ` // line ${i} of ${path}`))
      return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,100 +1,100 @@\n${rows.join('\n')}`
    }).join('\n')
    const h = storePatch(big)!
    const host = await mount(`patch:${h}`)
    expect(host.querySelector('.dv-count')?.textContent).toBe('20 of 20 files')
    expect(paths(host)).toHaveLength(20)
    await vi.waitFor(() => expect(host.querySelector('[data-dv-file="src/mod00.ts"] .cm-line')).not.toBeNull())
    // The painted lines are virtualised, so read the document: the hunk header and its 100 rows.
    const view = EditorView.findFromDOM(host.querySelector<HTMLElement>('[data-dv-file="src/mod00.ts"] .cm-editor')!)
    expect(view?.state.doc.lines).toBe(101)
    expect(view?.state.doc.line(2).text).toBe(' // line 0 of src/mod00.ts')
    expect(calls).toEqual(['/api/diff/repos'])
  })
})
