import { ActivityTab } from './Activity'
import { DEFAULT_STATE, setUsageState, type UsageState } from './state'
import { ds, pending, reply, type Story } from '../stories/types'
import { SUMMARY, SUMMARY_AGENT, SUMMARY_EMPTY, SUMMARY_DEV_MANAGER, SUMMARY_DEVELOPERS, TREES } from './activity/summaryFixture'

const ROUTE = 'GET /api/activity?by=summary&days=7'
// The Usage page's state is its own store (usage/state.ts): each state sets it, so none leaks.
const usage = (s: Partial<UsageState> = {}) => () => setUsageState({ ...DEFAULT_STATE, tab: 'activity', ...s })
const Page = ({ children }: { children: React.ReactNode }) => <div className="pad usage">{children}</div>

// The tab's pieces each have a story in ./activity/Activity.stories.tsx.
export const stories: Story[] = [
  {
    name: 'Usage activity',
    group: 'Settings',
    what: 'What the agents\' time and cost went to, from the one summary answer (`GET /api/activity?by=summary`): the scope crumb, four tiles, then Where the time goes and What finished issues cost beside the Bottlenecks and Agents by tree. It follows the page\'s Period, Measure and drill scope; tapping a tree or an agent sets that scope, so the scoped tab is the retro for a tree or an agent.',
    when: 'Usage page, Activity tab (Settings links it from the activity classifier).',
    code: ['web/src/usage/Activity.tsx#ActivityTab'],
    rules: [
      'Two columns from 761 px (time and finished-issue costs 3fr, bottlenecks and agents by tree 2fr); one column on a phone in the order tiles, time, bottlenecks, finished-issue costs, agents by tree, with no sideways scroll at 360 px (' + ds('Narrow panes and overflow') + ').',
      'A Time | Cost switch at the top counts the whole page in agent-hours or in cost (the Measure control picks API $, % of week or Real $); the same answer serves both, and the mode is in the state and the deep link (`mode=cost`). In Cost mode every section shows its cost counterpart, never a time figure under a cost heading: tiles, Where the cost goes, Cost by agent type, Cost by model in place of Bottlenecks, Agents by tree by cost. The Agent types control (one toggle per type present, with its agent count, and All) sits above the crumb; a filtered set of types is named after the scope in the crumb, so a filtered number is never read as the whole system. It keeps its buttons while a new answer loads.',
      'A scope set by a tap is the drill scope in `usage/state.ts`, so the URL, back and the crumb follow it.',
      'While the daemon rebuilds its digests after a restart the answer is partial and marked `warming`: a muted line above the tiles says so, with Refresh to ask again (S-1206).',
      'Loading shows the loading mark (`Loading`); error with Retry and empty are typographic, as the rest of Usage (' + ds('Empty, loading, and error') + ').',
    ],
    fit: 'page',
    states: [
      { name: 'Whole system', routes: { [ROUTE]: SUMMARY }, setup: usage(), render: () => <Page><ActivityTab shown /></Page> },
      { name: 'Scoped to a tree', routes: { 'GET /api/activity?by=summary&days=7&scope=tree%3Acos': { ...SUMMARY, scope: { kind: 'tree', id: 'cos', name: 'cos' }, trees: [TREES[0]] } }, setup: usage({ scope: { kind: 'tree', id: 'cos' } }), render: () => <Page><ActivityTab shown /></Page> },
      { name: 'Scoped to an agent', routes: { 'GET /api/activity?by=summary&days=7&scope=agent%3Afx-dev': SUMMARY_AGENT }, setup: usage({ scope: { kind: 'agent', id: 'fx-dev' } }), render: () => <Page><ActivityTab shown /></Page> },
      { name: 'Developers only', routes: { [`${ROUTE}&agents=developer`]: SUMMARY_DEVELOPERS }, setup: usage({ agents: ['developer'] }), render: () => <Page><ActivityTab shown /></Page> },
      { name: 'Developers and managers', routes: { [`${ROUTE}&agents=developer%2Cmanager`]: SUMMARY_DEV_MANAGER }, setup: usage({ agents: ['developer', 'manager'] }), render: () => <Page><ActivityTab shown /></Page> },
      { name: 'Cost mode', routes: { [ROUTE]: SUMMARY }, setup: usage({ mode: 'cost' }), render: () => <Page><ActivityTab shown /></Page> },
      { name: 'Cost mode, developers and managers', routes: { [`${ROUTE}&agents=developer%2Cmanager`]: SUMMARY_DEV_MANAGER }, setup: usage({ mode: 'cost', agents: ['developer', 'manager'] }), render: () => <Page><ActivityTab shown /></Page> },
      { name: '% of week', routes: { [ROUTE]: SUMMARY }, setup: usage({ measure: 'week' }), render: () => <Page><ActivityTab shown /></Page> },
      { name: 'Warming (partial, after a restart)', routes: { [ROUTE]: { ...SUMMARY, warming: true } }, setup: usage(), render: () => <Page><ActivityTab shown /></Page> },
      { name: 'Loading', routes: { [ROUTE]: pending() }, setup: usage(), render: () => <Page><ActivityTab shown /></Page> },
      { name: 'Empty', routes: { [ROUTE]: SUMMARY_EMPTY }, setup: usage(), render: () => <Page><ActivityTab shown /></Page> },
      { name: 'Error', routes: { [ROUTE]: reply(503, { error: 'fixture: unreachable' }) }, setup: usage(), render: () => <Page><ActivityTab shown /></Page> },
    ],
  },
]
