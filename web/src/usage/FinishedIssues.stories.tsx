import { itsa } from '../stories/itsaFixtures'
import { ds, type Story } from '../stories/types'
import { FinishedIssues, IssueKey } from './FinishedIssues'
import type { UsagePeriod } from './state'
import { ISSUES, ISSUES_EMPTY, ISSUES_MANY } from './story-data'
import type { Issues } from './types'

// The fixture's issues as the store holds them, so a key opens its ITSA and the Tree column names
// the tree its owner belongs to (stories/fixtures.ts's agents). The ages are invented.
const store = (d: Issues) => ({
  itsas: d.issues.map((r, i) => ({ ...itsa(400 + i, null, r.title, r.status, { min: 6000 - i * 100 }), id: `fx-issue-${i}`, key: r.key, closed_at: r.closed_at })),
})

const panel = (d: Issues | null, error: string | null = null, days: UsagePeriod = 7, allAgents = false) => () => (
  <div className="pad usage"><FinishedIssues d={d} error={error} retry={() => {}} days={days} allAgents={allAgents} /></div>
)

export const stories: Story[] = [{
  name: 'Usage finished issues',
  group: 'Settings',
  what: 'The Overview\'s Finished issues panel: the five most expensive issues closed in the period that have spend. A row is the issue key and title (the key opens its ITSA when the store has it), the tree its owner belongs to, its configuration in short words, its own cost, that cost against its configuration\'s median as a bar with a tick, and its share of the weekly window. "All N →" opens the Issues tab, N counting every issue the Closed filter lists. An issue above 1.5× its median reads "N× median"; the rest read "typical".',
  when: 'The Overview tab of the Usage page (`usage` world), under the spend charts (web/src/usage/Overview.tsx). Its period is the page\'s Period control and its numbers follow the page\'s Measure. The issues come from one call the page makes when it loads (web/src/usage/issueData.ts#useIssues), which is where the loading line, the error and the Retry come from.',
  code: ['web/src/usage/FinishedIssues.tsx#FinishedIssues', 'web/src/usage/FinishedIssues.tsx#IssueKey'],
  rules: [
    'The comparison is `.vs`: `--space-12` × 2 wide and `--space-2` tall, `--radius-xs` corners on a `--status-neutral-bg` track, filled with `--accent`, with the median a `--space-05` tick in `--text-primary`',
    'The panel is a plain `.uc-panel` table: a hairline and quiet ink, no card and no shadow. An issue key links in `--cite-ink`, and a click on it stays out of any row click around it, as a key links in mail and the sidebar',
    'A configuration the API has no stats for draws no tick and reads "typical"; a cost of exactly its median reads "typical" too. The multiple takes one decimal below 10, none above',
    'The Week column reads "≈N%" for a known share, "paid" for an OpenCode or OpenRouter configuration (their spend is billed through their own accounts), and "—" when the daemon knows neither',
    'At 760 px and narrower the Tree, Configuration, comparison and Week columns fold into one muted line under the issue, so the row keeps its key, title and cost (' + ds('Narrow panes and overflow') + ')',
    'While an agent type filter is set the panel still shows, and its title carries a muted "All agents" label beside it, since the issues count every agent (S-1845)',
    'Loading shows the loading mark (`Loading`); a failure shows the reason with a Retry button; a period with nothing finished says "No issues finished in this period" (' + ds('Empty, loading, and error') + ')',
  ],
  states: [
    { name: 'Five most expensive, 7 days', data: store(ISSUES), render: panel(ISSUES) },
    { name: 'A busy period, 36 closed', data: store(ISSUES_MANY), render: panel(ISSUES_MANY) },
    { name: 'Filtered to a type, labelled All agents', data: store(ISSUES), render: panel(ISSUES, null, 7, true) },
    { name: 'Today', data: store(ISSUES), render: panel(ISSUES, null, 1) },
    { name: 'All time', data: store(ISSUES), render: panel(ISSUES, null, 0) },
    { name: 'Nothing finished in the period', data: store(ISSUES_EMPTY), render: panel(ISSUES_EMPTY) },
    { name: 'Still loading', render: panel(null) },
    { name: 'Could not load, with Retry', render: panel(null, 'fixture: issue costs unavailable') },
    {
      name: 'A key the store knows, and one it does not',
      data: store(ISSUES_MANY),
      render: () => <div className="pad usage"><table className="data"><tbody>
        <tr><td><IssueKey keyName="FX-401" title="Fixture: keep the retry delay between attempts" /></td></tr>
        <tr><td><IssueKey keyName="FX-999" title="Fixture: an ITSA the store no longer holds" /></td></tr>
      </tbody></table></div>,
    },
  ],
}]
