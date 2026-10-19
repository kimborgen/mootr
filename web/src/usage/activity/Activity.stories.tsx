import { ds, type Story } from '../../stories/types'
import { ActivityTiles } from './ActivityTiles'
import { AgentTrees } from './AgentTrees'
import { Bottlenecks } from './Bottlenecks'
import { ConfigCosts } from './ConfigCosts'
import { CostByModel, CostByType } from './CostBreakdown'
import { ScopeCrumb } from './ScopeCrumb'
import { TimeCard } from './TimeCard'
import { CONFIGS, SUMMARY, SUMMARY_AGENT, SUMMARY_EMPTY, TREES } from './summaryFixture'

// The pieces of the Activity tab (S-1011); the tab itself is in ../Activity.stories.tsx.

// Unclassified work is the largest here, and still comes last.
const WITH_UNCLASSIFIED = { ...SUMMARY, working_by_category: [{ key: 'unclassified', label: 'Unclassified', seconds: 80 * 3600, cost_usd: 300, modes: null, estimated: true, leaves: {} }, ...SUMMARY.working_by_category] }
const Page = ({ children }: { children: React.ReactNode }) => <div className="pad usage">{children}</div>

export const stories: Story[] = [
  {
    name: 'Activity scope crumb',
    group: 'Settings',
    what: '"All agents › whole system", or the drilled tree, ITSA or agent with All agents clearing it. When the Agent types control filters, the types are named after the scope. A model or harness scope is not one activity reads, so it says the whole system shows.',
    when: 'Above the Activity tiles; the scope is the page\'s drill scope (S-661).',
    code: ['web/src/usage/activity/ScopeCrumb.tsx#ScopeCrumb'],
    rules: ['All agents is `--accent-text`; on a phone it is `--size-hit-touch` tall (' + ds('Density') + ').'],
    states: [
      { name: 'Whole system', render: () => <Page><ScopeCrumb scope={null} /></Page> },
      { name: 'An agent', render: () => <Page><ScopeCrumb scope={{ kind: 'agent', id: 'fx-dev' }} answer={SUMMARY_AGENT.scope} /></Page> },
      { name: 'Filtered to developers', render: () => <Page><ScopeCrumb scope={null} filter={['developer']} /></Page> },
      { name: 'Two types, in an agent', render: () => <Page><ScopeCrumb scope={{ kind: 'agent', id: 'fx-dev' }} answer={SUMMARY_AGENT.scope} filter={['developer', 'manager']} /></Page> },
      { name: 'Today (last 24 h)', render: () => <Page><ScopeCrumb scope={null} days={1} /></Page> },
      { name: 'A model (not read)', render: () => <Page><ScopeCrumb scope={{ kind: 'model', id: 'claude-opus-5-5' }} /></Page> },
    ],
  },
  {
    name: 'Activity tiles',
    group: 'Settings',
    what: 'Time mode: working agent-hours with a per-day sparkline and its share of the clock; waiting on you (replies, new prompts); friction with its two largest parts; cost per working hour in the Measure, with the category that takes most of it. Cost mode: the cost in the Measure, cost per working hour, and the agent type and the tree that cost the most, each with its share ("developer · 42%"), then one muted line saying waiting, friction and idle time have no recorded cost.',
    when: 'Top of the Activity tab, on the Usage page\'s `Tile`.',
    code: ['web/src/usage/activity/ActivityTiles.tsx#ActivityTiles'],
    rules: ['A Measure mode that can\'t be computed reads as a dash, never $0.00.', 'Two tiles a row on a phone, four on a desktop.', 'Cost mode shows no time figure on any tile; cost per working hour reads "per working agent-hour".'],
    states: [
      { name: 'API $', render: () => <Page><ActivityTiles d={SUMMARY} measure="api" mode="time" /></Page> },
      { name: 'Real $', render: () => <Page><ActivityTiles d={SUMMARY} measure="real" mode="time" /></Page> },
      { name: 'No working time', render: () => <Page><ActivityTiles d={SUMMARY_EMPTY} measure="api" mode="time" /></Page> },
      { name: 'Cost mode, API $', render: () => <Page><ActivityTiles d={SUMMARY} measure="api" mode="cost" /></Page> },
      { name: 'Cost mode, % of week', render: () => <Page><ActivityTiles d={SUMMARY} measure="week" mode="cost" /></Page> },
      { name: 'Cost mode, no cost by type', render: () => <Page><ActivityTiles d={SUMMARY_EMPTY} measure="api" mode="cost" /></Page> },
    ],
  },
  {
    name: 'Where the time goes',
    group: 'Settings',
    what: 'One clock bar of the scope\'s agent-hours (working, other agents and jobs, you, friction, idle) with a legend row each, then working by what the work was for. In Cost mode (the page switch) it is Where the cost goes: no clock bar, and the categories by their estimated cost, each marked "est." with its share.',
    when: 'Activity tab, left column on a desktop.',
    code: ['web/src/usage/activity/TimeCard.tsx#TimeCard'],
    rules: [
      'Categories take `--series-1`, `--series-3` to `--series-6`, then `--sand-400` for "N more"; never `--series-2`, which reads like the warning ochre that marks the human.',
      'Rows are `--size-row-table` with tabular numbers (' + ds('Density') + ').',
      'Unclassified work is never ranked among the categories: it is a muted last row, after "N more", and never named by the cost tile.',
    ],
    states: [
      { name: 'Time', render: () => <Page><TimeCard d={SUMMARY} measure="api" mode="time" /></Page> },
      { name: 'With unclassified work', render: () => <Page><TimeCard d={WITH_UNCLASSIFIED} measure="api" mode="time" /></Page> },
      { name: 'No categories', render: () => <Page><TimeCard d={SUMMARY_AGENT} measure="api" mode="time" /></Page> },
      { name: 'Cost mode', render: () => <Page><TimeCard d={SUMMARY} measure="api" mode="cost" /></Page> },
      { name: 'Cost mode, Real $ not known', render: () => <Page><TimeCard d={{ ...SUMMARY, working_by_category: SUMMARY.working_by_category.map((c) => ({ ...c, modes: null })) }} measure="real" mode="cost" /></Page> },
    ],
  },
  {
    name: 'Bottlenecks',
    group: 'Settings',
    what: 'The waits and slow work that can be fixed, largest first: agent-hours, a bar against the largest, the agents hit and the top two, and the single longest span when it is most of it. The human\'s carry a "you" tag. Top eight, then Show all.',
    when: 'Activity tab, right column on a desktop, after Where the time goes on a phone.',
    code: ['web/src/usage/activity/Bottlenecks.tsx#Bottlenecks'],
    rules: ['Bars take the clock group\'s colour; the you tag is `--status-warning-fg`.', 'Show all is a text button, `--size-hit-touch` on a phone.', 'An agent\'s name is `--accent-text` and scopes the tab to that agent.'],
    states: [
      { name: 'Ten, top eight shown', render: () => <Page><Bottlenecks rows={SUMMARY.bottlenecks} /></Page> },
      { name: 'One', render: () => <Page><Bottlenecks rows={SUMMARY_AGENT.bottlenecks} /></Page> },
      { name: 'None', render: () => <Page><Bottlenecks rows={[]} /></Page> },
    ],
  },
  {
    name: 'Cost by agent type',
    group: 'Settings',
    what: 'The kept agents\' cost split by registry type (and chief-of-staff, assistant, intake, untyped), largest first, each with a bar against the largest, its agent count and its share. In Time mode the same card is Time by agent type, the working agent-hours of the same rows, so a time figure never sits under a cost heading. A type\'s name counts only that type. Top eight, then Show all.',
    when: 'Activity tab, left column under Where the time (cost) goes on a desktop; second on a phone.',
    code: ['web/src/usage/activity/CostBreakdown.tsx#CostByType'],
    rules: ['A Measure mode that is not known reads as a dash and sorts last.', 'The bar is `--indigo-500`; rows are as Bottlenecks, with a type name `--accent-text` and `--size-hit-touch` tall on a phone.'],
    states: [
      { name: 'Cost, API $', render: () => <Page><CostByType rows={SUMMARY.by_type ?? []} mode="cost" measure="api" /></Page> },
      { name: 'Cost, Real $ not known', render: () => <Page><CostByType rows={(SUMMARY.by_type ?? []).map((r) => ({ ...r, modes: null }))} mode="cost" measure="real" /></Page> },
      { name: 'Time', render: () => <Page><CostByType rows={SUMMARY.by_type ?? []} mode="time" measure="api" /></Page> },
      { name: 'None', render: () => <Page><CostByType rows={[]} mode="cost" measure="api" /></Page> },
    ],
  },
  {
    name: 'Cost by model',
    group: 'Settings',
    what: 'Replaces Bottlenecks in Cost mode, since a wait or slow-work span has no recorded cost: the kept agents\' cost per harness and model, largest first, with the harness mark, a bar against the largest, the agent count and the share.',
    when: 'Activity tab in Cost mode, right column on a desktop; after Cost by agent type on a phone.',
    code: ['web/src/usage/activity/CostBreakdown.tsx#CostByModel'],
    rules: ['Models read as their short names with the harness mark in `--h-*`.', 'Its unit line says waits and bottlenecks have no cost, so the swap is explained.'],
    states: [
      { name: 'Four models', render: () => <Page><CostByModel rows={SUMMARY.by_model ?? []} measure="api" /></Page> },
      { name: 'None', render: () => <Page><CostByModel rows={[]} measure="api" /></Page> },
    ],
  },
  {
    name: 'What finished issues cost',
    group: 'Settings',
    what: 'Closed work issues grouped by model, by agent type, or by both: the issues, the cost as a range mark (a dot at the median, a tick at the 75th percentile, scaled to the largest p75 shown) with the median in the Measure, then the working, lead time and review medians.',
    when: 'Activity tab, left column under Where the time goes on a desktop; after Bottlenecks on a phone.',
    code: ['web/src/usage/activity/ConfigCosts.tsx#ConfigCosts'],
    rules: [
      'Models read as their short names ("Opus 5.5", "DeepSeek v4.1 flash") with the harness mark in `--h-*`.',
      'At a phone width lead time and reviews move to a muted second line under the name (' + ds('Narrow panes and overflow') + ').',
      'The dot is `--indigo-500` (working); the line and tick `--text-muted`. A mode with no values reads as a dash.',
    ],
    states: [
      { name: 'By model', render: () => <Page><ConfigCosts configs={CONFIGS} measure="api" /></Page> },
      { name: 'Real $', render: () => <Page><ConfigCosts configs={CONFIGS} measure="real" /></Page> },
      { name: 'None', render: () => <Page><ConfigCosts configs={SUMMARY_EMPTY.configs} measure="api" /></Page> },
    ],
  },
  {
    name: 'Agents by tree',
    group: 'Settings',
    what: 'The root agents with their subtrees\' totals, each root\'s largest direct children indented under it: the harness mark, "· type · N agents", the working hours (Time) or the cost in the Measure (Cost), and a thin bar split by the clock groups. [Working | Friction] sorts in Time mode; Cost mode sorts by cost and shows only the cost in the Measure, with a bar of its share of the largest. Top eight roots, then Show all; tapping a row scopes the tab to that tree.',
    when: 'Activity tab, right column under Bottlenecks on a desktop; last on a phone.',
    code: ['web/src/usage/activity/AgentTrees.tsx#AgentTrees'],
    rules: [
      'In Time mode bars take the clock bar\'s colours (`GROUP_COLOR`) and the legend shows once below; in Cost mode the bar is `--indigo-500`, no legend, and no row shows hours.',
      'A root shows its top three children; the rest are one tap into its tree. Scoped to one tree, its top ten show, then Show all; "Show all" closes when the scope changes to another tree.',
      'Rows are `--size-hit-touch` on a phone (' + ds('Density') + ').',
    ],
    states: [
      { name: 'Ten roots', render: () => <Page><AgentTrees trees={TREES} measure="api" mode="time" /></Page> },
      { name: 'One tree (scoped)', render: () => <Page><AgentTrees trees={[TREES[0]]} measure="api" mode="time" /></Page> },
      { name: 'One tree, fourteen children', render: () => <Page><AgentTrees trees={[{ ...TREES[0], children: Array.from({ length: 14 }, (_, i) => ({ ...TREES[0].children[i % 7], id: `fixture-kid-${i}`, name: `fixture-kid-${i}` })) }]} measure="api" mode="time" /></Page> },
      { name: 'Cost mode', render: () => <Page><AgentTrees trees={TREES} measure="api" mode="cost" /></Page> },
      { name: 'None', render: () => <Page><AgentTrees trees={[]} measure="api" mode="time" /></Page> },
    ],
  },
]
