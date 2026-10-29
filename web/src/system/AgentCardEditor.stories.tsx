import { defaultCardLayout, type CardLayout } from '../card-layout'
import { setHairline, setIssueOn, placeItem, resetAgentLayout } from '../agent-layout'
import { AGENTS } from '../stories/fixtures'
import { FIELDS, TREE } from '../stories/itsaFixtures'
import { OnMount } from '../stories/helpers'
import { ACTIVITY, COSTS } from '../stories/workFixtures'
import { ds, type Story } from '../stories/types'
import { cardItemsFor } from '../work/card-items'
import type { WorkExtras } from '../work/data'
import { AgentCardEditor, AgentCardPhoneEditor } from './AgentCardEditor'

const extras: WorkExtras = { costs: COSTS, activity: ACTIVITY, watch: {}, fields: null, fieldsFailed: false, fieldsStart: 0 }
const items = cardItemsFor('agent', FIELDS)
const issue = defaultCardLayout('issue')

// The desktop editor as the Agent card tab draws it: its layout is given, and its changes go nowhere (a story does not save).
const editor = (layout: CardLayout, agents = AGENTS) => (
  <div style={{ width: 'var(--size-pane-min)', minWidth: 600 }}>
    <AgentCardEditor layout={layout} issue={issue} items={items} fields={FIELDS} agents={agents} itsas={TREE} extras={extras} onChange={() => {}} onReset={() => {}} />
  </div>
)
// The phone editor as the Agent card tab draws it on a phone.
const phone = (layout: CardLayout) => (
  <AgentCardPhoneEditor layout={layout} issue={issue} items={items} fields={FIELDS} agents={AGENTS} itsas={TREE} extras={extras} onChange={() => {}} onReset={() => {}} />
)
// The ISSUE switch off: the nested issue card is not drawn, and its switch reads off.
const issueOff = setIssueOn(defaultCardLayout('agent'), false)
// A context badge moved in front of Health, and the hairline off.
const moved = setHairline(placeItem(defaultCardLayout('agent'), 'context', 'BADGES', 0), false)
// The ⋯ menu of Health, opened by its button once the editor has drawn.
const openMenu = (el: HTMLElement) => { el.querySelector<HTMLButtonElement>('[aria-label="Options for Health"]')?.click() }
const tap = (sel: string) => (el: HTMLElement) => { el.querySelector<HTMLButtonElement>(sel)?.click() }

export const stories: Story[] = [{
  name: 'Agent card editor',
  group: 'Settings',
  what: 'Settings › Fields and cards › Agent card, on a desktop: a live preview of the real agent card for the agent picked, then one row per slot. HEAD holds the mark and the name, locked, then the items the layout places (by default the model and the cost). ISSUE is a switch: the nested issue card is on or off, and its contents are the Issue card tab\'s. BADGES and FOOT list their items, each with a ⋯ to move it or hide it, and a + to add one from the Available list. The context hairline is a switch under the Available list. Reset to default restores the default card. Every change saves at once.',
  when: 'Settings, Fields and cards, Agent card tab (`#cfg=fields/agent`), on a desktop pane. On a phone the tab is the touch editor (AgentCardPhoneEditor).',
  code: ['web/src/system/AgentCardEditor.tsx#AgentCardEditor', 'web/src/CardEditor.tsx#CardEditor', 'web/src/views/WorkColumnsSettings.tsx#WorkColumnsSettings'],
  rules: [
    'Its colours, sizes and spacing are tokens only, and the editor shares the issue card editor\'s rows and chips (' + ds('Cards') + ').',
    'The mark and the name are locked: they show with a lock and take no ⋯ or +. The ISSUE switch sets the nested card; the issue item is never a chip.',
    'The preview is the real agent card (`SystemCard`), drawn with the view\'s layouts: its height is the card\'s, 96 px with the default layout, and a card with ISSUE off is one row shorter.',
    'A move the model refuses (a locked item, a slot at its cap, the issue placed anywhere but ISSUE) keeps the layout and says why in the menu and under the slot.',
  ],
  states: [
    { name: 'Defaults', render: () => editor(defaultCardLayout('agent')) },
    { name: 'ISSUE off: the nested card is not drawn', render: () => editor(issueOff) },
    { name: 'A badge moved to the front, the hairline off', render: () => editor(moved) },
    { name: 'The ⋯ menu of Health open', height: 520, overlay: '.ice-menu', render: () => <OnMount run={openMenu}>{editor(defaultCardLayout('agent'))}</OnMount> },
    { name: 'No agents yet', render: () => editor(defaultCardLayout('agent'), []) },
    { name: 'After Reset', render: () => editor(resetAgentLayout(FIELDS)) },
  ],
}, {
  name: 'Agent card phone editor',
  group: 'Settings',
  what: 'Settings › Fields and cards › Agent card at 360-430 px, touch: the same layout as the desktop editor, one list per slot under a sticky preview of the agent card. A row\'s handle ⠿ lifts it on a long press; ↑ and ↓ move it within its slot and across a slot boundary; ⋯ opens a sheet of moves, with a refused one disabled and its reason shown. + Add to card lists the hidden items. The ISSUE switch and the hairline are the same settings as on a desktop.',
  when: 'Settings, Fields and cards, Agent card tab (`#cfg=fields/agent`), on a phone (360-430 px).',
  code: ['web/src/system/AgentCardEditor.tsx#AgentCardPhoneEditor', 'web/src/CardPhoneEditor.tsx#CardPhoneEditor'],
  rules: [
    'Each row is `--size-hit-touch` tall; its handle, ↑, ↓ and ⋯ are each `--size-hit-touch`. A locked row has a lock and no controls (' + ds('Cards') + ').',
    'The preview is sticky at the top of the tab and scales to the width; the page has no sideways scroll at 360 px.',
  ],
  states: [
    { name: 'Defaults', render: () => phone(defaultCardLayout('agent')) },
    { name: 'ISSUE off', render: () => phone(issueOff) },
    { name: 'The ⋯ sheet of Health', height: 640, overlay: '.menu.popover', render: () => <OnMount run={tap('[data-item="health"] [data-act=menu]')}>{phone(defaultCardLayout('agent'))}</OnMount> },
    { name: 'The Add sheet', height: 640, overlay: '.menu.popover', render: () => <OnMount run={tap('.ipe-add')}>{phone(defaultCardLayout('agent'))}</OnMount> },
  ],
}]
