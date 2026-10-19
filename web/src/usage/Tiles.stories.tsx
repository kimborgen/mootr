import { ds, type Story } from '../stories/types'
import { sparkPath } from '../system/usage'
import type { Series } from './charts/math'
import type { UsagePeriod } from './state'
import { BY_DAY, ISSUES, ISSUES_EMPTY, series, USAGE, USAGE_EMPTY } from './story-data'
import { Tile, Tiles } from './Tiles'
import type { Issues, Usage } from './types'

// The tree series the Overview shares with the Spend tile. Its `days` must be the chart's day count
// for the period (web/src/usage/charts/OverviewCharts.tsx#chartDays) or the tile draws no change.
const TREE = series('tree', 6)
const UP: Series = { ...TREE, total: { cost_usd: 68.4 }, previous: { cost_usd: 52.1 } }
const DOWN: Series = { ...TREE, total: { cost_usd: 41.2 }, previous: { cost_usd: 60.8 } }
const SPARK = sparkPath(BY_DAY.map((d) => ({ cost_usd: d.cost_usd })), 64, 20)

const at = (u: Usage, o: { days?: UsagePeriod; series?: Series | null; issues?: Issues | null; failed?: boolean } = {}) => () => (
  <div className="pad usage"><Tiles u={u} days={o.days ?? 7} series={o.series ?? null} issues={o.issues === undefined ? ISSUES : o.issues} issuesFailed={o.failed ?? false} /></div>
)

export const stories: Story[] = [{
  name: 'Usage headline tiles',
  group: 'Settings',
  what: 'The four headline tiles under the limits band: spend over the period with its change against the period before and a sparkline of the days; the real money this month (what the paid accounts bill, since a subscription is flat); the issues finished in the period with their median cost; and today, with how many agents spent and the top one. Every number follows the page\'s Measure: API-equivalent dollars, a share of the 7-day window, or the real money paid.',
  when: 'The Overview tab of the Usage page (`usage` world), between the limits band and the spend charts (web/src/usage/Overview.tsx), for the page\'s Period. A drilled scope replaces them with the scoped view\'s own tiles (web/src/usage/drill/Drill.tsx), and another tab\'s table is a different story.',
  code: ['web/src/usage/Tiles.tsx#Tiles', 'web/src/usage/Tiles.tsx#Tile'],
  rules: [
    'The four sit in `.tiles`, each at least `--space-12` × 3 wide: four across on a desktop and two at 760 px and narrower, under a `--page-rule` hairline (' + ds('Density') + ')',
    'The spend tile draws the period\'s days as a sparkline: a `--series-1` stroke, no fill, no axis, `--space-12` + `--space-3` wide and `--space-5` tall',
    'The change reads ▲ when spend rose and ▼ when it fell, the rise in warning ink, with the percent rounded; all time and today have no period before them and draw none',
    'A number the measure cannot compute reads as an em dash, never a made-up number, and the Real money tile says why it has none ("No paid account reports spend") (' + ds('Status') + ')',
    'The issues tile reads "…" and "Loading" until GET /api/usage/issues answers, then "—" and "Could not load issues" when it fails; it names the median cost only when something finished',
    'Today counts the agents that spent and names the top one with its cost; the daemon caps that list at 30 rows, and at the cap the count is a floor ("30+ agents spent") and no top agent is named. With nothing spent today it says "No spend yet today"',
    'Each label names its period ("Spend · 7 days"), so the four cover the same window as the charts under them',
    'With no account, no daily spend and no spend today the Overview draws its empty state instead of these (' + ds('Empty, loading, and error') + ')',
  ],
  states: [
    { name: '7 days, above the week before', render: at(USAGE, { series: UP }) },
    { name: '7 days, below the week before', render: at(USAGE, { series: DOWN }) },
    { name: 'Today', render: at(USAGE, { days: 1 }) },
    { name: 'All time', render: at(USAGE, { days: 0 }) },
    { name: 'A few agents, the top one named', render: at({ ...USAGE, by_agent: USAGE.by_agent.slice(0, 4) }, { series: UP }) },
    { name: 'The list at its cap', render: at({ ...USAGE, by_agent: USAGE.by_agent.slice(0, 30) }, { series: UP }) },
    { name: 'Nothing spent today', render: at({ ...USAGE, by_agent: [] }, { series: UP }) },
    { name: 'No readings yet', render: at(USAGE_EMPTY, { issues: ISSUES_EMPTY }) },
    { name: 'Issues still loading', render: at(USAGE, { series: UP, issues: null }) },
    { name: 'Issues failed to load', render: at(USAGE, { series: UP, issues: null, failed: true }) },
    { name: 'One tile on its own', render: () => <div className="pad usage"><Tile label="Spend · 7 days" value="$68.40" spark={SPARK}>API-equivalent</Tile></div> },
  ],
}]
