import { defaultCardLayout, type CardLayout } from '../card-layout'
import { FIELDS, TREE } from '../stories/itsaFixtures'
import { OnMount } from '../stories/helpers'
import { ACTIVITY, COSTS } from '../stories/workFixtures'
import { ds, type Story } from '../stories/types'
import { cardItemsFor } from '../work/card-items'
import type { WorkExtras } from '../work/data'
import { IssueCardPhoneEditor } from './IssueCardPhoneEditor'
import { resetIssueLayout } from './issue-layout'

const extras: WorkExtras = { costs: COSTS, activity: ACTIVITY, watch: {}, fields: null, fieldsFailed: false, fieldsStart: 0 }
const items = cardItemsFor('issue', FIELDS)

// The phone editor as the Issue card tab draws it on a phone: its layout is given, and its changes go nowhere (a story does not save).
const editor = (layout: CardLayout, itsas = TREE) => (
  <IssueCardPhoneEditor layout={layout} items={items} fields={FIELDS} itsas={itsas} extras={extras} onChange={() => {}} onReset={() => {}} />
)
// Top full (its cap is 3), Status in Meta: a step up from Meta is refused, and its reason shows under Top.
const topFull: CardLayout = { ...defaultCardLayout('issue'), slots: { TOP: ['parent', 'kind', 'rollup'], META: ['status', 'links', 'owner', 'updated', 'health'], BADGES: [], FOOT: [] }, chosen: true }
// The ⋯ sheet of Status, with Top full: its Move to Top is disabled and says why.
const tap = (sel: string) => (el: HTMLElement) => { el.querySelector<HTMLButtonElement>(sel)?.click() }

export const stories: Story[] = [{
  name: 'Issue card phone editor',
  group: 'Settings',
  what: 'Settings › Fields and cards › Issue card, on a phone: the same card as the desktop editor, edited by touch. A sticky live preview of one ITSA as the board draws it, then one list per slot: TOP, TITLE (locked, with its 1, 2 or 3 lines), META, BADGES and FOOT. Each row has a handle to drag, ↑ and ↓ (which cross slot boundaries), and a ⋯ sheet with Move to a slot and Hide. + Add to card opens a sheet of the hidden fields, each with the slot it goes to.',
  when: 'Settings, Fields and cards, Issue card tab (`#cfg=fields/issue`), on a phone.',
  code: ['web/src/itsa/IssueCardPhoneEditor.tsx#IssueCardPhoneEditor', 'web/src/itsa/issue-layout.ts#destination', 'web/src/views/WorkColumnsSettings.tsx#WorkColumnsSettings'],
  rules: [
    'Every row is `--size-hit-touch` tall, and so is every control in it: the handle, ↑, ↓ and ⋯. The key and title rows are locked, with a lock and no controls.',
    'Every write is the model\'s move (issue-layout.ts `moveTo`); a refused step writes nothing and shows its reason under the slot it was for, in the error colour. A slot at its cap is named in its header ("2 of 3").',
    'A long press of the handle (`--duration-hold`) lifts the row; a drop between rows or across slots writes once. Travel before the hold is a scroll and cancels it; Escape or a touch cancel puts the row back, and writes nothing.',
    'The sheets are the menu layer (`showPopover`): a bottom sheet on a phone over a scrim. A choice the slot refuses is disabled, with its reason beside it. Each choice closes the sheet and is announced in the status line under the list (aria-live).',
    'The layout is the same one the desktop editor writes, so an edit here shows on the desktop, on the board, and in a split view at once.',
    'No horizontal scroll at 360 or 430 px. Colours, sizes and spacing are tokens only (' + ds('Density') + ').',
  ],
  states: [
    { name: 'Defaults', render: () => editor(defaultCardLayout('issue')) },
    { name: 'A refused step, with its reason', render: () => <OnMount run={tap('[data-item="status"] [data-act=up]')}>{editor(topFull)}</OnMount> },
    { name: 'The ⋯ sheet, with a disabled reason', height: 640, overlay: '.menu.popover', render: () => <OnMount run={tap('[data-item="status"] [data-act=menu]')}>{editor(topFull)}</OnMount> },
    { name: 'The Add sheet', height: 640, overlay: '.menu.popover', render: () => <OnMount run={tap('.ipe-add')}>{editor(defaultCardLayout('issue'))}</OnMount> },
    { name: 'No ITSAs yet: the sample preview', render: () => editor(defaultCardLayout('issue'), []) },
    { name: 'After Reset', render: () => editor(resetIssueLayout(FIELDS)) },
  ],
}]
