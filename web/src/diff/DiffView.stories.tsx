// The PR diff view's stories (S-1531). Every route is a stub; repos, paths and shas are invented (diffFixture.ts).
import type { ReactNode } from 'react'
import { ds, pending, reply, type Story } from '../stories/types'
import { OnMount } from '../stories/helpers'
import { DiffView } from './DiffView'
import { diffListUrl } from './diffApi'
import { BASE, HEAD, PR, REPO, diffRoutes, kinds, realistic, type FixtureFile } from './diffFixture'

const KEY = `diff:${REPO}#${PR}`
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
  what: 'One pull request\'s diff, like GitHub\'s files-changed tab. The header names the PR, the head and base shas, and "N of M files" shown. "Meat" mode (on by default) hides the files that are not the change itself: one chip per class with its count (Tests, Lockfiles, Generated hidden; Docs shown), and a Hide or Show on a file overrides its class. A wide pane has the file list as a left column with +/- counts and shows both sides next to each other; a narrow pane, such as a phone, shows unified diffs, opens the list as a sheet from "Files (N) ▾", and puts prev and next file buttons at the bottom. Each file loads when it scrolls into view. Unchanged runs collapse with an "expand" row, and "Expand all" shows the whole file. Added and deleted files, renames (old → new), binaries ("binary, N KB"), files over the size cap ("too large", with a download when its size is known and within the 50 MB the server serves), and protected files ("hidden: protected file", never fetched) get a row in place of a diff. A Viewed checkmark per file is kept in this browser (shared by every open diff view) and resets when that file changes in the PR. A side the server cannot find (the PR was pushed to and the cache moved on) is an error with Try again, never a whole-file add or delete.',
  when: 'A tab or world opened by a `diff:REPO#N` key (`#diff=REPO:N`). It reads `GET /api/diff` for the list, then `GET /api/diff/file` for each side of a file with the `head` and `base` shas the list returned, so a push meanwhile does not change what is shown. It opens from an ITSA\'s PR or branch link (`View diff`), the Work table\'s PR chip, and a GitHub PR URL in mail, for a repo `GET /api/diff/repos` lists (S-1533), as well as the deep link. Keys: `j` and `k` for the next and previous file, `n` and `p` for the next and previous change.',
  code: ['web/src/diff/DiffView.tsx#DiffView', 'web/src/diff/FileDiff.tsx#FileDiff', 'web/src/files/codePrefs.tsx#CodePrefButtons', 'web/src/diff/diffModel.ts#isShown'],
  rules: [
    'The same CodeMirror setup, syntax tokens, text size and wrap as the file view (' + ds('Code in mail') + '); the diff is `@codemirror/merge`, loaded as its own chunk with the first file.',
    'A diff tints only its changed lines: added on `--status-success-bg`, removed on `--status-error-bg`, with the gutter bar and the changed text underlined on `--status-success-fg` and `--status-error-fg`. Colours, sizes and type are tokens only.',
    'Layout follows the pane\'s width, not the window\'s: the list column from 720 px, both sides next to each other from 900 px, otherwise unified with the files sheet. Long lines scroll sideways inside the code, never the page.',
    'Controls, list rows, the Viewed checkbox and the prev and next buttons are `--size-hit-touch` (44 px) on a phone (' + ds('Density') + ').',
    'The merge view\'s editors are handed to the caller (the `onEditor` prop).',
    'A file draws within 800 px of the scroll container and tears its editor down (`destroy()`, `onEditor(null)`) beyond 3000 px, so a long PR keeps few EditorViews. Its fetched text, Viewed, Expand all and a pending jump stay, and its height is pinned while torn down so nothing shifts. A file with focus or a selection, or a jump still to land, is kept.',
    'Go to declaration (S-1532): Ctrl/Cmd-click (desktop) or tap (phone) an identifier, read from the syntax tree. It is looked up in the declaration index at the PR head, or at the merge base on deleted lines. One match in a file of the PR un-hides and opens that file, scrolls to it, expands to the line and marks it (`--highlight-1`, faded in from `--highlight-3` over `--duration-focus`); one elsewhere shows its lines with Open file; several show the `Declaration picker`. With Ctrl/Cmd held an identifier that has a declaration is underlined on hover.',
  ],
  states: [
    { name: 'Split, Meat on', routes: only(kinds()), setup: setMode('split'), render: view },
    { name: 'Unified', routes: only(kinds()), setup: setMode('unified'), render: view },
    { name: 'Meat off', routes: only(kinds()), setup: setMode('split'), render: () => frame(<OnMount run={clickWhenLoaded('.dv-meat')}><DiffView viewKey={KEY} /></OnMount>) },
    { name: 'Files sheet on a phone', routes: only(kinds()), setup: setMode('split'), render: () => frame(<OnMount run={clickWhenLoaded('.dv-files-btn')}><DiffView viewKey={KEY} /></OnMount>) },
    { name: 'Binary, protected, renamed', routes: only(kinds().filter((f) => ['web/public/logo.png', '.env', 'src/net.ts', 'src/diff.ts', 'src/legacy.ts'].includes(f.file.path))), setup: setMode('split'), render: view },
    {
      name: 'Too large to diff',
      routes: only([{ file: { path: 'data/dump.json', additions: 90000, deletions: 12 }, base: '{}', head: '{', headHeaders: { 'x-stam-truncated': '1', 'x-stam-size': String(9 * 1024 * 1024) } }, kinds()[2]]),
      setup: setMode('unified'),
      render: view,
    },
    { name: 'Empty', routes: listOnly([]), render: view },
    { name: 'Loading', routes: { [`GET ${diffListUrl(REPO, PR)}`]: pending() }, render: view },
    { name: 'Error: no such PR', routes: { [`GET ${diffListUrl(REPO, PR)}`]: reply(404, { error: `no PR ${PR} in ${REPO}` }) }, render: view },
    { name: 'Error: unknown repo', routes: { [`GET ${diffListUrl('nope', PR)}`]: reply(404, { error: 'unknown repo nope: it is not in settings.itsa.repos' }) }, render: () => frame(<DiffView viewKey={`diff:nope#${PR}`} />) },
    { name: 'Error: timed out', routes: { [`GET ${diffListUrl(REPO, PR)}`]: reply(504, { error: `fetching PR ${PR} of ${REPO} timed out after 60s` }) }, render: view },
    { name: 'Realistic: 40 files and a 3000-line file', routes: only(realistic()), setup: setMode('split'), render: () => frame(<DiffView viewKey={KEY} />, 720) },
  ],
}]
