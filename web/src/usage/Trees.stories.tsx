import { TreesTab } from './Trees'
import { TREES, USAGE, USAGE_FILTERED } from './story-data'
import { ds, type Story } from '../stories/types'
import { DEFAULT_STATE, setUsageState } from './state'

const page = (nodes: typeof TREES) => () => <div className="pad usage"><TreesTab nodes={nodes} /></div>

export const stories: Story[] = [{
  name: 'Usage trees',
  group: 'Settings',
  what: 'Each tree\'s total cost: one row per root agent with its subtree\'s cost over the period, and its children below it, a fold per node. A node also names the share of an account\'s window it used, when stam has one. The daemon dedupes a tree with shared children, so a node under several parents shows under each.',
  when: 'The Trees tab of the Usage page (`usage` world), for the page\'s period.',
  code: ['web/src/usage/Trees.tsx#TreesTab'],
  rules: [
    'Rows are `--size-row-table` tall and indent one `--space-3` per level, like the agent tree (' + ds('Density') + ').',
    'Roots start open; a chevron turns to point down when a fold is open; a leaf has no chevron.',
    'A long name is cut with an ellipsis and the cost stays visible at the end, in `--text-secondary`.',
    'The Agent types control shows above the trees (S-1753) and the totals follow it: with types chosen, each node counts only those agents\' cost, a tree with no chosen agent is left out, and a muted note says "Showing only developer. Each total counts only those agents." The note follows the daemon\'s `filtered_agents` echo, so a daemon that ignores the filter is never labelled filtered. Cost and Time Measures both follow it.',
    'With no tree spend it says "No trees with spend yet" (' + ds('Empty, loading, and error') + ').',
  ],
  states: [
    { name: 'Three trees', render: page(TREES) },
    { name: 'Filtered to developers', setup: () => setUsageState({ ...DEFAULT_STATE, agents: ['developer'] }), render: () => <div className="pad usage"><TreesTab nodes={USAGE_FILTERED.trees!} u={USAGE_FILTERED} /></div> },
    { name: 'With the Agent types control', setup: () => setUsageState({ ...DEFAULT_STATE }), render: () => <div className="pad usage"><TreesTab nodes={TREES} u={USAGE} /></div> },
    { name: 'No trees', render: page([]) },
  ],
}]
