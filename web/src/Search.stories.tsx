import { SearchPalette } from './Search'
import { OnMount } from './stories/helpers'
import { ds, type Story } from './stories/types'
import { setUi } from './ui/state'
import type { SearchResult } from './types'

const R = (kind: SearchResult['kind'], id: string, title: string, o: Partial<SearchResult> = {}): SearchResult => ({ kind, id, title, score: 1, ...o })
const RESULTS: SearchResult[] = [
  R('agent', 'fx-dev', 'fixture-dev', { snippet: 'developer · working on the fixture change', meta: 'fixture-machine' }),
  R('agent', 'fx-review', 'fixture-review', { snippet: 'reviewer', meta: 'fixture-machine' }),
  R('thread', 't1', 'Fixture thread: which option to pick', { snippet: 'The fixture reviewer found nothing to change.', meta: '2 h ago' }),
  R('itsa', 'i1', 'F-1 Fixture issue', { snippet: 'in progress', meta: 'F-1' }),
  R('setting', 's1', 'Fixture setting', { snippet: 'Settings · Notifications', section: 'notify' }),
]
// Types a query into the box the way a person does, so the palette asks for results.
const type = (text: string) => (el: HTMLElement) => {
  const input = el.ownerDocument.getElementById('search-all') as HTMLInputElement
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
const open = () => setUi({ searchOpen: true })

export const stories: Story[] = [{
  name: 'Search palette',
  group: 'Tree and shell',
  what: "One search box over the agents, the human's mail threads, the ITSAs, and Settings. Results come ranked from the daemon and are grouped by kind (Agents, Mail, Issues, Settings); each row has an icon (an agent's mark), a title, an excerpt, and a short meta. Choosing a result opens the agent's world, the thread, the issue, or the Settings section.",
  when: "Ctrl+K or Cmd+K on a desktop (the sidebar's filter box there only filters the agent tree); on a phone, the Search bar at the top of the Agents tab. It opens empty with the caret in the box; Esc, the close button, or the scrim closes it. The query waits 120 ms after the last keystroke, asks for up to 24 results, and drops an answer a later keystroke has outdated.",
  code: ['web/src/Search.tsx#SearchPalette', 'web/src/Search.tsx#openSearch', 'web/src/Search.tsx#toggleSearch'],
  rules: [
    'The panel is a raised overlay: `--overlay-panel-bg`, `--radius-lg`, `--shadow-raised`, over `--surface-scrim`; it is the width of the screen minus 32 px up to 640 px, and at most 72vh or 640 px high (' + ds('Menus, overlays, and inputs') + ').',
    'The input row is 48 px; a result row is `--size-row-menu`, and the selected row uses `--accent-subtle`. Arrow keys move the selection, Home and End jump, Enter opens it.',
    'On a phone (760 px and below) the panel fills the screen above the navigation, with no scrim and no entry animation; the input and each result become touch targets of at least `--size-hit-touch`, and a result grows to two lines, its title over its excerpt.',
    'The panel enters with the top-drop motion over `--duration-slow` (' + ds('Motion') + ').',
  ],
  states: [
    { name: 'Empty', height: 420, overlay: '#search-palette', setup: open, render: () => <SearchPalette /> },
    { name: 'Results, grouped by kind', height: 520, overlay: '#search-palette', routes: { 'GET /api/search': RESULTS }, setup: open, render: () => <OnMount run={type('fixture')}><SearchPalette /></OnMount> },
    { name: 'No matches', height: 420, overlay: '#search-palette', routes: { 'GET /api/search': [] }, setup: open, render: () => <OnMount run={type('zzzz')}><SearchPalette /></OnMount> },
  ],
}]
