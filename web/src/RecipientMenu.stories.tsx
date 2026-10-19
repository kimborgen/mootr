import { Glyph, PlainGlyph } from './Glyph'
import { RecipientMenu, makeRecipStore, type Recip } from './RecipientMenu'
import type { CcItem } from './cc-pills'
import { agent, byName } from './stories/fixtures'
import { ds, type Story } from './stories/types'

const dev = byName('fixture-dev')
const cos = byName('fixture-cos')
const noop = () => {}
const recips = (): Recip[] => [
  { id: null, name: dev.name, tag: 'current', glyph: <Glyph agent={dev} /> },
  { id: cos.id, name: cos.name, tag: 'parent', glyph: <Glyph agent={cos} /> },
  { id: 'assistant', name: 'Assistant', tag: 'executive assistant', glyph: <PlainGlyph name="bot" /> },
]
// The popover's body, drawn in the flow (the real one is fixed to the viewport by the menu layer).
function Body({ cc = [], picked = null, ccOk = true, items = [] }: { cc?: string[]; picked?: string | null; ccOk?: boolean; items?: CcItem[] }) {
  const store = makeRecipStore()
  store.set({ recips: recips(), picked, cc, ccOk, to: dev.id, pick: noop, toggle: noop, items, drop: noop })
  return <div className="story-pad"><div className="menu popover" role="dialog" aria-label="Recipient" style={{ position: 'static' }}><RecipientMenu store={store} /></div></div>
}
const many = Array.from({ length: 9 }, (_, i) => agent({ id: `fx-many-${i}`, name: `fixture-helper-${i + 1}`, role: 'developer', parents: [cos.id] }))

export const stories: Story[] = [{
  name: 'Recipient menu',
  group: 'Composer',
  what: "The menu the stam icon in the prompt input opens. Write to: the current agent, its parent, intake, cos and the assistant (those that exist, each agent once), the choice ticked; picking one closes the menu and the message goes there. cc: ticks for the agents already cc'd and for cos, intake and the assistant, and a search that finds any live agent by name or role; a tick toggles and keeps the menu open. cc only shows where the message goes as mail (Mail mode, or a message to an agent chosen here). The recipient is never listed as a cc. A thread or ITSA picked from the prompt input's cc pills (S-1464) lists first, ticked, saying what it does: a thread's participants get the mail, an ITSA has it filed on it; a click drops it.",
  when: 'Click the stam icon in the bottom bar or any other prompt input (`web/src/Composer.tsx#Composer`). It opens upward from the icon as a popover; on a phone it is a bottom sheet.',
  code: ['web/src/RecipientMenu.tsx#RecipientMenu', 'web/src/RecipientMenu.tsx#makeRecipStore', 'web/src/ui/menu.tsx#showPopover', 'web/src/actions.tsx#assistantOpts'],
  rules: [
    'It is the menu layer\'s popover (`--menu-bg`, `--radius-md`, `--shadow-float`, ' + ds('Modals and menus') + '), opening upward from the icon and capped to the room above, so it never runs off the screen; the cc rows scroll inside it.',
    'Write to rows are radios and cc rows are checkboxes, each with a tick (never colour alone), `--size-row-menu` high and `--size-hit-touch` on a phone, as is the search field.',
    'Arrow keys, Home and End move between rows; Enter in the search ticks the first match; Escape closes it and returns the focus to the icon. Focus starts on the current recipient.',
    'The icon carries the state when the menu is closed: its label reads "Recipient: name, cc N", and it takes the accent and a +N badge while a cc or another recipient is chosen.',
  ],
  states: [
    { name: 'Default (Mail mode)', render: () => <Body /> },
    { name: 'cc chosen', render: () => <Body cc={['fx-review', 'fx-ops']} /> },
    { name: 'Many cc (the list scrolls)', data: { agents: [...many, byName('fixture-cos'), dev, byName('fixture-review'), byName('fixture-ops')] }, render: () => <Body cc={many.map((a) => a.id)} /> },
    { name: 'Picked from the cc pills', render: () => <Body cc={['fx-review']} items={[{ kind: 'thread', id: 'th-fx', title: 'Fixture build fails on the example module', people: ['fx-ops', 'fx-wait'] }, { kind: 'itsa', id: 'it-fx', title: 'S-1 Example', people: [] }]} /> },
    { name: 'Assistant chosen', render: () => <Body picked="assistant" /> },
    { name: 'Direct mode (no cc)', render: () => <Body ccOk={false} /> },
  ],
}]
