import { IssuesTab } from './Issues'
import { ISSUES, ISSUES_EMPTY } from './story-data'
import { ds, type Story } from '../stories/types'

// `days` is the page's Period, which the tab filters closed issues by; the issue costs themselves
// load with the page, for the whole history.
const page = (d: typeof ISSUES | null, error: string | null = null) => () => (
  <div className="pad usage"><IssuesTab d={d} error={error} retry={() => {}} days={7} /></div>
)

export const stories: Story[] = [{
  name: 'Usage issues',
  group: 'Settings',
  what: 'Every issue in the period as a sortable table, a Closed/Open/All filter with its own count, then the cost per configuration (harness and model): how many closed issues and their median, average, range and weekly-window share. A row is the issue key and title, its status, its configuration, its own cost, its cost with its children, its agents and its weekly share; a row click drills into that ITSA on the Overview. Claude and Codex amounts are API-equivalent, not what the subscription bills; OpenCode and OpenRouter amounts with no weekly share read "paid".',
  when: 'The Issues tab of the Usage page (`usage` world). The issue costs load with the page; the table follows the page\'s Period, so Closed is the issues that closed inside it.',
  code: ['web/src/usage/Issues.tsx#IssuesTab'],
  rules: [
    'Only issues of kind `issue` show: Closed lists the ones that closed inside the period, Open the ones still open, All both; the muted count beside the filter says which in words.',
    'Headers sort, own cost descending first: a text column starts ascending and a numeric one descending, and the first click on the current column turns it round. An issue key links to its ITSA when the store has it, in `--cite-ink`, the way a key links in mail and the sidebar; a closed status is a plain badge and any other shows the `prog` tone.',
    'Both tables follow the page\'s Measure: the API-equivalent dollars, the share of a subscription window, or the real money paid.',
    'At 760 px and narrower the Status, Configuration, Total with children, Agents and Week columns fold into one muted line under the issue, so the table keeps Issue and Own cost; a table wider than the page scrolls sideways inside its own box (' + ds('Narrow panes and overflow') + ').',
    'Loading shows the loading mark (`Loading`); a failure shows the reason with a Retry button; an empty list names its own case: "No issues closed in this period", "No open issues" or "No issues in this period" (' + ds('Empty, loading, and error') + ').',
  ],
  states: [
    { name: 'Closed issues, 7 days', render: page(ISSUES) },
    { name: 'Loading', render: page(null) },
    { name: 'Could not load', render: page(null, 'fixture: issue costs unavailable') },
    { name: 'Nothing closed in the period', render: page(ISSUES_EMPTY) },
  ],
}]
