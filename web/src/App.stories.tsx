import { App } from './App'
import { AGENTS } from './stories/fixtures'
import { pane, seedShell } from './stories/shell'
import { ds, type Story } from './stories/types'
import * as shell from './shell/layout'
import { setUi } from './ui/state'
import { rapidThreads } from './stories/mailFixtures'
import { pickOf, setPick, setRapid } from './views/rapid'

const quiet = () => setUi({ collapsed: {}, stoppedOpen: false, filter: '', treeFocus: null, searchOpen: false, topOpen: false, rapid: {} })
const seeded = seedShell({ current: 'fx-dev', worlds: { 'fx-dev': pane('p0', ['details:fx-dev']) } })
const conv = seedShell({ current: 'fx-dev', worlds: { 'fx-dev': pane('p0', ['view:fx-dev']) } })
const WITH_VIEW = AGENTS.map((a) => (a.id === 'fx-dev' ? { ...a, view: { can_stream: true, can_send: true, can_interrupt: true, can_approve: true } } : a))
const RAPID = rapidThreads(8)
const home = seedShell({ current: null, worlds: {} })
// Frames are fixed at the page's size, so the whole app needs a height of its own.
const HEIGHT = 720

export const stories: Story[] = [{
  name: 'App frame',
  group: 'Tree and shell',
  fit: 'page',
  what: "The whole page. On a desktop: the left sidebar (search, add agent, a stack of tabbed panes holding the agent tree, Issues with Requirements, Mail, and Machines, and a footer with theme, Settings, Usage, System view, Process view, and this daemon's machine), the centre column (the main world, whose agent tabs carry wait badges, the bottom prompt input), the executive assistant dropping down from the top, and the search palette over everything. On a phone the sidebar and the main world take turns, and a bottom navigation switches between Agents, Mail, Issues, Main, Work, and Assistant.",
  when: 'Every page of the web UI. The layout of the main world is the daemon\'s; the sidebar\'s size and whether it is open are per browser. A separator between the sidebar and main drags, and a click on it closes the sidebar; a reveal button fades in near the edge of a closed side world. Alt+1 and Alt+2 enter the tree view, Alt+A opens the prompt that suggests where a message goes, Alt+C opens the assistant and moves between it and the chiefs of staff, Ctrl+K or Cmd+K opens search (on a phone, the Search bar at the top of the Agents tab does), and `e` archives the open mail thread.',
  code: ['web/src/App.tsx#App', 'web/src/App.tsx#TopWorld', 'web/src/App.tsx#paneTarget', 'web/src/composer-target.ts#bottomTarget', 'web/src/bottom-slot.ts#setBottomSlot'],
  rules: [
    'On a desktop there is one prompt input, always in the bottom world, and its target follows the main world (`bottomTarget`, S-1436): an agent (also from its mail, details, instructions and inventory tabs), a terminal, a mail thread, an ITSA, or the chief of staff on Work. A thread and an ITSA publish their own send (staged answers, notes, the staged action) through `bottom-slot.ts`, and render no box of their own. A staged image\'s tab (S-1475) only shows what the input holds: the input keeps following the tab under it (`inputMain`), whatever its kind. An agent\'s own view (`view:`) where its view takes no prompts has Direct off, with the terminal as its reason, and Mail on; while its turn runs with an empty box, the send button is Stop (`onStop`, from `ownview-live.ts`). Where nothing can be written to (Settings, Usage, Process, a requirement, nothing selected) the input stays and enters suggestion mode (S-1474): it suggests a recipient as you type like Alt+A, sends mail only, and each mail carries a system note with the one-line context of what the main world showed. The Alt+A and Alt+C top worlds keep their own input. A phone keeps each view\'s own box, and shows the bar in suggestion mode where nothing can be written to.',
    'Two layouts, one tree: at 760 px and below the shell is the phone layout (one pane, the sidebar as a full tab, the bottom navigation), above it the desktop layout. Neither is the fallback of the other; every change is checked at 360 and at 1280 px.',
    'The bottom navigation is `--nav-h` high (`--size-phone-nav` plus the bottom safe-area inset) and hides while the keyboard is up; its buttons split the width and show a badge for what waits on you, counted once so the Mail, Issues, and Work badges agree (' + ds('Density') + ').',
    'The assistant\'s drop-down and the search palette are both overlays at `--z-top-overlay` over a `--surface-scrim` (no scrim on a phone\'s search); Escape closes the topmost first: the image viewer, then search, then the assistant.',
    'A right-click or long press opens the pane menu (this pane, then stam, then layout), except on inputs, tree rows, rendered mail, and code; on a phone it is one menu with the agent\'s actions first.',
    'Issues, Requirements, and Machines fold within the sidebar; Mail does not fold but switches between its lists (Mail, Awaiting reply, Archived, Deferred), and the Mail and Issues sections resize by their separators.',
    'The footer holds one icon per page world (Settings, Usage, System view, Process view) and this daemon\'s machine name; the global menu repeats them.',
    'The theme button cycles system, light, and dark; the choice is kept per browser.',
    'In an agent\'s rapid-fire mode (S-1004) the bottom prompt input mails it: its target line says "New thread to NAME", or "Follow-up in" the picked card\'s text (on a phone the reply arrow alone, so the text gets the room) with a ✕ (a `--size-hit-touch` target on a phone) that goes back to new threads.',
  ],
  states: [
    { name: 'An agent selected', height: HEIGHT, overlay: '#shell', data: { agents: AGENTS }, routes: seeded.routes, setup: () => { quiet(); seeded.setup() }, render: () => <App /> },
    { name: 'No agent selected', height: HEIGHT, overlay: '#shell', data: { agents: AGENTS }, routes: home.routes, setup: () => { quiet(); home.setup() }, render: () => <App /> },
    { name: 'Phone: the Agents tab', height: HEIGHT, overlay: '#shell', data: { agents: AGENTS }, routes: seeded.routes, setup: () => { quiet(); seeded.setup(); setTimeout(() => shell.phoneShow('left'), 100) }, render: () => <App /> },
    { name: 'Rapid-fire, a card picked', height: HEIGHT, overlay: '#shell', data: { agents: WITH_VIEW, humanThreads: RAPID }, routes: conv.routes,
      setup: () => { quiet(); setRapid('fx-dev', true); setPick('fx-dev', pickOf(RAPID[5], 'fx-dev')); conv.setup() }, render: () => <App /> },
    { name: 'Search open', height: HEIGHT, overlay: '#search-palette', data: { agents: AGENTS }, routes: seeded.routes, setup: () => { quiet(); seeded.setup(); setUi({ searchOpen: true }) }, render: () => <App /> },
  ],
}]
