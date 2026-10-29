import { defaultCardLayout, type CardLayout } from '../card-layout'
import { FIELDS, TREE } from '../stories/itsaFixtures'
import { OnMount } from '../stories/helpers'
import { ACTIVITY, COSTS } from '../stories/workFixtures'
import { ds, type Story } from '../stories/types'
import { cardItemsFor } from '../work/card-items'
import type { WorkExtras } from '../work/data'
import { IssueCardEditor } from './IssueCardEditor'
import { placeItem, resetIssueLayout } from './issue-layout'

const extras: WorkExtras = { costs: COSTS, activity: ACTIVITY, watch: {}, fields: null, fieldsFailed: false, fieldsStart: 0 }
const items = cardItemsFor('issue', FIELDS)
const ids = items.map((i) => i.id)

// The editor as a page draws it: its layout is given, and its changes go nowhere (a story does not save).
const editor = (layout: CardLayout, itsas = TREE) => (
  <div style={{ width: 'var(--size-pane-min)', minWidth: 600 }}>
    <IssueCardEditor layout={layout} items={items} fields={FIELDS} itsas={itsas} extras={extras} onChange={() => {}} onReset={() => {}} />
  </div>
)
// A layout with every item placed in BADGES, which has no cap: nothing is left in Available.
// Badges empty: a chip moved into it lands at its only place.
const emptyBadges: CardLayout = { ...defaultCardLayout('issue'), slots: { ...defaultCardLayout('issue').slots, BADGES: [] }, chosen: true }
const everyPlaced = ids.reduce((l, i) => placeItem(l, i, 'BADGES'), defaultCardLayout('issue'))
// META with its five items, the cap: its + is disabled.
const metaFull: CardLayout = { ...defaultCardLayout('issue'), slots: { ...defaultCardLayout('issue').slots, META: ['status', 'rollup', 'links', 'owner', 'updated'] }, chosen: true }
// The keys a step presses on a chip, once the editor has drawn: Space lifts, arrows move, Space drops, Escape cancels.
const pressKeys = (item: string, keys: string[]) => (el: HTMLElement) => {
  const chip = el.querySelector<HTMLElement>(`[data-item="${item}"]`)!
  chip.focus()
  for (const key of keys) chip.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}
// META full, Updated in BADGES: a step up from BADGES lands in META, which is at its cap, so the move is refused.
const metaFullRefusal: CardLayout = { ...defaultCardLayout('issue'), slots: { TOP: ['parent', 'kind'], META: ['status', 'rollup', 'links', 'owner', 'health'], BADGES: ['updated'], FOOT: [] }, chosen: true }
// The + menu of BADGES: opened by its button once the editor has drawn.
const openAdd = (el: HTMLElement) => { el.querySelector<HTMLButtonElement>('[aria-label="Add to Badges"]')?.click() }

export const stories: Story[] = [{
  name: 'Issue card editor',
  group: 'Settings',
  what: 'Settings › Fields and cards › Issue card, on a desktop: a live preview of one ITSA as the board draws it, then one row per slot. TOP, META, BADGES and FOOT list their items, each with a ⋯ to move it to another slot or hide it, and a + to add one from the Available list. The key and the title are fixed; the title sets its lines (1 to 3). The Available list holds the hidden items, with a search. Reset to default restores the seeded card. Every change saves at once.',
  when: 'Settings, Fields and cards, Issue card tab (`#cfg=fields/issue`), on a desktop pane. On a phone the tab is the touch editor (IssueCardPhoneEditor).',
  code: ['web/src/itsa/IssueCardEditor.tsx#IssueCardEditor', 'web/src/views/WorkColumnsSettings.tsx#WorkColumnsSettings'],
  rules: [
    'Its colours, sizes and spacing are tokens only; each slot row is a flex line with `--space-3` between its name and its items, and the chips use the badge spec (' + ds('Cards') + ').',
    'A slot at its cap (TOP 3, META 5, FOOT 3) disables its +, and its ⋯ menu greys the full slot. BADGES has no cap and clips.',
    'The key and the title are locked: they show with a lock and take no ⋯ or +.',
    'Menus open under their trigger, one at a time, and close on a choice; a choice is announced in the status line under the editor (aria-live).',
    'The preview is a real issue card (`IssueCard`, board size): it is the card a board draws from the same layout, so the editor shows what the human will see.',
    'Drag (pointer or touch) lifts a chip from its slot or from Available; the ghost follows the pointer 1:1, the source dims to 50% in place, and the gap (`drop-fill`, `drop-border`) takes the chip’s height where it would land. Dropping on Available hides it. No motion on reflow.',
    'Keys: Space lifts a chip, the arrows move it within its slot or to the slot above or below (Available counts as a slot), Space drops it and Escape puts it back. Delete or Backspace hides it. A key-lifted chip is raised at full opacity and already sits in its candidate place, with no gap. The chips are one roving tab stop grid. Every step is announced in the status line (aria-live).',
    'A move the model refuses (a locked item, a slot at its cap, Links against a link kind) keeps the layout and hangs its reason under that slot, in the error colour, over the rows below: no row moves when it shows. A drop writes once, when it changes the layout.',
  ],
  states: [
    { name: 'Defaults', render: () => editor(defaultCardLayout('issue')) },
    { name: 'A slot at its cap', render: () => editor(metaFull) },
    { name: 'The + menu of Badges open', height: 520, overlay: '.ice-menu', render: () => <OnMount run={openAdd}>{editor(defaultCardLayout('issue'))}</OnMount> },
    { name: 'Available list empty', render: () => editor(everyPlaced) },
    { name: 'No ITSAs yet: the sample preview', render: () => editor(defaultCardLayout('issue'), []) },
    { name: 'After Reset', render: () => editor(resetIssueLayout(FIELDS)) },
    { name: 'A chip lifted from the keyboard, moved to its place', render: () => <OnMount run={pressKeys('owner', [' ', 'ArrowDown'])}>{editor(emptyBadges)}</OnMount> },
    { name: 'A refused step, with its reason', render: () => <OnMount run={pressKeys('updated', [' ', 'ArrowUp'])}>{editor(metaFullRefusal)}</OnMount> },
  ],
}]
