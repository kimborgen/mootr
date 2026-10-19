import { UsageView } from './UsageView'
import { DEFAULT_STATE, setUsageState, type UsageState } from './state'
import { ACTIVITY_EMPTY_ROUTES, activityRoutes, ISSUES, seriesRoutes, USAGE, USAGE_CALM, USAGE_EMPTY, USAGE_FILTERED, USAGE_STALE } from './story-data'
import { ds, reply, type Story } from '../stories/types'

const open = (patch: Partial<UsageState> = {}) => () => setUsageState({ ...DEFAULT_STATE, ...patch })
const routes = (usage: unknown = USAGE) => ({
  'GET /api/usage': usage, 'GET /api/usage/issues': ISSUES, ...seriesRoutes(), ...activityRoutes(),
})

export const stories: Story[] = [{
  name: 'Usage page',
  group: 'Settings',
  what: 'The page for what the agents spend: a header with the title, a Period control (Today, 7 days, 30 days, All time) and a Measure control (API $, % of week, Real $), and seven tabs under it: Overview, Activity, Issues, Models, Trees, Agents, Days. The Overview shows blocked agents, today\'s numbers, each account\'s limit windows with estimated shares of who used them, allocations, the cost instructions, and the spend charts. The other tabs are tables and lists of the same spend; every tab but Issues has an Agent types control that filters by agent type, and Overview, Models, Trees, Agents and Days send it to `/api/usage` as `agents=`. Only API-equivalent dollars are computed: the other two measures are disabled.',
  when: 'The `usage` world: the Usage button in the header or the palette, a link from Settings › Activity (which opens the Activity tab), or a deep link such as `#view=usage&tab=models&period=7d`. It loads when it opens, again each time it is shown after being hidden, and again when the period changes.',
  code: ['web/src/usage/UsageView.tsx#UsageView', 'web/src/usage/UsageView.tsx#openUsageActivity', 'web/src/usage/state.ts#setUsageState'],
  rules: [
    'The tab, period, measure, and drill scope live in `web/src/usage/state.ts` and in the browser history, so Back and Forward move between them and a reload restores them; a deep link writes only what differs from the default (7 days, API $, Overview).',
    'The period and measure controls are segmented buttons; a measure that is not computed yet is `disabled` with the title "Not available yet" (' + ds('State vocabulary') + ').',
    'On every tab but Issues an Agent types control (an always-visible row of toggle buttons, one per agent type present with its agent count, and All) filters by the registry type: developer, manager, reviewer and so on, plus chief-of-staff, assistant, intake and untyped for agents without one. Selecting a type includes it; with none selected every agent counts. The choice is in the state and the deep link (`types=developer,manager`; an older `agents=managers` link still maps); Activity names it after the scope in its crumb, and Agents says how many rows show. Models, Days, Trees, Issues and Overview are pre-aggregated and ignore it. On a phone the buttons share two columns, each `--size-hit-touch` tall; no chips or switches (' + ds('Density') + ').',
    'The tabs are a `tablist` that scrolls sideways with its scrollbar hidden when they do not fit; the selected tab has a 2 px underline in `--tab-indicator-focused` (' + ds('Tabs and pane header') + ').',
    'At 760 px and narrower, the tabs and the control buttons are `--size-hit-touch` tall, the controls take the full width and scroll sideways instead of wrapping, and tables fold their wide columns under the row\'s name (' + ds('Density') + ').',
    'A meter fills with `--accent`, turns `--status-warning-fg` from 80% and `--status-error-fg` from 100% (' + ds('Status') + ').',
    'Loading shows the loading mark (`Loading`) and a failed load shows the daemon\'s reason in place of the tab; a page with no account and no spend shows an empty-state heading and a Cost settings button (' + ds('Empty, loading, and error') + ').',
  ],
  fit: 'page',
  states: [
    { name: 'Overview, windows near 100%', routes: routes(), setup: open(), render: () => <UsageView /> },
    { name: 'Overview, calm week', routes: routes(USAGE_CALM), setup: open(), render: () => <UsageView /> },
    { name: 'Overview, a stale reading', routes: routes(USAGE_STALE), setup: open(), render: () => <UsageView /> },
    { name: 'Today (hourly)', routes: routes(), setup: open({ days: 1 }), render: () => <UsageView /> },
    { name: 'Models, each harness', routes: routes(), setup: open({ tab: 'models' }), render: () => <UsageView /> },
    { name: 'Agents, 40 rows', routes: routes(), setup: open({ tab: 'agents' }), render: () => <UsageView /> },
    { name: 'Agents, Developers only', routes: routes(), setup: open({ tab: 'agents', agents: ['developer'] }), render: () => <UsageView /> },
    { name: 'Agents, Developers and managers', routes: routes(), setup: open({ tab: 'agents', agents: ['developer', 'manager'] }), render: () => <UsageView /> },
    { name: 'Activity, Developers', routes: routes(), setup: open({ tab: 'activity', agents: ['developer'] }), render: () => <UsageView /> },
    { name: 'Activity, Developers and managers', routes: routes(), setup: open({ tab: 'activity', agents: ['developer', 'manager'] }), render: () => <UsageView /> },
    { name: 'Days', routes: routes(), setup: open({ tab: 'days' }), render: () => <UsageView /> },
    { name: 'Overview, filtered to developers', routes: routes(USAGE_FILTERED), setup: open({ agents: ['developer'] }), render: () => <UsageView /> },
    { name: 'Trees, filtered to developers', routes: routes(USAGE_FILTERED), setup: open({ tab: 'trees', agents: ['developer'] }), render: () => <UsageView /> },
    { name: 'Trees', routes: routes(), setup: open({ tab: 'trees' }), render: () => <UsageView /> },
    { name: 'Loading', routes: routes(), setup: open(), render: () => <UsageView shown={false} /> },
    { name: 'Error', routes: { ...routes(), 'GET /api/usage': reply(503, { error: 'fixture: usage is unavailable' }) }, setup: open(), render: () => <UsageView /> },
    { name: 'No readings yet', routes: { ...routes(USAGE_EMPTY), ...ACTIVITY_EMPTY_ROUTES }, setup: open(), render: () => <UsageView /> },
  ],
}]
