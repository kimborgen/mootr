// @vitest-environment jsdom
// S-1531: the diff view against a mocked API: header, Meat chips and per-file overrides, the states of a file, viewed marks, and the keys.
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DiffView, type DiffViewApi } from './DiffView'
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

  // S-1820: .dv-main scrolls, so the draw-ahead observer takes it as its root and its 800 px margin is not clipped.
  it('observes files from the .dv-main scroll container', async () => {
    const opts: IntersectionObserverInit[] = []
    vi.stubGlobal('IntersectionObserver', class { constructor(_cb: unknown, o: IntersectionObserverInit) { opts.push(o) } observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } })
    const host = await mount()
    const main = host.querySelector<HTMLElement>('.dv-main')!
    expect(opts.length).toBeGreaterThan(0)
    for (const o of opts) {
      expect(o.root).toBe(main)
      expect(o.rootMargin).toBe('800px 0px')
    }
  })
})
