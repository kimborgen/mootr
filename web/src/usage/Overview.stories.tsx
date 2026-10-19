import { Overview } from './Overview'
import { DEFAULT_STATE, setUsageState } from './state'
import { ACCOUNT_CLAUDE, ACCOUNT_CODEX, ACCOUNT_OPENCODE, ACCOUNT_OR_AGENTS, ACCOUNT_OR_AGENTS_SPENT, ACCOUNT_OR_SYSTEM, ACCOUNT_OR_SYSTEM_LOW, ACCOUNT_OR_SYSTEM_UNSET, ACCOUNT_STALE, ISSUES, ISSUES_EMPTY, seriesRoutes, USAGE, USAGE_CALM, USAGE_EMPTY, USAGE_FILTERED } from './story-data'
import { ds, type Story } from '../stories/types'

// `days` is the page's Period (the Usage header's control); the Overview draws its charts, its
// issues tile and the finished issues panel from it.
const page = (u: typeof USAGE, issues: typeof ISSUES | null = ISSUES, issuesError: string | null = null) => () => <div className="pad usage"><Overview u={u} issues={issues} issuesError={issuesError} retryIssues={() => {}} days={7} /></div>
const fresh = () => setUsageState({ ...DEFAULT_STATE })
const routes = seriesRoutes()

export const stories: Story[] = [{
  name: 'Usage overview',
  group: 'Settings',
  what: 'The first tab of the Usage page, top to bottom: the blocked callout (one line per blocked agent, with an Open link); the limits band, one card per account with each window\'s meter, its reset time and a hatched forecast to where the window stands at reset (a warning when that reaches 100% first), the credit, the paid spend, the budget, and the tree allocations; the four headline tiles (spend over the period with its change against the period before, real money this month, issues finished in the period and their median cost, and today); the spend charts, per bucket and "where it went"; the finished issues panel (the most expensive issues closed in the period, each cost against its configuration\'s median); and a footer with the cost instructions and a button to edit them in Settings. The API-equivalent note and the estimates note sit in the footer. With a drill scope set — a tree, ITSA, model, harness or agent, opened from a chart or a table — the tiles, charts and finished issues give way to the scoped view.',
  when: 'The Overview tab of the Usage page (`usage` world), the page\'s default tab. It draws the page\'s Period from its `days` prop. With no account, no subscription, no daily spend and no spend today it shows the empty state instead.',
  code: ['web/src/usage/Overview.tsx#Overview'],
  rules: [
    'A window\'s `.lim-meter` is `--space-2` tall with `--radius-xs` corners; it fills with `--accent`, turns `--status-warning-fg` when the forecast reaches 100% before the reset and `--status-error-fg` at 100%, and its forecast is a hatched `--lim-ink` stripe to the projected percent. A budget meter uses the same 80% and 100% thresholds.',
    'The four tiles sit in `.tiles`, each at least `--space-12` × 3 wide, two per row at 760 px and narrower; the spend tile draws a `--series-1` sparkline.',
    'OpenRouter has two budgets on one credit, side by side under "OpenRouter budgets": Agents (account `openrouter`) and System (`openrouter-system`, stam\'s own calls: mail gate, summaries, titles, decisions). Each shows spent, the cap and period, what is left, and a meter; from 80% the card border and meter turn `--status-warning-fg` with a `low` badge, at 100% `--status-error-fg` with `spent`. A spent Agents budget never stops System. With no system budget the System card prompts for one with a Set in Settings button. The two cards sit two across and stack into one column at 480 px and narrower (' + ds('Density') + ').',
    'A stale reading gets a `warn` badge with its age and forecasts nothing; a paid amount reads exact, "≈" for an estimate, or none when unknown (' + ds('Status') + ').',
    'The two spend charts are raised panels side by side (about 2/3 and 1/3), stacking into one column at 760 px and narrower (' + ds('Density') + ').',
    'The issues tile reads "…" and "Loading" until `/api/usage/issues` answers, then "—" and "Could not load issues" when it fails; the finished issues panel below the charts shows the same reason with a Retry button (' + ds('Empty, loading, and error') + ').',
    'Finished issues lists the five most expensive issues closed in the period that have spend, each as a bar from zero with a tick at its configuration\'s median: "N× median" once the cost passes 1.5× it, "typical" otherwise. "All N →" opens the Issues tab, N counting the Closed filter.',
    'It takes the page\'s Period from its `days` prop, so its charts, its issues tile and the finished issues panel cover the same window as the other tabs.',
    'With Agent types chosen (S-1753) the control shows at the top and a muted note names them. The Spend tile (without its change against the period before) and Today count only those agents, as the daemon sums them; the limits band, subscription windows, real money, the spend charts and finished issues stay account-wide and the note says so. The spend charts and finished issues are not split by type, so while a filter is applied each of their panel titles carries a muted "All agents" label (S-1845), and they stay in place. The note follows the daemon\'s `filtered_agents` echo, so a daemon that ignores the filter is never labelled filtered. With a drill scope set, the note says the drill counts every agent instead, since the scoped view is not filtered by type.',
    'The cost instructions are the setting from Settings › Spending; "Edit in Settings" opens that section.',
  ],
  states: [
    { name: 'Windows near 100%', routes, setup: fresh, render: page(USAGE) },
    { name: 'Filtered to developers', routes, setup: () => { fresh(); setUsageState({ ...DEFAULT_STATE, agents: ['developer'] }) }, render: page(USAGE_FILTERED) },
    { name: 'Calm week', routes, setup: fresh, render: page(USAGE_CALM) },
    { name: 'Each harness (Claude, Codex, OpenCode)', routes, setup: fresh, render: page({ ...USAGE, blocked: [], allocations: [], accounts: [ACCOUNT_CLAUDE, ACCOUNT_CODEX, ACCOUNT_OPENCODE] }) },
    { name: 'OpenRouter budgets: agents and system', routes, setup: fresh, render: page({ ...USAGE, blocked: [], allocations: [], accounts: [ACCOUNT_CLAUDE, ACCOUNT_OR_AGENTS, ACCOUNT_OR_SYSTEM] }) },
    { name: 'OpenRouter budgets: agents spent, system low', routes, setup: fresh, render: page({ ...USAGE, blocked: [], allocations: [], accounts: [ACCOUNT_OR_AGENTS_SPENT, ACCOUNT_OR_SYSTEM_LOW] }) },
    { name: 'OpenRouter budgets: no system budget', routes, setup: fresh, render: page({ ...USAGE, blocked: [], allocations: [], accounts: [ACCOUNT_OR_AGENTS, ACCOUNT_OR_SYSTEM_UNSET] }) },
    { name: 'Stale reading', routes, setup: fresh, render: page({ ...USAGE, blocked: [], allocations: [], accounts: [ACCOUNT_STALE] }) },
    { name: 'No accounts configured', routes, setup: fresh, render: page({ ...USAGE, accounts: [], blocked: [], allocations: [], by_day: USAGE.by_day }) },
    { name: 'No cost readings yet', routes, setup: fresh, render: page(USAGE_EMPTY, ISSUES_EMPTY) },
    { name: 'Issues failed to load', routes, setup: fresh, render: page(USAGE, null, 'fixture: issue costs unavailable') },
    { name: 'Issues still loading', routes, setup: fresh, render: page(USAGE, null) },
  ],
}]
