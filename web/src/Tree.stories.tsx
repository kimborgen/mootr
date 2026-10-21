import { Tree, TreeTools } from './Tree'
import { setSidebarCols } from './sidebar-cols'
import { applyLiveEvent } from './store'
import { AGENTS, agent } from './stories/fixtures'
import { OnMount, Side } from './stories/helpers'
import { ds, type Story } from './stories/types'
import { setUi } from './ui/state'
import type { Agent, Itsa } from './types'

const T0 = '2026-10-01T09:00:00.000Z'
// The tree's own UI state (folds, the filter, the stopped list), reset by every state so one
// state's folds never reach the next.
const ui = (o: Partial<{ collapsed: Record<string, boolean>; stoppedOpen: boolean; filter: string; treeFocus: string | null }> = {}) =>
  () => setUi({ collapsed: {}, stoppedOpen: false, filter: '', treeFocus: null, ...o })

const itsa = (id: string, owner: string, status: string): Itsa => ({
  id, key: 'F-' + id.slice(-1), parent_id: null, kind: 'issue', title: 'Fixture issue ' + id, summary: null, body: null, status, owner,
  thread_id: null, created_by: 'fx-cos', created_at: T0, updated_at: T0, closed_at: null,
})

// A tree of three levels: a chief of staff, a manager under it, and a developer and a reviewer under the manager.
const NESTED: Agent[] = [
  agent({ id: 'n-cos', name: 'fixture-cos', role: 'chief of staff', chief_of_staff: true }),
  agent({ id: 'n-mgr', name: 'fixture-manager', role: 'manager', parents: ['n-cos'], activity: 'working', created_at: '2026-10-01T09:01:00.000Z' }),
  agent({ id: 'n-dev', name: 'fixture-dev', role: 'developer', parents: ['n-mgr'], activity: 'working', created_at: '2026-10-01T09:02:00.000Z' }),
  agent({ id: 'n-rev', name: 'fixture-review', role: 'reviewer', harness: 'codex', model: 'gpt-6.1-sol', parents: ['n-mgr'], created_at: '2026-10-01T09:03:00.000Z' }),
  agent({ id: 'n-solo', name: 'fixture-solo', role: 'developer', parents: ['n-cos'], created_at: '2026-10-01T09:04:00.000Z' }),
]
// Many agents under several managers, for a tree that scrolls.
const LONG: Agent[] = [
  NESTED[0],
  ...Array.from({ length: 4 }, (_, m) => agent({ id: `l-m${m}`, name: `fixture-manager-${m + 1}`, role: 'manager', parents: ['n-cos'], created_at: `2026-10-01T09:0${m + 1}:00.000Z` })),
  ...Array.from({ length: 28 }, (_, i) => agent({
    id: `l-a${i}`, name: `fixture-agent-${i + 1}`, role: ['developer', 'reviewer', 'tester'][i % 3], harness: ['claude', 'codex', 'opencode'][i % 3],
    parents: [`l-m${i % 4}`], activity: ['working', 'idle', 'waiting', 'idle'][i % 4], context_tokens: 40000 + i * 15000, context_level: i > 22 ? 2 : i > 14 ? 1 : 0,
    created_at: `2026-10-01T10:${String(i).padStart(2, '0')}:00.000Z`,
  })),
]

const cost = (own: number, tree: number) => ({ mode: 'api' as const, own: { api: own, five_hour: null, seven_day: null, subscription: null, paid_usd: 0 }, tree: { api: tree, five_hour: null, seven_day: null, subscription: null, paid_usd: 0 } })

const link = { n: 1, system: 'branch', external_id: 'stam/fixture', url: 'branch:stam/fixture', meta: { repo: 'fixture/repo', review: { verdict: 'approve', by: 'fx-review', summary: null, at: T0 }, tests: { passed: 14, failed: 0, skipped: 0, command: null, at: T0 } } }
const colItsa = (id: string, owner: string, o: Partial<Itsa> = {}): Itsa => ({ ...itsa(id, owner, 'in_progress'), key: id.toUpperCase(), ...o })
const COL_ITSAS = [colItsa('s-1', 'fx-dev', { links: [link], health: 'at_risk' }), colItsa('s-2', 'fx-ops'), colItsa('s-3', 'fx-review', { links: [{ ...link, meta: { repo: 'fixture/repo', tests: { passed: 3, failed: 2, skipped: 0, command: null, at: T0 } } }] })]
const picked = (cols: string[]) => () => { setUi({ collapsed: {}, stoppedOpen: false, filter: '', treeFocus: null }); setSidebarCols(cols) }

export const stories: Story[] = [{
  name: 'Agent tree',
  group: 'Tree and shell',
  what: "The org tree of running agents in the left sidebar. A row is the agent's mark, its name, its role, and on the right the facts that need a glance: the ITSAs it owns, a waiting approval, what it waits for, unread mail, bypass mode, a different machine, no ITSA, context used, cost, and a model code. A parent folds its children; an agent with several parents also shows, linked, under each. Under the agents come the running rings, then a fold of stopped agents.",
  when: "The left sidebar (`#w-left`) whenever it is open; on a phone it is the Agents tab of the bottom navigation. It reads the agent list, the ITSAs, and the rings from the store; before the first agent list arrives it shows a loading mark, and an unreachable daemon shows its error in place of the rows.",
  code: ['web/src/Tree.tsx#Tree', 'web/src/format.ts#treeAgents', 'web/src/format.ts#live'],
  rules: [
    'The columns button next to the ? picks up to two Work columns (Review, Tests, Health, any ITSA field). They take the role\'s slot, filled from the ITSA the agent owns; an empty value shows a dash, and the role moves to the tooltip. The button is `--size-hit-touch` on a phone (' + ds('Touch targets') + '). No animation.',
    'Columns are a fixed width so they line up down the tree. At 380 px and narrower the model code is dropped, and at 300 px the tree total too; a meta item shows whole or not at all, and the name keeps at least 10 characters when it can.',
    'A row is `--size-row-tree` high on a desktop and `--size-hit-touch` on a phone (`.node` sets `--row` at 760 px and below); the whole row is the target, so the small buttons inside it never need to be (' + ds('Density') + ').',
    'A child indents 14 px per level, with a guide line at each level. The chevron is 16 px and only a parent has one. Left and right arrows fold and unfold, up and down move, Enter opens the agent.',
    'The selected row (the open world) uses `--tree-row-selected-bg` and `--tree-row-selected-fg`; hover uses `--tree-row-hover`. A stopped agent in the tree is `--text-muted`.',
    'The context bar is 28 × 4 px: `--text-muted` at level 0, `--st-blocked` at level 1, `--st-errored` at levels 2 and 3. Its tooltip says how much of the forced-compaction limit is used.',
    "The role column hides on a phone unless an action is pending (`pausing…`); the hover actions (add a child, more) show on hover or focus on a desktop and always on a phone, where the add button is hidden. A long press opens the same menu as More.",
    'A hairline spend bar sits under each cost: the agent\'s own spend against the biggest spender shown, on a square-root scale, easing by `transform: scaleX` as it grows and flashing `--st-working` for spend that just arrived. The cost figure itself never rolls or counts up.',
    'A mark stamps once when its state changes (the ring, the owned ITSA\'s chip, the unread badge), and a row nudges once when its owned issue changes status, further when it starts waiting on you. Each goes through the motion gate (' + ds('Motion') + '): nothing moves while the tree scrolls, for an off-screen row, under reduced motion, or with that kind off in Settings › Motion (S-698).',
    'Mail sent between two rows the tree shows flies a small envelope along the indent gutter from the sender\'s row to the recipient\'s unread badge, which stamps as it lands; mail to or from you travels to the top of the list, and an end that is scrolled away is clipped to the list\'s edge (S-699, see `Sidebar mail motion`).',
    'Roots sort the executive assistant first, then a chief of staff, then by creation time; children sort by creation time. Stopped agents sort by last update, newest first, and at most 40 show.',
    'A resting agent (S-1969) keeps its row: a dashed ring with a dash pip, and the resting badge after its name, the wake time alone (`~14:20`, local; none when unknown) with the full line in its tooltip. It counts as live, so its other marks stay.',
    "Colour never carries a state alone: the mark's pip and ring style do too, and each badge has an icon or a count (" + ds('State vocabulary') + ').',
  ],
  states: [
    { name: 'Fixture agents, every state', data: { itsas: [itsa('i1', 'fx-dev', 'in_progress'), itsa('i2', 'fx-cos', 'needs_input'), itsa('i3', 'fx-cos', 'in_progress')] }, setup: ui({ stoppedOpen: false }), render: () => <Side><Tree /></Side> },
    {
      name: 'Resting agents',
      data: { agents: [
        agent({ id: 'r-0', name: 'fixture-lead', role: 'manager', activity: 'idle' }),
        agent({ id: 'r-1', name: 'fixture-pr-wait', role: 'developer', parents: ['r-0'], lifecycle: 'paused', activity: null, resting: { reason: 'wait', waits: [{ id: 'rw1', kind: 'event', target: null, detail: 'PR #12', since: '2026-10-01T09:00:00.000Z', until: null }], expected_wake: new Date(Date.now() + 3 * 3600_000).toISOString() } }),
        agent({ id: 'r-2', name: 'fixture-no-wake', role: 'reviewer', parents: ['r-0'], lifecycle: 'paused', activity: null, resting: { reason: 'wait', waits: [{ id: 'rw2', kind: 'agent', target: 'r-0', detail: null, since: '2026-10-01T09:00:00.000Z', until: null }], expected_wake: null } }),
        agent({ id: 'r-3', name: 'fixture-idle', role: 'standing', parents: ['r-0'], lifecycle: 'paused', activity: null, resting: { reason: 'idle', waits: [], expected_wake: null } }),
      ] },
      setup: ui(), render: () => <Side><Tree /></Side>,
    },
    { name: 'Nested', data: { agents: NESTED }, setup: ui({ treeFocus: 'n-dev' }), render: () => <Side><Tree /></Side> },
    { name: 'A parent folded', data: { agents: NESTED }, setup: ui({ collapsed: { 'n-mgr': true } }), render: () => <Side><Tree /></Side> },
    {
      name: 'Each harness, with cost and unread',
      data: { agents: [
        agent({ id: 'h-1', name: 'fixture-claude', harness: 'claude', activity: 'working', unread: 3, cost: cost(0.42, 0.42), context_tokens: 120000 }),
        agent({ id: 'h-2', name: 'fixture-codex', harness: 'codex', model: 'gpt-6.1-sol', activity: 'idle', cost: cost(1.2, 4.8), in_itsa: false }),
        agent({ id: 'h-3', name: 'fixture-opencode', harness: 'opencode', model: 'openrouter/fixture/flash', activity: 'working', machine: 'fixture-other', permission_mode: 'bypass' }),
      ] },
      setup: ui(), render: () => <Side><Tree /></Side>,
    },
    {
      name: 'Waiting and blocked',
      data: { agents: AGENTS.filter((a) => ['fx-cos', 'fx-review', 'fx-ops', 'fx-wait', 'fx-err'].includes(a.id)), itsas: [itsa('i4', 'fx-ops', 'needs_approval')] },
      setup: ui(), render: () => <Side><Tree /></Side>,
    },
    { name: 'Owning ITSAs', data: { agents: NESTED, itsas: [itsa('i5', 'n-dev', 'in_progress'), itsa('i6', 'n-mgr', 'in_progress'), itsa('i7', 'n-mgr', 'needs_review'), itsa('i8', 'n-rev', 'done')] }, setup: ui(), render: () => <Side><Tree /></Side> },
    {
      name: 'Mail in flight',
      data: { agents: NESTED },
      setup: ui(),
      render: () => <Side><OnMount run={() => { applyLiveEvent('mail.sent', { id: 'tree-mail', from: 'n-cos', to: ['n-rev'], thread: null, ask: false }) }}><Tree /></OnMount></Side>,
    },
    {
      name: 'Spend bars and issue chips',
      data: {
        agents: [
          agent({ id: 's-1', name: 'fixture-big', activity: 'working', cost: cost(41.2, 41.2) }),
          agent({ id: 's-2', name: 'fixture-mid', activity: 'idle', unread: 2, cost: cost(12.7, 12.7) }),
          agent({ id: 's-3', name: 'fixture-small', activity: 'blocked', cost: cost(0.84, 0.84) }),
          agent({ id: 's-4', name: 'fixture-zero', activity: 'waiting', cost: cost(0, 0) }),
        ],
        itsas: [itsa('s1', 's-1', 'in_progress'), itsa('s2', 's-2', 'needs_review'), itsa('s3', 's-3', 'in_progress')],
      },
      setup: ui(), render: () => <Side><Tree /></Side>,
    },
    {
      name: 'Rings and stopped agents',
      data: { rings: [{ id: 'r1', name: 'fixture-ring', format: 'review', round: 2, max_rounds: 4, status: 'running', members: 'fx-cos' }] },
      setup: ui({ stoppedOpen: true }), render: () => <Side><Tree /></Side>,
    },
    { name: 'Filtered', setup: ui({ filter: 'review' }), render: () => <Side><Tree /></Side> },
    { name: 'Long tree', data: { agents: LONG }, setup: ui(), render: () => <Side><div style={{ height: 560, overflow: 'auto' }}><Tree /></div></Side> },
    { name: 'One column', data: { itsas: COL_ITSAS }, setup: picked(['review']), render: () => <Side><Tree /></Side> },
    { name: 'Two columns', data: { itsas: COL_ITSAS }, setup: picked(['review', 'tests']), render: () => <Side><Tree /></Side> },
    { name: 'No agents', data: { agents: [] }, setup: ui(), render: () => <Side><Tree /></Side> },
    { name: 'Loading', data: { agents: [], loaded: { agents: false, mail: true, itsas: true } }, setup: ui(), render: () => <Side><Tree /></Side> },
    { name: 'Daemon unreachable', data: { agents: [], error: 'fixture: the daemon did not answer' }, setup: ui(), render: () => <Side><Tree /></Side> },
  ],
},
{
  name: 'Tree header buttons',
  group: 'Tree and shell',
  what: "The two buttons at the tree's header: the columns on each row (a menu of the Work columns, up to the cap, with None for the role) and what the marks mean (the legend). The sidebar shows them on its Agents heading; the Agents page shows them at the right end of its header.",
  when: "On the sidebar's Agents heading, and in the header of the Agents page (`w:agents`).",
  code: ['web/src/Tree.tsx#TreeTools'],
  rules: ['Both are `.icon-btn` in the heading with an `aria-label` each, and the columns button is `aria-haspopup="menu"`, the legend `aria-haspopup="dialog"`. A press on either opens its menu or legend where it is; neither changes the tree.'],
  states: [
    { name: 'In a heading', data: { agents: AGENTS }, setup: ui(), render: () => <Side><TreeTools /></Side> },
  ],
}]
