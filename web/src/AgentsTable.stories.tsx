import { AgentsTable } from './AgentsTable'
import { buildLines, factsOf, type ColumnId, type Group, type Scope, type Sort } from './agents-table'
import { agent } from './stories/fixtures'
import { ds, type Story } from './stories/types'
import { setUi } from './ui/state'
import type { Agent, Itsa } from './types'

// The table's own folds, reset by every state so one state's folds never reach the next.
const quiet = () => setUi({ collapsed: {}, stoppedOpen: false, filter: '', treeFocus: null })

const T0 = '2026-10-01T09:00:00.000Z'
// Stopped and archived agents (S-2937): the Age column shows when each last changed, and the context shows no value.
const GONE: Agent[] = [
  ...Array.from({ length: 3 }, (_, i) => agent({ id: `st-${i}`, name: `fixture-stopped-${i + 1}`, role: 'developer', lifecycle: 'shut_down', activity: 'idle', activity_detail: null, machine: 'fixture-box-one', cost: cost(1 + i), created_at: T0, updated_at: `2026-10-2${i}T08:00:00.000Z` })),
  ...Array.from({ length: 4 }, (_, i) => agent({ id: `ar-${i}`, name: `fixture-archived-${i + 1}`, role: 'reviewer', lifecycle: 'archived', activity: 'idle', activity_detail: null, machine: i % 2 ? 'fixture-box-two' : 'fixture-box-one', created_at: T0, updated_at: `2026-10-1${i}T08:00:00.000Z` })),
]
const itsa = (id: string, key: string, owner: string, status: string, title: string): Itsa => ({
  id, key, title, status, owner, parent_id: null, kind: 'issue', summary: null, body: null, created_by: 'fx-cos', thread_id: null,
  created_at: T0, updated_at: T0, closed_at: null,
} as unknown as Itsa)

// A fleet of 24 over two machines: a chief of staff, three managers under it, and developers, reviewers and testers under them,
// with the working, idle and waiting ones spread about, a context and a cost each, and ITSAs owned by some.
const FLEET: Agent[] = [
  agent({ id: 'fl-cos', name: 'fixture-cos', role: 'chief of staff', chief_of_staff: true, cost_usd: 4.2, cost: cost(4.2) }),
  ...Array.from({ length: 3 }, (_, m) => agent({ id: `fl-m${m}`, name: `fixture-manager-${m + 1}`, role: 'manager', parents: ['fl-cos'], activity: m === 0 ? 'working' : 'idle', machine: m === 2 ? 'fixture-box-two' : 'fixture-box-one', created_at: `2026-10-01T09:0${m + 1}:00.000Z`, cost: cost(m + 1.5) })),
  ...Array.from({ length: 20 }, (_, i) => agent({
    id: `fl-a${i}`, name: `fixture-agent-${i + 1}`, role: ['developer', 'reviewer', 'tester'][i % 3], harness: ['claude', 'codex', 'opencode'][i % 3],
    model: ['claude-opus-5-5', 'gpt-6.1-sol', 'claude-sonnet-5-5'][i % 3], parents: [`fl-m${i % 3}`], activity: ['working', 'idle', 'waiting', 'idle'][i % 4],
    machine: i % 2 ? 'fixture-box-two' : 'fixture-box-one', context_tokens: 40000 + i * 15000, context_level: i > 16 ? 2 : i > 10 ? 1 : 0,
    created_at: `2026-10-01T10:${String(i).padStart(2, '0')}:00.000Z`, cost: cost((i * 37) % 11 / 2), unread: i % 5 ? 0 : 2,
  })),
]
const ITSAS: Itsa[] = [
  itsa('i-1', 'F-1', 'fl-a0', 'in_progress', 'Fixture issue one'),
  itsa('i-2', 'F-2', 'fl-a3', 'waiting', 'Fixture issue two'),
  itsa('i-3', 'F-3', 'fl-m1', 'in_review', 'Fixture issue three'),
]
// The fleet, as the store holds it: the machine this page runs on is the first fixture box.
// A waiting manager whose child isn't waiting: the Waiting scope lists the manager alone, and its cost keeps the tree's spend (S-3281).
const WAITING_TREE: Agent[] = [
  agent({ id: 'wt-m', name: 'fixture-waiting-manager', role: 'manager', cost_usd: 3, cost: cost(3), waits: [{ kind: 'human' }] as never, created_at: T0 }),
  agent({ id: 'wt-k', name: 'fixture-idle-child', role: 'developer', parents: ['wt-m'], cost_usd: 1, cost: cost(1), created_at: T0 }),
]
// A waiting manager blocked on an open ask: its Activity cell links to the ask (S-3977).
const ASKED: Agent[] = [
  agent({ id: 'ak-m', name: 'fixture-blocked-manager', role: 'manager', cost_usd: 2, cost: cost(2), waits: [{ kind: 'human' }] as never, open_ask: 'request:fx-ask', created_at: T0 }),
  agent({ id: 'ak-k', name: 'fixture-idle-child', role: 'developer', parents: ['ak-m'], cost_usd: 1, cost: cost(1), created_at: T0 }),
]
const ASK = { key: 'request:fx-ask', kind: 'request', state: 'open', outcome: null, what: 'Permission request', agent_id: 'ak-m', agent_name: 'fixture-blocked-manager', machine: 'fixture-box-one', thread_id: 'fx-ask-thread', itsa_id: null, since: T0, settled_at: null } as const
const HERE = 'fixture-box-one'
const facts = (agents: Agent[] = FLEET) => factsOf(agents, ITSAS, HERE)

function cost(own: number) {
  return { mode: 'api' as const, own: { api: own, five_hour: null, seven_day: null, subscription: null, paid_usd: 0 }, tree: { api: own, five_hour: null, seven_day: null, subscription: null, paid_usd: 0 } }
}

// The table, with its lines built the page's way for the grouping and sort a state names.
function table(o: { group?: Group; sort?: Sort | null; cols?: ColumnId[]; cursor?: string | null; query?: string; agents?: Agent[]; scope?: Scope; checked?: string[] } = {}) {
  const agents = o.agents ?? FLEET
  const f = facts(agents)
  const lines = buildLines(agents, f, { group: o.group ?? 'tree', query: o.query ?? '', sort: o.sort ?? null, collapsed: {}, scope: o.scope })
  return <AgentsTable lines={lines} facts={f} group={o.group ?? 'tree'} cols={o.cols ?? ['role', 'model', 'machine', 'itsa', 'activity', 'wait', 'context', 'cost', 'unread', 'age']}
    sort={o.sort ?? null} cursor={o.cursor ?? null} enforce={200000} onSort={() => {}} onPick={() => {}}
    checked={new Set(o.checked ?? [])} checkAll={o.checked?.length ? 'some' : 'none'} onCheck={() => {}} onCheckAll={() => {}} />
}

export const stories: Story[] = [{
  name: 'Agents table',
  group: 'Tree and shell',
  what: 'The Agents page\'s table (S-1432): one row per agent at `--size-row-table`, with the harness mark in its state ring, the name, and the columns the human picks. The header sorts by any column, and a sort among siblings keeps the tree. The table draws from the same lines as the sidebar tree: the same agents, order and folds.',
  when: 'On the desktop Agents page (`w:agents`), under its header with the grouping, the search, the column picker and the legend. A phone keeps the agent tree.',
  code: ['web/src/AgentsTable.tsx#AgentsTable', 'web/src/Tree.tsx#CtxBar', 'web/src/Tree.tsx#CostCell'],
  rules: [
    'Rows are `--size-row-table` tall. The header is sticky on `--table-header-bg` with `--table-border` hairlines and no other rules (' + ds('Tables, tree, and empty states') + ').',
    'The table scrolls up and down in its own box, never the page or sideways: its columns shrink, then drop by priority as it narrows (age first, then unread, machine, role and model, activity and ITSA). A long text cuts with an ellipsis, and its full value is the tooltip.',
    'A header that is sorted shows its direction and `aria-sort`. A click cycles ascending, descending and no sort.',
    'The tree keeps the sidebar\'s folds: a chevron folds an agent\'s children. An agent with two parents shows under each, its second place muted and marked.',
    'A fold counts the children in the scope the table lists. A cost shows its tree ("/" and the tree spend) when the agent has children in any scope, so a parent in Waiting keeps its tree spend when its children are not waiting.',
    'A group line (Machine, ITSA) sits above its agents on `--table-header-bg`, with the count. This machine comes first among machines; the agents with no ITSA come last.',
    'A click picks a row (its cursor); a double click opens the agent, as the sidebar row does (' + ds('Density') + ').',
    'A checkbox checks its row and does not pick it. A checked row takes `--table-row-hover`, and the header box is mixed when only some rows in view are checked.',
  ],
  states: [
    { name: 'Tree, by default', data: { agents: FLEET, itsas: ITSAS }, setup: quiet, render: () => table() },
    { name: 'Grouped by machine', data: { agents: FLEET, itsas: ITSAS }, setup: quiet, render: () => table({ group: 'machine' }) },
    { name: 'Grouped by ITSA', data: { agents: FLEET, itsas: ITSAS }, setup: quiet, render: () => table({ group: 'itsa' }) },
    { name: 'Flat, sorted by cost', data: { agents: FLEET, itsas: ITSAS }, setup: quiet, render: () => table({ group: 'flat', sort: { col: 'cost', dir: 'desc' }, cursor: 'fl-a3' }) },
    { name: 'Three checked, the picked row unchecked', data: { agents: FLEET, itsas: ITSAS }, setup: quiet, render: () => table({ cursor: 'fl-m0', checked: ['fl-a0', 'fl-a1', 'fl-a2'] }) },
    { name: 'Narrow, 520 px', data: { agents: FLEET, itsas: ITSAS }, setup: quiet, render: () => <div style={{ width: 520 }}>{table({ cursor: 'fl-m0' })}</div> },
    { name: 'Stopped', data: { agents: GONE, itsas: ITSAS }, setup: quiet, render: () => table({ scope: 'stopped', agents: GONE }) },
    { name: 'Waiting, a parent whose child is not waiting', data: { agents: WAITING_TREE, itsas: ITSAS }, setup: quiet, render: () => table({ scope: 'waiting', agents: WAITING_TREE }) },
    { name: 'Archived, by age', data: { agents: GONE, itsas: ITSAS }, setup: quiet, render: () => table({ scope: 'archived', agents: GONE, group: 'flat', sort: { col: 'age', dir: 'desc' } }) },
    { name: 'Blocked on an open ask', data: { agents: ASKED, itsas: ITSAS, asks: [ASK] }, setup: quiet, render: () => table({ agents: ASKED, scope: 'waiting' }) },
    { name: 'Empty', data: { agents: [], itsas: [] }, setup: quiet, render: () => <AgentsTable lines={[]} facts={facts([])} group="tree" cols={['role', 'cost']} sort={null} cursor={null} enforce={200000} onSort={() => {}} onPick={() => {}} checked={new Set()} checkAll="none" onCheck={() => {}} onCheckAll={() => {}} empty={<div className="pad muted">No agents running. Press + to add one.</div>} /> },
  ],
}]
