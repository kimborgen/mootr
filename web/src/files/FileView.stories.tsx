// The file view's and the Files world's stories (S-1526). Every route is a stub; paths and hosts are invented.
import type { ReactNode } from 'react'
import { ds, pending, raw, reply, type Story } from '../stories/types'
import { CodeView } from './CodeView'
import { FileView } from './FileView'
import { FilesView } from './FilesView'

const TS = Array.from({ length: 60 }, (_, i) => (i === 6 ? `export const wide = '${'x'.repeat(160)}'` : `export const line${i + 1} = ${i + 1}`)).join('\n') + '\n'
// 50,000 lines: only the visible ones are drawn, so this must scroll smoothly.
const BIG = Array.from({ length: 50_000 }, (_, i) => (i % 7 === 0 ? `// line ${i + 1}: a comment` : `export const value${i + 1} = ${i * 3} + 'text ${i + 1}'`)).join('\n')
const MD = '# Notes\n\nA paragraph with `code` and a [link](https://example.com).\n\n- one\n- two\n'
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="#7a8fb8"/><circle cx="120" cy="60" r="36" fill="#fff"/></svg>'
const HOME = '/home/fixture/projects'
const read = (host: string, path: string) => `GET /api/files/read?host=${host}&path=${encodeURIComponent(path)}`
const list = (host: string, path: string) => `GET /api/files/list?host=${host}&path=${encodeURIComponent(path)}`
const entries = [
  { name: 'docs', kind: 'dir', size: 0, mtime: 1 },
  { name: 'index.ts', kind: 'file', size: 2300, mtime: 1 },
  { name: 'README.md', kind: 'file', size: 400, mtime: 1 },
  { name: 'latest', kind: 'symlink', size: 0, mtime: 1 },
]
const tree = {
  [list('fixture-machine', '')]: { host: 'fixture-machine', roots: [{ path: HOME, name: 'projects' }] },
  [list('fixture-machine', HOME)]: { host: 'fixture-machine', path: HOME, entries },
}
const key = (path: string, line?: number) => `file:fixture-machine:${path}${line ? `#L${line}` : ''}`
const frame = (children: ReactNode) => <div style={{ height: 520 }}>{children}</div>

export const stories: Story[] = [{
  name: 'File view',
  group: 'Tree and shell',
  what: 'One file from this machine or a peer, by type: an image (tap it for the image viewer), Markdown rendered with a Rendered and Source toggle, text and code with line numbers, a PDF in the PDF viewer (its own story), and a Download button for anything else (video, binaries) until those get viewers. The breadcrumb names the path and each part opens the Files world at that folder. An image over 50 MB is not loaded: it says it is too large to show and offers Download. Download builds the file in the page, so above 500 MB it shows a note with the size instead, and below it shows "Preparing… 40%" while it streams. A text file over 5 MB shows its first part with a Load all button, or a Download button above 50 MB. A stopped peer shows "is stopped" with a Start button, and a strict-mode refusal links to that machine\'s own page.',
  when: 'A tab or world opened by a `file:HOST:PATH` key (`#file=HOST:PATH`, or a tap on a file in the Files world), with `#Lline` to scroll to and mark a line. It reads `GET /api/files/read` once on open.',
  code: ['web/src/files/FileView.tsx#FileView', 'web/src/files/FileView.tsx#Crumbs', 'web/src/files/FileView.tsx#Failure', 'web/src/files/CodeView.tsx#CodeView', 'web/src/files/fileKey.ts#kindOf'],
  rules: [
    'Full height of its pane; on a phone the pane is the screen, and long lines scroll inside the code block, never the page.',
    'A file path in rendered Markdown links to its file at its line (S-1529); a relative path resolves in the open file\'s folder, on the same machine.',
    'Go to declaration (S-1532): Ctrl/Cmd-click (or tap, on a phone) an identifier in code. A file inside a checkout of `settings.itsa.repos` is looked up in the declaration index at that checkout\'s HEAD, so uncommitted edits can put a line off; any other file in its own syntax tree. One match jumps (in this file by its #L line, in another as a new file tab), several show the `Declaration picker`.',
    'Controls are `--size-hit-touch` (44 px) on a phone (' + ds('Density') + '); colours, sizes and type are tokens only.',
  ],
  states: [
    { name: 'Code at a line', routes: { [read('fixture-machine', '/p/a.ts')]: raw(TS) }, render: () => frame(<FileView viewKey={key('/p/a.ts', 7)} />) },
    { name: 'Code, plain', routes: { [read('fixture-machine', '/p/a.ts')]: raw(TS) }, render: () => frame(<FileView viewKey={key('/p/a.ts')} />) },
    { name: 'Markdown', routes: { [read('fixture-machine', '/p/n.md')]: raw(MD) }, render: () => frame(<FileView viewKey={key('/p/n.md')} />) },
    { name: 'Image', routes: { [read('fixture-machine', '/p/i.svg')]: raw(SVG, 'image/svg+xml') }, render: () => frame(<FileView viewKey={key('/p/i.svg')} />) },
    { name: 'Image too large', routes: { [read('fixture-machine', '/p/huge.png')]: raw('', 'image/png', { 'x-stam-size': String(200 * 1024 * 1024) }) }, render: () => frame(<FileView viewKey={key('/p/huge.png')} />) },
    { name: 'Download', routes: { [read('fixture-machine', '/p/d.zip')]: raw('PK', 'application/zip', { 'x-stam-size': '2048' }) }, render: () => frame(<FileView viewKey={key('/p/d.zip')} />) },
    { name: 'Truncated', routes: { [read('fixture-machine', '/p/big.log')]: raw('start\n', 'text/plain; charset=utf-8', { 'x-stam-truncated': '1', 'x-stam-size': String(9 * 1024 * 1024) }) }, render: () => frame(<FileView viewKey={key('/p/big.log')} />) },
    { name: 'Too large to load', routes: { [read('fixture-machine', '/p/huge.log')]: raw('start\n', 'text/plain; charset=utf-8', { 'x-stam-truncated': '1', 'x-stam-size': String(900 * 1024 * 1024) }) }, render: () => frame(<FileView viewKey={key('/p/huge.log')} />) },
    { name: 'Loading', routes: { [read('fixture-machine', '/p/a.ts')]: pending() }, render: () => frame(<FileView viewKey={key('/p/a.ts')} />) },
    { name: 'Peer stopped', routes: { [read('storage', '/p/a.ts')]: reply(503, { state: 'stopped', host: 'storage', error: 'storage is stopped' }) }, render: () => frame(<FileView viewKey="file:storage:/p/a.ts" />) },
    { name: 'Not found', routes: { [read('fixture-machine', '/p/gone.ts')]: reply(404, { error: 'no such file' }) }, render: () => frame(<FileView viewKey={key('/p/gone.ts')} />) },
  ],
}, {
  name: 'File code block',
  group: 'Tree and shell',
  what: 'A read-only code viewer: CodeMirror 6 with line numbers, syntax colour picked by the file path, search, a wrap toggle, and a text-size control for a phone, which has no pinch here. A click or tap on a line number reports the line for a #L link, and `line` scrolls to and marks one. An empty file says so. It loads as its own chunk on first use.',
  when: 'Inside the file view for text, code, and a Markdown file shown as source. Its Wrap toggle and text-size control (`CodePrefButtons`, remembered per viewer) are the same ones the PR diff view uses.',
  code: ['web/src/files/CodeView.tsx#CodeView', 'web/src/files/codePrefs.tsx#CodePrefButtons'],
  rules: [
    'Colour comes from the `--syntax-*` tokens on `--code-bg` in the mono font, never a new colour (' + ds('Code in mail') + ').',
    'Toolbar buttons and the search panel are `--size-hit-touch` on a touch screen, `--size-control` otherwise. The text sizes are the `--type-chrome-*` tokens and `--doc-size-body`; the marked line and search matches use `--highlight-*`.',
    'Long lines scroll inside the editor, never the page; only visible lines are drawn, so a 50,000-line file stays smooth.',
    'With `onDecl`, a Ctrl/Cmd-click or a tap on an identifier (read from the syntax tree) reports it, and with Ctrl/Cmd held an identifier that has a declaration is underlined in `--accent-text` on hover (S-1532).',
  ],
  states: [
    { name: 'Marked line', render: () => frame(<CodeView text={TS} path="a.ts" line={12} onLineLink={() => {}} />) },
    { name: 'Plain text', render: () => frame(<CodeView text={'no language here\nsecond line'} path="notes.txt" />) },
    { name: 'Empty', render: () => frame(<CodeView text="" path="a.ts" />) },
    { name: '50,000 lines', render: () => frame(<CodeView text={BIG} path="big.ts" line={25000} />) },
  ],
}, {
  name: 'Files world',
  group: 'Tree and shell',
  what: 'A tree of the allowed roots for this machine and each peer, a path box (`/path`, or `HOST:/path`; a folder lists below it, a file opens), and the files opened lately, kept per viewer in the browser. Folders list when they open. A peer that is stopped says so and offers Start.',
  when: 'The Files world (`w:files`), from the global menu or `#view=files`; a breadcrumb part in the file view opens it at that folder.',
  code: ['web/src/files/FilesView.tsx#FilesView'],
  rules: ['Rows are `--size-row-tree` on a desktop and `--size-hit-touch` on a phone (' + ds('Density') + '); one column, scrolling inside the pane.'],
  states: [
    { name: 'Tree', routes: tree, render: () => frame(<FilesView />) },
    { name: 'Peer stopped', data: { machines: [{ name: 'storage', online: false, ts: 0, cpu: { pct: 0, cores: [], count: 0 }, ram: { pct: 0, used: 0, total: 0 }, swap: { pct: 0, used: 0, total: 0 }, load: [] }] }, routes: { ...tree, [list('storage', '')]: reply(503, { state: 'stopped', host: 'storage', error: 'storage is stopped' }) }, render: () => frame(<FilesView />) },
    { name: 'No roots', routes: { [list('fixture-machine', '')]: { host: 'fixture-machine', roots: [] } }, render: () => frame(<FilesView />) },
    { name: 'Error', routes: { [list('fixture-machine', '')]: reply(403, { error: 'only the human can read files' }) }, render: () => frame(<FilesView />) },
  ],
}]
