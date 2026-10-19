// Go to declaration's picker (S-1532). Paths, lines and names are invented.
import { ds, type Story } from '../stories/types'
import { DeclPicker, isPhone, type DeclPickState } from './DeclPicker'
import type { DeclMatch } from './declApi'

const m = (path: string, line: number, kind: string, text: string): DeclMatch => ({ path, line, col: 17, kind, text })
const MANY: DeclMatch[] = [
  m('src/server/routes.ts', 42, 'function', 'export function handle(req: Request, res: Response) {'),
  m('src/server/legacy/routes-v1.ts', 118, 'function', 'function handle(req, res) {'),
  m('web/src/files/fixture-handlers/handle.ts', 7, 'const', 'export const handle = (e: Event) => queue.push(e)'),
  m('py/worker/jobs.py', 23, 'method', 'def handle(self, job):'),
]
const ONE = m('lib/shared/format.ts', 12, 'function', 'export function formatBytes(n: number): string {')
const picker = (state: DeclPickState, name = 'handle') => (
  <div style={{ height: 420 }}>
    <DeclPicker name={name} state={state} anchor={{ x: 24, y: 48, top: 30 }} phone={isPhone()} onPick={() => {}} onOpen={state.s === 'one' ? () => {} : undefined} onClose={() => {}} inPlace />
  </div>
)

export const stories: Story[] = [{
  name: 'Declaration picker',
  group: 'Tree and shell',
  what: 'What go to declaration found when it is not a plain jump: a list of declarations as path:line, kind and the line\'s text (several matches, ranked: the same file, files it imports, its folder, then the rest, at most 30 with "and N more"); one declaration in a file the view cannot jump to, shown as its lines with an Open file action; a quiet "No declaration of NAME found."; "Indexing the repo…" while the index builds; or an error.',
  when: 'After a Ctrl/Cmd-click (desktop) or a tap (phone) on an identifier in the PR diff view or the file view, when the lookup (`GET /api/decl`) finds several matches, none, or one outside the view. A popover below the identifier on desktop, a bottom sheet on a phone. Escape, a press outside, Close, or the scrim closes it.',
  code: ['web/src/decl/DeclPicker.tsx#DeclPicker'],
  rules: [
    'Rows are at least `--size-hit-touch` (44 px) tall on every screen, and the buttons are on a phone (' + ds('Density') + ').',
    'The popover is `--surface-raised` with `--shadow-float` on `--z-popover`; the sheet sits over `--surface-scrim`. Paths and code are in the mono font, the declaration\'s own line marked with `--highlight-1` on `--code-bg`.',
    'It is drawn on the document body: the phone sheet covers the bottom bar, over the scrim. Long paths and lines cut with an ellipsis, never widening the page.',
  ],
  states: [
    { name: 'Several matches', height: 420, overlay: '.decl-pick', render: () => picker({ s: 'list', matches: MANY, total: 4 }) },
    { name: 'More than the cap', height: 420, overlay: '.decl-pick', render: () => picker({ s: 'list', matches: MANY, total: 41 }) },
    { name: 'One outside the PR', height: 420, overlay: '.decl-pick', render: () => picker({ s: 'one', match: ONE, lines: ['export function formatBytes(n: number): string {', '  if (n < 1024) return `${n} B`', '  const kb = n / 1024', '  return kb < 1024 ? `${kb.toFixed(1)} KB` : `${(kb / 1024).toFixed(1)} MB`', '}'], openNote: 'Opens the live checkout on fixture-machine, which can differ from the PR.' }, 'formatBytes') },
    { name: 'No match', height: 200, overlay: '.decl-pick', render: () => picker({ s: 'none' }, 'mystery') },
    { name: 'Building the index', height: 200, overlay: '.decl-pick', render: () => picker({ s: 'building' }) },
    { name: 'Error', height: 200, overlay: '.decl-pick', render: () => picker({ s: 'error', message: 'commit a1b2c3d4e5f6 is not in fixture; open the diff again' }) },
  ],
}]
