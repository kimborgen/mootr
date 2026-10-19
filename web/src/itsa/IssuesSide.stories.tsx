import { OnMount } from '../stories/helpers'
import { DEEP, itsa, itsaData, LONG, TREE, WAITING_ITSAS } from '../stories/itsaFixtures'
import { ds, type Story } from '../stories/types'
import type { Data } from '../store'
import { getUi } from '../ui/state'
import type { UiState } from '../ui/state'
import { IssuesSide, NewItsa } from './IssuesSide'

const leftRef = { current: null as HTMLElement | null }
// The sidebar's UI state (which rows are open, the section's height) is set on the store's object
// directly, so a story never writes the browser's storage the way setUi does.
const withUi = (p: Partial<UiState>, node: () => React.ReactNode) => () => { Object.assign(getUi(), { itsaOpen: {}, closedItsasOpen: false, issuesFolded: false, issuesH: 340, ...p }); return node() }
const side = () => <div className="tree-side" style={{ width: '100%' }}><IssuesSide leftRef={leftRef} /></div>
const open = (...ids: number[]) => Object.fromEntries(ids.map((n) => [`fx-i-${n}`, true]))
const waiting = (extra: Partial<Data> = {}) => itsaData(TREE, { attention: WAITING_ITSAS, ...extra })
// Forty roots with long titles: the list at a realistic scale.
const ROOTS = Array.from({ length: 40 }, (_, i) => itsa(1000 + i, null, i % 6 === 0 ? 'A long title that goes past the width of the list and has to end in an ellipsis rather than wrap, number ' + i : `Fixture root issue ${i}`, ['backlog', 'in_progress', 'in_review', 'done', 'todo'][i % 5], { min: 40000 - i * 500 }))
const press = (sel: string) => (el: HTMLElement) => el.querySelector<HTMLElement>(sel)?.click()

export const stories: Story[] = [{
  name: 'Issues list',
  group: 'ITSA and work',
  what: 'The Issues section of the left sidebar, between the agent tree and the mail list: a row for each root ITSA (status glyph, key, title, a roll-up bar when it has children), each expandable into its children to any depth. Open roots come first and closed roots fold into one "Closed" row at the end. A "Work" row opens the Work page, and the header counts open roots or, when something waits on you, says "N waiting on you" and opens that list.',
  when: 'The sidebar on a desktop, below the tree; on a phone it is the Issues tab of the navigation and fills the screen. A row opens the ITSA\'s world (`w:itsa:ID`); the board button opens the all-issues board; the plus button opens the new-issue box.',
  code: ['web/src/itsa/IssuesSide.tsx#IssuesSide', 'web/src/itsa/IssuesSide.tsx#NewItsa'],
  rules: [
    'Rows are `--size-row-tree` (24 px) tall and `--size-hit-touch` on a phone; each level indents by `--space-3`. A selected row takes `--tree-row-selected-bg`, hover `--tree-row-hover` (' + ds('Density') + ').',
    'A row that waits on you carries a warning badge with the user icon; a folded row with something waiting below it carries the same badge titled "Something in here waits on you". The status glyph and words say the rest (' + ds('State vocabulary') + ').',
    'A closed row\'s title takes `--text-muted`; a row being created shows its title with a dashed underline until the daemon has it.',
    'Open ones first, each group oldest first. The Work row\'s count is every open ITSA, not roots.',
    'A separator above the section resizes it (at least 64 px, at most what the tree and the mail list leave), and the header folds it on a desktop; both are remembered on this device. A phone has no fold and no separator.',
    'First load shows the Loading badge where the empty text will stand, so nothing jumps; an unreachable daemon shows its error in the list (' + ds('Empty, loading, and error') + ').',
    'The new-issue box: Enter adds, Escape or leaving it empty cancels, and Add is disabled until there is a title; on a phone Add is at least `--size-hit-touch` wide.',
  ],
  states: [
    { name: 'Roots, collapsed', data: itsaData(TREE), render: withUi({}, side) },
    { name: 'In a sidebar pane', data: itsaData(TREE), render: withUi({ issuesFolded: true }, () => <div className="tree-side" style={{ width: '100%', height: 260, display: 'flex', flexDirection: 'column' }}><IssuesSide leftRef={leftRef} pane /></div>) },
    { name: 'A tree expanded', data: itsaData(TREE), render: withUi({ itsaOpen: open(910, 911, 912) }, side) },
    { name: 'Something waits on you', data: waiting(), render: withUi({}, side) },
    { name: 'Waiting, with the tree open down to it', data: waiting(), render: withUi({ itsaOpen: open(910, 911, 912) }, side) },
    { name: 'A seven-level chain', data: itsaData(DEEP), render: withUi({ itsaOpen: open(960, 961, 962, 963, 964, 965) }, side) },
    { name: 'Closed roots shown', data: itsaData(TREE), render: withUi({ closedItsasOpen: true }, side) },
    { name: 'Folded', data: itsaData(TREE), render: withUi({ issuesFolded: true }, side) },
    { name: 'New issue', data: itsaData(TREE), render: withUi({}, () => <OnMount run={press('#new-issue')}>{side()}</OnMount>) },
    { name: 'Forty roots, long titles', data: itsaData(ROOTS), render: withUi({}, side) },
    { name: 'A long board\'s root, expanded', data: itsaData(LONG), render: withUi({ itsaOpen: open(970) }, side) },
    { name: 'Loading', data: itsaData([], { loaded: { agents: true, mail: true, itsas: false } }), render: withUi({}, side) },
    { name: 'Empty', data: itsaData([]), render: withUi({}, side) },
    { name: 'Error', data: itsaData([], { itsaError: 'fixture: the daemon is unreachable' }), render: withUi({}, side) },
  ],
}, {
  name: 'New ITSA box',
  group: 'ITSA and work',
  what: 'A one-line text box with an Add button for a new ITSA\'s title, shown inline where the ITSA will go. Enter or Add creates it, as the human; the new ITSA shows at once as pending.',
  when: 'Under the Issues header after the plus button (a new root), and in the ITSA view\'s Children section after "New child" (a child of that ITSA).',
  code: ['web/src/itsa/IssuesSide.tsx#NewItsa'],
  rules: [
    'The box takes focus when it opens; Escape, or blurring it while empty, closes it. While the request is out, the box and Add are disabled.',
    'The placeholder names what is being made ("New issue\'s title", "Child\'s title") and is also the box\'s accessible name.',
    'A refusal shows "Couldn\'t add it" and the reason in the notice bar, and keeps the typed title.',
  ],
  states: [
    { name: 'New root', render: () => <NewItsa parent={null} placeholder="New issue's title" onDone={() => {}} /> },
    { name: 'New child', render: () => <NewItsa parent="fx-i-910" placeholder="Child's title" onDone={() => {}} /> },
  ],
}]
