import { AgentsPage, AgentsPhone } from './AgentsPage'
import { OnMount } from './stories/helpers'
import { setAgentsView } from './agents-table-view'
import type { Scope } from './agents-table'
import { AGENTS, agent } from './stories/fixtures'
import { pane, seedShell } from './stories/shell'
import { type Story } from './stories/types'
import { setUi } from './ui/state'
import { showMenu } from './ui/menu'
import { agentMenu } from './actions'
import type { Agent, Machine } from './types'

// A machine for the header's strip: its CPU and RAM percentages, online unless it is said to be offline (S-3182).
const GB = 1e9
const machine = (name: string, cpu: number, ram: number, online = true): Machine => ({
  name, online, ts: Date.parse('2026-10-21T09:00:00.000Z'), cpu: { pct: cpu, cores: [cpu], count: 4 }, ram: { pct: ram, used: GB * ram / 10, total: 10 * GB },
  swap: { pct: 0, used: 0, total: 0 }, load: [0.5, 0.6, 0.7],
})
const TWO = [machine('fixture-a', 62, 40), machine('fixture-b', 35, 55)]
// The page's own world: one pane holding the Agents view, as the Agents icon opens it.
const page = seedShell({ current: 'w:agents', worlds: { 'w:agents': pane('p0', ['agents']) } })
// The tree's folds, filter and stopped list, reset by every state, and the detail pane shut (S-3048).
const quiet = () => { setUi({ collapsed: {}, stoppedOpen: false, filter: '', treeFocus: null, agentSelect: false }); setAgentsView({ pane: false }, { remember: false }) }
// The page as a state names it: its folds reset and its scope set on screen only, so no story saves the human's view.
const at = (scope: Scope) => () => { quiet(); setAgentsView({ scope }, { remember: false }); page.setup() }
// The desk with its detail pane open or shut, in a scope, for the row a state picks (S-3048).
const withPane = (scope: Scope, pane: boolean) => () => { quiet(); setAgentsView({ scope, pane }, { remember: false }); page.setup() }
// Checks the rows of the given agents, by their checkboxes, as a click does (S-3117).
const checkRows = (ids: string[]) => (el: HTMLElement) => { for (const id of ids) el.querySelector<HTMLElement>(`tr[data-agent-row="${id}"] td.ac-check`)?.click() }

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
// A manager blocked on an open ask: its phone row's state is the link to the ask (S-3977).
const BLOCKED: Agent[] = [agent({ id: 'bl-m', name: 'fixture-blocked-manager', role: 'manager', waits: [{ kind: 'human' }] as never, open_ask: 'request:fx-ask' })]
const BLOCKED_ASK = { key: 'request:fx-ask', kind: 'request', state: 'open', outcome: null, what: 'Permission request', agent_id: 'bl-m', agent_name: 'fixture-blocked-manager', machine: 'fixture-box-one', thread_id: 'fx-ask-thread', itsa_id: null, since: '2026-10-24T11:00:00.000Z', settled_at: null } as const

// A chain five deep, so the phone list's indent cap and its parent hint show (S-1432): the fifth agent sits at the third level.
const DEEP: Agent[] = Array.from({ length: 5 }, (_, i) => agent({
  id: `dp-${i}`, name: `fixture-deep-${i}`, role: 'developer', parents: i ? [`dp-${i - 1}`] : undefined, activity: i === 4 ? 'waiting' : 'working',
  created_at: `2026-10-01T11:0${i}:00.000Z`,
}))
// The same chain with each parent's own and tree spend, for the row's cost (S-3281): a parent shows "own/tree".
const costOf = (own: number, tree: number) => ({ mode: 'api' as const, own: { api: own, five_hour: null, seven_day: null, subscription: null, paid_usd: 0 }, tree: { api: tree, five_hour: null, seven_day: null, subscription: null, paid_usd: 0 } })
const DEEP_COST: Agent[] = DEEP.map((a, i) => ({ ...a, cost: costOf(160 - i * 20, 352 - i * 40) }))
const PHONE_PAGE = () => { quiet(); setAgentsView({ scope: 'live' }, { remember: false }); page.setup() }
// The phone list in select mode (S-3282), and the rows a state checks by their tap, as a tap on a row does.
const SELECT_PAGE = () => { PHONE_PAGE(); setUi({ agentSelect: true }) }
const tapRows = (ids: string[]) => (el: HTMLElement) => { for (const id of ids) el.querySelector<HTMLElement>(`.arow[data-id="${id}"] .arow-main`)?.click() }
// The phone list's long press: the menu opens at the row, as a hold does (agentMenu).
const holdRow = (id: string) => (el: HTMLElement) => { const row = el.querySelector<HTMLElement>(`.arow[data-id="${id}"]`); if (!row) throw new Error(`no row ${id}`); const r = row.getBoundingClientRect(); showMenu(r.left, r.bottom, agentMenu(SCOPED.find((a) => a.id === id)), row) }

const phoneStories: Story[] = [{
  name: 'Agents phone list',
  group: 'Tree and shell',
  what: 'The phone Agents page (S-1432): a header with the live count and Spawn, the scope chips in one row that scrolls sideways, and a list of two-line agent rows grouped by tree.',
  when: 'On a phone (360-430 px), when the Agents tab opens its page. Tap a row to open the agent\'s world; long press a row (`duration-hold`) for its menu.',
  code: ['web/src/AgentsPage.tsx#AgentsPhone', 'web/src/AgentsPage.tsx#AgentRow'],
  rules: [
    'Select mode (S-3282): the header\'s Select turns each row into a checkbox in the fold chevron\'s slot, so no text moves. A tap checks the row, and the header shows "N selected", Select all and Done. The bar sits fixed on the phone\'s bottom bar (`--nav-h`), and the list pads its foot by the bar\'s height.',
    'Rows are the sidebar\'s tree order, from the same `buildLines` the desk table reads, under the scope the chips pick. Nothing is ordered a second time.',
    'Each row is at least `--size-hit-touch` high. Line 1 is the harness mark in its state ring, the name and the cost on the right. Line 2 is muted: the top wait or the activity, then the model, then the ITSA key.',
    'The indent is 12 px a level and stops at level 3. A deeper agent stays at level 3 and shows "↳ parent" on line 2.',
    'A tap opens the agent\'s world. A long press (`duration-hold`) opens `agentMenu` at the row, and the tap after it does not fire. A scroll or a move past the hold slop cancels the hold. The `⋯` button stays on each row.',
    'The chips share the desk\'s scope (`useAgentsView().scope`). Empty scopes use the same words as the desk (SCOPE_EMPTY).',
  ],
  states: [
    { name: 'Live, four deep', data: { agents: DEEP }, routes: page.routes, setup: PHONE_PAGE, render: () => <AgentsPhone /> },
    { name: 'Live, waiting agent', data: { agents: AGENTS }, routes: page.routes, setup: PHONE_PAGE, render: () => <AgentsPhone /> },
    { name: 'Live, blocked on an open ask', data: { agents: BLOCKED, asks: [BLOCKED_ASK] }, routes: page.routes, setup: PHONE_PAGE, render: () => <AgentsPhone /> },
    { name: 'Scope: Waiting', data: { agents: SCOPED }, routes: page.routes, setup: at('waiting'), render: () => <AgentsPhone /> },
    { name: 'Scope: Stopped', data: { agents: SCOPED }, routes: page.routes, setup: at('stopped'), render: () => <AgentsPhone /> },
    { name: 'Scope: Archived', data: { agents: SCOPED }, routes: page.routes, setup: at('archived'), render: () => <AgentsPhone /> },
    { name: 'Live, parents with own and tree cost', data: { agents: DEEP_COST }, routes: page.routes, setup: PHONE_PAGE, render: () => <AgentsPhone /> },
    { name: 'Empty', data: { agents: [] }, routes: page.routes, setup: PHONE_PAGE, render: () => <AgentsPhone /> },
    { name: 'Long-pressed row, with its menu', data: { agents: FLEET }, routes: page.routes, setup: PHONE_PAGE, render: () => <OnMount run={holdRow('fl-a0')}><AgentsPhone /></OnMount> },
    { name: 'Select mode, nothing checked', data: { agents: FLEET }, routes: page.routes, setup: SELECT_PAGE, render: () => <AgentsPhone /> },
    { name: 'Select mode, three checked, with the bar', data: { agents: FLEET }, routes: page.routes, setup: SELECT_PAGE, height: 640, overlay: '.agents-bulk-dock',
      render: () => <OnMount run={tapRows(['fl-a0', 'fl-a1', 'fl-a2'])}><AgentsPhone /></OnMount> },
  ],
}]

export const stories: Story[] = [{
  name: 'Agents page',
  group: 'Tree and shell',
  what: "The Agents page (`w:agents`, S-1428, S-1432): on the desktop, the agents table under a header with the title, the live count, the grouping, the search, the column picker and the legend. The count of asks, permissions and waits is one source with the sidebar's and the bottom bar's. On a phone the page keeps the agent tree until the phone list (a later PR).",
  when: 'When the Agents icon in the sidebar footer, or the Agents tab header in the sidebar, opens its page. The page is a world of its own, so it can be split, tabbed and remembered like Settings or Usage.',
  code: ['web/src/AgentsPage.tsx#AgentsPage', 'web/src/Tree.tsx#Tree', 'web/src/MachinesSide.tsx#MachinesStrip', 'web/src/MachinesSide.tsx#Meter'],
  rules: [
    'The header is `--size-tab-bar` (36 px) high, with the title in chrome-large and the counts in chrome-small, muted; the waiting count takes the warning ink and reads "asks or waits", what it counts. Its controls are `.icon-btn` or the field height `--size-row-table`.',
    'Scope chips (Live, Waiting, Stopped, Archived) are a `.seg` with each count. Live is the default and the header count stays the live count whatever the scope. The chosen scope is kept in the view record with the grouping. Waiting counts the live agents with a permission request open or any wait (a timer, an agent, children, a job, an event or the human); Stopped and Archived are the agents with that lifecycle, listed in the same table.',
    'An archive of hundreds shows its first 100 rows, then a button shows the next 100; nothing is fetched per scope, so the archived agents come from the same list the sidebar\'s Stopped section reads.',
    'The table is the Agents table (AgentsTable.stories.tsx): the grouping and the columns are kept in settings, so a choice follows the human to every device. In Tree grouping the Archived and Stopped lists are newest first by Age, roots and children alike, unless a column is sorted.',
    'The header ends with a primary Spawn button (`--accent`, a plus and the label) that opens the spawn menu. Between the search and the icon buttons, the machines strip shows each machine by name with its CPU and RAM meters, or its name muted and "off"; hover or focus opens the sidebar\'s machine popover. The header steps down only while it overflows, each step measured: first the count, the group select and the search give way in CSS (the count to nothing, the group select to its minimum, the search to the width its placeholder needs); then the strip is one Machines button whose dot is the worst level and whose click lists every machine; then Spawn is its plus alone, labelled "Spawn agent"; then the scope chips are one Scope select showing each scope with its count; last the page title hides. A step back is taken once the header holds the form back with room to spare. The strip re-draws only when the machines change, not on the 5 s agent poll.',
    'On a phone (360-760 px wide) the page is the agent list (the phone list, its own stories below). The sidebar\'s tree keeps the `#tree` id.',
    'Counts are one source, as the sidebar\'s and the bottom bar\'s: live agents are the running ones. The header\'s "asks or waits" is the human\'s waiting list (`useWaiting`: the asks that wait on you), a different count from the Waiting chip.',
    'Rows are checked by their checkboxes or with `x` and Shift-click (S-3117). The checked set is kept by id and not saved: it survives a poll and a re-sort, drops an agent that leaves the scope, and clears on a scope change. Checking a row never changes the detail pane.',
    'The detail pane (S-3048) is the right side of the desk: `DetailsView` for the picked row, 420 px wide. A row is picked by a click or the arrow keys, and stays picked through polls, re-sorts and a scope that still lists it. Space shows or hides the pane, but not while focus is in a field or with a modifier (Shift, Ctrl, Alt or Meta) held. A key pick shows in the pane after 150 ms, so holding an arrow key fetches nothing for each agent it passes; a click shows at once. The pane shows only with a pick (S-3616): with nothing picked the table takes the full width and no empty pane shows. With a pick it is open from a 1100 px desk on, until the human presses Space (a pick never reopens a pane Space closed), and below 900 px an open pane lies over the table.',
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
    { name: 'Pane allowed, nothing picked: no pane', data: { agents: AGENTS }, routes: page.routes, setup: withPane('live', true), render: () => <AgentsPage /> },
    { name: 'Three checked, pane open', data: { agents: FLEET }, routes: page.routes, setup: withPane('live', true), render: () => <OnMount run={checkRows(['fl-a0', 'fl-a1', 'fl-a2'])}><AgentsPage picked="fl-a3" /></OnMount> },
    { name: 'Pane closed', data: { agents: AGENTS }, routes: page.routes, setup: withPane('live', false), render: () => <AgentsPage picked="fx-dev" /> },
    { name: 'Machines strip, two online', data: { agents: FLEET, machines: TWO }, routes: page.routes, setup: withPane('live', false), render: () => <AgentsPage /> },
    { name: 'Machines strip, over 80% and over 95%', data: { agents: FLEET, machines: [machine('fixture-a', 85, 82), machine('fixture-b', 97, 40)] }, routes: page.routes, setup: withPane('live', false), render: () => <AgentsPage /> },
    { name: 'Machines strip, one offline', data: { agents: FLEET, machines: [TWO[0], machine('fixture-b', 0, 0, false)] }, routes: page.routes, setup: withPane('live', false), render: () => <AgentsPage /> },
    { name: 'Machines collapsed, narrow header', data: { agents: FLEET, machines: [machine('fixture-a', 85, 82), TWO[1]] }, routes: page.routes, setup: withPane('live', false), render: () => <div style={{ width: 900 }}><AgentsPage /></div> },
  ],
}, ...phoneStories]
