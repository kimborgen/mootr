// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fileHref } from './fileKey'
import { findPaths, fileLinkClick, linkFilePaths, resolvePath } from './pathLinks'

vi.mock('./open', () => ({ openFile: vi.fn() }))
import { openFile } from './open'

const found = (t: string) => findPaths(t).map((h) => [t.slice(h.start, h.end), h.path, h.line])

describe('findPaths', () => {
  it('finds paths with lines, absolute, relative, and known-folder paths', () => {
    expect(found('see src/daemon.ts:3613 and /home/user/projects/stam2/web/src/App.tsx:12.')).toEqual([
      ['src/daemon.ts:3613', 'src/daemon.ts', 3613],
      ['/home/user/projects/stam2/web/src/App.tsx:12', '/home/user/projects/stam2/web/src/App.tsx', 12],
    ])
    expect(found('edit web/src/files/open.ts, then ./a.css and ../b.md')).toEqual([
      ['web/src/files/open.ts', 'web/src/files/open.ts', undefined], ['./a.css', './a.css', undefined], ['../b.md', '../b.md', undefined],
    ])
    expect(found('run bin/stam-fast now')).toEqual([['bin/stam-fast', 'bin/stam-fast', undefined]])
    expect(found('(README.md:3:7)')).toEqual([['README.md:3:7', 'README.md', 3]])
  })
  it('never links URLs, domains, or words', () => {
    expect(found('https://github.com/example/repo/blob/main/src/a.ts and github.com/x/y.ts')).toEqual([])
    expect(found('Node.js, and/or, e.g. 3.5, a/b, /api/mail, ~/x.ts, v1.2')).toEqual([])
    expect(found('mailto:a@b.ts')).toEqual([])
  })
  it('never links a site: multi-dot hosts, and a bare `.sh` name without a line', () => {
    expect(found('docs.github.com/en/x.md, www.example.com/a/b.ts, bun.sh/install and bun.sh')).toEqual([])
    expect(found('see build.sh:3')).toEqual([['build.sh:3', 'build.sh', 3]])
    expect(found('notes/todo.md and web.config.ts:4')).toEqual([['notes/todo.md', 'notes/todo.md', undefined], ['web.config.ts:4', 'web.config.ts', 4]])
  })
  it('finishes on a long pathological line (no quadratic backtracking)', () => {
    expect(found('+a/'.repeat(20_000))).toEqual([])
    expect(found('a/'.repeat(20_000) + '!')).toEqual([])
  })
})

describe('resolvePath', () => {
  it('resolves against the cwd, and leaves a relative path alone without one', () => {
    expect(resolvePath('src/a.ts', { host: 'h', cwd: '/w/repo/' })).toBe('/w/repo/src/a.ts')
    expect(resolvePath('../x.md', { host: 'h', cwd: '/w/repo' })).toBe('/w/x.md')
    expect(resolvePath('src/a.ts', { host: 'h' })).toBeNull()
    expect(resolvePath('/abs/a.ts', { host: 'h' })).toBe('/abs/a.ts')
    expect(resolvePath('../../../x.ts', { host: 'h', cwd: '/a' })).toBeNull()
  })
})

describe('linkFilePaths', () => {
  const el = (html: string) => { const d = document.createElement('div'); d.innerHTML = html; return d }
  it('links paths in text and inline code, not in code blocks or links', () => {
    const d = el('<p>at src/a.ts:5 and <code>web/b.tsx</code></p><pre><code>src/c.ts</code></pre><p><a href="x">src/d.ts</a></p>')
    linkFilePaths(d, { host: 'host1', cwd: '/w/r' })
    const links = [...d.querySelectorAll<HTMLAnchorElement>('a.file-link')]
    expect(links.map((a) => [a.textContent, a.dataset.fileHost, a.dataset.filePath, a.dataset.fileLine])).toEqual([
      ['src/a.ts:5', 'host1', '/w/r/src/a.ts', '5'], ['web/b.tsx', 'host1', '/w/r/web/b.tsx', undefined],
    ])
    expect(links[0].getAttribute('href')).toBe('#file=host1:/w/r/src/a.ts#L5')
    expect(d.querySelector('pre a')).toBeNull()
    expect(d.querySelectorAll('a').length).toBe(3)
    expect(d.textContent).toBe('at src/a.ts:5 and web/b.tsxsrc/c.tssrc/d.ts')
    linkFilePaths(d, { host: 'host1', cwd: '/w/r' }) // idempotent
    expect(d.querySelectorAll('a.file-link').length).toBe(2)
  })
  it('leaves a relative path as text without a cwd, and links an absolute one', () => {
    const d = el('<p>src/a.ts and /x/y.ts</p>')
    linkFilePaths(d, { host: 'h' })
    expect([...d.querySelectorAll<HTMLElement>('a.file-link')].map((a) => a.dataset.filePath)).toEqual(['/x/y.ts'])
  })
  it('skips a text node over 20 KB', () => {
    const d = el('<p>' + 'x '.repeat(11_000) + 'src/a.ts</p>')
    linkFilePaths(d, { host: 'h', cwd: '/r' })
    expect(d.querySelector('a')).toBeNull()
  })
  it('encodes the deep link so + and & survive and the line stays', () => {
    expect(fileHref('h', '/r/a+b&c d.ts', 7)).toBe('#file=h:/r/a%2Bb%26c%20d.ts#L7')
    const d = el('<p>/r/a+b.ts:7</p>')
    linkFilePaths(d, { host: 'h' })
    expect(d.querySelector('a')!.getAttribute('href')).toBe('#file=h:/r/a%2Bb.ts#L7')
    expect(new URLSearchParams(d.querySelector('a')!.getAttribute('href')!.slice(1)).get('file')).toBe('h:/r/a+b.ts#L7')
  })
  it('a click opens the file view at the line; a modified click does not', () => {
    const d = el('<p>src/a.ts:5</p>')
    linkFilePaths(d, { host: 'h', cwd: '/r' })
    const a = d.querySelector('a')!
    const ev = { target: a, preventDefault: vi.fn(), metaKey: true }
    expect(fileLinkClick(ev)).toBe(false)
    expect(fileLinkClick({ target: a, preventDefault: vi.fn() })).toBe(true)
    expect(openFile).toHaveBeenCalledWith('h', '/r/src/a.ts', 5)
    expect(fileLinkClick({ target: d, preventDefault: vi.fn() })).toBe(false)
  })
})
