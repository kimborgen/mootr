import { AgentsPage } from './AgentsPage'
import { setAgentsView } from './agents-table-view'
import type { Scope } from './agents-table'
import { AGENTS, agent } from './stories/fixtures'
import { pane, seedShell } from './stories/shell'
import { type Story } from './stories/types'
import { setUi } from './ui/state'
import type { Agent } from './types'

// The page's own world: one pane holding the Agents view, as the Agents icon opens it.
const page = seedShell({ current: 'w:agents', worlds: { 'w:agents': pane('p0', ['agents']) } })
// The tree's folds, filter and stopped list, reset by every state, and the detail pane shut (S-3048).
const quiet = () => { setUi({ collapsed: {}, stoppedOpen: false, filter: '', treeFocus: null }); setAgentsView({ pane: false }, { remember: false }) }
// The page as a state names it: its folds reset and its scope set on screen only, so no story saves the human's view.
const at = (scope: Scope) => () => { quiet(); setAgentsView({ scope }, { remember: false }); page.setup() }
// The desk with its detail pane open or shut, in a scope, for the row a state picks (S-3048).
const withPane = (scope: Scope, pane: boolean) => () => { quiet(); setAgentsView({ scope, pane }, { remember: false }); page.setup() }

// A realistic fleet: a chief of staff, managers under it, and developers, reviewers and testers under them, with several working and waiting.
const FLEET: Agent[] = [
  agent({ id: 'fl-cos', name: 'fixture-cos', role: 'chief of staff', chief_of_staff: true }),
  ...Array.from({ length: 3 }, (_, m) => agent({ id: `fl-m${m}`, name: `fixture-manager-${m + 1}`, role: 'manager', parents: ['fl-cos'], activity: m === 0 ? 'working' : 'idle', created_at: `2026-10-01T09:0${m + 1}:00.000Z` })),
  ...Array.from({ length: 20 }, (_, i) => agent({
    id: `fl-a${i}`, name: `fixture-agent-${i + 1}`, role: ['developer', 'reviewer', 'tester'][i % 3], harness: ['claude', 'codex', 'opencode'][i % 3],
    model: ['claude-opus-5-5', 'gpt-6.1-sol', 'claude-sonnet-5-5'][i % 3], parents: [`fl-m${i % 3}`], activity: ['working', 'idle', 'waiting', 'idle'][i % 4],
    context_tokens: 40000 + i * 15000, context_level: i > 16 ? 2 : i > 10 ? 1 : 0, created_at: `2026-10-01T10:${String(i).padStart(2, '0')}:00.000Z`,
  })),
]

// Scope fixtures (S-2937): five shut-down agents and a long archive, each updated at its own time, the newest first.
const STOPPED: Agent[] = Array.from({ length: 5 }, (_, i) => agent({
  id: `st-${i}`, name: `fixture-stopped-${i + 1}`, role: 'developer', lifecycle: 'shut_down', activity: 'idle', activity_detail: null,
  created_at: `2026-10-01T08:0${i}:00.000Z`, updated_at: `2026-10-20T1${i}:00:00.000Z`,
}))
const ARCHIVED: Agent[] = Array.from({ length: 300 }, (_, i) => agent({
  id: `ar-${i}`, name: `fixture-archived-${i + 1}`, role: ['developer', 'reviewer', 'tester'][i % 3], lifecycle: 'archived', activity: 'idle', activity_detail: null,
  created_at: `2026-09-${String(1 + (i % 28)).padStart(2, '0')}T10:00:00.000Z`, updated_at: `2026-10-${String(1 + (i % 20)).padStart(2, '0')}T09:00:00.000Z`,
}))
// The fleet, its stopped and archived agents beside the live ones, for the scope states.
const SCOPED: Agent[] = [...FLEET, ...STOPPED, ...ARCHIVED.slice(0, 12)]

export const stories: Story[] = [{
  name: 'Agents page',
  group: 'Tree and shell',
  what: "The Agents page (`w:agents`, S-1428, S-1432): on the desktop, the agents table under a header with the title, the live count, the grouping, the search, the column picker and the legend. The count of asks, permissions and waits is one source with the sidebar's and the bottom bar's. On a phone the page keeps the agent tree until the phone list (a later PR).",
  when: 'When the Agents icon in the sidebar footer, or the Agents tab header in the sidebar, opens its page. The page is a world of its own, so it can be split, tabbed and remembered like Settings or Usage.',
  code: ['web/src/AgentsPage.tsx#AgentsPage', 'web/src/Tree.tsx#Tree'],
  rules: [
    'The header is `--size-tab-bar` (36 px) high, with the title in chrome-large and the counts in chrome-small, muted; the waiting count takes the warning ink and reads "asks or waits", what it counts. Its controls are `.icon-btn` or the field height `--size-row-table`.',
    'Scope chips (Live, Waiting, Stopped, Archived) are a `.seg` with each count. Live is the default and the header count stays the live count whatever the scope. The chosen scope is kept in the view record with the grouping. Waiting counts the live agents with a permission request open or any wait (a timer, an agent, children, a job, an event or the human); Stopped and Archived are the agents with that lifecycle, listed in the same table.',
    'An archive of hundreds shows its first 100 rows, then a button shows the next 100; nothing is fetched per scope, so the archived agents come from the same list the sidebar\'s Stopped section reads.',
    'The table is the Agents table (AgentsTable.stories.tsx): the grouping and the columns are kept in settings, so a choice follows the human to every device.',
    'On a phone (360-760 px wide) the page is the sidebar\'s tree, with its two header buttons. The tree carries no `#tree` id here: the sidebar\'s tree keeps it.',
    'Counts are one source, as the sidebar\'s and the bottom bar\'s: live agents are the running ones. The header\'s "asks or waits" is the human\'s waiting list (`useWaiting`: the asks that wait on you), a different count from the Waiting chip.',
    'The detail pane (S-3048) is the right side of the desk: `DetailsView` for the picked row, 420 px wide. A row is picked by a click or the arrow keys, and stays picked through polls, re-sorts and a scope that still lists it. Space shows or hides the pane, but not while focus is in a field. It is open from a 1100 px desk on, until the human presses Space, and below 900 px an open pane lies over the table.',
  ],
  states: [
    { name: 'A fleet of 24', data: { agents: FLEET }, routes: page.routes, setup: () => { quiet(); page.setup() }, render: () => <AgentsPage /> },
    { name: 'Live and waiting', data: { agents: AGENTS }, routes: page.routes, setup: () => { quiet(); page.setup() }, render: () => <AgentsPage /> },
    { name: 'No agents', data: { agents: [] }, routes: page.routes, setup: () => { quiet(); page.setup() }, render: () => <AgentsPage /> },
    { name: 'Scope: Live', data: { agents: SCOPED }, routes: page.routes, setup: at('live'), render: () => <AgentsPage /> },
    { name: 'Scope: Waiting', data: { agents: SCOPED }, routes: page.routes, setup: at('waiting'), render: () => <AgentsPage /> },
    { name: 'Scope: Stopped', data: { agents: SCOPED }, routes: page.routes, setup: at('stopped'), render: () => <AgentsPage /> },
    { name: 'Scope: Archived', data: { agents: SCOPED }, routes: page.routes, setup: at('archived'), render: () => <AgentsPage /> },
    { name: 'Scope: Archived, none', data: { agents: FLEET }, routes: page.routes, setup: at('archived'), render: () => <AgentsPage /> },
    { name: 'Scope: Archived, 300 paged', data: { agents: [...FLEET, ...ARCHIVED] }, routes: page.routes, setup: at('archived'), render: () => <AgentsPage /> },
    { name: 'Pane open, live agent', data: { agents: AGENTS }, routes: page.routes, setup: withPane('live', true), render: () => <AgentsPage picked="fx-dev" /> },
    { name: 'Pane open, waiting agent', data: { agents: AGENTS }, routes: page.routes, setup: withPane('live', true), render: () => <AgentsPage picked="fx-review" /> },
    { name: 'Pane open, archived agent', data: { agents: SCOPED }, routes: page.routes, setup: withPane('archived', true), render: () => <AgentsPage picked="ar-0" /> },
    { name: 'Pane open, no agent picked', data: { agents: AGENTS }, routes: page.routes, setup: withPane('live', true), render: () => <AgentsPage /> },
    { name: 'Pane closed', data: { agents: AGENTS }, routes: page.routes, setup: withPane('live', false), render: () => <AgentsPage picked="fx-dev" /> },
  ],
}]
