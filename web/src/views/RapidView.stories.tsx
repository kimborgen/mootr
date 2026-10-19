import { RapidView } from './RapidView'
import { pickOf, setPick } from './rapid'
import { ds, type Story } from '../stories/types'
import { rapidThreads } from '../stories/mailFixtures'

const FEW = rapidThreads(3)
const MANY = rapidThreads(40)
const view = (h = 420) => <div style={{ height: h, display: 'flex', flexDirection: 'column' }}><RapidView id="fx-dev" /></div>

export const stories: Story[] = [{
  name: 'Rapid-fire mode',
  group: 'Mail',
  what: 'An agent\'s conversation as a column of mail cards, one per thread between you and the agent, oldest at the top and the newest at the bottom by the prompt input. Each card speaks for the first mail you sent in its thread, and its head for who wrote last. Every send starts a new thread; a tap picks a card, and sends follow up in its thread until a second tap, the ✕ in the prompt input, or Esc unpicks it. ↑ in an empty prompt input picks the newest card. The picked card offers Open, for the whole thread. The list comes from the daemon by agent, so an agent\'s old threads stay reachable: when a box has more, Load older threads at the top fetches 60 more.',
  when: 'The Rapid-fire choice in an agent\'s view switch (the ⚡ toggle on a phone), remembered per agent on this device; it shows in place of the conversation (`view:ID`).',
  code: ['web/src/views/RapidView.tsx#RapidView', 'web/src/views/rapid.ts#rapidThreads', 'web/src/views/rapid.ts#rapidTarget'],
  rules: [
    'The column is `--measure-conversation` wide, as the conversation is; cards sit `--space-2` apart, so many fit (' + ds('Density') + ').',
    'The picked card is `--accent-subtle` with its border, never a solid accent fill (' + ds('Developer rules') + ').',
    'Load older threads shows only while a box has more, and keeps the cards you were reading in place (' + ds('Density') + ').',
    'Open and the prompt input\'s ✕ are `--size-hit-touch` on a phone (' + ds('Density') + ').',
  ],
  states: [
    { name: 'Empty', data: { humanThreads: [] }, render: () => view(240) },
    { name: 'A few threads', data: { humanThreads: FEW }, setup: () => setPick('fx-dev', null), render: () => view() },
    { name: 'Picked', data: { humanThreads: FEW }, setup: () => setPick('fx-dev', pickOf(FEW[1], 'fx-dev')), render: () => view() },
    { name: 'Older threads to load', data: { humanThreads: MANY, rapidWith: { 'fx-dev': { threads: [], more: true } } }, setup: () => setPick('fx-dev', null), render: () => view(600) },
    { name: 'Forty threads', data: { humanThreads: MANY }, setup: () => setPick('fx-dev', null), render: () => view(600) },
  ],
}]
