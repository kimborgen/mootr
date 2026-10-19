// The PR diff view's stories (S-1531). Every route is a stub; repos, paths and shas are invented (diffFixture.ts).
import type { ReactNode } from 'react'
import { ds, pending, reply, type Story } from '../stories/types'
import { OnMount } from '../stories/helpers'
import { DiffView } from './DiffView'
import { diffListUrl } from './diffApi'
import { patchHash, storePatch } from './patchStore'
import { BASE, HEAD, PR, REPO, diffRoutes, kinds, realistic, type FixtureFile } from './diffFixture'

const KEY = `diff:${REPO}#${PR}`
// A patch pasted in mail, and its key: the hash of the text, so the tab is the same wherever it opens (S-2103).
const PATCH = `diff --git a/src/diff.ts b/src/diff.ts
--- a/src/diff.ts
+++ b/src/diff.ts
@@ -1,3 +1,4 @@
 import { read } from './io'
-export const MAX = 10
+export const MAX = 20
+export const MIN = 1
 export function clamp(n: number) {
`
const PATCH_KEY = `patch:${patchHash(PATCH)}`
const frame = (children: ReactNode, h = 640) => <div style={{ height: h }}>{children}</div>
const setMode = (m: 'split' | 'unified') => () => { try { localStorage.setItem('stam.diff.mode', m) } catch { /* no storage */ } }
// A step that waits for the list to draw, then clicks one control (a no-op where the control isn't there, such as the files button on a wide pane).
const clickWhenLoaded = (sel: string) => (el: HTMLElement) => {
  if (!el.querySelector('.dv-count')) throw new Error('the diff has not loaded')
  el.querySelector<HTMLElement>(sel)?.click()
}
const only = (files: FixtureFile[]) => diffRoutes(files)
const listOnly = (files: unknown[]) => ({ [`GET ${diffListUrl(REPO, PR)}`]: { repo: REPO, pr: PR, head: HEAD, base: BASE, mergeBase: BASE, files } })
const view = () => frame(<DiffView viewKey={KEY} />)

export const stories: Story[] = [{
  name: 'PR diff view',
  group: 'Tree and shell',
  what: 'One pull request\'s diff, like GitHub\'s files-changed tab. The header names the PR, the head and base shas, and "N of M files" shown, then a review chip: the stam reviewer\'s verdict (approved or changes requested, with who) when the PR\'s `stam/review` status says so, "approved · another head" muted when that verdict is on a different head than the one shown, and a muted "no review" when none is posted, the PR is not watched or the status is pending. A tap on the chip shows the summary. On a narrow pane the header is trimmed: only the head sha shows (both are in its title), the chip uses a short label ("changes · other head"; the full words stay in its title and the sheet), and Wrap and the text size fold into one "Aa · Wrap ●/○" button that opens a small sheet. "Meat" mode (on by default) hides the files that are not the change itself: one chip per class with its count (Tests, Lockfiles, Generated hidden; Docs shown), and a Hide or Show on a file overrides its class. A wide pane has the file list as a left column with +/- counts and shows both sides next to each other; a narrow pane, such as a phone, shows unified diffs, opens the list as a sheet from "Files (N) ▾", and puts prev and next file buttons at the bottom. Each file loads when it scrolls into view. Unchanged runs collapse with an "expand" row, and "Expand all" shows the whole file. Added and deleted files, renames (old → new), binaries ("binary, N KB"), files over the size cap ("too large", with a download when its size is known and within the 50 MB the server serves), and protected files ("hidden: protected file", never fetched) get a row in place of a diff. A Viewed checkmark per file is kept in this browser (shared by every open diff view) and resets when that file changes in the PR. A side the server cannot find (the PR was pushed to and the cache moved on) is an error with Try again, never a whole-file add or delete. A `patch:HASH` tab (S-2103) is a patch pasted in mail: its files are drawn from their own hunks in one unified document, with the `@@` numbers in the gutter, no review chip, no Split, and no request to any API; when this browser has lost its entry the view says to open it again from its mail.',
  when: 'A tab or world opened by a `diff:REPO#N` key (`#diff=REPO:N`). It reads `GET /api/diff` for the list, then `GET /api/diff/file` for each side of a file with the `head` and `base` shas the list returned, so a push meanwhile does not change what is shown. It opens from an ITSA\'s PR or branch link (`View diff`), the Work table\'s PR chip, and a GitHub PR URL in mail, for a repo `GET /api/diff/repos` lists (S-1533), as well as the deep link. Keys: `j` and `k` for the next and previous file, `n` and `p` for the next and previous change; with two diff views open, only the one last pointed at or focused takes them. A patch tab opens by `patch:HASH` (S-2103), the hash of the fence\'s text, kept in this browser\'s LRU so it reloads while its entry lasts.',
  code: ['web/src/diff/DiffView.tsx#DiffView', 'web/src/diff/FileDiff.tsx#FileDiff', 'web/src/diff/PatchDiff.tsx#PatchDiff', 'web/src/diff/DiffFileHead.tsx#DiffFileHead', 'web/src/files/codePrefs.tsx#CodePrefButtons', 'web/src/diff/diffModel.ts#isShown'],
  rules: [
    'The same CodeMirror setup, syntax tokens, text size and wrap as the file view (' + ds('Code in mail') + '); the diff is `@codemirror/merge`, loaded as its own chunk with the first file.',
    'A diff tints only its changed lines: added on `--status-success-bg`, removed on `--status-error-bg`, with the gutter bar and the changed text underlined on `--status-success-fg` and `--status-error-fg`. Colours, sizes and type are tokens only.',
    'Layout follows the pane\'s width, not the window\'s: the list column from 720 px, both sides next to each other from 900 px, otherwise unified with the files sheet. Long lines scroll sideways inside the code, never the page.',
    'Controls, list rows, the Viewed checkbox and the prev and next buttons are `--size-hit-touch` (44 px) on a phone (' + ds('Density') + ').',
    'The review chip (S-1917) comes from the poller\'s snapshot of the PR, never a GitHub call, so it shows what `stam/review` holds, the status `scripts/merge-pr.mjs` trusts. A verdict on another head is muted (' + ds('Color semantics') + '), never success-coloured, and the chip never claims an approve the status does not back. It sits in the title row without adding one: on a phone the reviewer\'s name truncates first. The summary is shown as text.',
    'A narrow pane (under 720 px) keeps the header to its two rows: the base sha drops out, the review chip takes its short label, and "Aa · Wrap" replaces the Wrap and A−/A+ buttons, with the wrap state visible on the button itself (' + ds('Density') + '). The file column\'s width is `--size-diff-side`.',
    'The merge view\'s editors are handed to the caller (the `onEditor` prop).',
    'A file draws within 800 px of the scroll container and tears its editor down (`destroy()`, `onEditor(null)`) beyond 3000 px, so a long PR keeps few EditorViews. Its fetched text, Viewed, Expand all and a pending jump stay, and its height is pinned while torn down so nothing shifts. A file with focus or a selection, or a jump still to land, is kept.',
    'Go to declaration (S-1532): Ctrl/Cmd-click (desktop) or tap (phone) an identifier, read from the syntax tree. It is looked up in the declaration index at the PR head, or at the merge base on deleted lines. One match in a file of the PR un-hides and opens that file, scrolls to it, expands to the line and marks it (`--highlight-1`, faded in from `--highlight-3` over `--duration-focus`); one elsewhere shows its lines with Open file; several show the `Declaration picker`. With Ctrl/Cmd held an identifier that has a declaration is underlined on hover.',
    'A patch file the checkout could not resolve (S-2103) is one unified document of its own hunks: added rows on `--status-success-bg`, removed on `--status-error-bg`, hunk headers muted on `--surface-sunken`, and the gutter numbers from the `@@` headers. It has no second side, so there is no merge view and no Split (' + ds('Color semantics') + ').',
  ],
  states: [
    { name: 'Split, Meat on', routes: only(kinds()), setup: setMode('split'), render: view },
    { name: 'Unified', routes: only(kinds()), setup: setMode('unified'), render: view },
    { name: 'Meat off', routes: only(kinds()), setup: setMode('split'), render: () => frame(<OnMount run={clickWhenLoaded('.dv-meat')}><DiffView viewKey={KEY} /></OnMount>) },
    { name: 'Files sheet on a phone', routes: only(kinds()), setup: setMode('split'), render: () => frame(<OnMount run={clickWhenLoaded('.dv-files-btn')}><DiffView viewKey={KEY} /></OnMount>) },
    { name: 'Text and wrap sheet on a phone', routes: only(kinds()), setup: setMode('split'), render: () => frame(<OnMount run={clickWhenLoaded('.dv-text')}><DiffView viewKey={KEY} /></OnMount>) },
    { name: 'Binary, protected, renamed', routes: only(kinds().filter((f) => ['web/public/logo.png', '.env', 'src/net.ts', 'src/diff.ts', 'src/legacy.ts'].includes(f.file.path))), setup: setMode('split'), render: view },
    {
      name: 'Too large to diff',
      routes: only([{ file: { path: 'data/dump.json', additions: 90000, deletions: 12 }, base: '{}', head: '{', headHeaders: { 'x-stam-truncated': '1', 'x-stam-size': String(9 * 1024 * 1024) } }, kinds()[2]]),
      setup: setMode('unified'),
      render: view,
    },
    { name: 'Review: approved', routes: diffRoutes(kinds(), { verdict: 'approve', by: 'rev-1', summary: 'Small and tested; one nit on naming.', at: '2026-10-19T10:00:00Z', head: HEAD, stale: false }), setup: setMode('split'), render: view },
    { name: 'Review: changes requested, sheet open', routes: diffRoutes(kinds(), { verdict: 'changes', by: 'rev-1', summary: 'The cache is never cleared when the head moves.', at: '2026-10-19T10:00:00Z', head: HEAD, stale: false }), setup: setMode('split'), render: () => frame(<OnMount run={clickWhenLoaded('.dv-review')}><DiffView viewKey={KEY} /></OnMount>) },
    { name: 'Review: another head', routes: diffRoutes(kinds(), { verdict: 'approve', by: 'rev-1', summary: 'Fine as it was.', at: '2026-10-19T10:00:00Z', head: '7e57c0de7e57c0de7e57c0de7e57c0de7e57c0de', stale: true }), setup: setMode('split'), render: view },
    { name: 'Empty', routes: listOnly([]), render: view },
    { name: 'Loading', routes: { [`GET ${diffListUrl(REPO, PR)}`]: pending() }, render: view },
    { name: 'Error: no such PR', routes: { [`GET ${diffListUrl(REPO, PR)}`]: reply(404, { error: `no PR ${PR} in ${REPO}` }) }, render: view },
    { name: 'Error: unknown repo', routes: { [`GET ${diffListUrl('nope', PR)}`]: reply(404, { error: 'unknown repo nope: it is not in settings.itsa.repos' }) }, render: () => frame(<DiffView viewKey={`diff:nope#${PR}`} />) },
    { name: 'Error: timed out', routes: { [`GET ${diffListUrl(REPO, PR)}`]: reply(504, { error: `fetching PR ${PR} of ${REPO} timed out after 60s` }) }, render: view },
    { name: 'Patch: a pasted patch', setup: () => { storePatch(PATCH) }, render: () => frame(<DiffView viewKey={PATCH_KEY} />) },
    { name: 'Patch: the entry is gone', setup: () => { try { localStorage.removeItem('stam/diff-patch/deadbeefdeadbeef') } catch { /* no storage */ } }, render: () => frame(<DiffView viewKey="patch:deadbeefdeadbeef" />) },
    { name: 'Realistic: 40 files and a 3000-line file', routes: only(realistic()), setup: setMode('split'), render: () => frame(<DiffView viewKey={KEY} />, 720) },
  ],
}]
