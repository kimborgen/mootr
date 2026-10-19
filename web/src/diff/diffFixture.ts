// Fixtures for the diff view's stories (S-1531): a PR as the API would list it, with each file's two sides, as stub routes.
// Paths and shas are invented.
import { diffFileUrl, diffListUrl } from './diffApi'
import type { DiffFileItem } from './diffModel'
import { raw } from '../stories/types'

export const HEAD = '5a1c0de5a1c0de5a1c0de5a1c0de5a1c0de5a1c0'
export const BASE = 'ba5e0f1ba5e0f1ba5e0f1ba5e0f1ba5e0f1ba5e0'
export const REPO = 'fixture-repo'
export const PR = 512
const refs = { repo: REPO, pr: PR, head: HEAD, base: BASE }

export interface FixtureFile { file: Partial<DiffFileItem> & { path: string }; base?: string; head?: string; headType?: string; headHeaders?: Record<string, string> }

// A TypeScript-looking file of n lines.
export const codeLines = (n: number, tag = 'a'): string[] =>
  Array.from({ length: n }, (_, i) => (i % 40 === 0 ? `// section ${i / 40 + 1} of ${tag}` : i % 40 === 1 ? `export function ${tag}${i}(value: number): number {` : i % 40 === 2 ? `  return value * ${i} + ${tag.length}` : i % 40 === 3 ? '}' : `const ${tag}Const${i} = { id: ${i}, name: '${tag}-${i}' }`))

// The same lines with every `every`th line changed, plus a few added after the first.
export const edited = (lines: string[], every: number, extra = 0): string[] => {
  const out = lines.map((l, i) => (i % every === every - 1 ? l.replace(/\d+/, (m) => String(Number(m) + 1)) + ' // edited' : l))
  out.splice(1, 0, ...Array.from({ length: extra }, (_, i) => `// added line ${i + 1}`))
  return out
}

const item = (f: FixtureFile): DiffFileItem => {
  const b = f.base ?? '', h = f.head ?? ''
  const status = f.file.status ?? (f.base === undefined ? 'added' : f.head === undefined ? 'deleted' : 'modified')
  const bl = b ? b.split('\n') : [], hl = h ? h.split('\n') : []
  const del = bl.filter((l) => !hl.includes(l)).length
  const add = hl.filter((l) => !bl.includes(l)).length
  return { status, additions: add, deletions: del, binary: false, class: null, headBlob: f.head === undefined ? undefined : `h${f.file.path}`, baseBlob: f.base === undefined ? undefined : `b${f.file.path}`, ...f.file } as DiffFileItem
}

// The routes of a PR: its list and each file's sides, keyed as the stories stub wants them (the exact request).
export function diffRoutes(files: FixtureFile[]): Record<string, unknown> {
  const routes: Record<string, unknown> = {}
  routes[`GET ${diffListUrl(REPO, PR)}`] = { repo: REPO, pr: PR, head: HEAD, base: BASE, mergeBase: BASE, files: files.map(item) }
  for (const f of files) {
    const it = item(f)
    if (it.denied) continue
    if (f.base !== undefined) routes[`GET ${diffFileUrl(refs, it.oldPath ?? it.path, 'base')}`] = raw(f.base)
    if (f.head !== undefined) routes[`GET ${diffFileUrl(refs, it.path, 'head')}`] = raw(f.head, f.headType, f.headHeaders)
  }
  return routes
}

// A small PR with a rename, an added and a deleted file, a binary, a protected file and the classes Meat hides.
export const kinds = (): FixtureFile[] => {
  const a = codeLines(120, 'files'), t = codeLines(30, 'spec')
  return [
    { file: { path: 'src/files.ts' }, base: a.join('\n'), head: edited(a, 30, 4).join('\n') },
    { file: { path: 'src/peers.ts' }, base: codeLines(50, 'peers').join('\n'), head: edited(codeLines(50, 'peers'), 20).join('\n') },
    { file: { path: 'src/diff.ts', status: 'added' }, head: codeLines(24, 'diff').join('\n') },
    { file: { path: 'src/legacy.ts', status: 'deleted' }, base: codeLines(18, 'legacy').join('\n') },
    { file: { path: 'src/net.ts', oldPath: 'src/network.ts', status: 'renamed' }, base: codeLines(60, 'net').join('\n'), head: edited(codeLines(60, 'net'), 25).join('\n') },
    { file: { path: 'web/public/logo.png', binary: true, additions: 0, deletions: 0 }, head: 'PNG', headType: 'image/png', headHeaders: { 'x-stam-size': '18432' } },
    { file: { path: '.env', denied: true, additions: 0, deletions: 0 } },
    { file: { path: 'test/files.test.ts', class: 'tests' }, base: t.join('\n'), head: edited(t, 10, 6).join('\n') },
    { file: { path: 'test/peers.test.ts', class: 'tests' }, base: t.join('\n'), head: edited(t, 12, 2).join('\n') },
    { file: { path: 'package-lock.json', class: 'lockfiles' }, base: '{\n  "v": 1\n}', head: '{\n  "v": 2\n}' },
    { file: { path: 'dist/app.min.js', class: 'generated' }, base: 'var a=1', head: 'var a=2' },
    { file: { path: 'docs/files.md', class: 'docs' }, base: '# Files\n\nOld text.\n', head: '# Files\n\nNew text.\n\nMore.\n' },
  ]
}

// About 40 files and one 3000-line file, with the classes in the mix.
export const realistic = (): FixtureFile[] => {
  const files: FixtureFile[] = []
  const big = codeLines(3000, 'engine')
  files.push({ file: { path: 'src/engine.ts' }, base: big.join('\n'), head: edited(big, 200, 8).join('\n') })
  for (let i = 0; i < 24; i++) {
    const a = codeLines(40 + (i % 5) * 20, `mod${i}`)
    files.push({ file: { path: `src/${i % 3 ? 'util' : 'core'}/mod${i}.ts` }, base: a.join('\n'), head: edited(a, 15 + (i % 4) * 5, i % 3).join('\n') })
  }
  for (let i = 0; i < 9; i++) {
    const a = codeLines(30, `spec${i}`)
    files.push({ file: { path: `test/mod${i}.test.ts`, class: 'tests' }, base: a.join('\n'), head: edited(a, 10, 3).join('\n') })
  }
  files.push({ file: { path: 'package-lock.json', class: 'lockfiles' }, base: '{"v":1}', head: '{"v":2}' })
  files.push({ file: { path: 'dist/bundle.js', class: 'generated' }, base: 'x=1', head: 'x=2' })
  files.push({ file: { path: 'dist/bundle.js.map', class: 'generated' }, base: '{}', head: '{"a":1}' })
  for (let i = 0; i < 4; i++) files.push({ file: { path: `docs/guide${i}.md`, class: 'docs' }, base: `# Guide ${i}\n\nOld.\n`, head: `# Guide ${i}\n\nNew.\n` })
  return files
}
