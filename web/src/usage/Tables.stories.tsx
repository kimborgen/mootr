import type { ReactNode } from 'react'
import { AgentsTab, DaysTab, ModelsTab } from './Tables'
import { USAGE, USAGE_EMPTY, USAGE_FILTERED } from './story-data'
import { ds, type Story } from '../stories/types'
import { DEFAULT_STATE, setUsageState } from './state'

const wrap = (node: ReactNode) => <div className="pad usage">{node}</div>

export const stories: Story[] = [{
  name: 'Usage tables',
  group: 'Settings',
  what: 'The Models, Agents and Days tabs of the Usage page: sortable tables of spend. Models has one row per harness and model with its harness, tokens in and out, cache read and write, each count with its API-equivalent cost beside it (for example 1.2M · $3.40), a Token est. total (the tokens at list prices; the Cost column is what the harness reported), the share of the week it used where it runs on a subscription, and cost. A ? by the heading explains each column. Agents has one row per agent, with its harness and model in a muted line under its name. Days has a bar per day, then a table of the days. Each row also shows its share of the table\'s total as a percent and a bar. A counter the harness does not report reads as an em dash, not zero.',
  when: 'The Models, Agents and Days tabs of the Usage page (`usage` world). The table shows the page\'s period: Today and All time use each row\'s own today and lifetime totals, and 7 or 30 days use the totals the API sums over that period.',
  code: ['web/src/usage/Tables.tsx#ModelsTab', 'web/src/usage/Tables.tsx#AgentsTab', 'web/src/usage/Tables.tsx#DaysTab', 'web/src/usage/Tables.tsx#DataTable', 'web/src/usage/Tables.tsx#Dot', 'web/src/usage/Tables.tsx#ModelsHelp'],
  rules: [
    'A column header is a button that sorts; a second press flips the direction and `aria-sort` follows. Models and Agents start on cost, largest first; Days on the day, newest first. Pressing the name column sorts A to Z; any other column sorts largest first.',
    'A row\'s dot is the harness colour: `--h-claude`, `--h-codex` or `--h-opencode`; a spend that belongs to no harness (stam\'s own) reads `--text-muted`.',
    'The share bar is a `.meter` of `--space-12` × 1.5 wide, × 0.75 on a phone, with its percent to the left; below 1% it reads "<1%".',
    'At 760 px and narrower the token columns (and Harness on Models) fold into one muted line under the name, and the sort buttons are `--size-hit-touch` tall; on a wider page the name column does not wrap, and a table wider than the page scrolls sideways inside its own box (' + ds('Narrow panes and overflow') + ').',
    'The ? by the Models heading (S-1440) is a `--size-control` round button (`--size-hit-touch` on a phone) with `aria-expanded`; it opens the column explanations (In, Out, Cache read, Cache write, Token est., Cost, % of week) in a panel under the heading, and a second press closes it.',
    'On Models each token count shows its API-equivalent cost at the registry\'s prices after a dot, and the Token est. column totals them. A cost is a dash where the model\'s price is null or the harness reports no such counter; the total is a dash when any reported kind is unpriced, never a partial sum. The % of week column is empty for a model not on a subscription and a dash where the window is not calibrated. The % of week column hides when the Measure is % of week, since Cost already is that share. On a phone the muted line carries the same costs in brackets (`1k in ($0.01)`), the estimate and the share instead of new columns, and drops the costs entirely when no kind is priced.',
    'Models, Agents and Days show the Agent types control above the table (S-1491, S-1753), the types with spend in the period largest first, each with its agent count; the counts do not shrink to the selection. The tab asks `/api/usage` with the selection, so every row, total and bar counts only the chosen types, and a muted note "Showing only developer." says so. The note follows the daemon\'s `filtered_agents` echo: a daemon that ignores the filter gets "This daemon does not filter usage by agent type: the numbers count every agent." instead, never a false "Showing only". On the Agents tab that older-daemon note reads "the rows and totals on this tab count only those types; the other tabs count every agent.", because the tab filters its rows in the page.',
    'With no rows each tab says so in one muted line: "No model spend yet", "No agent spend yet", or "No spend in this period" (' + ds('Empty, loading, and error') + ').',
  ],
  states: [
    { name: 'Models, 7 days (each harness)', render: () => wrap(<ModelsTab u={USAGE} days={7} />) },
    { name: 'Models, help open', render: () => wrap(<ModelsTab u={USAGE} days={7} helpOpen />) },
    { name: 'Models, today', render: () => wrap(<ModelsTab u={USAGE} days={1} />) },
    { name: 'Models, all time', render: () => wrap(<ModelsTab u={USAGE} days={0} />) },
    { name: 'Models, none', render: () => wrap(<ModelsTab u={USAGE_EMPTY} days={7} />) },
    { name: 'Agents, 40 rows, 7 days', setup: () => setUsageState({ ...DEFAULT_STATE }), render: () => wrap(<AgentsTab u={USAGE} days={7} />) },
    { name: 'Agents, filtered to developers', setup: () => setUsageState({ ...DEFAULT_STATE, agents: ['developer'] }), render: () => wrap(<AgentsTab u={USAGE_FILTERED} days={7} />) },
    { name: 'Models, filtered to developers', setup: () => setUsageState({ ...DEFAULT_STATE, agents: ['developer'] }), render: () => wrap(<ModelsTab u={USAGE_FILTERED} days={7} />) },
    { name: 'Days, filtered to developers', setup: () => setUsageState({ ...DEFAULT_STATE, agents: ['developer'] }), render: () => wrap(<DaysTab u={USAGE_FILTERED} />) },
    { name: 'Models, daemon ignores the filter', setup: () => setUsageState({ ...DEFAULT_STATE, agents: ['developer'] }), render: () => wrap(<ModelsTab u={USAGE} days={7} />) },
    { name: 'Agents, none', render: () => wrap(<AgentsTab u={USAGE_EMPTY} days={7} />) },
    { name: 'Days', render: () => wrap(<DaysTab u={USAGE} />) },
    { name: 'Days, none', render: () => wrap(<DaysTab u={USAGE_EMPTY} />) },
  ],
}]
