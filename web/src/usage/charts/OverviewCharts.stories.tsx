import { OverviewCharts } from './OverviewCharts'
import { DEFAULT_STATE, setUsageState, type UsagePeriod } from '../state'
import { SERIES_EMPTY_ROUTES, SERIES_ERROR_ROUTES, seriesRoutes } from '../story-data'
import { ds, type Story } from '../../stories/types'

const at = (days: UsagePeriod) => () => setUsageState({ ...DEFAULT_STATE, days })
const draw = () => <div className="pad usage"><OverviewCharts /></div>

export const stories: Story[] = [{
  name: 'Overview charts',
  group: 'Settings',
  what: 'The spend charts of the Usage overview, wired to the page: the period comes from the page\'s Period control, the grouping (tree, ITSA, model, harness) is its own, and a click on a segment or a bar sets the page\'s drill scope. It asks the daemon for the period and the one before in a single call and hands the answer to the spend charts.',
  when: 'In the Usage page\'s Overview tab. It loads when shown, again for a new period or grouping (the call in flight is cancelled), and again on Retry.',
  code: ['web/src/usage/charts/OverviewCharts.tsx#OverviewCharts', 'web/src/usage/charts/OverviewCharts.tsx#chartDays', 'web/src/usage/charts/OverviewCharts.tsx#drillScope'],
  rules: [
    'While an agent type filter is set the charts still draw from every agent: each panel title carries a muted "All agents" label beside it (S-1845).',
    'The panels, colours, and keyboard behaviour are those of the spend charts story; this wiring adds the period: Today asks for 1 day and draws hourly columns, 7 days asks for 6, 30 days for 29 (the API counts today and the days before).',
    'All time draws the last 30 days, because a year of columns is a comb; the panel subtitle names the period it drew.',
    'A reply without rows is treated as an error, "The spend series is not available from this daemon.", not drawn as an empty chart (' + ds('Empty, loading, and error') + ').',
  ],
  states: [
    { name: '7 days', routes: seriesRoutes(), setup: at(7), render: draw },
    { name: 'Today', routes: seriesRoutes(), setup: at(1), render: draw },
    { name: '30 days', routes: seriesRoutes(), setup: at(30), render: draw },
    { name: 'All time (last 30 days)', routes: seriesRoutes(), setup: at(0), render: draw },
    { name: 'Filtered to a type, labelled All agents', routes: seriesRoutes(), setup: at(7), render: () => <div className="pad usage"><OverviewCharts allAgents /></div> },
    { name: 'Error', routes: SERIES_ERROR_ROUTES, setup: at(7), render: draw },
    { name: 'No spend', routes: SERIES_EMPTY_ROUTES, setup: at(7), render: draw },
  ],
}]
