import { AgentTypeBar, AllAgentsLabel, UsageFilter } from './AgentTypeBar'
import { DEFAULT_STATE, setUsageState } from './state'
import { ds, type Story } from '../stories/types'
import { TYPES } from './activity/summaryFixture'
import { USAGE, USAGE_FILTERED } from './story-data'

const Page = ({ children }: { children: React.ReactNode }) => <div className="pad usage">{children}</div>
const at = (agents: string[]) => () => setUsageState({ ...DEFAULT_STATE, agents })

export const stories: Story[] = [
  {
    name: 'Usage agent types',
    group: 'Settings',
    what: 'The Agent types row of Usage › Activity and the tabs fed by `/api/usage` (Overview, Models, Trees, Agents, Days): one toggle button per agent type present in the window, labelled with the type and its agent count ("developer 112"), then an All button that clears the choice. A type is the agent\'s registry type, or chief-of-staff, assistant or intake for an agent without one, or untyped.',
    when: 'Top of the Activity tab (types from the summary, before the filter) and of Overview, Models, Trees, Agents and Days (types from the `agent_types` of the usage answer, counted before the filter, so they do not shrink to the selection); Issues has no such row. The same selection is shared, remembered and deep-linked across all of them.',
    code: ['web/src/usage/AgentTypeBar.tsx#AgentTypeBar', 'web/src/usage/AgentTypeBar.tsx#UsageFilter', 'web/src/usage/AgentTypeBar.tsx#AllAgentsLabel'],
    rules: [
      'Selecting a type includes it; with none selected every agent counts and All is pressed. Taking the last type out is the same as All.',
      'The buttons are the `.seg` pressed-state group (`aria-pressed`), largest type first; they wrap, and on a phone share two columns, each `--size-hit-touch` tall (' + ds('Density') + '). No chips or switches.',
      'On the usage tabs the control comes with a muted note (`UsageFilter`, S-1753): "Showing only developer." once the daemon says it applied the filter (`filtered_agents`); a daemon that ignores `agents=` gets "This daemon does not filter usage by agent type: the numbers count every agent." and never a false "Showing only". The counts come from `agent_types`, so they do not shrink to the selection.',
      'A type in the choice stays a button, with a count of 0, when the window has none of it, so it can be cleared.',
    ],
    states: [
      { name: 'All', setup: at([]), render: () => <Page><AgentTypeBar types={TYPES} /></Page> },
      { name: 'Developers and managers', setup: at(['developer', 'manager']), render: () => <Page><AgentTypeBar types={TYPES} /></Page> },
      { name: 'A type with none in the window', setup: at(['advisor']), render: () => <Page><AgentTypeBar types={TYPES.filter((t) => t.type !== 'advisor')} /></Page> },
      { name: 'Usage tab, filtered', setup: at(['developer']), render: () => <Page><UsageFilter u={USAGE_FILTERED} /></Page> },
      { name: 'Usage tab, daemon ignores the filter', setup: at(['developer']), render: () => <Page><UsageFilter u={USAGE} /></Page> },
      { name: 'Few types', setup: at([]), render: () => <Page><AgentTypeBar types={TYPES.slice(0, 2)} /></Page> },
      { name: 'A panel title labelled All agents', setup: at(['developer']), render: () => <Page><div className="uc-head"><span className="uc-title">Where it went</span><AllAgentsLabel /></div></Page> },
    ],
  },
]
